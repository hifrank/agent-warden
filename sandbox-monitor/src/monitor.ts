/**
 * sandbox-monitor — In-guest execution monitor for Kata sandbox pods.
 *
 * Runs as PID 1 inside the Kata microVM. Forks the actual tool command
 * as a child process and monitors it from inside the guest VM, producing
 * a structured JSON telemetry record on stdout when the tool exits.
 *
 * This compensates for Defender eBPF being unable to penetrate Kata
 * microVMs. See design doc §4.1.1 "Sandbox Execution Monitor".
 *
 * Usage:
 *   sandbox-monitor [--timeout <ms>] -- <tool-command> [args...]
 */

import { spawn, ChildProcess } from "node:child_process";
import { readFileSync, readdirSync, statSync, watch, FSWatcher } from "node:fs";
import { join } from "node:path";

// ────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────

interface ProcessInfo {
  pid: number;
  ppid: number;
  comm: string;
  args: string;
}

interface TelemetryRecord {
  version: "1.0";
  type: "sandbox.telemetry";
  tenantId: string;
  sessionId: string;
  toolName: string;
  skillName: string;
  execution: {
    command: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
    startedAt: string;
    finishedAt: string;
  };
  processes: {
    total: number;
    tree: ProcessInfo[];
    suspicious: string[];
  };
  syscalls: {
    blocked: { syscall: string; count: number }[];
    totalAuditEvents: number;
  };
  filesystem: {
    filesCreated: string[];
    filesModified: string[];
    totalBytesWritten: number;
    suspiciousFiles: string[];
  };
  network: {
    connections: NetworkConnection[];
    dnsQueries: string[];
    totalBytesOut: number;
    totalBytesIn: number;
  };
  resources: {
    cpuMs: number;
    memoryPeakMb: number;
    ioBytesRead: number;
    ioBytesWrite: number;
  };
  risk: {
    score: number;
    factors: string[];
    action: "allow" | "flag" | "alert";
  };
}

interface NetworkConnection {
  proto: string;
  remoteAddr: string;
  remotePort: number;
  state: string;
}

// ────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────

const SUSPICIOUS_BINARIES = new Set([
  "curl", "wget", "nc", "ncat", "netcat", "nmap", "ssh", "scp",
  "python", "python3", "perl", "ruby", "lua", "bash", "zsh", "dash",
  "socat", "telnet", "ftp", "tftp", "rsync",
]);

const SUSPICIOUS_FILE_PATTERNS = [
  /\.sh$/,
  /\.py$/,
  /reverse.?shell/i,
  /exploit/i,
  /backdoor/i,
  /payload/i,
  /meterpreter/i,
];

const WATCHED_DIRS = ["/tmp", "/var/tmp"];

const TCP_STATES: Record<string, string> = {
  "01": "ESTABLISHED", "02": "SYN_SENT", "03": "SYN_RECV",
  "04": "FIN_WAIT1", "05": "FIN_WAIT2", "06": "TIME_WAIT",
  "07": "CLOSE", "08": "CLOSE_WAIT", "09": "LAST_ACK",
  "0A": "LISTEN", "0B": "CLOSING",
};

// ────────────────────────────────────────────────────────────────────
// Process monitoring
// ────────────────────────────────────────────────────────────────────

function scanProcessTree(): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  try {
    const pids = readdirSync("/proc").filter((f) => /^\d+$/.test(f));
    for (const pidStr of pids) {
      const pid = parseInt(pidStr, 10);
      if (pid <= 1) continue; // skip PID 0 and ourselves
      try {
        const stat = readFileSync(join("/proc", pidStr, "stat"), "utf-8");
        const cmdline = readFileSync(join("/proc", pidStr, "cmdline"), "utf-8")
          .replace(/\0/g, " ")
          .trim();
        const parts = stat.match(/\d+ \((.+?)\) \S+ (\d+)/);
        if (parts) {
          procs.push({
            pid,
            ppid: parseInt(parts[2], 10),
            comm: parts[1],
            args: cmdline || parts[1],
          });
        }
      } catch {
        // Process may have exited between readdir and read
      }
    }
  } catch {
    // /proc might not be available
  }
  return procs;
}

function findSuspiciousProcesses(tree: ProcessInfo[]): string[] {
  const suspicious: string[] = [];
  for (const proc of tree) {
    const baseName = proc.comm.split("/").pop() ?? proc.comm;
    if (SUSPICIOUS_BINARIES.has(baseName)) {
      suspicious.push(baseName);
    }
    // Detect common reverse shell patterns in args
    if (/\/dev\/tcp\//i.test(proc.args) || /bash\s+-i/i.test(proc.args)) {
      suspicious.push(`reverse_shell_pattern:${baseName}`);
    }
  }
  return [...new Set(suspicious)];
}

// ────────────────────────────────────────────────────────────────────
// Network monitoring
// ────────────────────────────────────────────────────────────────────

function parseHexIp(hex: string): string {
  // Linux /proc/net/tcp stores IPs in little-endian hex
  const n = parseInt(hex, 16);
  return [(n & 0xff), (n >> 8 & 0xff), (n >> 16 & 0xff), (n >> 24 & 0xff)].join(".");
}

function scanNetConnections(): NetworkConnection[] {
  const conns: NetworkConnection[] = [];
  for (const proto of ["tcp", "tcp6", "udp", "udp6"]) {
    try {
      const data = readFileSync(`/proc/net/${proto}`, "utf-8");
      const lines = data.trim().split("\n").slice(1); // skip header
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        if (cols.length < 4) continue;
        const [, localAddr, remoteAddr, state] = cols;
        const [remoteIp, remotePortHex] = remoteAddr.split(":");
        const remotePort = parseInt(remotePortHex, 16);
        const ip = proto.includes("6") ? remoteIp : parseHexIp(remoteIp);
        // Skip loopback and unconnected
        if (ip === "0.0.0.0" || ip === "127.0.0.1" || remotePort === 0) continue;
        conns.push({
          proto: proto.replace("6", ""),
          remoteAddr: ip,
          remotePort,
          state: TCP_STATES[state] ?? state,
        });
      }
    } catch {
      // Might not exist
    }
  }
  return conns;
}

// ────────────────────────────────────────────────────────────────────
// Filesystem monitoring
// ────────────────────────────────────────────────────────────────────

interface FsEvents {
  created: string[];
  modified: string[];
}

function startFsWatcher(): { events: FsEvents; stop: () => void } {
  const events: FsEvents = { created: [], modified: [] };
  const watchers: FSWatcher[] = [];

  for (const dir of WATCHED_DIRS) {
    try {
      const watcher = watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = join(dir, filename);
        if (eventType === "rename") {
          events.created.push(fullPath);
        } else if (eventType === "change") {
          events.modified.push(fullPath);
        }
      });
      watchers.push(watcher);
    } catch {
      // Directory might not exist or be readable
    }
  }

  return {
    events,
    stop: () => watchers.forEach((w) => w.close()),
  };
}

function findSuspiciousFiles(files: string[]): string[] {
  return files.filter((f) =>
    SUSPICIOUS_FILE_PATTERNS.some((p) => p.test(f))
  );
}

function totalBytesWritten(files: string[]): number {
  let total = 0;
  for (const f of files) {
    try {
      total += statSync(f).size;
    } catch {
      // File may already be gone
    }
  }
  return total;
}

// ────────────────────────────────────────────────────────────────────
// Resource monitoring
// ────────────────────────────────────────────────────────────────────

interface ResourceUsage {
  cpuMs: number;
  memoryPeakMb: number;
  ioBytesRead: number;
  ioBytesWrite: number;
}

function getResourceUsage(startCpuUsage: NodeJS.CpuUsage): ResourceUsage {
  const cpuDelta = process.cpuUsage(startCpuUsage);
  const cpuMs = Math.round((cpuDelta.user + cpuDelta.system) / 1000);

  let memoryPeakMb = Math.round(process.memoryUsage().rss / 1024 / 1024);
  let ioBytesRead = 0;
  let ioBytesWrite = 0;

  try {
    const io = readFileSync("/proc/self/io", "utf-8");
    for (const line of io.split("\n")) {
      const [key, val] = line.split(":").map((s) => s.trim());
      if (key === "read_bytes") ioBytesRead = parseInt(val, 10);
      if (key === "write_bytes") ioBytesWrite = parseInt(val, 10);
    }
  } catch {
    // Might not be available
  }

  // Try to get peak RSS from cgroup memory stats
  try {
    const memMax = readFileSync("/sys/fs/cgroup/memory.peak", "utf-8").trim();
    memoryPeakMb = Math.round(parseInt(memMax, 10) / 1024 / 1024);
  } catch {
    try {
      const memMax = readFileSync("/sys/fs/cgroup/memory/memory.max_usage_in_bytes", "utf-8").trim();
      memoryPeakMb = Math.round(parseInt(memMax, 10) / 1024 / 1024);
    } catch {
      // Fall back to process.memoryUsage() above
    }
  }

  return { cpuMs, memoryPeakMb, ioBytesRead, ioBytesWrite };
}

// ────────────────────────────────────────────────────────────────────
// Risk scoring
// ────────────────────────────────────────────────────────────────────

function computeRisk(telemetry: Omit<TelemetryRecord, "risk">): TelemetryRecord["risk"] {
  let score = 0;
  const factors: string[] = [];

  // Suspicious processes: +40 each
  for (const proc of telemetry.processes.suspicious) {
    score += 40;
    factors.push(`unexpected_process:${proc}`);
  }

  // Seccomp violations: +30 each
  for (const sc of telemetry.syscalls.blocked) {
    score += 30;
    factors.push(`seccomp_violation:${sc.syscall}`);
  }

  // Outbound connections: +25 each
  for (const conn of telemetry.network.connections) {
    score += 25;
    factors.push(`outbound_connection:${conn.remoteAddr}:${conn.remotePort}`);
  }

  // DNS queries: +15 each
  if (telemetry.network.dnsQueries.length > 0) {
    score += 15;
    factors.push(`dns_queries:${telemetry.network.dnsQueries.length}`);
  }

  // Excessive files: +10
  if (telemetry.filesystem.filesCreated.length > 100) {
    score += 10;
    factors.push(`excessive_files:${telemetry.filesystem.filesCreated.length}`);
  }

  // Suspicious files: +20 each
  for (const f of telemetry.filesystem.suspiciousFiles) {
    score += 20;
    factors.push(`suspicious_file:${f}`);
  }

  // Non-zero exit: +5
  if (telemetry.execution.exitCode !== 0 && telemetry.execution.exitCode !== null) {
    score += 5;
    factors.push(`nonzero_exit:${telemetry.execution.exitCode}`);
  }

  score = Math.min(score, 100);

  let action: "allow" | "flag" | "alert";
  if (score <= 25) action = "allow";
  else if (score <= 50) action = "flag";
  else action = "alert";

  return { score, factors, action };
}

// ────────────────────────────────────────────────────────────────────
// CLI parsing
// ────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { timeout: number; command: string[] } {
  let timeout = 0;
  const args = argv.slice(2); // strip node + script

  let i = 0;
  while (i < args.length) {
    if (args[i] === "--timeout" && i + 1 < args.length) {
      timeout = parseInt(args[i + 1], 10);
      i += 2;
    } else if (args[i] === "--") {
      return { timeout, command: args.slice(i + 1) };
    } else {
      break;
    }
  }

  // Everything remaining is the command
  return { timeout, command: args.slice(i) };
}

// ────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { timeout, command } = parseArgs(process.argv);
  if (command.length === 0) {
    process.stderr.write("sandbox-monitor: no command specified\n");
    process.stderr.write("Usage: sandbox-monitor [--timeout <ms>] -- <command> [args...]\n");
    process.exit(1);
  }

  const tenantId = process.env.TENANT_ID ?? "unknown";
  const sessionId = process.env.SESSION_ID ?? "unknown";
  const toolName = process.env.TOOL_NAME ?? command[0];
  const skillName = process.env.SKILL_NAME ?? "";

  // Start monitors
  const startCpuUsage = process.cpuUsage();
  const fsMonitor = startFsWatcher();
  const startedAt = new Date();

  // Collect stdout from the child as the tool's actual output.
  // Telemetry goes to stderr to avoid mixing.
  const toolOutputChunks: Buffer[] = [];

  // Spawn the tool process
  const child: ChildProcess = spawn(command[0], command.slice(1), {
    stdio: ["inherit", "pipe", "inherit"],
    env: { ...process.env },
  });

  child.stdout?.on("data", (chunk: Buffer) => {
    toolOutputChunks.push(chunk);
  });

  // Set up timeout if specified
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  if (timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5000);
    }, timeout);
  }

  // Periodically sample process tree and network
  const processSnapshots: ProcessInfo[][] = [];
  const networkSnapshots: NetworkConnection[][] = [];
  const sampleInterval = setInterval(() => {
    processSnapshots.push(scanProcessTree());
    networkSnapshots.push(scanNetConnections());
  }, 500);

  // Wait for child to exit
  const { exitCode, signal } = await new Promise<{
    exitCode: number | null;
    signal: string | null;
  }>((resolve) => {
    child.on("exit", (code, sig) => {
      resolve({ exitCode: code, signal: sig });
    });
  });

  // Cleanup
  clearInterval(sampleInterval);
  if (timeoutHandle) clearTimeout(timeoutHandle);
  fsMonitor.stop();

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  // Final snapshots
  const finalProcs = scanProcessTree();
  processSnapshots.push(finalProcs);
  networkSnapshots.push(scanNetConnections());

  // Merge all process snapshots (unique by pid+comm)
  const allProcs = new Map<string, ProcessInfo>();
  for (const snap of processSnapshots) {
    for (const p of snap) {
      allProcs.set(`${p.pid}:${p.comm}`, p);
    }
  }
  const tree = [...allProcs.values()];
  const suspicious = findSuspiciousProcesses(tree);

  // Merge all network snapshots
  const allConns = new Map<string, NetworkConnection>();
  for (const snap of networkSnapshots) {
    for (const c of snap) {
      allConns.set(`${c.proto}:${c.remoteAddr}:${c.remotePort}`, c);
    }
  }
  const connections = [...allConns.values()];

  const resources = getResourceUsage(startCpuUsage);
  const { events } = fsMonitor;
  const suspiciousFiles = findSuspiciousFiles([...events.created, ...events.modified]);

  // Build telemetry (without risk — computed next)
  const partial: Omit<TelemetryRecord, "risk"> = {
    version: "1.0",
    type: "sandbox.telemetry",
    tenantId,
    sessionId,
    toolName,
    skillName,
    execution: {
      command: command.join(" "),
      exitCode: timedOut ? null : exitCode,
      signal: timedOut ? "SIGTERM(timeout)" : signal,
      durationMs,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
    },
    processes: {
      total: tree.length,
      tree: tree.slice(0, 50), // cap to avoid huge telemetry
      suspicious,
    },
    syscalls: {
      blocked: [], // Populated by seccomp audit log parsing if available
      totalAuditEvents: 0,
    },
    filesystem: {
      filesCreated: events.created.slice(0, 200),
      filesModified: events.modified.slice(0, 200),
      totalBytesWritten: totalBytesWritten(events.created),
      suspiciousFiles,
    },
    network: {
      connections,
      dnsQueries: [], // Would require DNS stub; left for future enhancement
      totalBytesOut: 0,
      totalBytesIn: 0,
    },
    resources,
  };

  const risk = computeRisk(partial);
  const telemetry: TelemetryRecord = { ...partial, risk };

  // Write the actual tool output to stdout (for the Gateway to consume)
  const toolOutput = Buffer.concat(toolOutputChunks);
  process.stdout.write(toolOutput);

  // Write telemetry to stderr as a single JSON line
  // Container Insights collects both stdout and stderr.
  // Using stderr ensures tool output and telemetry don't mix in the same stream.
  process.stderr.write("\n" + JSON.stringify(telemetry) + "\n");

  // Exit with the tool's exit code
  process.exit(exitCode ?? (timedOut ? 124 : 1));
}

main().catch((err) => {
  process.stderr.write(`sandbox-monitor fatal error: ${err}\n`);
  process.exit(125);
});
