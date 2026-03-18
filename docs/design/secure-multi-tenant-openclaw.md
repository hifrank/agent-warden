az security alert list --query "[?contains(alertType,'K8S')]" -o table# Secure Multi-Tenant Design for Hosting OpenClaw

> **Status:** Draft  
> **Date:** 2026-03-13  
> **Author:** [TBD]  
> **Project:** agent-warden

---

## 1. Executive Summary

OpenClaw is a personal AI assistant designed for single-user, self-hosted deployments. This document defines a secure multi-tenant architecture that allows a hosting provider to run isolated OpenClaw instances for multiple tenants while preserving the security guarantees users expect from a "personal" assistant.

The core principle: **each tenant's OpenClaw environment must be as isolated as if it were running on a dedicated machine.**

---

## 2. Threat Model

### 2.1 Adversaries

| Adversary | Goal | Capability |
|---|---|---|
| Malicious tenant | Escape isolation, access other tenants' data | Full control of their own OpenClaw instance |
| Compromised channel | Inject prompts via WhatsApp/Telegram/Slack DMs | Send arbitrary messages to a tenant's bot |
| External attacker | Breach the hosting platform | Network-level access, credential stuffing |
| Insider (operator) | Access tenant secrets or conversations | Platform admin access |

### 2.2 Assets to Protect

- **Tenant credentials** — API keys (OpenAI, Anthropic), channel bot tokens (Telegram, Discord, Slack)
- **Conversation history** — session transcripts, media files
- **Workspace data** — skills, AGENTS.md, uploaded files, browser profiles
- **Channel identity** — WhatsApp sessions (Baileys creds), Signal identity keys
- **Configuration** — openclaw.json, per-tenant settings

### 2.3 Security Goals

1. **Tenant isolation** — no cross-tenant data access (memory, network, filesystem, process)
2. **Credential confidentiality** — operator cannot read tenant secrets at rest
3. **Least privilege** — each tenant's tooling runs with minimal permissions
4. **Auditability** — all administrative and security-relevant events are logged
5. **Defense in depth** — multiple layers, no single point of failure

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────┐
│                    Control Plane                         │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Tenant   │  │   Sentinel   │  │  Secrets Manager  │  │
│  │ Registry │  │  MCP Server  │  │  (Vault / KMS)    │  │
│  └──────────┘  └──────────────┘  └───────────────────┘  │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────────┐  │
│  │ Ingress  │  │   Metrics /  │  │  Provisioning     │  │
│  │ Router   │  │   Logging    │  │  Orchestrator     │  │
│  └──────────┘  └──────────────┘  └───────────────────┘  │
└──────────────────────────┬──────────────────────────────┘
                           │
              ┌────────────┼────────────────┐
              │            │                │
     ┌────────▼───┐ ┌─────▼──────┐ ┌───────▼─────┐
     │  Tenant A  │ │  Tenant B  │ │  Tenant C   │
     │ ┌────────┐ │ │ ┌────────┐ │ │ ┌────────┐  │
     │ │Gateway │ │ │ │Gateway │ │ │ │Gateway │  │
     │ │:18789  │ │ │ │:18789  │ │ │ │:18789  │  │
     │ └───┬────┘ │ │ └───┬────┘ │ │ └───┬────┘  │
     │     │      │ │     │      │ │     │        │
     │ ┌───▼────┐ │ │ ┌───▼────┐ │ │ ┌───▼────┐  │
     │ │Pi Agent│ │ │ │Pi Agent│ │ │ │Pi Agent│  │
     │ │(RPC)   │ │ │ │(RPC)   │ │ │ │(RPC)   │  │
     │ └────────┘ │ │ └────────┘ │ │ └────────┘  │
     │ ┌────────┐ │ │ ┌────────┐ │ │ ┌────────┐  │
     │ │Sandbox │ │ │ │Sandbox │ │ │ │Sandbox │  │
     │ │(Docker)│ │ │ │(Docker)│ │ │ │(Docker)│  │
     │ └────────┘ │ │ └────────┘ │ │ └────────┘  │
     │  isolated  │ │  isolated  │ │  isolated   │
     │  namespace │ │  namespace │ │  namespace  │
     └────────────┘ └────────────┘ └─────────────┘
```

### 3.1 Key Components

| Component | Responsibility |
|---|---|
| **Tenant Registry** | Stores tenant metadata, billing tier, feature flags | Azure Cosmos DB / Azure SQL |
| **Agent Warden Server** | Security policy enforcement, access control decisions, audit event emission | Azure Container Apps / AKS Pod |
| **Secrets Manager** | Encrypts/decrypts tenant credentials (API keys, bot tokens). Tenants' secrets are envelope-encrypted with per-tenant KEKs | Azure Key Vault (Premium HSM-backed) |
| **Ingress Router** | Routes inbound channel webhooks and WebSocket connections to the correct tenant Gateway | Azure Application Gateway for Containers (AGC) + Azure Front Door |
| **Provisioning Orchestrator** | Lifecycle management: create, suspend, migrate, destroy tenant environments | AKS Operator / Azure Resource Manager |
| **Metrics / Logging** | Centralized observability with tenant-scoped log partitioning | Azure Monitor + Log Analytics |
| **DLP / Compliance** | Data classification, sensitive data detection, policy enforcement across tenant data flows | Microsoft Purview |

---

## 4. Tenant Isolation Model

### 4.1 Compute Isolation

Each tenant runs inside a **dedicated container group** (pod) with:

| Layer | Mechanism | Purpose |
|---|---|---|
| Container | Dedicated Docker/OCI containers per tenant | Process-level isolation |
| Namespaces | Separate Linux PID, network, mount, user namespaces | Kernel-level isolation |
| Seccomp | Restrictive seccomp profile (no `ptrace`, `mount`, `keyctl`) | Syscall filtering |
| AppArmor/SELinux | Mandatory access control profiles | Prevent container escape |
| Resource limits | CPU/memory cgroups, PID limits | Prevent noisy-neighbor DoS |

```yaml
# Per-tenant container constraints (example)
resources:
  limits:
    cpu: "2"
    memory: "4Gi"
    ephemeral-storage: "10Gi"
  requests:
    cpu: "500m"
    memory: "1Gi"
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
  seccompProfile:
    type: RuntimeDefault
```

> **Exception — agent-browser skill:** The OpenClaw gateway container requires
> `readOnlyRootFilesystem: false` and `seccompProfile: type: Unconfined` when
> the `agent-browser` skill is installed. Chrome's crashpad handler, GPU cache,
> and subprocess management (clone/fork) require writable filesystem paths and
> unrestricted syscalls that cannot be redirected to tmpfs mounts. All sidecar
> containers (LiteLLM proxy, SaaS auth proxy, git-sync) continue to enforce
> `readOnlyRootFilesystem: true` and `RuntimeDefault` seccomp. The gateway
> container still drops all capabilities and disables privilege escalation.
> A custom Docker image (`agent-warden-openclaw/Dockerfile`) extends the base
> OpenClaw image with Chrome system dependencies and the agent-browser CLI
> pre-installed at `/opt/agent-browser`.

### 4.1.1 Kata Sandbox Isolation for Tool Execution (AKS Pod Sandboxing)

OpenClaw tenants execute untrusted code via Pi Agent tool calls and skills inside Docker sandboxes. In multi-tenant hosting, these sandbox executions represent the **highest escape risk** — a malicious or compromised tool could attempt to break out of the container and reach the host kernel.

**AKS Pod Sandboxing** uses **Kata Containers** (`kata-mshv-vm-isolation`) to run sandbox pods inside lightweight Hyper-V microVMs, adding a hardware VM boundary between untrusted code and the host kernel.

#### Hybrid Node Pool Architecture

The platform uses a **three-pool hybrid architecture** that balances Kata VM isolation with Microsoft Defender for Containers runtime visibility:

```
┌─────────────────────────────────────────────────────────────────────────┐
│  AKS Cluster                                                            │
│                                                                         │
│  ┌───────────────────────────────────────┐                              │
│  │  System Node Pool (runc)              │                              │
│  │  • Agent Warden Server                │ ← Full Defender eBPF        │
│  │  • Provisioning Operator              │   runtime visibility        │
│  │  • ALB Controller (Gateway API)       │                              │
│  └───────────────────────────────────────┘                              │
│                                                                         │
│  ┌───────────────────────────────────────┐                              │
│  │  Tenant Node Pool (runc)              │                              │
│  │  • OpenClaw Gateway (:18789)          │ ← Full Defender eBPF        │
│  │  • LLM DLP Proxy sidecar (:8080)     │   runtime visibility        │
│  │  • Workspace / State PVCs             │   (process, file, network)  │
│  └───────────────────────────────────────┘                              │
│                                                                         │
│  ┌───────────────────────────────────────┐                              │
│  │  Sandbox Node Pool (Kata Containers)  │                              │
│  │  • Tool execution pods                │ ← Defender: K8s audit +     │
│  │  • Skill sandbox containers           │   image scan only           │
│  │  • Ephemeral (no PVCs)                │   (no eBPF inside microVM)  │
│  │  RuntimeClass: kata-mshv-vm-isolation │                              │
│  └───────────────────────────────────────┘                              │
└─────────────────────────────────────────────────────────────────────────┘
```

| Node Pool | Runtime | Workload | Defender eBPF | Kata VM Isolation |
|---|---|---|---|---|
| `system` | `runc` (default) | Control plane pods | Full | No |
| `tenant` | `runc` (default) | OpenClaw Gateway, DLP Proxy, PVCs | Full | No |
| `sandbox` | `kata-mshv-vm-isolation` | Tool/skill execution containers | K8s audit + image scan only | Yes (Hyper-V microVM) |

#### Why This Split Preserves Defender Coverage

Defender for Containers' eBPF sensor runs on the **host kernel**. Kata pods run inside a **guest kernel** in a Hyper-V microVM. This means:

| Defender Capability | `runc` pods (tenant pool) | Kata pods (sandbox pool) |
|---|---|---|
| Process execution monitoring | Yes | **No** — eBPF can't see inside microVM |
| File access monitoring | Yes | **No** |
| Network connection monitoring | Yes | **No** (host sees VM-level traffic only) |
| DNS query monitoring | Yes | **No** |
| Binary drift detection | Yes | **No** |
| K8s API audit (kubectl exec, RBAC) | Yes | Yes |
| ACR image vulnerability scan | Yes | Yes |
| Pod spec security audit | Yes | Yes |

By keeping the **Gateway** (where Defender runtime monitoring is most valuable) on regular `runc` nodes, we retain full eBPF visibility into:
- Pi Agent process spawning
- Credential file access
- Outbound network connections
- DNS exfiltration attempts

The **sandbox pool** trades runtime Defender visibility for stronger isolation — an acceptable tradeoff because:
1. Sandbox containers are ephemeral (seconds to minutes)
2. They have no access to PVCs (state/workspace/secrets)
3. Network egress is strictly limited via Calico NetworkPolicy
4. The DLP proxy and Agent Warden audit trail provide application-level monitoring

#### Compensating Controls for Sandbox Pool (Kata)

Since Defender eBPF doesn't penetrate Kata microVMs, compensating controls ensure visibility:

| Control | Mechanism | Coverage |
|---|---|---|
| Network egress enforcement | Calico NetworkPolicy (enforced at host veth) | Full — even Kata pods use host networking stack via virtio-net |
| Azure Firewall FQDN rules | VNET-level egress filtering | Full — works outside the VM boundary |
| Execution timeout | Agent Warden enforces hard timeout per tool call | Full — sandbox pod killed after timeout |
| Resource limits | Kubernetes ResourceQuota + LimitRange on namespace | Full — cgroups enforced by kubelet on host |
| DLP scanning on I/O | Tool input/output scanned by Agent Warden (Intercept Point 4) | Full — runs before/after sandbox |
| Output content scanning | Purview DLP on tool results before returning to Pi Agent | Full |
| Audit trail | Agent Warden logs every tool invocation with input hash, output hash, duration | Full |
| Image scanning | Defender scans sandbox images in ACR on push | Full |
| K8s audit | Defender monitors pod creation, exec, RBAC changes | Full |

#### Sandbox Execution Monitor (In-Guest Observability)

Since Defender's eBPF sensor cannot penetrate Kata microVMs, we embed a **sandbox execution monitor** (`sandbox-monitor`) as the entrypoint wrapper inside every sandbox container. This provides process-level, filesystem-level, and network-level telemetry from **inside** the guest VM — achieving comparable visibility to Defender on `runc` nodes.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Kata MicroVM (Hyper-V)                                                  │
│                                                                         │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │  PID 1: sandbox-monitor (entrypoint wrapper)                      │  │
│  │                                                                   │  │
│  │  ┌─ Monitors ─────────────────────────────────────────────────┐   │  │
│  │  │  • procfs watcher  — tracks child process tree (fork/exec) │   │  │
│  │  │  • seccomp audit   — logs blocked/suspicious syscalls       │   │  │
│  │  │  • fs watcher      — inotify on /tmp, detects file creates │   │  │
│  │  │  • net watcher     — /proc/net/tcp+udp, tracks connections │   │  │
│  │  │  • resource meter  — CPU/memory/IO from /proc/self/cgroup  │   │  │
│  │  └────────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  ┌─ Child Process ───────────────────────────────────────────┐   │  │
│  │  │  PID 2: <actual tool command>                              │   │  │
│  │  │  (runs as nobody:65534, capped resources)                  │   │  │
│  │  └────────────────────────────────────────────────────────────┘   │  │
│  │                                                                   │  │
│  │  On exit: serialize telemetry → stdout (JSON)                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
         │
         │  Pod logs (stdout JSON) collected by Container Insights
         ▼
┌─────────────────────────┐     ┌────────────────────────────┐
│  Azure Monitor           │────►│  Log Analytics Workspace   │
│  (Container Insights)    │     │  KQL queries on sandbox    │
│                          │     │  telemetry                 │
└─────────────────────────┘     └────────────┬───────────────┘
                                             │
                                             ▼
                                   ┌─────────────────────┐
                                   │  Microsoft Sentinel  │
                                   │  (analytics rules    │
                                   │   on sandbox events) │
                                   └─────────────────────┘
```

##### What sandbox-monitor Captures

| Telemetry | Source (inside microVM) | Equivalent Defender Feature | Alert Trigger |
|---|---|---|---|
| **Process tree** | `fork()`/`execve()` via ptrace or `/proc` polling | Process execution monitoring | Unexpected binary (curl, wget, nc, nmap, ssh) |
| **Syscall violations** | seccomp audit log (`SECCOMP_RET_LOG`) | Linux capabilities monitoring | Blocked syscall attempts (ptrace, mount, keyctl) |
| **File I/O** | inotify on writable paths (`/tmp`, `/var/tmp`) | File access monitoring | File creation count > threshold, suspicious filenames |
| **Network connections** | `/proc/net/tcp`, `/proc/net/udp`, `/proc/net/tcp6` polling | Network connection monitoring | Any outbound connection (sandbox should have none on Free tier) |
| **DNS queries** | Intercept via `/etc/resolv.conf` → local stub or parse `/proc/net/udp` | DNS query monitoring | Any DNS resolution (unexpected for most tools) |
| **Resource usage** | `/proc/self/cgroup` (cpu, memory), `/proc/self/io` | Container resource anomaly | CPU spike, memory near limit, excessive disk I/O |
| **Exit status** | waitpid() on child process | N/A | Non-zero exit, killed by signal (OOM, timeout) |
| **Execution duration** | Wall clock timer | N/A | Exceeds expected duration for tool type |

##### sandbox-monitor Output Schema

The monitor writes a single JSON telemetry record to stdout on completion. Container Insights collects this via the standard pod log pipeline:

```jsonc
{
  "version": "1.0",
  "type": "sandbox.telemetry",
  "tenantId": "tenant-abc123",
  "sessionId": "session-xyz",
  "toolName": "web-search",
  "skillName": "@clawhub/web-search",

  "execution": {
    "command": "node /skill/index.js --query 'weather today'",
    "exitCode": 0,
    "signal": null,
    "durationMs": 2340,
    "startedAt": "2026-03-13T10:00:00.000Z",
    "finishedAt": "2026-03-13T10:00:02.340Z"
  },

  "processes": {
    "total": 3,
    "tree": [
      { "pid": 2, "ppid": 1, "comm": "node", "args": "/skill/index.js --query 'weather today'" },
      { "pid": 3, "ppid": 2, "comm": "node", "args": "/skill/node_modules/.bin/fetch" }
    ],
    "suspicious": []    // e.g. ["curl", "wget", "nc"] would appear here
  },

  "syscalls": {
    "blocked": [],       // seccomp audit events: [{ "syscall": "ptrace", "count": 1 }]
    "totalAuditEvents": 0
  },

  "filesystem": {
    "filesCreated": ["/tmp/result.json"],
    "filesModified": [],
    "totalBytesWritten": 1024,
    "suspiciousFiles": []   // e.g. ["/tmp/reverse_shell.sh"]
  },

  "network": {
    "connections": [],    // [{ "proto": "tcp", "remoteAddr": "...", "remotePort": 443, "state": "ESTABLISHED" }]
    "dnsQueries": [],     // [{ "qname": "api.openai.com", "qtype": "A" }]
    "totalBytesOut": 0,
    "totalBytesIn": 0
  },

  "resources": {
    "cpuMs": 890,
    "memoryPeakMb": 64,
    "ioBytesRead": 2048,
    "ioBytesWrite": 1024
  },

  "risk": {
    "score": 0,           // 0-100, computed by monitor
    "factors": [],        // e.g. ["unexpected_process:curl", "outbound_connection:1.2.3.4:4444"]
    "action": "allow"     // "allow" | "flag" | "alert"
  }
}
```

##### Risk Scoring

The sandbox-monitor computes a risk score (0–100) based on weighted factors:

| Factor | Weight | Examples |
|---|---|---|
| Suspicious process spawned | +40 | `curl`, `wget`, `nc`, `nmap`, `ssh`, `python -c`, `bash -i` |
| Seccomp violation | +30 | Any blocked syscall (ptrace, mount, keyctl, personality) |
| Outbound network connection | +25 | Any TCP/UDP connection from sandbox |
| DNS resolution attempt | +15 | Any DNS query (most tools shouldn't need DNS) |
| Excessive file creation | +10 | > 100 files in /tmp |
| Suspicious file names | +20 | `*.sh`, `*.py` with `chmod +x`, `/tmp/exploit*` |
| Excessive resource usage | +10 | > 90% of memory limit sustained |
| Non-zero exit code | +5 | Tool crashed or was killed |

Risk thresholds:

| Score | Action | Response |
|---|---|---|
| 0–25 | `allow` | Normal — log telemetry only |
| 26–50 | `flag` | Log + flag for review in Agent Warden dashboard |
| 51–75 | `alert` | Log + create Sentinel SIEM incident + notify platform security |
| 76–100 | `alert` + suspend | Log + Sentinel incident + auto-suspend tenant via `warden.tenant.suspend` |

##### Sentinel Analytics Rules for Sandbox Events

```kql
// KQL: Detect suspicious sandbox executions
ContainerLog
| where ContainerName == "sandbox"
| where LogEntry contains '"type":"sandbox.telemetry"'
| extend telemetry = parse_json(LogEntry)
| extend riskScore = toint(telemetry.risk.score)
| where riskScore > 50
| extend tenantId = tostring(telemetry.tenantId),
         toolName = tostring(telemetry.toolName),
         suspiciousProcesses = tostring(telemetry.processes.suspicious),
         connections = tostring(telemetry.network.connections)
| project TimeGenerated, tenantId, toolName, riskScore, suspiciousProcesses, connections
| order by riskScore desc
```

```kql
// KQL: Detect sandbox network exfiltration attempts
ContainerLog
| where ContainerName == "sandbox"
| where LogEntry contains '"type":"sandbox.telemetry"'
| extend telemetry = parse_json(LogEntry)
| extend netConns = array_length(telemetry.network.connections)
| where netConns > 0
| extend tenantId = tostring(telemetry.tenantId),
         toolName = tostring(telemetry.toolName),
         connections = telemetry.network.connections
| project TimeGenerated, tenantId, toolName, netConns, connections
```

##### How sandbox-monitor Fits in the Execution Flow

```
OpenClaw Gateway (tenant pool, runc)
         │
         │ 1. Pi Agent decides to execute tool
         │
         ▼
Agent Warden: warden.dlp.scan()     ◄── Intercept Point 4 (input)
         │ DLP scan on tool input
         │
         ▼
K8s API: Create sandbox Pod
         │ - runtimeClassName: kata-mshv-vm-isolation
         │ - entrypoint: /usr/local/bin/sandbox-monitor
         │ - args: ["--", "node", "/skill/index.js", "--query", "..."]
         │
         ▼
┌─────────────────────────────────┐
│  Kata microVM                    │
│  sandbox-monitor (PID 1)         │
│    ├── starts monitors           │
│    ├── fork/exec tool (PID 2)    │
│    ├── waits for exit            │
│    ├── collects telemetry        │
│    └── writes JSON to stdout     │
└─────────────────────────────────┘
         │
         │ 2. Pod completes, stdout collected
         │
         ▼
Gateway reads pod logs (tool output + telemetry)
         │
         ▼
Agent Warden: warden.dlp.scan()     ◄── Intercept Point 4 (output)
         │ DLP scan on tool output
         │
         ▼
Agent Warden: warden.sandbox.report()
         │ Parse telemetry, evaluate risk score
         │ Write audit record to Cosmos DB
         │ If risk > 50: create Sentinel SIEM incident
         │
         ▼
Tool output returned to Pi Agent
         │ (sensitive data redacted by DLP)
         ▼
Continue conversation
```

#### Kata RuntimeClass

```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata:
  name: kata-mshv-vm-isolation
handler: kata-mshv-vm-isolation
overhead:
  podFixed:
    memory: "160Mi"    # Hyper-V microVM overhead
    cpu: "250m"
scheduling:
  nodeSelector:
    kubernetes.azure.com/os-sku: AzureLinux    # Kata requires Azure Linux nodes
    openclaw.io/pool: sandbox
```

#### Sandbox Pod Spec (Tool Execution)

```yaml
apiVersion: v1
kind: Pod
metadata:
  name: sandbox-<tenant-id>-<session-id>
  namespace: tenant-<tenant-id>
  labels:
    openclaw.io/component: sandbox
    openclaw.io/tenant: <tenant-id>
spec:
  runtimeClassName: kata-mshv-vm-isolation    # VM-level isolation
  restartPolicy: Never
  activeDeadlineSeconds: 300                   # Hard kill after 5 min
  serviceAccountName: openclaw-<tenant-id>-sandbox   # Minimal SA, no Key Vault access
  securityContext:
    runAsNonRoot: true
    runAsUser: 65534       # nobody
  containers:
    - name: sandbox
      image: <acr>.azurecr.io/openclaw-sandbox:latest
      command: ["/bin/sh", "-c", "<tool-command>"]
      resources:
        limits:
          cpu: "1"
          memory: "512Mi"
          ephemeral-storage: "1Gi"
      securityContext:
        readOnlyRootFilesystem: true
        allowPrivilegeEscalation: false
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: scratch
          mountPath: /tmp
  volumes:
    - name: scratch
      emptyDir:
        medium: Memory
        sizeLimit: "256Mi"
  # No PVC mounts — sandbox has no access to tenant state/workspace/secrets
```

#### Per-Tier Sandbox Isolation

| Capability | Free | Pro | Enterprise |
|---|---|---|---|
| Sandbox runtime | Kata (shared sandbox pool) | Kata (shared sandbox pool) | Kata (dedicated sandbox pool or Confidential VM) |
| Sandbox timeout | 30s | 120s | 300s |
| Sandbox memory | 256 MB | 512 MB | 2 GB |
| Concurrent sandboxes | 1 | 3 | 10 |
| Sandbox network access | None | Allowlisted domains | Custom allowlist per skill |

### 4.2 Network Isolation

```
                        Internet
                           │
                    ┌──────▼──────┐
                    │   Ingress   │
                    │   (TLS)     │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼────┐ ┌────▼─────┐ ┌────▼─────┐
        │ Tenant A │ │ Tenant B │ │ Tenant C │
        │ Network  │ │ Network  │ │ Network  │
        │ (VLAN/   │ │ (VLAN/   │ │ (VLAN/   │
        │  netns)  │ │  netns)  │ │  netns)  │
        └──────────┘ └──────────┘ └──────────┘
         No lateral    No lateral    No lateral
         traffic       traffic       traffic
```

- **Network policies** deny all inter-tenant traffic (default-deny)
- Each tenant's Gateway binds to `127.0.0.1:18789` inside its own network namespace
- Outbound traffic is restricted to:
  - LLM provider APIs (OpenAI, Anthropic, etc.) — via allowlisted egress
  - Channel APIs (Telegram, Discord, Slack, WhatsApp) — via allowlisted egress
  - Secrets Manager endpoint (mTLS)
- No direct internet-inbound to tenant containers; all traffic flows through Application Gateway for Containers (AGC)

### 4.3 Filesystem Isolation

```
/tenants/
├── <tenant-id>/                    # Per-tenant root (encrypted volume)
│   ├── .openclaw/
│   │   ├── openclaw.json           # Tenant config (secrets redacted, ref to vault)
│   │   ├── credentials/            # Channel creds (encrypted at rest)
│   │   ├── sessions/               # Conversation history
│   │   └── workspace/
│   │       ├── AGENTS.md
│   │       ├── SOUL.md
│   │       └── skills/
│   └── sandbox/                    # Per-session sandbox mounts
└── <tenant-id>/
    └── ...
```

- Each tenant volume is **encrypted at rest** (LUKS or cloud-provider disk encryption)
- Volumes are mounted with `noexec,nosuid,nodev` where applicable
- Sandbox directories for tool execution are ephemeral (tmpfs or short-lived volumes)
- The gateway container uses `readOnlyRootFilesystem: false` when agent-browser is enabled (Chrome requires writable paths — see §4.1 for details)

### 4.4 Sandbox Enforcement

OpenClaw already supports Docker-based sandboxing for non-main sessions. In multi-tenant mode, **all sessions run sandboxed**:

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "always",           // Force sandbox for ALL sessions
        "image": "ghcr.io/openclaw/openclaw:latest",
        "networkMode": "none",      // No network in tool sandbox
        "readOnlyRootFilesystem": true,
        "memoryLimit": "512m",
        "pidLimit": 100
      }
    }
  }
}
```

### 4.5 Persistent Storage Architecture

Kubernetes pods are ephemeral — they can be rescheduled to a different node at any time (node failure, scale-down, rolling upgrade, spot eviction). **All OpenClaw instance state must survive pod rescheduling** without data loss.

#### 4.5.1 OpenClaw State Inventory

OpenClaw stores all persistent state under `$OPENCLAW_STATE_DIR` (default `~/.openclaw`) and a workspace directory. The full inventory of state that must survive pod lifecycle:

| Criticality | Data | Path (inside container) | Description |
|---|---|---|---|
| **Critical** | Main config | `.openclaw/openclaw.json` | Tenant config (models, channels, agent defaults, skills) |
| **Critical** | Workspace identity files | `workspace/AGENTS.md`, `SOUL.md`, `USER.md`, `IDENTITY.md`, `TOOLS.md` | Agent personality, user profile, operating instructions |
| **Critical** | Long-term memory | `workspace/MEMORY.md`, `workspace/memory/*.md` | Curated memory + daily memory logs |
| **Critical** | Session transcripts | `.openclaw/agents/<id>/sessions/*.jsonl` | Conversation history (JSONL per session) |
| **Critical** | Auth credentials | `.openclaw/credentials/`, `.openclaw/agents/<id>/agent/auth-profiles.json` | OAuth tokens, API keys, WhatsApp creds |
| **Critical** | Channel state | `.openclaw/telegram/`, `.openclaw/matrix/`, `.openclaw/msteams/` | Per-channel binding state, encryption keys (Matrix E2E) |
| **Important** | Installed skills | `.openclaw/skills/`, `workspace/skills/` | Managed + workspace-level skill code and configs |
| **Important** | Installed plugins | `.openclaw/extensions/<pluginId>/` | Plugin code + dependencies |
| **Important** | Installed hooks | `.openclaw/hooks/<hookId>/` | Hook handler code |
| **Important** | Cron state | `.openclaw/cron/jobs.json`, `.openclaw/cron/runs/` | Scheduled jobs + execution history |
| **Important** | Exec approvals | `.openclaw/exec-approvals.json` | Per-agent tool execution allowlists |
| **Important** | Subagent registry | `.openclaw/subagents/runs.json` | Sub-agent state |
| **Important** | Canvas files | `workspace/canvas/` | Canvas UI artifacts |
| **Important** | OpenProse state | `workspace/.prose/` | Prose program runs, bindings, agent memory (SQLite) |
| **Rebuildable** | Memory search index | `.openclaw/memory/<agentId>.sqlite` | SQLite + sqlite-vec vectors (rebuild via `openclaw memory index`) |
| **Rebuildable** | QMD index | `.openclaw/agents/<id>/qmd/xdg-cache/qmd/index.sqlite` | QMD memory index |
| **Rebuildable** | LanceDB vectors | `.openclaw/memory/lancedb/` | Vector DB (if memory-lancedb extension active) |
| **Rebuildable** | Plugin catalogs | `.openclaw/mpm/`, `.openclaw/plugins/catalog.json` | External channel catalog metadata |
| **Ephemeral** | Logs | `/tmp/openclaw/openclaw-*.log` | Rolling 24h log files (500 MB cap) |
| **Ephemeral** | Gateway lock | `os.tmpdir()/openclaw-*/gateway.*.lock` | Singleton lock file |
| **Ephemeral** | Sandbox tmpfs | `/tmp`, `/var/tmp`, `/run` | Sandbox ephemeral mounts |

#### 4.5.2 Volume Architecture

Each tenant gets **two Persistent Volume Claims (PVCs)** backed by Azure Managed Disks, plus a tmpfs for ephemeral data:

```
┌─────────────────────────────────────────────────────────────────────┐
│  Tenant Pod (StatefulSet — ordinal 0)                               │
│                                                                     │
│  ┌─────────────────────────────────────┐                            │
│  │  Container: openclaw-gateway        │                            │
│  │  OPENCLAW_STATE_DIR=/data/state     │                            │
│  │  Workspace: /data/workspace         │                            │
│  └───────────┬─────────────┬───────────┘                            │
│              │             │                                        │
│  ┌───────────▼──────┐ ┌───▼────────────┐  ┌──────────────────────┐ │
│  │  PVC: state-vol   │ │ PVC: work-vol  │  │ emptyDir (tmpfs)     │ │
│  │  Azure Premium SSD│ │ Azure Premium  │  │ /tmp, /var/tmp       │ │
│  │  ZRS / LRS        │ │ SSD ZRS / LRS  │  │ ephemeral only       │ │
│  │                   │ │                │  │                      │ │
│  │  /data/state/     │ │ /data/workspace│  │ Logs, locks,         │ │
│  │  ├── openclaw.json│ │ ├── AGENTS.md  │  │ sandbox scratch      │ │
│  │  ├── credentials/ │ │ ├── SOUL.md    │  │                      │ │
│  │  ├── agents/      │ │ ├── USER.md    │  └──────────────────────┘ │
│  │  ├── sessions/    │ │ ├── MEMORY.md  │                           │
│  │  ├── skills/      │ │ ├── memory/    │  ┌──────────────────────┐ │
│  │  ├── extensions/  │ │ ├── skills/    │  │ Secret Volume (CSI)  │ │
│  │  ├── hooks/       │ │ ├── canvas/    │  │ /mnt/secrets/        │ │
│  │  ├── cron/        │ │ └── .prose/    │  │ (Key Vault refs)     │ │
│  │  ├── telegram/    │ │                │  └──────────────────────┘ │
│  │  ├── matrix/      │ └────────────────┘                           │
│  │  └── msteams/     │                                              │
│  └───────────────────┘                                              │
└─────────────────────────────────────────────────────────────────────┘
```

#### 4.5.3 StatefulSet Configuration

Tenant pods are deployed as **StatefulSets** (not Deployments) to guarantee stable persistent volume bindings across rescheduling:

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: openclaw-${TENANT_ID}
  namespace: tenant-${TENANT_ID}
  labels:
    app.kubernetes.io/name: openclaw
    app.kubernetes.io/instance: ${TENANT_ID}
    openclaw.io/tier: ${TIER}
spec:
  replicas: 1
  serviceName: openclaw-${TENANT_ID}
  podManagementPolicy: OrderedReady
  updateStrategy:
    type: RollingUpdate
  selector:
    matchLabels:
      app.kubernetes.io/name: openclaw
      app.kubernetes.io/instance: ${TENANT_ID}
  template:
    metadata:
      labels:
        app.kubernetes.io/name: openclaw
        app.kubernetes.io/instance: ${TENANT_ID}
    spec:
      terminationGracePeriodSeconds: 30
      serviceAccountName: openclaw-${TENANT_ID}   # Workload Identity
      securityContext:
        runAsUser: 1000      # node user
        runAsGroup: 1000
        fsGroup: 1000        # PVC files owned by node:node
        fsGroupChangePolicy: OnRootMismatch
      containers:
        - name: openclaw-gateway
          image: <acr>.azurecr.io/openclaw-custom:2026.3.12   # Custom image with agent-browser/Chrome
          command: ["/bin/sh", "-c"]
          args:
            - |
              ln -sfn /opt/agent-browser /home/node/.agent-browser
              exec openclaw gateway --bind lan --allow-unconfigured
          env:
            - name: OPENCLAW_STATE_DIR
              value: /data/state
            - name: OPENCLAW_CONFIG_PATH
              value: /data/state/openclaw.json
            - name: AGENT_BROWSER_HOME
              value: /opt/agent-browser
          volumeMounts:
            - name: state-vol
              mountPath: /data/state
            - name: work-vol
              mountPath: /data/workspace
            - name: secrets
              mountPath: /mnt/secrets
              readOnly: true
            - name: ephemeral
              mountPath: /tmp
            - name: ephemeral
              mountPath: /var/tmp
          resources:
            limits:
              cpu: "2"
              memory: "4Gi"
            requests:
              cpu: "500m"
              memory: "1Gi"
          securityContext:
            readOnlyRootFilesystem: false       # Required for agent-browser/Chrome (see §4.1 exception)
            allowPrivilegeEscalation: false
            seccompProfile:
              type: Unconfined                  # Chrome subprocess management requires unrestricted syscalls
            capabilities:
              drop: ["ALL"]
      volumes:
        - name: secrets
          csi:
            driver: secrets-store.csi.k8s.io
            readOnly: true
            volumeAttributes:
              secretProviderClass: openclaw-${TENANT_ID}
        - name: ephemeral
          emptyDir:
            medium: Memory      # tmpfs — cleared on pod restart
            sizeLimit: 2Gi
  volumeClaimTemplates:
    - metadata:
        name: state-vol
        labels:
          openclaw.io/tenant: ${TENANT_ID}
          openclaw.io/volume-type: state
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: managed-premium-zrs   # Azure Premium SSD v2, ZRS
        resources:
          requests:
            storage: ${STATE_STORAGE}           # 2Gi (Free), 20Gi (Pro), 100Gi (Enterprise)
    - metadata:
        name: work-vol
        labels:
          openclaw.io/tenant: ${TENANT_ID}
          openclaw.io/volume-type: workspace
      spec:
        accessModes: ["ReadWriteOnce"]
        storageClassName: managed-premium-zrs
        resources:
          requests:
            storage: ${WORKSPACE_STORAGE}       # 3Gi (Free), 30Gi (Pro), 400Gi (Enterprise)
```

**Why StatefulSet over Deployment:**

| Concern | Deployment | StatefulSet |
|---------|-----------|-------------|
| Stable PVC binding | PVC released on scale-down; must re-claim | PVC permanently bound to pod ordinal |
| Pod identity | Random pod name on each reschedule | Stable name (`openclaw-<tenant>-0`) |
| Ordered startup | No guarantee | Ordered, avoids split-brain on shared state |
| Volume lifecycle | PVC deleted with Deployment (unless manually managed) | PVC persists independently — survives pod deletion |
| Rolling update | Old pod killed → new pod may start before PVC detaches | Old pod drained → PVC detaches → new pod attaches |

#### 4.5.4 Storage Classes

| Storage Class | Azure Disk Type | Replication | Use Case | IOPS |
|---|---|---|---|---|
| `managed-premium-zrs` | Premium SSD v2 (ZRS) | 3 AZ copies | Pro / Enterprise (default) | Up to 80,000 |
| `managed-premium-lrs` | Premium SSD v2 (LRS) | 3 copies, single AZ | Free tier (cost optimization) | Up to 80,000 |
| `managed-standard-zrs` | Standard SSD (ZRS) | 3 AZ copies | Archived tenants (cold storage) | Up to 6,000 |

All storage classes enforce:
- **Encryption at rest**: Azure Disk Encryption (platform-managed keys by default; customer-managed keys via Key Vault for Enterprise tier)
- **reclaim policy**: `Retain` — PVCs are never auto-deleted; explicit cleanup during tenant deletion (§10)
- **allowVolumeExpansion**: `true` — PVCs can be resized without pod restart

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: managed-premium-zrs
provisioner: disk.csi.azure.com
parameters:
  skuName: PremiumV2_ZRS
  cachingMode: None
  DiskIOPSReadWrite: "3000"
  DiskMBpsReadWrite: "125"
reclaimPolicy: Retain
allowVolumeExpansion: true
volumeBindingMode: WaitForFirstConsumer    # Bind to pod's AZ
```

#### 4.5.5 Storage Quotas by Tier

| Resource | Free | Pro | Enterprise |
|---|---|---|---|
| State volume | 2 Gi | 20 Gi | 100 Gi |
| Workspace volume | 3 Gi | 30 Gi | 400 Gi |
| Total persistent storage | 5 Gi | 50 Gi | 500 Gi |
| IOPS (state + workspace) | 500 | 3,000 | 10,000 |
| Throughput | 25 MBps | 125 MBps | 500 MBps |
| Disk encryption | Platform-managed key | Platform-managed key | Customer-managed key (Key Vault) |
| Replication | LRS | ZRS | ZRS |

Enforced via **Azure Disk IOPS/throughput parameters** on the StorageClass and **Kubernetes ResourceQuotas** on the namespace:

```yaml
apiVersion: v1
kind: ResourceQuota
metadata:
  name: storage-quota
  namespace: tenant-${TENANT_ID}
spec:
  hard:
    requests.storage: ${TOTAL_STORAGE}        # 5Gi / 50Gi / 500Gi
    persistentvolumeclaims: "3"               # state + workspace + 1 spare
```

#### 4.5.6 Data Durability During Pod Lifecycle Events

| Event | What Happens to Data | Recovery |
|---|---|---|
| **Pod restart** (CrashLoopBackOff, OOM) | PVC stays attached to node; pod remounts same PVC | Automatic — same PVC, same data |
| **Pod rescheduled** (node drain, spot eviction) | PVC detaches from old node, reattaches on new node | Automatic — StatefulSet controller waits for PVC reattach (30–120 s for Azure Disk) |
| **Node failure** (VM crash) | AKS detects unhealthy node (5 min timeout); pod rescheduled | Automatic — PVC (ZRS) is available from any AZ; attach to new node |
| **AZ failure** | ZRS disks remain accessible via surviving AZs | Automatic — pod scheduled to healthy AZ node |
| **Rolling update** (OpenClaw version upgrade) | Old pod terminates gracefully (30 s grace period); PVC detaches; new pod attaches same PVC | Automatic — zero data loss |
| **Tenant suspension** | Pod scaled to 0 replicas; PVCs remain bound (no deletion) | Manual — scale back to 1 on reactivation |
| **Tenant deletion** | Crypto-shred KEK in Key Vault → PVC data unreadable; PVC deleted after retention period | Irreversible by design (GDPR §10) |

#### 4.5.7 Graceful Shutdown & State Consistency

OpenClaw must flush in-flight state before the pod terminates. The `terminationGracePeriodSeconds: 30` gives the process time to:

1. **Receive SIGTERM** — Kubernetes sends the signal
2. **Drain active sessions** — complete current LLM streaming responses (or save checkpoint)
3. **Flush session JSONL** — ensure last messages are written to disk
4. **Flush cron state** — persist `jobs.json` and any pending run logs
5. **Close channel connections** — graceful WebSocket/API disconnect
6. **Sync filesystem** — `fsync` on critical files

The platform adds a **preStop hook** to give OpenClaw time:

```yaml
lifecycle:
  preStop:
    exec:
      command:
        - /bin/sh
        - -c
        - "kill -SIGTERM 1 && sleep 25"   # Signal openclaw, wait for flush
```

If OpenClaw does not exit within 30 seconds, Kubernetes sends SIGKILL. Data written to the PVC before SIGKILL is preserved (kernel flushes dirty pages on unmount).

#### 4.5.8 Memory Index Rebuild on Startup

The SQLite-based memory search indexes (`memory/<agentId>.sqlite`, `qmd/index.sqlite`) and optional LanceDB vector store are **rebuildable** from the source-of-truth markdown files in the workspace. On pod startup, an init container checks index freshness:

```yaml
initContainers:
  - name: memory-index-check
    image: ghcr.io/openclaw/openclaw:0.9.28
    command:
      - /bin/sh
      - -c
      - |
        # Compare index mtime with newest workspace/memory/*.md
        INDEX="/data/state/memory/default.sqlite"
        LATEST_MD=$(find /data/workspace/memory -name '*.md' -newer "$INDEX" 2>/dev/null | head -1)
        if [ -n "$LATEST_MD" ] || [ ! -f "$INDEX" ]; then
          echo "Memory index stale or missing — rebuilding..."
          openclaw memory index --state-dir /data/state --workspace /data/workspace
        else
          echo "Memory index is up to date."
        fi
    volumeMounts:
      - name: state-vol
        mountPath: /data/state
      - name: work-vol
        mountPath: /data/workspace
```

This ensures the index is always consistent without requiring the index itself to be treated as critical data.

#### 4.5.9 Backup Strategy for Persistent Volumes

PVC backups complement the DR strategy (§14) with OpenClaw-aware granularity:

| Backup Target | Method | Frequency | Retention | RTO |
|---|---|---|---|---|
| State volume | Azure Disk snapshot (incremental) | Every 6 hours | 30 days | < 15 min (create disk from snapshot) |
| Workspace volume | Azure Disk snapshot (incremental) | Every 6 hours | 30 days | < 15 min |
| Session transcripts | Stream to Azure Blob (JSONL append) | Near-real-time | 1 year (WORM) | < 5 min (restore from blob) |
| Workspace memory/*.md | Git-sync to Azure Repos (per-tenant) | On every write | Full history | < 1 min (git clone) |
| Config (openclaw.json) | Config audit log (§19) + blob backup | On change | 1 year | < 1 min |
| Channel creds | Key Vault versioning (§6) | On rotation | 90 days | Immediate (Key Vault restore) |

**Incremental snapshots** mean only changed blocks are stored — cost-efficient for the many small files in `.openclaw/`.

For workspace memory files (`MEMORY.md`, `memory/*.md`), an optional **git-sync sidecar** provides version history beyond what disk snapshots offer:

```yaml
containers:
  - name: workspace-git-sync
    image: registry.k8s.io/git-sync/git-sync:v4
    args:
      - --repo=https://dev.azure.com/platform/tenant-backups/_git/${TENANT_ID}-workspace
      - --root=/data/workspace
      - --period=300s           # Sync every 5 minutes
      - --one-time=false
      - --ssh=false
      - --credential=managed-identity
    volumeMounts:
      - name: work-vol
        mountPath: /data/workspace
        readOnly: true          # git-sync reads, never writes
```

---

## 5. Authentication & Authorization

### 5.1 Tenant Admin Authentication

```
Tenant Admin ──► OIDC/SAML IdP ──► Control Plane API ──► Tenant Resources
                                       │
                                       ▼
                                  RBAC Policy Engine
```

- **SSO via OIDC/SAML** for tenant administrators
- **MFA required** for all admin operations
- **API keys** (rotatable, scoped) for programmatic access
- **Short-lived tokens** (JWT, 15-minute expiry) for session-based access

### 5.2 RBAC Model

| Role | Permissions |
|---|---|
| `tenant:owner` | Full access to their tenant: config, secrets, channels, billing |
| `tenant:admin` | Manage config, channels, skills. Cannot access raw credentials |
| `tenant:viewer` | Read-only dashboard, session history (redacted) |
| `platform:operator` | Manage tenant lifecycle, view metrics. **Cannot** access tenant secrets or conversations |
| `platform:security` | View audit logs, trigger incident response. **Cannot** access tenant data |

### 5.3 Channel-Level Access Control

Leverage OpenClaw's existing DM security model per tenant:

```jsonc
{
  "channels": {
    "telegram": {
      "dmPolicy": "pairing",         // Require pairing code for new senders
      "allowFrom": ["123456789"]      // Tenant-managed allowlist
    },
    "discord": {
      "dmPolicy": "pairing",
      "allowFrom": ["user-id-1"]
    },
    "slack": {
      "dmPolicy": "pairing",
      "allowFrom": ["U0123ABCD"]
    }
  }
}
```

- **Default DM policy: `pairing`** — never `open` unless tenant explicitly opts in with risk acknowledgment
- `openclaw doctor` run periodically to flag risky DM policies

---

## 6. Credential & Secrets Management

### 6.1 Envelope Encryption

```
┌──────────────────────────────────────────────┐
│           Azure Key Vault (Premium)           │
│  ┌──────────────────────────────────────┐     │
│  │  Master Key (HSM-protected, FIPS     │     │
│  │  140-2 Level 3, never exported)      │     │
│  └──────────┬───────────────────────────┘     │
│             │                                 │
│  ┌──────────▼───────────────────────────┐     │
│  │  Per-Tenant KEK (encrypted by MK)    │     │
│  └──────────┬───────────────────────────┘     │
└─────────────┼─────────────────────────────────┘
              │
   ┌──────────▼───────────────────────────┐
   │  Per-Secret DEK (encrypted by KEK)   │
   │  ─────────────────────────────────   │
   │  TELEGRAM_BOT_TOKEN = enc(...)       │
   │  OPENAI_API_KEY = enc(...)           │
   │  DISCORD_BOT_TOKEN = enc(...)        │
   └──────────────────────────────────────┘
```

- **Master Key** held in Azure Key Vault HSM — FIPS 140-2 Level 3, never exported
- **Per-Tenant Key Encryption Key (KEK)** — derived per tenant, rotatable via Key Vault key rotation policy
- **Data Encryption Keys (DEK)** — per-secret, wrapped by KEK
- Secrets decrypted **only in-memory** inside the tenant's container at runtime via Workload Identity + CSI driver
- Operator access to Key Vault is logged via Azure Monitor diagnostic settings and alertable via Sentinel

### 6.2 Secret Injection

Secrets are injected via:
1. **Environment variables** (for LLM API keys) — mounted from Secrets Manager at container start
2. **Volume-mounted credential files** (for channel creds like WhatsApp/Baileys sessions) — decrypted at mount time, tmpfs-backed

```yaml
# Secrets injected via AKS Secrets Store CSI Driver
# SecretProviderClass references Azure Key Vault
apiVersion: secrets-store.csi.x-k8s.io/v1
kind: SecretProviderClass
metadata:
  name: tenant-abc123-secrets
  namespace: tenant-abc123
spec:
  provider: azure
  parameters:
    usePodIdentity: "false"
    useVMManagedIdentity: "false"
    clientID: "<tenant-workload-identity-client-id>"
    keyvaultName: "kv-tenant-abc123"
    tenantId: "<entra-tenant-id>"
    objects: |
      array:
        - |
          objectName: openai-api-key
          objectType: secret
        - |
          objectName: telegram-bot-token
          objectType: secret
  secretObjects:
    - secretName: tenant-abc123-env
      type: Opaque
      data:
        - objectName: openai-api-key
          key: OPENAI_API_KEY
        - objectName: telegram-bot-token
          key: TELEGRAM_BOT_TOKEN
```

### 6.3 Key Rotation

- Tenant API keys: **automatic rotation every 90 days** (Azure Key Vault rotation policy)
- Channel bot tokens: **on-demand rotation** via control plane → Key Vault API
- KEKs: **annual rotation** with re-wrapping of DEKs (Key Vault key rotation + Event Grid notification)
- Rotation is non-disruptive (dual-key window, CSI driver auto-refreshes mounted secrets)

---

## 7. Ingress & Routing

### 7.1 Webhook Routing

Channel platforms (Telegram, Slack, Discord) send webhooks to a shared endpoint. Application Gateway for Containers (AGC) routes via Gateway API HTTPRoute rules:

```
Telegram API ──► https://gw.example.com/webhook/telegram/<tenant-id>
Slack API    ──► https://gw.example.com/webhook/slack/<tenant-id>
Discord API  ──► https://gw.example.com/webhook/discord/<tenant-id>
```

- **Tenant ID in the webhook path** — registered with each channel platform per tenant
- **HMAC/signature verification** at the ingress layer before forwarding to tenant
- Rate limiting per tenant at ingress (prevent abuse of one tenant affecting others)

### 7.2 WebSocket Routing

For the Control UI, WebChat, and device nodes:

```
wss://gw.example.com/ws/<tenant-id>
    │
    ├── Auth: Bearer <tenant-jwt>
    ├── Verify tenant-id matches JWT claims
    └── Proxy to tenant Gateway ws://127.0.0.1:18789 (in tenant netns)
```

### 7.3 TLS Termination

- TLS 1.3 at ingress (no TLS 1.0/1.1)
- Per-tenant subdomain option: `<tenant-id>.gw.example.com` with wildcard cert
- mTLS between ingress and tenant Gateways (internal network)

---

## 8. Resource Governance

### 8.1 Quotas & Limits

| Resource | Free Tier | Pro Tier | Enterprise |
|---|---|---|---|
| CPU | 0.5 vCPU | 2 vCPU | 8 vCPU |
| Memory | 1 GB | 4 GB | 16 GB |
| Storage | 5 GB | 50 GB | 500 GB |
| Channels | 2 | 10 | Unlimited |
| Sessions (concurrent) | 5 | 50 | 500 |
| LLM API calls/day | 100 | 10,000 | Unlimited |
| Sandbox exec time/call | 30s | 120s | 300s |
| Skills (installed) | 5 | 50 | Unlimited |

### 8.2 Rate Limiting

```
Ingress Layer:
  - Per-tenant: 100 req/min (webhook), 10 ws connections
  - Per-IP: 50 req/min (brute-force protection)
  - Global: circuit breaker at 80% platform capacity

Tenant Layer:
  - LLM API proxy: token bucket per tenant
  - Tool execution: concurrent limit per tenant
  - Browser control: 1 concurrent browser per tenant (Free), 3 (Pro)
```

### 8.3 Noisy Neighbor Protection

- **CPU throttling** via cgroups (hard limits, not just requests)
- **I/O bandwidth limits** per tenant volume
- **Network bandwidth limits** via tc/eBPF per tenant namespace
- **OOM killer integration** — tenant container killed, not host processes

---

## 9. Audit & Observability

### 9.1 Audit Events

All security-relevant events are emitted to an append-only audit log:

| Event | Data Captured |
|---|---|
| `tenant.created` | Tenant ID, admin identity, timestamp |
| `tenant.suspended` | Tenant ID, reason, actor |
| `secret.accessed` | Tenant ID, secret name, accessor identity |
| `secret.rotated` | Tenant ID, secret name, rotation type |
| `channel.connected` | Tenant ID, channel type, timestamp |
| `dm.pairing.approved` | Tenant ID, channel, sender ID |
| `sandbox.exec` | Tenant ID, session ID, tool name, duration |
| `auth.login` | Tenant ID, user, IP, MFA method |
| `auth.failed` | Tenant ID, user, IP, failure reason |
| `config.changed` | Tenant ID, changed keys (values redacted), actor |
| `ingress.ratelimited` | Tenant ID, endpoint, rate |

### 9.2 Log Architecture

```
Tenant Containers ──► Fluentd/Vector (sidecar) ──► Log Aggregator
                                                      │
                                                      ├── Tenant logs (partitioned by tenant-id)
                                                      │   └── Searchable by tenant admin (their data only)
                                                      │
                                                      └── Platform audit logs
                                                          └── Searchable by platform:security role only
```

- **Tenant log isolation** — tenants can only query their own logs (Log Analytics workspace RBAC)
- **PII redaction** — conversation content is NOT sent to platform logs; only metadata. Purview DLP scans enforce redaction before log write
- **Retention** — audit logs: 1 year minimum; tenant logs: configurable per tier
- **Tamper protection** — Azure Blob immutability policies (WORM) with integrity checksums
- **SIEM correlation** — Microsoft Sentinel ingests logs from Defender, Purview DLP, Entra ID, and Key Vault for unified threat detection

### 9.3 Monitoring & Alerting

| Alert | Condition | Severity |
|---|---|---|
| Container escape attempt | Seccomp/AppArmor violation | Critical |
| Cross-tenant network access | Network policy deny log | Critical |
| DLP: credentials sent to LLM | Purview DLP block on LLM proxy intercept | Critical |
| Secret access anomaly | Unusual secret access pattern | High |
| Auth brute force | > 10 failed logins in 5 min | High |
| DLP: bulk PII detected | Purview DLP high-volume PII classification | High |
| Tenant resource exhaustion | > 90% of quota sustained 15 min | Medium |
| DM policy set to open | `dmPolicy` changed to `open` | Medium |
| DLP: PII in session logs | Purview scan of persisted sessions | Medium |
| Certificate expiry | < 14 days to expiry | Medium |

---

## 10. Tenant Lifecycle

### 10.1 Provisioning Flow

```
1. Tenant signs up ──► Create tenant record in Registry
2. Provision KEK   ──► Generate per-tenant KEK in KMS
3. Create namespace ──► Isolated network namespace + storage volume
4. Deploy Gateway   ──► Pull OpenClaw image, inject config template
5. Setup channels   ──► Tenant provides bot tokens → encrypted → stored in Vault
6. Health check     ──► `openclaw doctor` validates configuration
7. Activate         ──► Ingress routes enabled, webhooks registered
```

### 10.2 Suspension

When a tenant is suspended (billing, abuse, security incident):

1. Ingress routes removed (webhooks return 503)
2. Gateway process SIGTERMed (graceful shutdown)
3. Container stopped (not destroyed — data preserved)
4. Credentials remain encrypted at rest
5. Audit event emitted

### 10.3 Deletion

When a tenant requests deletion (GDPR/right to erasure):

1. Suspend tenant (above)
2. Export data to tenant if requested (encrypted archive)
3. **Crypto-shred**: delete per-tenant KEK from KMS → all DEK-wrapped secrets become irrecoverable
4. Destroy container, volumes, and namespace
5. Purge tenant logs after retention period
6. Remove tenant record from Registry
7. Audit event emitted (retained separately per compliance)

---

## 11. Agent Warden Server

The Agent Warden Server is the security brain of the platform, exposed as an MCP tool server that the control plane and tenant Gateways can invoke.

### 11.1 Tools Provided

| MCP Tool | Purpose |
|---|---|
| `warden.policy.evaluate` | Evaluate if a tenant action is permitted by current policy |
| `warden.tenant.provision` | Trigger secure tenant provisioning workflow |
| `warden.tenant.suspend` | Suspend a tenant with reason and audit trail |
| `warden.secret.rotate` | Initiate credential rotation for a tenant |
| `warden.audit.query` | Query audit logs (scoped to caller's permissions) |
| `warden.health.check` | Run security health checks across all tenants |
| `warden.network.verify` | Verify network isolation between tenants |
| `warden.alert.acknowledge` | Acknowledge and annotate a security alert |

### 11.2 Policy Engine

Policies defined as declarative rules:

```jsonc
{
  "policies": [
    {
      "name": "enforce-sandbox-all-sessions",
      "effect": "deny",
      "condition": "tenant.config.agents.defaults.sandbox.mode != 'always'",
      "action": "config.update",
      "message": "Multi-tenant deployments require sandbox mode 'always'"
    },
    {
      "name": "deny-open-dm-policy",
      "effect": "warn",
      "condition": "tenant.config.channels.*.dmPolicy == 'open'",
      "action": "channel.configure",
      "message": "Open DM policy is discouraged in shared hosting"
    },
    {
      "name": "enforce-credential-rotation",
      "effect": "enforce",
      "condition": "tenant.secret.age > 90d",
      "action": "secret.access",
      "message": "Credentials older than 90 days must be rotated"
    }
  ]
}
```

---

## 12. Deployment Topology

### 12.1 Option A: Azure Kubernetes Service (Recommended)

```
┌─────────────────────────────────────────────────────────────────────┐
│  AKS Cluster (Azure CNI + Calico NetworkPolicy)                     │
│  Microsoft Defender for Containers enabled                          │
│                                                                     │
│  Namespace: agent-warden-control                                        │
│  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐          │
│  │ Sentinel    │ │ ALB Ctrl     │ │ Provisioning         │          │
│  │ MCP Server  │ │ (Gateway API)│ │ Operator (CRD-based) │          │
│  └─────────────┘ └──────────────┘ └──────────────────────┘          │
│  Node pool: system (runc) — full Defender eBPF visibility           │
│                                                                     │
│  Namespace: tenant-<id-a>           NetworkPolicy: deny-all         │
│  ┌──────────────────────────────┐   + allow ingress from            │
│  │ Pod: openclaw-gateway        │     agent-warden-control              │
│  │ Sidecar: llm-dlp-proxy      │                                   │
│  │ PVC: Azure Disk (encrypted)  │   Workload Identity:             │
│  │ CSI SecretStore: Key Vault   │     tenant-<id-a>-identity       │
│  └──────────────────────────────┘                                   │
│  Node pool: tenant (runc) — full Defender eBPF visibility           │
│                                                                     │
│  ┌──────────────────────────────┐                                   │
│  │ Pod: sandbox-<id>-<session>  │   RuntimeClass:                   │
│  │ (ephemeral tool execution)   │     kata-mshv-vm-isolation        │
│  │ No PVCs, no secrets access   │   Hyper-V microVM isolation       │
│  └──────────────────────────────┘                                   │
│  Node pool: sandbox (Kata) — Defender K8s audit + image scan only   │
└─────────────────────────────────────────────────────────────────────┘
│                          │                           │
▼                          ▼                           ▼
Azure Key Vault        Azure Monitor              Microsoft Purview
(per-tenant secrets)   (Log Analytics +           (DLP scanning +
                        Sentinel SIEM)             data classification)
```

- **AKS** with Azure CNI for VNET-integrated pod networking and Calico for NetworkPolicy
- **Three node pools**: system (runc), tenant (runc), sandbox (Kata) — see §4.1.1 for hybrid architecture rationale
- **CRD: `OpenClawTenant`** — declarative tenant resource managed by a custom Kubernetes Operator
- **Azure Workload Identity** per tenant namespace — keyless access to Key Vault (replaces Vault Agent sidecar)
- **Secrets Store CSI Driver** for Azure Key Vault — mounts secrets as volumes, auto-rotation
- **Microsoft Defender for Containers** — full runtime eBPF monitoring on system + tenant pools; K8s audit + image scanning on sandbox pool
- **Azure Policy (Gatekeeper)** — enforce PodSecurityStandard: Restricted cluster-wide
- **NetworkPolicy** per namespace — deny all except ingress from control plane
- **Kata Containers** on sandbox pool — tool execution pods run inside Hyper-V microVMs, preventing kernel-level escape even if the sandbox container is compromised

### 12.2 Option B: Azure Confidential VMs (Higher Isolation)

For tenants requiring maximum isolation (enterprise/compliance):

- Each tenant gets a **dedicated Azure Confidential VM** (AMD SEV-SNP or Intel TDX)
- Hardware-based TEE (Trusted Execution Environment) — data encrypted in use, not just at rest/transit
- Host-level isolation eliminates shared-kernel risks
- Azure Attestation Service verifies VM integrity before secret release
- Higher cost, suitable for regulated industries (healthcare, finance)

---

## 13. Compliance Considerations

| Requirement | How Addressed | Azure Service |
|---|---|---|
| **GDPR / Right to Erasure** | Crypto-shred via KEK deletion; data export API | Azure Key Vault (key purge), Purview Data Map |
| **SOC 2 Type II** | Audit logging, access controls, encryption at rest/transit | Microsoft Defender for Cloud (regulatory compliance dashboard) |
| **HIPAA** (if applicable) | VM-based isolation, BAA support, encrypted PHI | Azure Confidential VMs, Azure BAA, Purview sensitivity labels |
| **Data Residency** | Per-tenant region selection for compute + storage | Azure region pinning, Azure Policy (allowed locations) |
| **PCI DSS** (if payment data) | No card data in OpenClaw; payment via external processor | N/A |
| **DLP / Data Classification** | Sensitive data detection in conversations, credentials, PII | Microsoft Purview DLP policies + sensitivity labels |

---

## 14. Disaster Recovery

| Scenario | RTO | RPO | Strategy |
|---|---|---|---|
| Single tenant container crash | < 1 min | 0 | AKS auto-restart via StatefulSet controller; PVC stays attached (§4.5.6) |
| Host node failure | < 5 min | 0 | AKS pod rescheduling to healthy node; PVC (ZRS) reattaches in 30–120 s (§4.5.6) |
| AZ failure | < 15 min | < 5 min | AKS zone-redundant node pools, Azure Disk ZRS (§4.5.4) |
| Region failure | < 1 hour | < 15 min | Azure Front Door failover to standby AKS cluster |
| Credential compromise | Immediate | N/A | Automated rotation via Key Vault + Agent Warden |

### 14.1 Backup Strategy

- **Tenant PVCs**: Azure Disk incremental snapshots every 6 hours; 30-day retention; GRS vault for cross-region — see §4.5.9 for full strategy
- **Workspace memory**: Git-sync sidecar to Azure Repos per tenant for version-level history (§4.5.9)
- **Session transcripts**: Streamed near-real-time to Azure Blob (WORM) for 1-year retention
- **Configuration**: GitOps-managed, versioned in Azure DevOps / GitHub; config audit log (§19)
- **Secrets**: Azure Key Vault with soft-delete + purge protection; KEKs replicated across Key Vault regions
- **Audit logs**: Replicated to Azure Blob Storage with immutability policies (WORM)
- **Rebuildable indexes**: Memory search SQLite and LanceDB indexes are not backed up — rebuilt on pod startup via init container (§4.5.8)

---

## 15. Microsoft Azure Solution Mapping

This section maps each architectural component to concrete Azure services.

### 15.1 Service-to-Component Mapping

| Design Component | Azure Service | SKU / Configuration | Why This Service |
|---|---|---|---|
| **Container Orchestration** | Azure Kubernetes Service (AKS) | Standard tier, Azure CNI + Calico | Native NetworkPolicy, Workload Identity, Defender integration |
| **Ingress / WAF** | Azure Application Gateway for Containers (AGC) + Azure Front Door | ALB (with WAF policy) / Premium | Gateway API-native L7 routing, WebSocket support, auto-scaling, WAF policy, global load balancing via Front Door |
| **Secrets Manager** | Azure Key Vault | Premium (HSM-backed) | FIPS 140-2 Level 3, per-tenant vaults or RBAC-scoped access |
| **Tenant Registry** | Azure Cosmos DB | Serverless or provisioned RU | Global distribution, low-latency reads for routing decisions |
| **Identity / Auth** | Microsoft Entra ID (Azure AD) | P2 (for Conditional Access, PIM) | OIDC/SAML SSO, MFA, Conditional Access, tenant org isolation |
| **Workload Identity** | AKS Workload Identity | Federated credentials per namespace | Keyless pod-to-Key Vault auth; no service principal secrets |
| **Container Registry** | Azure Container Registry | Premium (with geo-replication) | Private images, vulnerability scanning, content trust |
| **Tenant Storage** | Azure Disk (CSI) + Azure Files | Premium SSD, encryption with CMK | Per-tenant PVCs, encrypted at rest with customer-managed keys |
| **Log Aggregation** | Azure Monitor + Log Analytics | Per-tenant workspace or workspace-based RBAC | Tenant-scoped log access, KQL queries, 90-day hot retention |
| **SIEM / Threat Detection** | Microsoft Sentinel | Pay-as-you-go | Security analytics, automated incident response, Fusion ML |
| **Container Security** | Microsoft Defender for Containers | Plan enabled on subscription | Runtime threat detection, image scanning, Kubernetes audit |
| **Cloud Posture** | Microsoft Defender for Cloud | CSPM Plan 2 | Secure score, regulatory compliance, attack path analysis  |
| **Policy Enforcement** | Azure Policy + OPA Gatekeeper | Built-in + custom policies | Pod security standards, allowed registries, network constraints |
| **DLP / Data Governance** | Microsoft Purview | E5 or standalone DLP | Sensitive data classification, DLP policies, data lineage |
| **DNS / Certificates** | Azure DNS + Azure Key Vault certs | Standard | Wildcard certs for `*.gw.example.com`, auto-renewal |
| **DDoS Protection** | Azure DDoS Protection | Standard | Layer 3/4 protection for ingress public IPs |
| **Backup** | Azure Backup + AKS backup (preview) | GRS vault | Scheduled PVC snapshots, cross-region recovery |
| **CI/CD** | Azure DevOps / GitHub Actions | Standard | GitOps for tenant operator, image build pipelines |
| **Cost Management** | Azure Cost Management | Built-in | Per-tenant cost attribution via tags and resource groups |

### 15.2 Network Architecture on Azure

```
┌─────────────────────────────────────────────────────────────────┐
│  Azure Virtual Network (hub-spoke)                               │
│                                                                  │
│  ┌──────────────────────────────────────┐                        │
│  │  Hub VNET                            │                        │
│  │  ┌──────────┐  ┌─────────────────┐   │                        │
│  │  │ Azure    │  │ Azure Firewall  │   │                        │
│  │  │ Front    │  │ (egress filter) │   │                        │
│  │  │ Door     │  │ FQDN allowlist  │   │                        │
│  │  └────┬─────┘  └────────┬────────┘   │                        │
│  └───────┼─────────────────┼────────────┘                        │
│          │                 │                                     │
│  ┌───────▼─────────────────▼────────────┐                        │
│  │  Spoke VNET: AKS Cluster             │                        │
│  │  ┌────────────────┐                  │                        │
│  │  │ System Pool    │ (control plane)  │                        │
│  │  └────────────────┘                  │                        │
│  │  ┌────────────────┐                  │                        │
│  │  │ Tenant Pool    │ (tenant pods,    │                        │
│  │  │ (user nodepool)│  NetworkPolicy   │                        │
│  │  │                │  per namespace)  │                        │
│  │  └────────────────┘                  │                        │
│  └──────────────────────────────────────┘                        │
│          │                                                       │
│  ┌───────▼──────────────────────────────┐                        │
│  │  Private Endpoints                    │                        │
│  │  • Key Vault (per-tenant)            │                        │
│  │  • Cosmos DB (tenant registry)       │                        │
│  │  • ACR (container images)            │                        │
│  │  • Log Analytics                      │                        │
│  │  • Purview (DLP scanning)            │                        │
│  └──────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

- **Hub-spoke VNET** topology with Azure Firewall for centralized egress filtering
- **Azure Firewall FQDN rules** allowlist only LLM APIs and channel APIs (e.g., `api.openai.com`, `api.telegram.org`)
- **Private Endpoints** for all PaaS services — no public internet exposure for Key Vault, Cosmos DB, ACR
- **AKS private cluster** — API server not exposed to internet
- **NSG + Azure Firewall** layered network security

### 15.3 Identity Architecture with Entra ID

```
┌──────────────────────────────────────────┐
│  Microsoft Entra ID                       │
│                                           │
│  ┌───────────────────────────────────┐    │
│  │  App Registration: agent-warden   │    │
│  │  • OIDC for tenant admin login    │    │
│  │  • App roles: tenant:owner,       │    │
│  │    tenant:admin, tenant:viewer    │    │
│  └───────────────────────────────────┘    │
│                                           │
│  ┌───────────────────────────────────┐    │
│  │  Managed Identities               │    │
│  │  • agent-warden-control-identity      │    │
│  │  • tenant-<id>-workload-identity  │    │
│  │    (one per tenant namespace)     │    │
│  └───────────────────────────────────┘    │
│                                           │
│  ┌───────────────────────────────────┐    │
│  │  Conditional Access Policies       │    │
│  │  • Require MFA for all logins     │    │
│  │  • Block legacy auth protocols    │    │
│  │  • Require compliant device (opt) │    │
│  │  • Named location restrictions    │    │
│  └───────────────────────────────────┘    │
│                                           │
│  ┌───────────────────────────────────┐    │
│  │  Privileged Identity Management   │    │
│  │  • JIT access for platform ops    │    │
│  │  • Time-boxed role activation     │    │
│  │  • Approval workflow for KEK ops  │    │
│  └───────────────────────────────────┘    │
└──────────────────────────────────────────┘
```

- **Entra ID Conditional Access** enforces MFA, device compliance, and location-based restrictions for all tenant admin logins
- **Privileged Identity Management (PIM)** ensures platform operators activate roles just-in-time with audit trails
- **Workload Identity Federation** — each tenant namespace gets a managed identity with scoped RBAC to only its own Key Vault secrets

### 15.4 Monitoring Stack

| Layer | Azure Service | Purpose |
|---|---|---|
| Infrastructure metrics | Azure Monitor (Container Insights) | CPU, memory, network per tenant pod |
| Application logs | Log Analytics workspace | Tenant-partitioned logs with RBAC |
| Security events | Microsoft Sentinel | SIEM: correlate auth failures, policy violations, anomalies |
| Threat detection | Defender for Containers | Runtime alerts for container escape, crypto mining, reverse shells |
| Compliance posture | Defender for Cloud | Secure score, CIS benchmarks, regulatory dashboards |
| Cost attribution | Cost Management + tags | `tenant-id` tag on all resources for chargeback |

### 15.5 Defender for Containers: Runtime Monitoring Inside OpenClaw

Microsoft Defender for Containers deploys a **DaemonSet-based sensor** (based on eBPF) on every AKS node. This sensor hooks into kernel-level syscalls and gives full visibility into what processes do inside each tenant's OpenClaw container — without modifying the container image.

#### What Defender Monitors Inside the Container

| Activity | What Defender Sees | OpenClaw Relevance |
|---|---|---|
| **Process execution** | Every binary/script launched (path, args, parent, user) | Detects if Pi Agent spawns unexpected binaries, or if sandbox tools exec malicious commands |
| **File access** | File open/read/write/delete operations | Detects unauthorized access to `/tenants/<id>/.openclaw/credentials/`, session files, or config |
| **Network connections** | Outbound connections (dest IP, port, protocol) | Detects if a sandbox process tries to call external APIs, C2 servers, or cross-tenant IPs |
| **DNS queries** | All DNS resolution attempts | Detects DNS exfiltration (e.g., encoding data in DNS queries) or unexpected domain lookups |
| **Linux capabilities** | Capability usage (CAP_NET_RAW, CAP_SYS_ADMIN, etc.) | Detects privilege escalation attempts from sandbox containers |
| **Kernel module loads** | Attempts to load kernel modules | Detects container escape attempts (e.g., loading a rootkit) |
| **Sensitive file mounts** | Access to `/etc/shadow`, `/proc/kcore`, Docker socket | Detects breakout attempts from sandbox containers |

#### OpenClaw-Specific detection Scenarios

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tenant A Container (OpenClaw Gateway + Pi Agent + Sandbox)          │
│                                                                      │
│  NORMAL behavior (Defender learns baseline):                         │
│  ✅ node (Gateway process) listens on :18789                         │
│  ✅ node (Pi Agent) spawns child processes for tool execution        │
│  ✅ DNS: api.openai.com, api.telegram.org                            │
│  ✅ File reads: ~/.openclaw/workspace/*, ~/.openclaw/sessions/*      │
│                                                                      │
│  ANOMALOUS behavior (Defender alerts):                               │
│  🚨 curl/wget spawned inside sandbox → "Suspicious process"         │
│  🚨 nc (netcat) or nmap executed → "Reconnaissance tool detected"   │
│  🚨 /etc/passwd read by sandbox tool → "Sensitive file access"      │
│  🚨 Outbound to unknown IP on port 4444 → "Reverse shell attempt"  │
│  🚨 DNS query: evil.c2server.com → "Communication with suspicious   │
│     domain"                                                          │
│  🚨 chmod +s /tmp/exploit → "Privilege escalation via SUID"         │
│  🚨 Access to Docker socket → "Container breakout attempt"          │
│  🚨 /proc/1/root access → "Container escape via /proc"              │
│  🚨 Crypto mining binary detected → "Digital currency mining"       │
└──────────────────────────────────────────────────────────────────────┘
```

#### Defender Alert Categories for OpenClaw Containers

| Alert | Severity | Trigger | Automated Response |
|---|---|---|---|
| **Reverse shell detected** | Critical | Netcat/bash redirect to external IP from sandbox | Kill sandbox, suspend tenant, Sentinel incident |
| **Container escape attempt** | Critical | Mounting host paths, accessing Docker socket, /proc/1/root | Kill pod, cordon node, Sentinel incident |
| **Crypto miner detected** | High | Known mining binary or CPU-intensive unknown process | Kill pod, alert platform ops |
| **Suspicious process in sandbox** | High | curl/wget/nmap/ssh spawned by a tool execution | Log + alert tenant admin, optionally block |
| **Anomalous outbound connection** | High | Connection to IP not in egress allowlist | Block via NetworkPolicy, alert |
| **Sensitive file access** | Medium | Sandbox tool reads `/etc/shadow`, key files outside workspace | Log + alert, review sandbox permissions |
| **Drift detection** | Medium | New binary appears that wasn't in the original image | Alert platform ops (possible supply chain compromise) |
| **Reconnaissance commands** | Medium | `whoami`, `id`, `uname -a`, `cat /etc/os-release` in sequence | Log + alert (may indicate automated attack) |

#### How the Defender Sensor Works in AKS

```
┌─────────────────────────────────────────────────────┐
│  AKS Node (Linux)                                    │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  Defender DaemonSet Pod                         │  │
│  │  ┌──────────────┐  ┌────────────────────────┐  │  │
│  │  │ eBPF Sensor  │  │ Threat Intel Engine    │  │  │
│  │  │ (kernel-     │  │ (ML models + known     │  │  │
│  │  │  level hooks)│  │  attack signatures)    │  │  │
│  │  └──────┬───────┘  └───────────┬────────────┘  │  │
│  │         │ syscall events       │ classification │  │
│  │         └──────────┬───────────┘                │  │
│  │                    │                            │  │
│  │              ┌─────▼─────┐                      │  │
│  │              │ Alert     │                      │  │
│  │              │ Pipeline  │──► Defender for Cloud │  │
│  │              └───────────┘    ──► Sentinel SIEM  │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐           │
│  │ Tenant A │  │ Tenant B │  │ Tenant C │           │
│  │ Pod      │  │ Pod      │  │ Pod      │           │
│  │ (all     │  │ (all     │  │ (all     │           │
│  │ syscalls │  │ syscalls │  │ syscalls │           │
│  │ observed)│  │ observed)│  │ observed)│           │
│  └──────────┘  └──────────┘  └──────────┘           │
└─────────────────────────────────────────────────────┘
```

- **No agent inside the container** — the eBPF sensor runs at the node level; no sidecar or modification to OpenClaw images needed
- **Low overhead** — eBPF hooks are performant (~1-2% CPU overhead on node)
- **Tenant attribution** — alerts include pod name, namespace, and labels → maps directly to tenant ID
- **Kubernetes audit** — Defender also monitors the Kubernetes API server for suspicious `kubectl exec`, RBAC changes, or pod spec modifications
- **Kata sandbox pool limitation** — eBPF sensors cannot penetrate Kata microVMs on the sandbox node pool. Defender visibility for sandbox pods is limited to K8s audit logs and image scanning. See §4.1.1 for compensating controls.

#### Defender + Sentinel Integration for Automated Response

```jsonc
// Microsoft Sentinel Analytics Rule: auto-respond to container threats
{
  "name": "OpenClaw Container Threat Response",
  "severity": "High",
  "query": "SecurityAlert | where ProviderName == 'Azure Security Center' | where AlertType startswith 'K8S' | extend TenantId = tostring(parse_json(ExtendedProperties).['Namespace']) | where TenantId startswith 'tenant-'",
  "triggerOperator": "GreaterThan",
  "triggerThreshold": 0,
  "automationRules": [
    {
      "name": "Suspend compromised tenant",
      "conditions": [{ "property": "Severity", "operator": "Equals", "value": "High" }],
      "actions": [
        {
          "type": "RunPlaybook",
          "playbook": "agent-warden-suspend-tenant",
          "comment": "Calls warden.tenant.suspend via Agent Warden Server"
        }
      ]
    }
  ]
}
```

When Defender detects a critical threat inside a tenant's OpenClaw container:
1. **Defender** generates alert → pushed to **Microsoft Sentinel**
2. **Sentinel analytics rule** matches alert to tenant namespace
3. **Warden playbook** (Logic App) calls `warden.tenant.suspend` on the Agent Warden Server
4. **Agent Warden** suspends the tenant: kills gateway, removes ingress routes, preserves evidence
5. **Platform security team** investigates via Defender's detailed process tree and network timeline

#### Defender Image Scanning (Pre-Runtime)

Before containers even start, Defender also provides:

| Scan Type | When | What |
|---|---|---|
| **Registry scan** | On push to ACR | Scans OpenClaw image for known CVEs (OS packages, Node.js deps) |
| **Qualys/Trivy integration** | Continuous | Rescans existing images as new CVEs are published |
| **Binary drift detection** | Runtime | Alerts when a new binary appears that wasn't in the original image layer |
| **Kubernetes manifest audit** | Deploy time | Flags insecure pod specs (privileged, hostNetwork, no seccomp) |

This is critical because OpenClaw uses Node.js (npm supply chain risk) and Docker sandbox images — Defender catches compromised dependencies before they reach tenant containers.

---

## 16. Microsoft Purview Integration for DLP

Microsoft Purview provides Data Loss Prevention (DLP), data classification, and governance capabilities critical for a multi-tenant AI assistant platform where sensitive data flows through conversations, tool executions, and channel integrations.

### 16.1 Why Purview for OpenClaw Multi-Tenant

OpenClaw tenants interact with AI agents through natural language — conversations may contain:
- **PII** (names, emails, phone numbers, addresses, SSNs)
- **Financial data** (credit card numbers, bank accounts, invoices)
- **Health information** (PHI under HIPAA)
- **Credentials** (API keys, passwords, tokens accidentally pasted)
- **Proprietary business data** (trade secrets, internal docs)

Without DLP, a tenant's sensitive data could be:
1. Sent to an LLM API (data leakage to model provider)
2. Logged in plain text (exposure via log aggregation)
3. Persisted in session history (exposure via backup/breach)
4. Forwarded across channels (e.g., from Slack to Telegram)
5. Processed by sandbox tools (written to disk, exfiltrated)

### 16.2 Architecture: Purview Integration Points

```
                        ┌─────────────────────┐
                        │  Microsoft Purview   │
                        │  ┌───────────────┐   │
                        │  │ DLP Policies   │   │
                        │  │ (built-in +    │   │
                        │  │  custom SITs)  │   │
                        │  └───────┬───────┘   │
                        │          │            │
                        │  ┌───────▼───────┐   │
                        │  │ Classification │   │
                        │  │ Engine         │   │
                        │  └───────┬───────┘   │
                        │          │            │
                        │  ┌───────▼───────┐   │
                        │  │ Sensitivity    │   │
                        │  │ Labels         │   │
                        │  └───────────────┘   │
                        └──────────┬────────────┘
                                   │
              ┌────────────────────┼──────────────────────┐
              │                    │                      │
     ┌────────▼────────┐  ┌───────▼────────┐  ┌──────────▼──────────┐
     │ Intercept Point │  │ Intercept Point│  │  Intercept Point    │
     │ 1: Inbound Msgs │  │ 2: LLM Proxy  │  │  3: Session Store   │
     │ (channel → GW)  │  │ (GW → LLM API)│  │  (GW → storage)    │
     └─────────────────┘  └────────────────┘  └─────────────────────┘
              │                    │                      │
     ┌────────▼────────┐  ┌───────▼────────┐  ┌──────────▼──────────┐
     │ Intercept Point │  │ Intercept Point│  │  Intercept Point    │
     │ 4: Tool I/O     │  │ 5: Outbound   │  │  6: Cross-Channel   │
     │ (sandbox exec)  │  │ (GW → channel)│  │  (channel → channel)│
     └─────────────────┘  └────────────────┘  └─────────────────────┘
```

### 16.3 DLP Intercept Points

#### Intercept Point 1: Inbound Messages (Channel → Gateway)

Scan messages arriving from external channels before they reach the Pi Agent.

```
Telegram/Slack/Discord ──► Ingress ──► [DLP Scanner] ──► Tenant Gateway
                                            │
                                      Purview DLP API
                                      classifies content
                                            │
                                      ┌─────▼─────┐
                                      │ PII found? │
                                      │ PHI found? │
                                      │ Credentials│
                                      │ detected?  │
                                      └─────┬─────┘
                                            │
                        ┌───────────────────┼──────────────────┐
                        │                   │                  │
                     Allow             Redact/Mask          Block
                  (no sensitive       (replace SSN       (reject msg,
                   data found)        with ***-**-****)   notify tenant)
```

**Implementation**: A sidecar or middleware in the Agent Warden Server calls the Purview DLP evaluation API on each inbound message.

#### Intercept Point 2: LLM API Proxy (Gateway → LLM Provider)

Prevent sensitive data from being sent to external LLM providers.

```jsonc
// Sentinel policy: scan prompts before LLM API call
{
  "name": "dlp-llm-outbound",
  "effect": "enforce",
  "intercept": "llm.request",
  "action": {
    "scan": "purview.dlp.evaluate",
    "onMatch": {
      "creditCardNumber": "redact",
      "ssn": "redact",
      "apiKey": "block",
      "phi": "block_unless_baa"
    }
  }
}
```

This is the **highest-priority intercept** — once data is sent to an LLM API, it cannot be recalled.

#### Intercept Point 3: Session Persistence (Gateway → Storage)

Classify and label session transcripts before they are written to disk.

- Apply **sensitivity labels** to session files based on content classification
- Sessions containing PHI → labeled `Confidential/PHI` → encrypted with additional key, restricted access
- Sessions containing credentials → labeled `Highly Confidential` → auto-expiry, not included in backups

#### Intercept Point 4: Tool I/O (Sandbox Execution)

Scan data flowing in and out of Docker sandbox executions.

- Tool input: scan for sensitive data being passed to code execution
- Tool output: scan results for leaked credentials or PII
- File writes: classify files created by sandbox tools

#### Intercept Point 5: Outbound Messages (Gateway → Channel)

Prevent AI agent responses from leaking sensitive data back through channels.

- Agent may generate responses containing PII from context
- Scan outbound messages before delivery to Telegram/Slack/Discord
- Redact or block based on DLP policy

#### Intercept Point 6: Cross-Channel Forwarding

When data moves between channels (e.g., user asks agent to forward from Slack to email).

- Apply DLP policies based on the **destination channel's sensitivity level**
- Corporate Slack → Personal Telegram may require additional DLP checks

### 16.4 Purview Configuration

#### Sensitive Information Types (SITs)

Use Purview's built-in SITs plus custom ones for OpenClaw:

| SIT | Type | DLP Action |
|---|---|---|
| Credit Card Number | Built-in | Redact before LLM, mask in logs |
| SSN / National ID | Built-in | Redact before LLM, block storage in plain text |
| Email Address | Built-in | Allow (common in chat), flag if bulk |
| API Key patterns | **Custom** (`sk-[a-zA-Z0-9]{48}`, `ghp_`, `xoxb-`) | Block from LLM, alert tenant |
| Password in chat | **Custom** (regex: `password\s*[:=]\s*\S+`) | Redact, alert tenant |
| PHI (medical terms + PII) | Built-in (exact data match) | Block unless HIPAA tier |
| Source code with secrets | **Custom** (trainable classifier) | Redact secrets, allow code |

#### Custom SIT for API Keys:

```xml
<Entity id="custom-api-key-pattern" patternsProximity="300" recommendedConfidence="85">
  <Pattern confidenceLevel="85">
    <IdMatch idRef="Regex_APIKey"/>
  </Pattern>
</Entity>

<Regex id="Regex_APIKey">
  (sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xoxb-[0-9]+-[a-zA-Z0-9]+|AKIA[0-9A-Z]{16})
</Regex>
```

#### Sensitivity Labels

| Label | Applied When | Effect |
|---|---|---|
| `Public` | No sensitive data detected | Normal processing |
| `Internal` | Business data, internal context | Standard encryption at rest |
| `Confidential` | PII detected (names, emails, addresses) | CMK encryption, restricted backup access |
| `Confidential/PHI` | Health information detected | Additional encryption layer, HIPAA-compliant storage |
| `Highly Confidential` | Credentials, financial data | Auto-expiry (24h), excluded from bulk exports, alerts on access |

### 16.5 DLP Policy Actions

```jsonc
{
  "dlpPolicies": [
    {
      "name": "block-credentials-to-llm",
      "locations": ["llm.outbound"],
      "conditions": {
        "contentContains": ["custom-api-key-pattern", "password-in-chat"]
      },
      "actions": {
        "blockContent": true,
        "notifyTenantAdmin": true,
        "auditLog": true,
        "userNotification": "Sensitive credential detected and blocked from being sent to the AI model."
      }
    },
    {
      "name": "redact-pii-in-logs",
      "locations": ["session.persist", "log.write"],
      "conditions": {
        "contentContains": ["ssn", "credit-card-number", "national-id"]
      },
      "actions": {
        "redactMatches": true,
        "applySensitivityLabel": "Confidential",
        "auditLog": true
      }
    },
    {
      "name": "phi-handling",
      "locations": ["all"],
      "conditions": {
        "contentContains": ["phi-medical-terms"],
        "tenantTier": { "not": "enterprise" }
      },
      "actions": {
        "blockContent": true,
        "notifyTenantAdmin": true,
        "userNotification": "Health information detected. Upgrade to Enterprise tier for HIPAA-compliant processing."
      }
    }
  ]
}
```

### 16.6 Purview Data Map for Tenant Data

Register tenant data sources in Purview Data Map for governance:

```
Purview Data Map
├── Collection: agent-warden-platform
│   ├── Source: Azure Cosmos DB (tenant registry)
│   ├── Source: Log Analytics (platform audit logs)
│   └── Source: Azure Key Vault (key metadata — not secret values)
│
├── Collection: tenant-<id-a>
│   ├── Source: Azure Blob / Disk (session transcripts)
│   ├── Source: Azure Blob / Disk (workspace files)
│   └── Lineage: channel-inbound → DLP scan → agent processing → session store
│
└── Collection: tenant-<id-b>
    └── ...
```

- **Automated scanning** classifies tenant data assets on a schedule
- **Data lineage** tracks how sensitive data flows through the platform
- **Access policies** (Purview governance) can enforce that only tenant-scoped identities access tenant data

### 16.7 Integration with Agent Warden Server

The Agent Warden Server acts as the enforcement bridge between Purview and the OpenClaw runtime:

| Agent Warden Tool | Purview Integration |
|---|---|
| `warden.dlp.scan` | Calls Purview DLP evaluation API on content |
| `warden.dlp.policy.list` | Lists active DLP policies for a tenant |
| `warden.dlp.incident.report` | Creates a DLP incident in Purview compliance portal |
| `warden.label.apply` | Applies Purview sensitivity label to a session/file |
| `warden.label.check` | Checks sensitivity label before allowing data export |

```typescript
// agent-warden/src/tools/dlp.ts

interface DLPScanInput {
  tenantId: string;
  content: string;
  contentType: "message" | "llm-prompt" | "llm-response" | "tool-output" | "file";
  sourceChannel?: string;
  destinationChannel?: string;
}

interface DLPScanResult {
  allowed: boolean;
  matchedPolicies: string[];
  sensitiveInfoTypes: {
    name: string;
    confidence: number;
    count: number;
    locations: { offset: number; length: number }[];
  }[];
  action: "allow" | "redact" | "block";
  redactedContent?: string;   // Content with sensitive data masked
  sensitivityLabel: string;
  incidentId?: string;        // If a DLP incident was created
}
```

### 16.8 DLP Pipeline Flow

```
User sends message via Telegram
         │
         ▼
┌─────────────────┐     ┌──────────────────┐
│  AGC (Gateway    │────►│  Agent Warden    │
│  API HTTPRoute)  │     │  warden.dlp    │
└─────────────────┘     │  .scan()         │
                        └────────┬─────────┘
                                 │
                        ┌────────▼─────────┐
                        │  Purview DLP API  │
                        │  Classification   │
                        └────────┬─────────┘
                                 │
                    ┌────────────┼────────────┐
                    │            │            │
               No match     SIT match    SIT match
               (clean)      (low risk)   (high risk)
                    │            │            │
                    ▼            ▼            ▼
               Forward      Redact &     Block msg,
               to tenant    forward      alert admin,
               Gateway      to GW        log incident
                    │            │
                    ▼            ▼
              ┌──────────────────────┐
              │  Tenant Gateway      │
              │  (processes message) │
              └──────────┬──────────┘
                         │
                         ▼
              ┌──────────────────────┐
              │  LLM API Proxy       │
              │  warden.dlp.scan() │◄── Second scan before LLM call
              │  on prompt content   │
              └──────────┬──────────┘
                         │
                    (if allowed)
                         │
                         ▼
                   LLM Provider
                  (OpenAI, etc.)
```

### 16.9 Purview Alerts in Microsoft Sentinel SIEM

Purview DLP incidents flow into Microsoft Sentinel for correlation with other security events:

| Purview DLP Event | Sentinel Correlation | Automated Response |
|---|---|---|
| Credential detected in chat | + Auth failure from same tenant | Suspend channel, rotate credentials |
| Bulk PII in outbound msgs | + Unusual session count | Quarantine tenant, investigate exfiltration |
| PHI in non-HIPAA tenant | + Data residency violation | Block processing, notify compliance team |
| Repeated DLP blocks | + Same user/IP pattern | Flag for social engineering investigation |

### 16.10 DLP Implementation: Purview DLP Plugin (v0.4.0)

The DLP architecture is implemented as an **OpenClaw plugin** (`agent-warden-purview-dlp`) installed via init container into each tenant's OpenClaw instance. This approach hooks directly into OpenClaw's plugin event system rather than using a standalone sidecar proxy.

#### Two Operational Modes

| Mode | Default | Streaming | L2 Behavior | L2b | Use Case |
|---|---|---|---|---|---|
| **`enforce`** | ✓ | OFF | Sync Purview (`spawnSync`+`curl`), redacts on block | Active — blocks PII in outbound messages | Production: hard block on DLP violations |
| **`audit`** | | ON (partial) | Async Purview, log only (`would BLOCK`) | Not registered | Monitoring: log violations without blocking |

> **Architecture note:** `message_sending` is wired in `deliverOutboundPayloadsCore` but is **bypassed** by Telegram's streaming preview path (`deliverReplies` → `editMessageTelegram`). Therefore, **enforce mode requires Telegram streaming OFF** for L2b to intercept outbound messages. The plugin auto-configures streaming in `/data/state/openclaw.json` at startup based on mode.

#### Four-Layer Defense (Enforce Mode)

| Layer | Hook Event | Type | Purpose | Action |
|---|---|---|---|---|
| **L1: Prompt Guard** | `before_agent_start` | Async, modifying | Inject DLP security policy into LLM context | LLM refuses to output credit cards, SSNs, credentials |
| **L2: Output Scanner** | `tool_result_persist` | **Sync** (enforce) / Async (audit) | Scan tool output via Purview `processContent` API | Enforce: sync redact via `spawnSync`+`curl`. Audit: async log only |
| **L2b: Response Scanner** | `message_sending` | Async, modifying | Scan LLM's outbound response via Purview (enforce only) | Replace blocked content with DLP notice before delivery |
| **L3: Input Audit** | `message_received` | Async, void | Audit inbound user messages via Purview | Log BLOCKED/ALLOWED (fire-and-forget, cannot block) |

**How the layers work together (enforce mode):**

```
User message → L3 (audit inbound) → L1 (inject DLP policy) → LLM generates response
                                                                       │
                                          L2 (sync redact tool output) ◄┘
                                                       │
                                          L2b (block PII in response) ◄┘
                                                       │
                                          Telegram sendMessage ◄────────┘
```

- **L1** prevents the LLM from **generating** sensitive data by injecting a mandatory DLP security policy into the agent's system context. The LLM responds with `[Agent Warden DLP] I detected sensitive data...` instead of echoing PII.
- **L2** prevents sensitive data from **reaching the LLM** by intercepting tool results (e.g., `cat report.txt`) synchronously. In enforce mode, `processContentSync()` uses `spawnSync`+`curl` to call Purview blocking the event loop, ensuring redaction happens before the LLM sees the content. In audit mode, an async call logs `would BLOCK` but passes data through.
- **L2b** is the **last line of defense** — it intercepts the LLM's final outbound message via the `message_sending` hook and scans it through Purview. If the LLM bypasses L1+L2 and still includes PII, L2b replaces the message content with a DLP block notice. Only active in enforce mode (requires streaming OFF).
- **L3** provides **audit visibility** on inbound messages — every message is evaluated by Purview's ML-based classification engine, logged for compliance reporting.

All DLP evaluation is delegated to the **Purview `processContent` Graph API** — no local regex patterns needed. Purview's ML classifiers detect credit cards, SSNs, API keys, emails, and 200+ other sensitive information types.

#### Defense-in-Depth with Azure OpenAI (L0)

Azure OpenAI's built-in content management policy acts as an additional **L0 layer** that blocks generation of responses containing PII at the model level. This is not controlled by the plugin but provides an extra safety net:

| Layer | Source | Enforcement |
|---|---|---|
| **L0** | Azure OpenAI content filter | Model refuses to generate PII (ContentPolicyViolationError) |
| **L1** | Plugin (prompt guard) | LLM self-censors based on injected DLP policy |
| **L2** | Plugin (output scanner) | Tool output redacted before LLM sees it |
| **L2b** | Plugin (response scanner) | Outbound message blocked before delivery |
| **L3** | Plugin (input audit) | Inbound messages logged for compliance |

#### Cross-Tenant Purview Architecture

The Purview `processContent` API requires an **M365 E5 license** on the tenant. When the hosting platform tenant does not have E5, the plugin supports **cross-tenant authentication** to a separate E5 tenant:

```
┌─────────────────────────────────┐     ┌─────────────────────────────────┐
│  Platform Tenant                │     │  E5 Tenant                      │
│                                 │     │                                 │
│  AKS Pod                        │     │  Multi-tenant App Registration │
│  ┌─────────────────────────┐    │     │  "Agent Warden Purview DLP"    │
│  │ Purview DLP Plugin      │    │     │                                 │
│  │                         │    │     │                                 │
│  │ ClientSecretCredential ─┼────┼────►│  Service Principal             │
│  │ (client_id + secret)    │    │     │  Content.Process.All           │
│  └─────────────────────────┘    │     │                                 │
│                                 │     │  processContent API ✓          │
│  Env vars from Key Vault (CSI): │     │  (E5 licensed user required)   │
│  PURVIEW_DLP_CLIENT_ID          │     │                                 │
│  PURVIEW_DLP_CLIENT_SECRET      │     │  Admin consent URL:            │
│  PURVIEW_DLP_TENANT_ID          │     │  /adminconsent?client_id=...   │
└─────────────────────────────────┘     └─────────────────────────────────┘
```

**Authentication modes:**

| Mode | Credential | When Used |
|---|---|---|
| Same-tenant | `DefaultAzureCredential` (Managed Identity) | Platform tenant has M365 E5 |
| Cross-tenant | `ClientSecretCredential` (multi-tenant app) | Platform tenant lacks E5; uses external E5 tenant |

Cross-tenant mode is auto-detected when `PURVIEW_DLP_TENANT_ID` env var is set or `crossTenant: true` is in config.json.

#### Plugin Deployment

The plugin is packaged as a container image (`agent-warden-purview-dlp`) and installed via an **init container** in the tenant StatefulSet:

1. Init container copies plugin files to `/data/state/plugins/agent-warden-purview-dlp/`
2. Init container writes `config.json` from Helm values (mode, purview.enabled, userId, crossTenant)
3. Gateway container loads the plugin from the state volume
4. Cross-tenant credentials injected as env vars from Key Vault via CSI SecretProviderClass

#### Helm Values

```yaml
purviewDlpPlugin:
  enabled: true
  mode: "enforce"           # enforce | audit
  layers:
    promptGuard: true       # L1: before_agent_start
    outputScanner: true     # L2: tool_result_persist + L2b: message_sending (enforce only)
    inputAudit: true        # L3: message_received
  purviewEnabled: true
  purviewUserId: ""         # E5 tenant user ID (required for processContent)
  purviewTenantId: ""       # Cross-tenant E5 tenant ID (empty = same tenant)
  image:
    repository: acragentwardendev.azurecr.io/purview-dlp-plugin
    tag: "0.4.0"
    pullPolicy: Always
```

#### Telegram Streaming Auto-Configuration

The plugin automatically writes to `/data/state/openclaw.json` at startup:
- **Enforce mode** → sets `channels.telegram.streaming: "off"` (required for L2b `message_sending` hook to fire)
- **Audit mode** → sets `channels.telegram.streaming: "partial"` (better UX, no blocking needed)

#### Fail-Open Design

If the Purview API is unavailable or returns an error, the plugin **fails open** — it returns `allowed: true` and logs the error. L1 (prompt guard) always fires regardless of Purview availability since it is a static policy injection.

### 16.11 Purview Data Governance — Tier 1 (Azure Subscription Only)

Azure Purview Data Governance provides **Data Map, catalog, classification, lineage, and access policies** for governing tenant data assets — no M365 license required. This runs entirely within the platform Azure subscription using the Azure Purview account deployed via Terraform.

#### Two Purview Products in the Architecture

| Product | Portal | Tenant | License | Purpose |
|---|---|---|---|---|
| **Azure Purview Data Governance** | governance.purview.azure.com | Platform (ME-SRX, `9a72f9b7`) | Azure subscription (free tier included) | Data Map, lineage, classification of Azure data stores |
| **Microsoft Purview Compliance** | purview.microsoft.com | E5 (`8cbe524f`) | M365 E5 | DLP policies, processContent API, SITs (§16.10) |

#### Capabilities

| # | Capability | What It Does for OpenClaw | API |
|---|---|---|---|
| 1 | **Data Map & Catalog** | Scan and catalog tenant data stores (Cosmos DB, Blob Storage). Auto-discover data per tenant. | Purview Data Map REST API |
| 2 | **Collections** | Organize tenant data by collection (`tenant-<id>`). One collection per tenant under `agent-warden-platform` root. | Collections API |
| 3 | **Data Source Registration** | Register Cosmos DB (tenant registry), Blob Storage (session transcript backups) as scannable data sources. | Scan Data Sources API |
| 4 | **Automated Classification** | Scan registered data sources with 200+ built-in classifiers (PII, financial, health, credentials). Auto-label assets. | Scan API + Classification Rules |
| 5 | **Data Lineage** | Track data flow: `Channel inbound → DLP scan → LLM API → session store → backup`. Per-tenant lineage graphs. | Atlas Lineage API |
| 6 | **Catalog Search** | Search across all tenant collections for classified assets. "Which tenants have SSN data in their session backups?" | Search Query API |

#### Architecture

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Platform Tenant (ME-SRX)                                                │
│                                                                          │
│  ┌──────────────────────────────────┐                                    │
│  │  Azure Purview Account           │                                    │
│  │  (pview-agentwarden-dev)         │                                    │
│  │                                  │                                    │
│  │  Collections:                    │                                    │
│  │   └─ agent-warden-platform (root)│                                    │
│  │      ├─ tenant-demo-tenant       │                                    │
│  │      ├─ tenant-acme-corp         │                                    │
│  │      └─ tenant-contoso           │                                    │
│  │                                  │                                    │
│  │  Data Sources:                   │                                    │
│  │   ├─ cosmos-demo-tenant          │ → Cosmos DB (sessions, config)     │
│  │   ├─ blob-demo-tenant            │ → Blob Storage (transcript backup) │
│  │   ├─ cosmos-acme-corp            │                                    │
│  │   └─ blob-acme-corp              │                                    │
│  │                                  │                                    │
│  │  Scans:                          │                                    │
│  │   • Auto-classify PII, creds    │                                    │
│  │   • Schedule: every 6 hours     │                                    │
│  │   • Built-in + custom rules     │                                    │
│  └──────────────────────────────────┘                                    │
│                                                                          │
│  ┌──────────────────────────────────┐                                    │
│  │  Agent Warden Server (AKS)      │                                    │
│  │                                  │                                    │
│  │  warden.governance.setup         │ → Create collection + register DS  │
│  │  warden.governance.teardown      │ → Delete collection on tenant del  │
│  │  warden.governance.scan.run      │ → Trigger classification scan      │
│  │  warden.governance.search        │ → Search catalog for classified    │
│  │  warden.governance.classifications│ → Get classified assets per tenant│
│  │  warden.governance.lineage       │ → Track data flow per asset        │
│  └──────────────────────────────────┘                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

#### Terraform RBAC

| Role | Assigned To | Scope | Purpose |
|---|---|---|---|
| `Purview Data Curator` | Platform MI | Purview account | Manage collections, register sources, run scans |
| `Purview Data Source Administrator` | Platform MI | Purview account | Register and manage data sources, configure scans |
| `Cosmos DB Account Reader Role` | Purview MSI | Cosmos DB account | Purview scanner reads Cosmos DB metadata + data for classification |
| `Contributor` | Platform MI | Purview account | Full management (existing) |
| `Reader` | Platform MI | Purview account | Read metadata (existing) |

#### Agent Warden Governance Tools

| MCP Tool | Purpose |
|---|---|
| `warden.governance.setup` | Create tenant collection + register data sources (called during provisioning) |
| `warden.governance.teardown` | Delete tenant collection (called during tenant deletion) |
| `warden.governance.collections` | List all Purview collections |
| `warden.governance.datasources` | List all registered data sources |
| `warden.governance.scan.run` | Trigger classification scan on a data source |
| `warden.governance.scan.history` | View scan run history |
| `warden.governance.search` | Search the Data Map catalog (cross-tenant or per-tenant) |
| `warden.governance.classifications` | Get all classified assets in a tenant's collection |
| `warden.governance.lineage` | Get lineage graph for an asset |

#### Integration with Tenant Lifecycle

Data governance is automatically wired into the tenant lifecycle (§10):

| Lifecycle Event | Governance Action |
|---|---|
| **Tenant provisioned** | `warden.governance.setup` — creates collection, registers Cosmos DB + Blob sources |
| **Tenant active** | Scheduled scans classify data every 6 hours |
| **Tenant suspended** | Scans paused; classification data preserved |
| **Tenant deleted** | `warden.governance.teardown` — removes collection, deregisters sources |

#### Environment Variables

| Env Var | Value | Source |
|---|---|---|
| `AZURE_PURVIEW_GOVERNANCE_ENDPOINT` | `https://pview-agentwarden-dev.purview.azure.com` | Terraform output `purview_catalog_endpoint` |
| `PURVIEW_ROOT_COLLECTION` | `agent-warden-platform` | Default in env config |

---

## 17. Skill Management & Supply Chain Security

OpenClaw has a three-tier skill system — **bundled**, **managed** (from ClawHub), and **workspace** (user-authored). In multi-tenant hosting, skills are the primary vector for code execution inside a tenant's environment, making skill management a first-class security concern.

### 17.1 Skill Types and Risk Profile

| Skill Type | Source | Installs To | Execution Context | Risk Level |
|---|---|---|---|---|
| **Bundled** | Shipped with OpenClaw image | Read-only in image | Pi Agent (in-process) | Low — vetted by OpenClaw maintainers |
| **Managed** | ClawHub registry | `~/.openclaw/skills/managed/` | Pi Agent or sandbox | **High** — third-party code, npm dependencies |
| **Workspace** | Tenant-authored | `~/.openclaw/workspace/skills/` | Pi Agent or sandbox | **High** — arbitrary tenant code |

### 17.2 Threat Model for Skills

```
┌──────────────────────────────────────────────────────────────────┐
│  Skill Attack Surfaces                                            │
│                                                                   │
│  1. Malicious ClawHub skill                                       │
│     └─ npm dependency with backdoor (supply chain)                │
│     └─ Skill that exfiltrates tenant credentials                  │
│     └─ Skill that escalates privileges in sandbox                 │
│                                                                   │
│  2. Compromised managed skill update                              │
│     └─ ClawHub skill is legit at install, malicious after update  │
│     └─ Dependency hijack (typosquat, maintainer takeover)         │
│                                                                   │
│  3. Tenant-authored workspace skill                               │
│     └─ Tenant writes skill that breaks out of sandbox             │
│     └─ Skill that consumes excessive resources (DoS)              │
│     └─ Skill that probes for cross-tenant data                    │
│                                                                   │
│  4. Skill-to-skill interaction                                    │
│     └─ Skill A modifies behavior of Skill B via shared state      │
│     └─ Prompt injection via skill output → agent acts on it       │
└──────────────────────────────────────────────────────────────────┘
```

### 17.3 Skill Governance Architecture

```
                    ┌──────────────────────────────┐
                    │      ClawHub Registry         │
                    │  (public skill marketplace)   │
                    └──────────────┬───────────────┘
                                   │
                    ┌──────────────▼───────────────┐
                    │  Platform Skill Gateway       │
                    │  (Agent Warden Server)        │
                    │                               │
                    │  ┌─────────────────────────┐  │
                    │  │ 1. Allowlist check      │  │
                    │  │ 2. Signature verify     │  │
                    │  │ 3. Vulnerability scan   │  │
                    │  │ 4. Sandbox policy check │  │
                    │  │ 5. DLP content scan     │  │
                    │  └────────────┬────────────┘  │
                    └───────────────┼───────────────┘
                                    │
               ┌────────────────────┼────────────────────┐
               │                    │                    │
      ┌────────▼───────┐  ┌────────▼───────┐  ┌────────▼───────┐
      │   Tenant A     │  │   Tenant B     │  │   Tenant C     │
      │   Skills:      │  │   Skills:      │  │   Skills:      │
      │   • bundled ✅ │  │   • bundled ✅ │  │   • bundled ✅ │
      │   • web-search │  │   • calculator │  │   • (managed   │
      │     (managed,  │  │     (managed,  │  │     skills     │
      │      vetted) ✅│  │      vetted) ✅│  │     blocked    │
      │   • my-tool    │  │   • data-viz   │  │     by tier) ❌│
      │     (workspace,│  │     (workspace,│  │   • my-tool    │
      │      sandboxed)│  │      sandboxed)│  │     (workspace)│
      └────────────────┘  └────────────────┘  └────────────────┘
```

### 17.4 Skill Installation Controls

#### Platform Skill Allowlist

The platform maintains a curated allowlist of ClawHub skills that have been reviewed and approved:

```jsonc
// agent-warden skill registry
{
  "skillPolicies": {
    "clawhub": {
      "mode": "allowlist",           // "allowlist" | "blocklist" | "open"
      "allowedSkills": [
        {
          "name": "@clawhub/web-search",
          "maxVersion": "2.x",       // Pin to major version
          "requiredSandbox": true,
          "allowedCapabilities": ["network:outbound"],
          "lastReviewed": "2026-03-01",
          "reviewer": "platform:security"
        },
        {
          "name": "@clawhub/calculator",
          "maxVersion": "*",
          "requiredSandbox": false,  // Pure computation, no I/O
          "allowedCapabilities": [],
          "lastReviewed": "2026-02-15",
          "reviewer": "platform:security"
        }
      ],
      "blockedSkills": [
        {
          "name": "@clawhub/shell-exec",
          "reason": "Unrestricted shell access incompatible with multi-tenant"
        }
      ]
    },
    "workspace": {
      "mode": "sandboxed-only",      // All workspace skills must run in sandbox
      "maxSkillsPerTenant": {
        "free": 5,
        "pro": 50,
        "enterprise": -1             // Unlimited
      },
      "maxSkillSizeBytes": 5242880,  // 5 MB per skill
      "bannedImports": [
        "child_process",             // Direct shell exec
        "cluster",                   // Fork bomb risk
        "dgram",                     // Raw UDP
        "net"                        // Raw TCP (use fetch instead)
      ]
    }
  }
}
```

#### Skill Installation Flow

```
Tenant requests skill install
         │
         ▼
┌─────────────────────┐
│ Agent Warden Server │
│ warden.skill      │
│ .install()          │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐     ┌──────────────────────┐
│ 1. Allowlist check  │────►│ Skill in platform    │
│    (ClawHub skills) │  no │ allowlist?            │
└────────┬────────────┘     │ → DENY install       │
         │ yes              └──────────────────────┘
         ▼
┌─────────────────────┐
│ 2. Version pin      │
│    check            │
│    (within allowed  │
│     version range?) │
└────────┬────────────┘
         │ yes
         ▼
┌─────────────────────┐     ┌──────────────────────┐
│ 3. Vulnerability    │────►│ Defender for          │
│    scan             │     │ Containers: scan      │
│    (npm audit +     │     │ skill dependencies    │
│     Defender)       │     └──────────────────────┘
└────────┬────────────┘
         │ clean
         ▼
┌─────────────────────┐     ┌──────────────────────┐
│ 4. DLP content scan │────►│ Purview: scan skill   │
│    (Purview)        │     │ source for embedded   │
│                     │     │ credentials/secrets   │
└────────┬────────────┘     └──────────────────────┘
         │ clean
         ▼
┌─────────────────────┐
│ 5. Sandbox policy   │
│    applied          │
│    (set execution   │
│     constraints)    │
└────────┬────────────┘
         │
         ▼
    Skill installed to
    tenant workspace
    (audit event logged)
```

### 17.5 Skill Execution Sandbox Policy

Every managed and workspace skill runs inside the Docker sandbox with skill-specific constraints:

```jsonc
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "always"
      }
    },
    "skills": {
      "@clawhub/web-search": {
        "sandbox": {
          "networkMode": "filtered",     // Only allowlisted domains
          "networkAllowlist": [
            "*.google.com",
            "*.bing.com",
            "*.duckduckgo.com"
          ],
          "readOnlyRootFilesystem": true,
          "memoryLimit": "256m",
          "cpuLimit": "500m",
          "timeoutSeconds": 30,
          "filesystem": {
            "readPaths": ["/workspace/skills/@clawhub/web-search/"],
            "writePaths": ["/tmp/"],
            "denyPaths": [
              "/tenants/*/credentials/",
              "/tenants/*/sessions/"
            ]
          },
          "blockedSyscalls": ["ptrace", "mount", "keyctl"]
        }
      },
      "@clawhub/calculator": {
        "sandbox": {
          "networkMode": "none",         // No network at all
          "memoryLimit": "128m",
          "cpuLimit": "250m",
          "timeoutSeconds": 10,
          "filesystem": {
            "readPaths": [],
            "writePaths": ["/tmp/"],
            "denyPaths": ["*"]           // No filesystem access
          }
        }
      }
    }
  }
}
```

### 17.6 Skill Update & Supply Chain Security

#### Dependency Scanning Pipeline

```
ClawHub publishes skill update
         │
         ▼
┌──────────────────────────────┐
│ Platform Skill Scanner       │
│ (runs in agent-warden-control)   │
│                              │
│ 1. npm audit (known CVEs)    │
│ 2. Defender image scan       │
│    (scan skill as container  │
│     layer)                   │
│ 3. Lock file diff            │
│    (detect new/changed deps) │
│ 4. License compliance check  │
│ 5. Static analysis           │
│    (detect child_process,    │
│     eval, require('net'))    │
│ 6. Behavioral sandbox test   │
│    (run in isolated env,     │
│     monitor network/fs)      │
└──────────────┬───────────────┘
               │
         ┌─────┴─────┐
         │           │
      Passes       Fails
         │           │
         ▼           ▼
   Update allowed  Block update,
   for tenants     alert platform
   (staged rollout) security team
```

#### Version Pinning & Staged Rollout

| Policy | Behavior |
|---|---|
| **Auto-update disabled** | Skills pinned to installed version by default |
| **Platform-managed updates** | Platform security team reviews updates → promotes to allowlist |
| **Staged rollout** | Update applied to 5% of tenants → monitor for anomalies → 25% → 100% |
| **Rollback** | If Defender detects anomalous behavior post-update, auto-rollback to previous version |
| **Lock files** | `package-lock.json` / `pnpm-lock.yaml` stored and verified at install time |
| **Integrity hashes** | sha256 hash of skill package verified before install (subresource integrity) |

### 17.7 Runtime Skill Monitoring

Defender for Containers + Agent Warden provide real-time visibility into skill behavior:

| Monitor | What It Catches | Defender Feature |
|---|---|---|
| Process tree per skill | Skill spawning unexpected child processes | Process execution alerts |
| Network connections | Skill calling unauthorized external APIs | Anomalous outbound connection |
| File access patterns | Skill reading outside its allowed paths | Sensitive file access alerts |
| Resource consumption | Skill consuming excessive CPU/memory | Container resource anomaly |
| Execution duration | Skill running beyond timeout | Agent Warden timeout enforcement |
| Output content | Skill returning sensitive data | Purview DLP scan on tool output |

#### Skill Execution Audit Trail

Every skill invocation generates an audit event:

```jsonc
{
  "event": "skill.executed",
  "tenantId": "tenant-abc123",
  "sessionId": "session-xyz",
  "skill": {
    "name": "@clawhub/web-search",
    "version": "2.1.3",
    "type": "managed"
  },
  "execution": {
    "sandboxId": "sandbox-9a8b7c",
    "duration": 2340,              // ms
    "exitCode": 0,
    "resourceUsage": {
      "cpuMs": 890,
      "memoryPeakMb": 64,
      "networkBytesOut": 15240,
      "filesWritten": 1
    }
  },
  "dlpScan": {
    "inputClassification": "Public",
    "outputClassification": "Internal",
    "sensitiveTypesFound": []
  },
  "defenderAlerts": []
}
```

### 17.8 Agent Warden Skill Management Tools

| MCP Tool | Purpose |
|---|---|
| `warden.skill.install` | Install a skill with full security pipeline (allowlist, scan, sandbox policy) |
| `warden.skill.remove` | Remove a skill from a tenant and clean up artifacts |
| `warden.skill.list` | List installed skills for a tenant with version and scan status |
| `warden.skill.audit` | Query skill execution history for a tenant |
| `warden.skill.scan` | Trigger on-demand vulnerability scan of installed skills |
| `warden.skill.update` | Update a skill within allowed version range (staged rollout) |
| `warden.skill.policy.get` | Get the sandbox policy for a specific skill |
| `warden.skill.policy.set` | Override sandbox policy for a skill (platform:security role only) |
| `warden.skill.allowlist.add` | Add a ClawHub skill to the platform allowlist after review |
| `warden.skill.allowlist.remove` | Remove a skill from allowlist (blocks future installs, flags existing) |

```typescript
// agent-warden/src/tools/skills.ts

interface SkillInstallInput {
  tenantId: string;
  skillName: string;           // e.g., "@clawhub/web-search"
  version?: string;            // Specific version or range
  source: "clawhub" | "workspace";
}

interface SkillInstallResult {
  installed: boolean;
  skillName: string;
  version: string;
  securityChecks: {
    allowlistApproved: boolean;
    vulnerabilityScan: { passed: boolean; cveCount: number; criticalCount: number };
    dlpScan: { passed: boolean; sensitiveTypesFound: string[] };
    staticAnalysis: { passed: boolean; blockedImports: string[] };
    sandboxPolicy: string;     // Name of applied sandbox policy
  };
  deniedReason?: string;
}
```

### 17.9 Per-Tier Skill Capabilities

| Capability | Free | Pro | Enterprise |
|---|---|---|---|
| Bundled skills | All | All | All |
| ClawHub managed skills | 5 (from allowlist) | 50 (from allowlist) | Unlimited (allowlist + custom review) |
| Workspace skills | 5 | 50 | Unlimited |
| Skill network access | None | Filtered (allowlisted domains) | Filtered (custom allowlist per skill) |
| Skill memory limit | 128 MB | 256 MB | 1 GB |
| Skill timeout | 10s | 30s | 300s |
| Custom sandbox policies | No | No | Yes |
| Private ClawHub registry | No | No | Yes (bring your own skill registry) |
| Skill execution audit | 7-day retention | 30-day retention | 1-year retention |

---

## 18. Entra ID Permission Model for OpenClaw Instances

Each OpenClaw tenant instance needs access to Azure resources (Key Vault secrets, storage, Cosmos DB, LLM APIs). This section defines how to grant permissions using Microsoft Entra ID so that **no static credentials exist** inside containers.

### 18.1 Identity Architecture per Tenant

```
┌──────────────────────────────────────────────────────────────────┐
│  Microsoft Entra ID                                               │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  User-Assigned Managed Identity: mi-tenant-abc123          │   │
│  │                                                            │   │
│  │  Federated Credential:                                     │   │
│  │    Issuer: https://oidc.prod-aks.azure.com/<cluster-id>   │   │
│  │    Subject: system:serviceaccount:tenant-abc123:openclaw   │   │
│  │                                                            │   │
│  │  RBAC Assignments (scoped, least-privilege):               │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │ Key Vault Secrets User  → kv-tenant-abc123           │  │   │
│  │  │ Storage Blob Data Reader → sa-tenant-abc123          │  │   │
│  │  │ Cosmos DB Data Reader   → tenant-registry (filtered) │  │   │
│  │  │ (NO Key Vault Admin, NO Owner, NO Contributor)       │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────────────────┘   │
│                                                                   │
│  ┌────────────────────────────────────────────────────────────┐   │
│  │  User-Assigned Managed Identity: mi-agent-warden-control       │   │
│  │                                                            │   │
│  │  RBAC Assignments (control plane operations):              │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │ Key Vault Administrator → all tenant key vaults      │  │   │
│  │  │ Cosmos DB Data Contributor → tenant-registry          │  │   │
│  │  │ AKS Cluster Admin → AKS cluster (for provisioning)  │  │   │
│  │  │ Managed Identity Operator → create tenant identities │  │   │
│  │  └──────────────────────────────────────────────────────┘  │   │
│  └────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### 18.2 How Workload Identity Flows

```
┌──────────────────────┐     ┌──────────────────────┐
│ OpenClaw Gateway Pod │     │ AKS OIDC Issuer      │
│ (tenant-abc123 ns)   │     │                      │
│                      │     │ Issues projected     │
│ ServiceAccount:      ├────►│ service account      │
│   openclaw           │     │ token (JWT)          │
└──────────┬───────────┘     └──────────┬───────────┘
           │                            │
           │ 1. Pod gets projected      │
           │    SA token (auto-mounted) │
           │                            │
           ▼                            ▼
┌──────────────────────┐     ┌──────────────────────┐
│ Azure SDK in         │     │ Entra ID             │
│ OpenClaw code        │     │                      │
│                      │     │ Validates:           │
│ DefaultAzure-        ├────►│ • OIDC issuer match  │
│ Credential()         │     │ • Subject match      │
│                      │     │ • Audience match     │
│ (auto-discovers      │     │                      │
│  workload identity)  │     │ Returns:             │
└──────────────────────┘     │ • Azure access token │
                             │   scoped to RBAC     │
                             │   assignments        │
                             └──────────┬───────────┘
                                        │
                          ┌─────────────┼─────────────┐
                          │             │             │
                    ┌─────▼────┐ ┌─────▼────┐ ┌─────▼────┐
                    │Key Vault │ │ Storage  │ │ Cosmos   │
                    │(secrets) │ │(sessions)│ │(registry)│
                    │          │ │          │ │          │
                    │ Only     │ │ Only     │ │ Only own │
                    │ own      │ │ own      │ │ tenant   │
                    │ tenant's │ │ tenant's │ │ record   │
                    │ secrets  │ │ blobs    │ │          │
                    └──────────┘ └──────────┘ └──────────┘
```

**Key points:**
- **No static credentials** — OpenClaw pods never hold client secrets or certificates
- **Automatic token refresh** — Azure SDK handles token lifecycle
- **Blast radius containment** — if a tenant pod is compromised, the attacker can only access that tenant's resources
- **Works with Azure SDK `DefaultAzureCredential`** in Node.js — OpenClaw's TypeScript code can use `@azure/identity` package

### 18.3 RBAC Assignment Matrix

| Entra Identity | Azure Resource | RBAC Role | Scope | Purpose |
|---|---|---|---|---|
| `mi-tenant-<id>` | Key Vault `kv-tenant-<id>` | Key Vault Secrets User | Vault | Read own secrets (API keys, bot tokens) |
| `mi-tenant-<id>` | Storage `sa-tenant-<id>` | Storage Blob Data Contributor | Container | Read/write own session files, workspace |
| `mi-tenant-<id>` | Cosmos DB `tenant-registry` | Cosmos DB Data Reader | Document (own tenant-id) | Read own tenant config |
| `mi-tenant-<id>` | ACR `acr-agent-warden` | AcrPull | Registry | Pull OpenClaw container images |
| `mi-agent-warden-control` | Key Vault `kv-tenant-*` | Key Vault Administrator | Resource Group | Manage all tenant vaults (provisioning, rotation) |
| `mi-agent-warden-control` | Cosmos DB `tenant-registry` | Cosmos DB Data Contributor | Database | Create/update/delete tenant records |
| `mi-agent-warden-control` | Managed Identities | Managed Identity Operator | Resource Group | Create/delete per-tenant identities |
| `mi-agent-warden-control` | AKS | Azure Kubernetes Service Cluster Admin | Cluster | Create namespaces, deploy pods |
| `mi-agent-warden-control` | Log Analytics | Log Analytics Contributor | Workspace | Write audit events |

### 18.4 Permission Grant Flow (Provisioning)

When a new tenant is provisioned, the orchestrator creates all identity and RBAC resources:

```
warden.tenant.provision("tenant-xyz789")
         │
         ▼
┌─────────────────────────────────────────────┐
│ Step 1: Create Managed Identity             │
│   az identity create                        │
│     --name mi-tenant-xyz789                 │
│     --resource-group rg-agent-warden-tenants    │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 2: Create Federated Credential         │
│   az identity federated-credential create   │
│     --identity mi-tenant-xyz789             │
│     --issuer <AKS-OIDC-issuer>              │
│     --subject system:serviceaccount:        │
│              tenant-xyz789:openclaw          │
│     --audience api://AzureADTokenExchange    │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 3: Create Key Vault                    │
│   az keyvault create                        │
│     --name kv-tenant-xyz789                 │
│     --enable-rbac-authorization true        │
│     --enable-purge-protection true          │
│     --enable-soft-delete true               │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 4: Assign RBAC Roles                   │
│   az role assignment create                 │
│     --role "Key Vault Secrets User"         │
│     --assignee <mi-tenant-xyz789-principal> │
│     --scope <kv-tenant-xyz789-id>           │
│                                             │
│   az role assignment create                 │
│     --role "Storage Blob Data Contributor"  │
│     --assignee <mi-tenant-xyz789-principal> │
│     --scope <sa-tenant-xyz789/container>    │
└────────────────────┬────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────┐
│ Step 5: Create K8s ServiceAccount           │
│   apiVersion: v1                            │
│   kind: ServiceAccount                      │
│   metadata:                                 │
│     name: openclaw                          │
│     namespace: tenant-xyz789                │
│     annotations:                            │
│       azure.workload.identity/client-id:    │
│         <mi-tenant-xyz789-client-id>        │
│     labels:                                 │
│       azure.workload.identity/use: "true"   │
└────────────────────┬────────────────────────┘
                     │
                     ▼
    Tenant pod starts → auto-gets
    Entra token → accesses only its
    own Azure resources
```

### 18.5 Cross-Tenant Permission Isolation Verification

The Agent Warden Server can verify that no tenant identity has access to another tenant's resources:

```typescript
// agent-warden/src/tools/permissions.ts

interface PermissionVerifyInput {
  tenantId: string;
}

interface PermissionVerifyResult {
  tenantId: string;
  identity: string;
  assignments: {
    resource: string;
    role: string;
    scope: string;
    isOwnResource: boolean;   // Must be true for all
  }[];
  crossTenantAccess: boolean;  // Must be false
  violations: string[];
}
```

New Agent Warden tool: `warden.permissions.verify` — runs periodically and on provisioning to assert no cross-tenant RBAC leaks exist.

### 18.6 Conditional Access for OpenClaw Admin Portal

Tenant admins who manage their OpenClaw instances via the self-service portal authenticate through Entra ID with enforced policies:

| Conditional Access Policy | Effect |
|---|---|
| Require MFA | All admin logins require multi-factor authentication |
| Block legacy protocols | Only modern auth (OAuth 2.0 / OIDC) allowed |
| Named locations | Optional geo-restrictions per tenant |
| Device compliance | Optional: require Intune-compliant device |
| Sign-in risk | Block sign-ins flagged as risky by Entra ID Protection |
| Session controls | 1-hour session lifetime, re-auth on sensitive operations (secret management, channel config) |

### 18.7 Per-Agent Delegated Identity for Third-Party SaaS (§18.7)

Each OpenClaw instance is dedicated to a single user as a personal assistant. The agent acts **on behalf of that user** when accessing third-party SaaS (Google Workspace, Microsoft 365, Salesforce, etc.). This requires delegated permissions — the user consents once, and the agent uses OAuth 2.0 delegated flows to call APIs as the user.

#### 18.7.1 Identity Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Microsoft Entra ID                                                          │
│                                                                              │
│  App Registration: app-openclaw-<tenantId>                                   │
│  ┌─────────────────────────────────────────────────────────────────────────┐ │
│  │  Application (client) ID: <guid>                                        │ │
│  │  Redirect URI: https://portal.example.com/auth/callback/<tenantId>     │ │
│  │                                                                         │ │
│  │  Delegated API Permissions (granted by user consent):                   │ │
│  │  ┌───────────────────────────────────────────────────────────────────┐  │ │
│  │  │ Microsoft Graph:  Calendars.ReadWrite, Mail.Read, Files.Read     │  │ │
│  │  │ Google Workspace: calendar.events, gmail.readonly, drive.readonly │  │ │
│  │  │ Salesforce:       api, refresh_token                              │  │ │
│  │  │ (scopes selected by user during consent — not admin-forced)       │  │ │
│  │  └───────────────────────────────────────────────────────────────────┘  │ │
│  │                                                                         │ │
│  │  Federated Credential (for pod auth):                                   │ │
│  │    Issuer:  https://oidc.prod-aks.azure.com/<cluster-id>               │ │
│  │    Subject: system:serviceaccount:tenant-<id>:openclaw                  │ │
│  └─────────────────────────────────────────────────────────────────────────┘ │
│                                                                              │
│  User: frank@contoso.com                                                     │
│    └── Consented to app-openclaw-<tenantId> for: Graph, Google, Salesforce  │
│    └── Can revoke any time via Entra "My Apps" or SaaS admin panel          │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### 18.7.2 Consent & Token Flow

```
 ┌────────────────────┐
 │  User (browser)     │
 │  frank@contoso.com  │
 └────────┬───────────┘
          │
          │ 1. Navigate to portal → "Connect Google Calendar"
          ▼
 ┌────────────────────┐     ┌───────────────────────────┐
 │  Self-Service       │────►│  accounts.google.com      │
 │  Onboarding Portal  │     │  OAuth consent screen      │
 └────────────────────┘     │                            │
          ▲                  │  "OpenClaw Agent wants to: │
          │                  │   - View your calendars     │
          │                  │   - View your Drive files"  │
          │                  └──────────┬────────────────┘
          │                             │
          │ 3. Portal stores            │ 2. User clicks "Allow"
          │    refresh token            │    → auth code → token exchange
          │    in Key Vault             │    → refresh_token returned
          │                             │
          │                             ▼
          │                  ┌───────────────────────────┐
          └──────────────────│  kv-tenant-<tenantId>     │
                             │  Secret: google-refresh   │
                             │  Secret: salesforce-refresh│
                             │  Secret: graph-refresh    │
                             └───────────────────────────┘
                                        │
                                        │ CSI Driver mounts
                                        ▼
                             ┌───────────────────────────┐
                             │  Pi Agent (tenant pod)     │
                             │                            │
                             │  http://localhost:9090     │
                             │  → SaaS Auth Proxy sidecar │
                             │                            │
                             │  Proxy fetches refresh     │
                             │  token → exchanges for     │
                             │  short-lived access token   │
                             │  → injects Authorization   │
                             │  → forwards to SaaS API    │
                             └───────────────────────────┘
```

#### 18.7.3 SaaS Auth Proxy Sidecar

The SaaS Auth Proxy runs as a sidecar container alongside the OpenClaw Gateway. It intercepts all outbound SaaS API calls, injects authentication, and enforces per-tenant policies.

```
┌────────────────────────────────────────────────────────────────────┐
│  Tenant Pod                                                        │
│                                                                    │
│  ┌──────────────┐   ┌──────────────────┐   ┌──────────────────┐  │
│  │  OpenClaw     │──►│  SaaS Auth Proxy  │──►│  SaaS APIs       │  │
│  │  Gateway +    │   │  :9090            │   │  (Google, Graph, │  │
│  │  Pi Agent     │   │                   │   │   Salesforce)    │  │
│  │              │   │  Route table:      │   │                  │  │
│  │  All SaaS    │   │  /google/* → Google│   │  Authorization:  │  │
│  │  calls go    │   │  /graph/*  → Graph │   │  Bearer <token>  │  │
│  │  to          │   │  /sfdc/*   → SFDC  │   │  (injected by    │  │
│  │  localhost   │   │                   │   │   proxy)          │  │
│  │  :9090       │   │  Features:         │   └──────────────────┘  │
│  │              │   │  • Token caching   │                         │
│  └──────────────┘   │  • Path allowlist  │                         │
│                     │  • Request audit   │                         │
│  ┌──────────────┐   │  • DLP integration │                         │
│  │  LLM DLP     │   └──────────────────┘                          │
│  │  Proxy :8080 │                                                  │
│  └──────────────┘                                                  │
└────────────────────────────────────────────────────────────────────┘
```

**Key design decisions:**
- **Agent code never sees raw tokens** — the proxy is the only component that touches refresh/access tokens
- **Per-request audit logging** — every SaaS API call is logged with tenant ID, target API, path, HTTP method, response status
- **Path-level policy enforcement** — proxy can block specific API paths (e.g., allow `calendar.events.list` but block `gmail.send`)
- **Token caching** — access tokens cached in-memory for their lifetime (~50min for Google, ~1h for Graph), no repeated exchange calls
- **DLP integration** — proxy can pipe response bodies through Purview DLP before returning to Pi Agent

#### 18.7.4 Supported SaaS Providers

| Provider | Auth Method | Consent Flow | Token Storage | Revocation |
|---|---|---|---|---|
| Microsoft Graph (M365) | OAuth 2.0 auth code + PKCE | Entra consent prompt via portal | `graph-refresh` in Key Vault | Entra "My Apps" portal |
| Google Workspace | OAuth 2.0 auth code | Google consent screen via portal | `google-refresh` in Key Vault | Google Account → Security → Third-party access |
| Salesforce | OAuth 2.0 auth code | Salesforce Connected App consent | `sfdc-refresh` in Key Vault | Salesforce Setup → Connected Apps → Revoke |
| Slack | OAuth 2.0 V2 | Slack app install flow | `slack-token` in Key Vault | Slack admin → Manage Apps |
| GitHub | OAuth 2.0 / GitHub App | GitHub App install flow | `github-token` in Key Vault | GitHub Settings → Applications → Revoke |
| Custom / API-key only | API key (stored) | Admin enters key in portal | `custom-<name>` in Key Vault | Delete secret from vault |

#### 18.7.5 Security Properties

| Property | How It's Achieved |
|---|---|
| No static credentials in Pod | Refresh tokens in Key Vault, CSI-mounted read-only; access tokens in proxy memory only |
| User can revoke at any time | Standard OAuth revocation in each SaaS provider's UI |
| Blast radius containment | Compromised pod can only access *that user's* data in consented SaaS — no other users, no admin-level access |
| Conditional Access coverage | For M365: Entra CA policies apply to all delegated token refreshes (MFA, location, risk) |
| Audit trail | Proxy logs + Agent Warden audit + Entra sign-in logs (for M365) + SaaS native audit (for Google, Salesforce) |
| Path-level least privilege | Proxy enforces API path allowlists per tenant tier, beyond OAuth scope grants |
| Token auto-rotation | Azure Key Vault rotation policy for refresh tokens nearing expiry (Event Grid notification) |
| DLP on SaaS responses | Proxy can scan response bodies via Purview before returning to agent — prevents exfil through tool output |

#### 18.7.6 Provisioning Additions

When provisioning a tenant, the orchestrator additionally:

```
warden.tenant.provision("tenant-frank")
         │
         ... (existing steps 1–5) ...
         │
         ▼
┌─────────────────────────────────────────────────┐
│ Step 6: Create Entra App Registration            │
│   az ad app create                               │
│     --display-name "OpenClaw Agent - frank"      │
│     --sign-in-audience AzureADMyOrg              │
│     --web-redirect-uris                          │
│       https://portal.example.com/auth/callback/  │
│               tenant-frank                        │
│                                                   │
│   az ad app federated-credential create          │
│     --id <app-object-id>                          │
│     --parameters '{                               │
│       "issuer": "<AKS-OIDC-issuer>",             │
│       "subject": "system:serviceaccount:          │
│                   tenant-frank:openclaw",          │
│       "audiences": ["api://AzureADTokenExchange"] │
│     }'                                            │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────┐
│ Step 7: Store App Reg metadata in Cosmos DB      │
│   {                                               │
│     "tenantId": "tenant-frank",                   │
│     "appRegistration": {                          │
│       "appId": "<client-id>",                     │
│       "objectId": "<object-id>",                  │
│       "redirectUri": "https://portal.example.com/ │
│                       auth/callback/tenant-frank"  │
│     },                                            │
│     "saasConnections": {}                         │
│   }                                               │
└────────────────────┬────────────────────────────┘
                     │
                     ▼
    User navigates to portal → connects SaaS
    accounts → refresh tokens stored in Key Vault
```

---

## 19. Activity Tracing (Agent365-Style Audit)

Inspired by the Microsoft 365 Copilot agent audit model (Purview audit logs with `CopilotInteraction` records, agent management events, and accessed resource tracking), this section defines an equivalent activity tracing system for OpenClaw instances.

### 19.1 Why Agent365-Style Tracing

The Microsoft 365 agent audit model provides:
- **Every agent interaction** logged with prompt/response metadata
- **Accessed resources** tracked (files, sites, emails) with sensitivity labels
- **Agent identity** recorded (AgentId, AgentName, AgentVersion)
- **Plugin/skill usage** tracked per interaction
- **Model transparency** (which LLM, version, provider)
- **XPIA detection** (cross-prompt injection attack flags)
- **Correlation** across Purview audit, Sentinel SIEM, and compliance tools

OpenClaw needs the same level of tracing for multi-tenant hosting — every agent action, every resource access, every tool execution must be auditable.

### 19.2 Audit Record Schema

Modeled after the M365 `CopilotInteraction` record type:

```typescript
// agent-warden/src/audit/schema.ts

interface OpenClawInteraction {
  // === Record Identity ===
  recordId: string;                    // Unique audit record ID
  recordType: "OpenClawInteraction" | "OpenClawAdminAction" | "OpenClawSkillExecution";
  timestamp: string;                   // ISO 8601
  tenantId: string;

  // === Agent Identity (like M365 AgentId/AgentName) ===
  agent: {
    id: string;                        // OpenClaw agent identifier
    name: string;                      // Agent display name (from AGENTS.md)
    version: string;                   // OpenClaw version running
    model: string;                     // LLM model (e.g., "anthropic/claude-opus-4-6")
    modelProvider: string;             // "openai" | "anthropic" | "azure-openai"
  };

  // === Interaction Context (like M365 AppHost/Contexts) ===
  context: {
    channel: string;                   // "telegram" | "slack" | "discord" | "webchat" | "control-ui"
    channelUserId: string;             // Hashed sender ID (not PII)
    sessionId: string;                 // OpenClaw session ID
    sessionType: "main" | "group" | "dm";
    appHost: string;                   // "gateway" | "device-node" | "api"
  };

  // === Messages (like M365 Messages array) ===
  messages: {
    id: string;                        // Message ID
    isPrompt: boolean;                 // true = user input, false = agent response
    size: number;                      // Token count (not raw text — privacy)
    dlpClassification: string;         // Purview sensitivity label
    jailbreakDetected: boolean;        // Prompt injection detection flag
    xpiaDetected: boolean;             // Cross-prompt injection from accessed resources
  }[];

  // === Accessed Resources (like M365 AccessedResources) ===
  accessedResources: {
    id: string;                        // Resource identifier
    name: string;                      // Filename or resource name
    type: string;                      // "workspace-file" | "session-history" | "skill-data" | "url"
    action: "read" | "create" | "modify" | "delete";
    sensitivityLabelId?: string;       // Purview sensitivity label on the resource
    status: "success" | "blocked";     // Blocked by DLP or permission policy
    policyDetails?: {                  // If blocked
      policyId: string;
      policyName: string;
      reason: string;
    };
  }[];

  // === Skill/Tool Usage (like M365 AISystemPlugin) ===
  skills: {
    name: string;                      // Skill package name
    version: string;                   // Skill version
    type: "bundled" | "managed" | "workspace";
    sandboxId?: string;                // Docker sandbox instance ID
    duration: number;                  // Execution time (ms)
    networkBytesOut: number;           // Egress bytes
    filesWritten: number;              // Files created/modified
    exitCode: number;
    defenderAlerts: string[];          // Any Defender alerts during execution
  }[];

  // === LLM API Call Details (model transparency) ===
  llmCalls: {
    provider: string;                  // "openai" | "anthropic" | "azure-openai"
    model: string;                     // "gpt-5.4" | "gpt-4o" | "claude-opus-4-6"
    modelVersion: string;
    promptTokens: number;
    completionTokens: number;
    duration: number;                  // API call latency (ms)
    dlpScanResult: "allowed" | "redacted" | "blocked";
    cost?: number;                     // Estimated cost (USD) for metering
  }[];

  // === Security Signals ===
  security: {
    dlpPoliciesTriggered: string[];    // DLP policies that matched
    sensitivityLabel: string;          // Overall interaction sensitivity
    defenderAlerts: string[];          // Defender for Containers alerts
    anomalyScore?: number;             // Behavioral anomaly score
  };
}
```

### 19.3 Comparison: M365 Agent Audit vs. OpenClaw Audit

| M365 Agent Audit Field | OpenClaw Equivalent | Notes |
|---|---|---|
| `Operation: CopilotInteraction` | `recordType: "OpenClawInteraction"` | 1:1 mapping |
| `AgentId` | `agent.id` | OpenClaw agent identifier |
| `AgentName` | `agent.name` | From AGENTS.md config |
| `AgentVersion` | `agent.version` | OpenClaw semver |
| `AppHost` (Teams, Word, etc.) | `context.channel` (Telegram, Slack, etc.) | Channel as "host app" |
| `AppIdentity` | `context.appHost` + `agent.id` | Combined identity |
| `Messages[].isPrompt` | `messages[].isPrompt` | Same pattern |
| `Messages[].JailbreakDetected` | `messages[].jailbreakDetected` | Same field |
| `AccessedResources[].SensitivityLabelId` | `accessedResources[].sensitivityLabelId` | Purview labels on resources |
| `AccessedResources[].Action` | `accessedResources[].action` | read/create/modify/delete |
| `AccessedResources[].PolicyDetails` | `accessedResources[].policyDetails` | DLP block details |
| `AccessedResources[].Status` | `accessedResources[].status` | success/blocked |
| `AISystemPlugin` | `skills[]` | Skills are OpenClaw's "plugins" |
| `ModelTransparencyDetails` | `llmCalls[].provider/model/modelVersion` | Model transparency |
| `Contexts[].Type` | `context.sessionType` | Session context |
| N/A (M365 doesn't have this) | `skills[].defenderAlerts` | Container-level monitoring |
| N/A | `llmCalls[].dlpScanResult` | DLP on LLM calls |
| N/A | `llmCalls[].cost` | Multi-tenant metering |

### 19.4 Audit Event Pipeline

```
┌──────────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway (per tenant)                                    │
│                                                                   │
│  ┌─────────────┐   ┌──────────────┐   ┌───────────────────────┐  │
│  │ Inbound msg │──►│ Agent        │──►│ Outbound response     │  │
│  │ (channel)   │   │ processing   │   │ (channel)             │  │
│  └──────┬──────┘   └──────┬───────┘   └───────────┬───────────┘  │
│         │                 │                       │              │
│         │    ┌────────────┼───────────────────────┘              │
│         │    │            │                                      │
│         ▼    ▼            ▼                                      │
│  ┌─────────────────────────────────────────────────────────┐     │
│  │  OpenClaw Audit Emitter (sidecar / instrumented)        │     │
│  │  Constructs OpenClawInteraction record per interaction  │     │
│  └───────────────────────────┬─────────────────────────────┘     │
└──────────────────────────────┼───────────────────────────────────┘
                               │
                    ┌──────────▼──────────┐
                    │  Agent Warden       │
                    │  warden.audit     │
                    │  .ingest()          │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              │                │                │
     ┌────────▼───────┐ ┌─────▼──────┐ ┌───────▼───────┐
     │ Log Analytics  │ │ Microsoft  │ │ Azure Blob    │
     │ (hot query,    │ │ Sentinel   │ │ (immutable,   │
     │  90-day)       │ │ (SIEM      │ │  WORM, 1yr+)  │
     │                │ │  analytics)│ │               │
     │ KQL queries:   │ │            │ │ Long-term     │
     │ tenant-scoped  │ │ Correlation│ │ compliance    │
     │ RBAC           │ │ with       │ │ archive       │
     └────────────────┘ │ Defender + │ └───────────────┘
                        │ Purview    │
                        │ DLP alerts │
                        └────────────┘
```

### 19.5 KQL Queries for Tenant Activity Tracing

Tenants can query their own activity through the self-service portal (scoped by tenant RBAC in Log Analytics):

#### All interactions for a tenant in the last 24h

```kql
OpenClawAudit_CL
| where tenantId_s == "tenant-abc123"
| where TimeGenerated > ago(24h)
| where recordType_s == "OpenClawInteraction"
| project TimeGenerated, 
    channel = context_channel_s,
    sessionId = context_sessionId_s,
    agentModel = agent_model_s,
    promptTokens = llmCalls_promptTokens_d,
    completionTokens = llmCalls_completionTokens_d,
    dlpTriggered = security_dlpPoliciesTriggered_s,
    skillsUsed = skills_name_s
| order by TimeGenerated desc
```

#### Skills execution with security signals

```kql
OpenClawAudit_CL
| where tenantId_s == "tenant-abc123"
| where recordType_s == "OpenClawSkillExecution"
| where TimeGenerated > ago(7d)
| summarize 
    executions = count(),
    avgDuration = avg(skills_duration_d),
    totalEgress = sum(skills_networkBytesOut_d),
    defenderAlerts = countif(isnotempty(skills_defenderAlerts_s))
    by skills_name_s
| order by executions desc
```

#### Detect anomalous access patterns (platform security)

```kql
OpenClawAudit_CL
| where TimeGenerated > ago(1h)
| where recordType_s == "OpenClawInteraction"
| where accessedResources_status_s == "blocked"
| summarize 
    blockedCount = count(),
    tenants = dcount(tenantId_s),
    topReasons = make_set(accessedResources_policyDetails_reason_s, 5)
    by bin(TimeGenerated, 5m)
| where blockedCount > 10
| order by TimeGenerated desc
```

#### LLM cost per tenant (metering)

```kql
OpenClawAudit_CL
| where recordType_s == "OpenClawInteraction"
| where TimeGenerated > ago(30d)
| extend cost = todouble(llmCalls_cost_d)
| summarize 
    totalCost = sum(cost),
    totalPromptTokens = sum(todouble(llmCalls_promptTokens_d)),
    totalCompletionTokens = sum(todouble(llmCalls_completionTokens_d)),
    interactions = count()
    by tenantId_s
| order by totalCost desc
```

#### Jailbreak / prompt injection attempts

```kql
OpenClawAudit_CL
| where TimeGenerated > ago(7d)
| where messages_jailbreakDetected_b == true 
    or messages_xpiaDetected_b == true
| project TimeGenerated,
    tenantId_s,
    context_channel_s,
    context_sessionId_s,
    jailbreak = messages_jailbreakDetected_b,
    xpia = messages_xpiaDetected_b,
    dlpTriggered = security_dlpPoliciesTriggered_s
| order by TimeGenerated desc
```

### 19.6 Admin Activity Tracing

Beyond agent interactions, all administrative actions are traced (mirroring M365's admin audit):

```typescript
interface OpenClawAdminAction {
  recordType: "OpenClawAdminAction";
  timestamp: string;
  tenantId: string;
  actor: {
    userId: string;              // Entra ID Object ID
    userPrincipalName: string;   // UPN (for display)
    role: string;                // "tenant:owner" | "platform:operator" etc.
    ipAddress: string;
    mfaAuthenticated: boolean;
    pimElevated: boolean;        // Was PIM elevation used?
  };
  operation: string;
  resource: string;
  details: Record<string, unknown>;
}
```

| Operation | Trigger | Logged Details |
|---|---|---|
| `tenant.created` | Provisioning | Tier, region, admin email |
| `tenant.suspended` | Abuse/billing/incident | Reason, actor |
| `tenant.deleted` | GDPR deletion request | Crypto-shred confirmation |
| `channel.configured` | Tenant adds/removes channel | Channel type, DM policy |
| `channel.dmPolicy.changed` | DM policy update | Old policy → new policy |
| `secret.rotated` | Key rotation (manual or auto) | Secret name, rotation type |
| `secret.accessed` | Secret read by workload identity | Secret name, identity |
| `skill.installed` | Skill added to tenant | Skill name, version, scan results |
| `skill.removed` | Skill removed | Skill name, reason |
| `skill.allowlist.updated` | Platform security updates allowlist | Skill name, action (add/remove) |
| `config.changed` | `openclaw.json` modified | Changed keys (values redacted) |
| `sandbox.policy.changed` | Sandbox settings updated | Old policy → new policy |
| `permissions.verified` | Sentinel cross-tenant RBAC check | Identity, violations found |
| `dlp.policy.updated` | DLP policy change | Policy name, change type |

### 19.7 Purview Audit Integration

OpenClaw audit records can be ingested into Microsoft Purview Audit alongside native M365 agent events, providing a **unified audit view** across both M365 Copilot agents and OpenClaw agents:

```
┌──────────────────────────────────────────────────────────────┐
│  Microsoft Purview Unified Audit Log                          │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ M365 Copilot Agent Events                               │  │
│  │ RecordType: CopilotInteraction                          │  │
│  │ AppIdentity: Copilot.Studio.*                           │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │ OpenClaw Agent Events (via Sentinel → Purview connector)│  │
│  │ RecordType: OpenClawInteraction                         │  │
│  │ AppIdentity: OpenClaw.Tenant.<tenant-id>                │  │
│  └─────────────────────────────────────────────────────────┘  │
│                                                               │
│  Unified search: "Show me all agent interactions across       │
│  M365 Copilot AND OpenClaw for user X in the last 7 days"   │
│                                                               │
│  Unified DLP: Same DLP policies apply to both M365 agents    │
│  and OpenClaw agents                                          │
│                                                               │
│  Unified DSPM for AI: Data Security Posture Management        │
│  covers both M365 Copilot and OpenClaw AI interactions       │
└──────────────────────────────────────────────────────────────┘
```

### 19.8 Agent Warden Audit Tools

| MCP Tool | Purpose |
|---|---|
| `warden.audit.ingest` | Ingest an OpenClawInteraction record into the audit pipeline |
| `warden.audit.query` | Query audit logs (tenant-scoped or platform-scoped based on caller role) |
| `warden.audit.export` | Export audit records for compliance (encrypted, tenant-scoped) |
| `warden.audit.retention.set` | Configure retention period per tenant (based on tier) |
| `warden.audit.anomaly.detect` | Trigger anomaly detection on recent audit records |
| `warden.audit.report.generate` | Generate compliance report from audit data (SOC 2, HIPAA) |

---

## 20. External Data Source Authorization

OpenClaw tenants need to access external data sources (Google Workspace, GitHub, Jira, Salesforce, etc.) for skills and agent workflows. This section defines how the platform securely brokers OAuth 2.0 flows and manages third-party tokens.

### 20.1 Problem: OpenClaw Containers Can't Run OAuth Flows

OAuth 2.0 Authorization Code flow requires:
1. A **redirect URI** reachable from the identity provider
2. A **client secret** registered with the provider
3. A **user-facing browser** for consent

OpenClaw tenant containers have none of these — they run inside isolated network namespaces with no public endpoints. The platform must broker the OAuth flow on behalf of each tenant.

### 20.2 Architecture: Platform OAuth Broker

```
┌──────────────────────────────────────────────────────────────────────┐
│  Tenant Admin Browser                                                 │
│                                                                       │
│  1. "Connect Google Workspace" button in self-service portal          │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Sentinel OAuth Broker (Control Plane)                                │
│  https://auth.gw.example.com/oauth                                   │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐   │
│  │ 2. Build authorization URL with:                               │   │
│  │    • client_id (platform's app registered with Google)         │   │
│  │    • redirect_uri = https://auth.gw.example.com/callback       │   │
│  │    • scope = requested permissions (e.g., gmail.readonly)      │   │
│  │    • state = encrypted(tenant-id + nonce + timestamp)          │   │
│  │    • PKCE code_challenge (for public client security)          │   │
│  └────────────────────────────────────┬───────────────────────────┘   │
│                                       │                               │
│  ┌────────────────────────────────────▼───────────────────────────┐   │
│  │ 3. Redirect tenant admin to Google consent screen              │   │
│  └────────────────────────────────────┬───────────────────────────┘   │
│                                       │                               │
│  ┌────────────────────────────────────▼───────────────────────────┐   │
│  │ 4. Google calls back with authorization code                   │   │
│  │    → OAuth Broker validates state parameter                    │   │
│  │    → Exchanges code for access_token + refresh_token           │   │
│  │    → Encrypts tokens and stores in tenant's Key Vault          │   │
│  │    → Records connection in tenant registry                     │   │
│  │    → Emits audit event: connection.external.created            │   │
│  └────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Azure Key Vault (kv-tenant-abc123)                                   │
│                                                                       │
│  Secret: google-workspace-access-token   (short-lived, auto-rotated) │
│  Secret: google-workspace-refresh-token  (long-lived, encrypted)     │
│  Tag: provider=google, scope=gmail.readonly+drive.readonly           │
│  Tag: connected-by=admin@tenant.com, connected-at=2026-03-13        │
└──────────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway Pod (tenant-abc123)                                 │
│                                                                       │
│  Workload Identity → Key Vault → reads access token                  │
│  Uses token to call Google APIs on behalf of tenant                  │
│  When token expires → calls Sentinel Token Refresh service           │
└──────────────────────────────────────────────────────────────────────┘
```

### 20.3 Supported Authorization Patterns

| Pattern | Use Case | Examples | How It Works |
|---|---|---|---|
| **OAuth 2.0 Authorization Code + PKCE** | User-delegated access to SaaS APIs | Google Workspace, Microsoft Graph, GitHub, Salesforce, Slack | Platform OAuth Broker handles consent flow; tokens in Key Vault |
| **OAuth 2.0 Client Credentials** | App-to-app access (no user context) | Google Service Account, M365 app-only, Jira server | Client ID + secret stored in Key Vault; tenant pod uses directly |
| **API Key** | Simple key-based auth | OpenAI, Anthropic, SendGrid, Twilio | Key stored in Key Vault (already handled by Section 6) |
| **Service Account JSON** | Google Cloud service-to-service | Google Workspace Admin SDK, GCP APIs | JSON key file mounted via CSI driver from Key Vault |
| **Personal Access Token (PAT)** | Developer-oriented APIs | GitHub PAT, GitLab PAT, Atlassian API token | Stored as Key Vault secret; auto-rotation reminders |

### 20.4 Google Workspace Integration (Detailed Example)

#### Step 1: Platform-Level App Registration

The platform registers **one OAuth app** with Google (not one per tenant):

```
Google Cloud Console:
  Project: agent-warden-platform
  OAuth 2.0 Client:
    Name: Agent Warden - OpenClaw Multi-Tenant
    Type: Web application
    Authorized redirect URIs:
      - https://auth.gw.example.com/oauth/callback/google
    Scopes requested (configurable per connection):
      - https://www.googleapis.com/auth/gmail.readonly
      - https://www.googleapis.com/auth/drive.readonly
      - https://www.googleapis.com/auth/calendar.readonly
      - https://www.googleapis.com/auth/admin.directory.user.readonly
```

The platform's Google client ID and client secret are stored in the **control plane's** Key Vault (not tenant vaults).

#### Step 2: Tenant Initiates Connection

```jsonc
// POST /api/v1/tenants/tenant-abc123/connections
// Auth: Bearer <tenant-admin-jwt>
{
  "provider": "google-workspace",
  "scopes": [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/drive.readonly"
  ],
  "label": "Company Google Workspace"
}
// Response:
{
  "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?client_id=...&redirect_uri=...&scope=...&state=<encrypted>&code_challenge=<pkce>&response_type=code",
  "connectionId": "conn-g-xyz789"
}
```

#### Step 3: Consent & Token Storage

After the admin completes Google consent:

```
Google → https://auth.gw.example.com/oauth/callback/google
         ?code=4/abc123...
         &state=<encrypted(tenant-id + nonce + timestamp)>

OAuth Broker:
  1. Decrypt + validate state (tenant-id, nonce, expiry)
  2. Exchange code → tokens (using PKCE code_verifier)
  3. Store in Key Vault:
     kv-tenant-abc123:
       google-workspace-conn-xyz789-access-token = "<access_token>"
       google-workspace-conn-xyz789-refresh-token = "<refresh_token>"
       google-workspace-conn-xyz789-metadata = {
         "provider": "google-workspace",
         "scopes": ["gmail.readonly", "drive.readonly"],
         "connectedBy": "admin@company.com",
         "connectedAt": "2026-03-13T10:30:00Z",
         "expiresAt": "2026-03-13T11:30:00Z"  // access token expiry
       }
  4. Record in Cosmos DB: tenant connection registry
  5. Audit event: warden.audit.ingest({
       recordType: "OpenClawAdminAction",
       operation: "connection.external.created",
       details: { provider: "google-workspace", scopes: [...] }
     })
```

#### Step 4: OpenClaw Uses the Token

```typescript
// Inside OpenClaw skill or agent code
// The platform injects a token provider, not raw tokens

import { SentinelTokenProvider } from "@agent-warden/token-provider";

const tokenProvider = new SentinelTokenProvider({
  connectionId: "conn-g-xyz789",
  // Uses Workload Identity → Key Vault under the hood
});

// Get a valid access token (auto-refreshes if expired)
const token = await tokenProvider.getAccessToken("google-workspace");

// Use with Google APIs
const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages", {
  headers: { Authorization: `Bearer ${token}` }
});
```

### 20.5 Token Lifecycle Management

```
┌──────────────────────────────────────────────────────────┐
│  Token Refresh Service (runs in agent-warden-control)         │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Cron: every 5 minutes                               │  │
│  │                                                     │  │
│  │ For each tenant connection:                         │  │
│  │   1. Check access token expiry from Key Vault tags  │  │
│  │   2. If expires within 10 min:                      │  │
│  │      → Use refresh token to get new access token    │  │
│  │      → Store new access token in Key Vault          │  │
│  │      → Update expiry tag                            │  │
│  │   3. If refresh token fails (revoked/expired):      │  │
│  │      → Mark connection as "disconnected"            │  │
│  │      → Notify tenant admin                          │  │
│  │      → Audit event: connection.external.broken      │  │
│  └─────────────────────────────────────────────────────┘  │
│                                                           │
│  ┌─────────────────────────────────────────────────────┐  │
│  │ Cron: daily                                         │  │
│  │                                                     │  │
│  │ Check for stale connections:                        │  │
│  │   - Access token last used > 30 days → warn tenant  │  │
│  │   - Connection > 90 days → suggest reauthorization  │  │
│  └─────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### 20.6 Scope Governance & Least Privilege

The platform controls what scopes tenants can request per provider and tier:

```jsonc
{
  "externalConnections": {
    "google-workspace": {
      "platformClientId": "<google-oauth-client-id>",
      "allowedScopes": {
        "free": [
          "https://www.googleapis.com/auth/gmail.readonly"
        ],
        "pro": [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/drive.readonly",
          "https://www.googleapis.com/auth/calendar.readonly"
        ],
        "enterprise": [
          "https://www.googleapis.com/auth/gmail.readonly",
          "https://www.googleapis.com/auth/gmail.send",
          "https://www.googleapis.com/auth/drive",
          "https://www.googleapis.com/auth/calendar",
          "https://www.googleapis.com/auth/admin.directory.user.readonly"
        ]
      },
      "maxConnectionsPerTenant": {
        "free": 1,
        "pro": 5,
        "enterprise": 20
      },
      "requiredDlpScan": true     // DLP scan data fetched from Google
    },
    "microsoft-graph": {
      "platformClientId": "<entra-app-client-id>",
      "allowedScopes": {
        "free": ["User.Read", "Mail.Read"],
        "pro": ["User.Read", "Mail.Read", "Files.Read", "Calendars.Read"],
        "enterprise": ["User.Read", "Mail.ReadWrite", "Files.ReadWrite", "Calendars.ReadWrite", "Sites.Read.All"]
      },
      "requiredDlpScan": true
    },
    "github": {
      "platformClientId": "<github-oauth-app-id>",
      "allowedScopes": {
        "free": ["read:user", "repo:status"],
        "pro": ["read:user", "repo", "read:org"],
        "enterprise": ["read:user", "repo", "admin:org", "admin:repo_hook"]
      },
      "requiredDlpScan": false
    }
  }
}
```

### 20.7 DLP on External Data

When OpenClaw fetches data from an external source, Purview DLP scans the content before it enters the agent pipeline:

```
Google Drive API ──► OpenClaw skill fetches file
                            │
                            ▼
                    ┌───────────────────┐
                    │ DLP Intercept     │
                    │ (Purview scan)    │
                    │                   │
                    │ Classify content: │
                    │ • PII detected?   │
                    │ • PHI detected?   │
                    │ • Sensitivity     │
                    │   label applied   │
                    └───────┬───────────┘
                            │
                  ┌─────────┼─────────┐
                  │         │         │
               Clean    Sensitive   Blocked
                  │      (label +    (PHI in
                  │      redact)    non-HIPAA)
                  │         │         │
                  ▼         ▼         ▼
            Agent gets  Agent gets  Data not
            full data   redacted    delivered,
                        data        admin alerted
```

This is critical because external data sources may contain sensitive data that tenants don't realize they're exposing to the LLM.

### 20.8 Connection Security Controls

| Control | Implementation |
|---|---|
| **No tokens in containers** | Tokens stored in Key Vault, accessed via Workload Identity |
| **Token isolation** | Each tenant's tokens in their own Key Vault — no cross-tenant access |
| **Scope restriction** | Platform allowlist prevents over-permissioned OAuth scopes |
| **PKCE on all OAuth flows** | Mitigates authorization code interception |
| **State parameter encryption** | Prevents CSRF on callback |
| **Refresh token encryption** | Stored encrypted in Key Vault Premium (HSM-backed) |
| **Token usage audit** | Every token access logged via Key Vault diagnostics |
| **Stale connection cleanup** | Daily check for unused connections |
| **Revocation on tenant delete** | All external tokens revoked during tenant deletion |
| **DLP on fetched data** | Purview scans all data pulled from external sources |
| **Consent transparency** | Tenant admin sees exactly what scopes are requested before consenting |

### 20.9 Revoking External Connections

```
Tenant admin clicks "Disconnect Google Workspace"
         │
         ▼
┌─────────────────────────────────────────────────┐
│ Agent Warden: warden.connection.revoke()      │
│                                                  │
│ 1. Revoke token at provider:                     │
│    POST https://oauth2.googleapis.com/revoke     │
│    ?token=<access_token>                         │
│                                                  │
│ 2. Delete from Key Vault:                        │
│    az keyvault secret delete                     │
│      --vault kv-tenant-abc123                    │
│      --name google-workspace-conn-xyz789-*       │
│                                                  │
│ 3. Update tenant registry (Cosmos DB):           │
│    connection status = "revoked"                 │
│                                                  │
│ 4. Audit event:                                  │
│    connection.external.revoked                   │
│    (provider, scopes, revokedBy, reason)         │
│                                                  │
│ 5. Purge Key Vault soft-deleted secrets          │
│    (after retention period)                      │
└─────────────────────────────────────────────────┘
```

### 20.10 Agent Warden Connection Tools

| MCP Tool | Purpose |
|---|---|
| `warden.connection.create` | Initiate OAuth flow for an external provider |
| `warden.connection.callback` | Handle OAuth callback (internal, not tenant-facing) |
| `warden.connection.list` | List active external connections for a tenant |
| `warden.connection.revoke` | Revoke and clean up an external connection |
| `warden.connection.refresh` | Force-refresh an access token |
| `warden.connection.health` | Check health of all connections (token validity, scope) |
| `warden.connection.scopes` | List allowed scopes for a provider + tier |

### 20.11 Supported External Providers

| Provider | Auth Pattern | Key Scopes | Data DLP Required |
|---|---|---|---|
| **Google Workspace** | OAuth 2.0 Auth Code + PKCE | Gmail, Drive, Calendar, Admin | Yes |
| **Microsoft Graph** | OAuth 2.0 Auth Code + PKCE (via Entra ID) | Mail, Files, Calendar, Teams | Yes |
| **GitHub** | OAuth 2.0 Auth Code | Repos, issues, PRs, user profile | No (code repos, not PII) |
| **Slack** | OAuth 2.0 Auth Code | Channels, messages, files | Yes |
| **Jira / Atlassian** | OAuth 2.0 Auth Code | Issues, projects, boards | No |
| **Salesforce** | OAuth 2.0 Auth Code | Contacts, opportunities, cases | Yes |
| **Notion** | OAuth 2.0 Auth Code | Pages, databases | Yes |
| **Linear** | OAuth 2.0 Auth Code | Issues, projects | No |
| **Confluence** | OAuth 2.0 Auth Code | Pages, spaces | Yes |
| **Dropbox** | OAuth 2.0 Auth Code | Files, folders | Yes |

New providers can be added by registering an OAuth app and adding the provider config to the `externalConnections` configuration.

---

## 21. OpenClaw Inventory & Monitoring

Managing a fleet of tenant OpenClaw instances at scale requires a centralized inventory, lifecycle controls, health monitoring, and usage analytics — mirroring what Microsoft 365's **Copilot Control System (CCS)** provides for M365 Copilot agents.

### 21.1 Design Goals

| Goal | Description |
|------|-------------|
| **Single pane of glass** | Platform operators see every tenant instance, its state, version, and health from one console |
| **Lifecycle governance** | Instances follow a defined lifecycle with approval gates before going active |
| **Proactive monitoring** | Unhealthy or misbehaving instances are detected and surfaced before tenants notice |
| **Usage analytics** | Adoption, throughput, cost, and quality-of-service data are available for operators and tenants |
| **Self-service tenant view** | Tenants can see their own instance status, usage, and health without operator involvement |

### 21.2 Instance Registry (≈ M365 Agent Registry)

All OpenClaw instances are tracked in a central **Instance Registry** stored in Azure Cosmos DB alongside the existing Tenant Registry.

#### Lifecycle States

```
Requested → Provisioning → Active → Suspended → Archived → Deleted
                              ↓          ↑
                          Degraded ───────┘
```

| State | Description | Trigger |
|-------|-------------|---------|
| **Requested** | Tenant submitted provisioning request | Self-service portal / API |
| **Provisioning** | Namespace, secrets, pods being created | Approval workflow completed |
| **Active** | Healthy, accepting messages | Provisioning finished + health check passed |
| **Degraded** | Running but with issues (e.g., channel disconnected, high error rate) | Automated health checks |
| **Suspended** | Frozen — pods scaled to 0, data retained | Security incident / billing / operator action |
| **Archived** | Data export prepared, resources released | Tenant offboarding request |
| **Deleted** | Crypto-shredded, namespace deleted | Retention period expired (GDPR §10) |

#### Registry Record Schema

```jsonc
{
  "tenantId": "tenant-acme-corp",
  "instanceId": "oc-acme-corp-prod",
  "state": "Active",
  "version": "0.9.28",
  "tier": "Pro",
  "region": "eastus2",
  "createdAt": "2025-01-15T08:00:00Z",
  "lastHealthCheck": "2025-07-15T14:30:00Z",
  "healthStatus": "Healthy",
  "activeChannels": ["slack", "telegram", "web"],
  "skillCount": 12,
  "podCount": 2,
  "cpuUsagePct": 34,
  "memoryUsagePct": 51,
  "messagesLast24h": 1847,
  "llmTokensLast24h": 284000,
  "ownerIdentity": "acme-sp-openclaw@acme.onmicrosoft.com",
  "tags": { "department": "engineering", "costCenter": "CC-4200" }
}
```

#### M365 CCS Capability Mapping

| M365 CCS Feature | OpenClaw Platform Equivalent | Azure Service |
|---|---|---|
| Agent Registry (list all agents) | Instance Registry in Cosmos DB | Cosmos DB + Admin Portal |
| Availability filter (All users / No users) | Instance state filter (Active / Suspended / All) | Admin Portal UI |
| Publish / Deploy | Provision / Activate instance | Agent Warden `warden.tenant.provision` |
| Pin agent | Mark instance as "Featured" for org discovery | Registry metadata flag |
| Block agent | Suspend instance | Agent Warden `warden.tenant.suspend` |
| Remove / Delete agent | Archive / Delete instance | Agent Warden + crypto-shred pipeline |
| Approve Updates | Version upgrade approval workflow | Azure DevOps Pipeline + approval gate |
| Export Inventory | Export all instances as CSV/JSON | Admin Portal + `warden.inventory.export` |
| Manage Ownerless Agents | Detect instances with unresolved `ownerIdentity` | Scheduled Entra ID reconciliation |
| Reassign Agent | Transfer instance ownership | `warden.inventory.reassign` |
| Connector management | Channel & external connection governance | §20 OAuth Broker + Admin Portal |
| DLP policy on publishing | DLP scan on instance activation (§16) | Purview DLP + Agent Warden |

### 21.3 Health Monitoring

#### 21.3.1 Health Check Architecture

```
┌────────────────────────────────────────────────────┐
│                Health Check Controller              │
│          (CronJob — every 60 s per instance)        │
└───────────────┬──────────────┬─────────────────────┘
                │              │
      ┌─────────▼──────┐  ┌───▼──────────────┐
      │  Pod Liveness   │  │  Deep Health     │
      │  (K8s probes)   │  │  (openclaw doctor)│
      └─────────┬──────┘  └───┬──────────────┘
                │              │
      ┌─────────▼──────────────▼─────────────┐
      │       Health Aggregator Service       │
      │  (computes composite health score)    │
      └─────────────────┬───────────────────-─┘
                        │
         ┌──────────────┼──────────────┐
         ▼              ▼              ▼
  Instance Registry   Azure Monitor   Alert Rules
  (state update)      (custom metrics) (Action Groups)
```

#### 21.3.2 Health Dimensions

| Dimension | Check Method | Healthy Threshold | Degraded Threshold |
|-----------|-------------|-------------------|-------------------|
| **Pod status** | Kubernetes API | All pods Running | ≥1 pod CrashLoopBackOff |
| **Gateway connectivity** | WebSocket ping :18789 | RTT < 500 ms | RTT > 2 s or timeout |
| **Channel connectivity** | Per-channel heartbeat | All configured channels connected | ≥1 channel disconnected > 5 min |
| **LLM reachability** | Proxy health endpoint | API responds < 3 s | API error rate > 10% |
| **Memory / CPU** | Container Insights | < 80% of limit | > 90% of limit |
| **Message processing** | Queue depth + latency | Avg latency < 5 s | Avg latency > 30 s or queue > 100 |
| **Skill health** | Skill heartbeat probes | All active skills responding | ≥1 skill timeout |
| **Disk usage** | PVC metrics | < 70% capacity | > 90% capacity |
| **Certificate validity** | TLS cert check | > 30 days to expiry | < 7 days to expiry |
| **openclaw doctor** | CLI diagnostic command | All checks pass | ≥1 check failed |

OpenClaw's built-in `openclaw doctor` command is leveraged as a deep health probe, run inside the container via `kubectl exec`. Results are parsed and fed into the Health Aggregator.

#### 21.3.3 Composite Health Score

Each dimension produces a score: **1** (Healthy), **0.5** (Degraded), or **0** (Unhealthy). The composite score is a weighted average:

```
Composite = (0.20 × Pod) + (0.15 × Gateway) + (0.15 × Channel)
          + (0.15 × LLM) + (0.10 × CPU/Mem) + (0.10 × MsgProcessing)
          + (0.05 × Skill) + (0.05 × Disk) + (0.025 × Cert) + (0.025 × Doctor)
```

| Composite Score | Instance State |
|----------------|----------------|
| ≥ 0.8 | Healthy (Active) |
| 0.5 – 0.79 | Degraded |
| < 0.5 | Unhealthy → auto-escalate to operator |

#### 21.3.4 Azure Monitor Integration

Health data flows into Azure Monitor via **Container Insights** and **custom metrics**:

| Data Source | Azure Service | Retention |
|---|---|---|
| Pod metrics (CPU, memory, restarts) | Container Insights → Log Analytics | 90 days |
| Custom health scores | Azure Monitor custom metrics | 93 days (standard) |
| Health check logs | Log Analytics workspace | 180 days |
| Health state changes | Cosmos DB (Instance Registry) | Indefinite |
| Alert history | Azure Monitor Alerts | 30 days (fired), 1 year (history) |

### 21.4 Monitoring Dashboards

Modeled after M365's **Copilot Dashboard** and **Agent Dashboard** in Viva Insights.

#### 21.4.1 Platform Operator Dashboard (Azure Managed Grafana)

**Azure Managed Grafana** provides the primary operator dashboard, pulling data from Log Analytics and Azure Monitor:

| Panel | Metrics | Visualization |
|-------|---------|---------------|
| **Fleet Overview** | Total instances by state (Active/Degraded/Suspended) | Stat + pie chart |
| **Instance Health Map** | All instances with composite health score | Heat map (green/yellow/red) |
| **Version Distribution** | Instances by OpenClaw version | Bar chart |
| **Tier Breakdown** | Instances by tier (Free/Pro/Enterprise) | Pie chart |
| **Top-N Resource Consumers** | CPU, memory, LLM tokens — top 10 tenants | Table |
| **Message Throughput** | Messages/min across fleet, per region | Time series |
| **Error Rate** | 5xx errors, timeout rate, DLP blocks | Time series |
| **Channel Status** | Connected vs disconnected channels, by type | Stacked bar |
| **Provisioning Pipeline** | Instances in Requested/Provisioning state, avg provision time | Stat + timeline |
| **Alert Summary** | Active alerts by severity | Table with links |

#### 21.4.2 Tenant Self-Service Dashboard (Azure Workbooks)

Tenants access their own instance dashboard via **Azure Monitor Workbooks** embedded in the self-service portal. Data is scoped to the tenant's namespace via Entra ID RBAC.

| Panel | Data |
|-------|------|
| Instance Status | Current state, version, uptime, health score |
| Channel Health | Per-channel connectivity status and last message time |
| Usage Summary | Messages processed (24h/7d/30d), LLM tokens consumed |
| Skill Inventory | Active skills, versions, last execution time |
| External Connections | Connected providers, token expiry, last sync |
| Cost Estimate | Compute + LLM token cost for current billing period |
| Alerts | Tenant-scoped alerts (channel down, resource near limit) |

### 21.5 Usage Analytics

Modeled after M365 Copilot Analytics' five areas:

| M365 Copilot Analytics Area | OpenClaw Equivalent | Implementation |
|---|---|---|
| **Readiness & Adoption Report** | Tenant onboarding funnel — requested → active, time-to-first-message | KQL over Cosmos DB change feed + Log Analytics |
| **Copilot Dashboard** | Platform Fleet Dashboard (§21.4.1) — aggregate health, throughput, cost | Azure Managed Grafana |
| **Agent Dashboard** | Tenant Instance Dashboard (§21.4.2) — per-tenant view | Azure Monitor Workbooks |
| **Copilot Analytics Reports** | Pre-built KQL reports: channel usage, skill popularity, LLM cost trends | Log Analytics saved queries + Workbooks |
| **Advanced Reporting** | Power BI dataflows connected to Log Analytics export | Power BI + Azure Data Explorer (ADX) |

#### 21.5.1 Key Metrics

| Category | Metric | Granularity | Source |
|----------|--------|-------------|--------|
| **Adoption** | Active instances (DAI/WAI/MAI) | Daily | Instance Registry |
| **Adoption** | New tenants provisioned | Weekly | Cosmos DB change feed |
| **Usage** | Messages processed | Per-instance, per-channel | OpenClawInteraction audit (§19) |
| **Usage** | LLM tokens consumed | Per-instance, per-model | LLM proxy logs |
| **Usage** | Skills invoked | Per-instance, per-skill | Audit records |
| **Usage** | External data fetches | Per-instance, per-provider | OAuth Broker logs |
| **Performance** | P50 / P95 / P99 message latency | Per-instance | Application Insights |
| **Performance** | LLM response latency | Per-model | LLM proxy metrics |
| **Cost** | Compute cost | Per-instance | AKS container metrics + pricing API |
| **Cost** | LLM token cost | Per-instance, per-model | Token counter × model pricing |
| **Security** | DLP block count | Per-instance | Purview audit (§16) |
| **Security** | Defender alerts | Per-instance | Defender for Containers |
| **Quality** | Error rate | Per-instance | Application Insights |
| **Quality** | User satisfaction (if feedback collected) | Per-instance | Custom telemetry |

#### 21.5.2 Advanced Reporting with Power BI

For organizations needing analytics beyond built-in dashboards:

1. **Log Analytics Data Export** → Azure Data Explorer (ADX) or Storage Account
2. **Power BI DirectQuery** connects to ADX for real-time analytics
3. Pre-built Power BI template provides:
   - Executive summary (fleet size, growth trend, aggregate cost)
   - Per-tenant drill-down (usage, cost, health history)
   - Channel effectiveness comparison
   - Skill usage ranking and trend
   - LLM cost forecasting (time-series projection)
   - Security posture score (DLP blocks, Defender alerts, policy violations)

### 21.6 Alerting & Automated Response

#### 21.6.1 Alert Rules

| Alert | Severity | Condition | Action |
|-------|----------|-----------|--------|
| Instance Unhealthy | Sev 1 | Composite health < 0.5 for > 5 min | Page on-call + Agent Warden auto-investigate |
| Instance Degraded | Sev 2 | Composite health 0.5–0.79 for > 15 min | Notify operator Slack/Teams channel |
| Pod CrashLoop | Sev 1 | RestartCount > 5 in 10 min | Auto-collect logs + create incident |
| High LLM Cost | Sev 3 | Token spend > 150% of tier daily budget | Notify tenant + operator |
| Channel Disconnected | Sev 2 | Channel offline > 10 min | Notify tenant + auto-reconnect attempt |
| Version Drift | Sev 3 | Instance > 2 minor versions behind latest | Notify operator, add to upgrade queue |
| Disk Near Full | Sev 2 | PVC usage > 90% | Notify tenant + expand if auto-scaling enabled |
| Certificate Expiry | Sev 2 | TLS cert < 7 days to expiry | Auto-renew via cert-manager or alert |
| Fleet Anomaly | Sev 1 | > 10% of fleet simultaneously Degraded/Unhealthy | Page platform lead + create P1 incident |
| Orphaned Instance | Sev 3 | Owner identity unresolvable in Entra ID > 7 days | Notify platform admin for reassignment |

#### 21.6.2 Automated Response Chain

```
Alert Fired → Azure Monitor Action Group
  ├── Notify: Email / Teams / PagerDuty
  ├── Log Analytics: Create incident record
  ├── Logic App / Sentinel Playbook:
  │     ├── Collect diagnostic snapshot (openclaw doctor, pod logs, events)
  │     ├── Check if known issue (match against KB)
  │     ├── If auto-recoverable → execute remediation
  │     │     ├── Restart pod (CrashLoop)
  │     │     ├── Reconnect channel (disconnect)
  │     │     ├── Scale up (resource pressure)
  │     │     └── Rotate credential (auth failure)
  │     └── If not auto-recoverable → escalate to operator with full context
  └── Agent Warden: Update instance state in Registry
```

### 21.7 Inventory Management MCP Tools

New Agent Warden tools for inventory and monitoring:

| Tool | Purpose | Access |
|------|---------|--------|
| `warden.inventory.list` | List all instances with optional filters (state, tier, region, health, version) | Platform Operator |
| `warden.inventory.get` | Get detailed instance record including health score and metrics | Platform Operator, Tenant (own instance) |
| `warden.inventory.export` | Export full inventory as JSON/CSV | Platform Operator |
| `warden.inventory.reassign` | Transfer instance ownership to new Entra ID identity | Platform Operator |
| `warden.inventory.tags` | Add/update/remove tags on an instance (cost center, department, etc.) | Platform Operator, Tenant |
| `warden.monitoring.health` | Get current composite health score and per-dimension breakdown | Platform Operator, Tenant (own) |
| `warden.monitoring.metrics` | Query usage metrics for an instance over a time range | Platform Operator, Tenant (own) |
| `warden.monitoring.alerts` | List active and recent alerts for an instance or the fleet | Platform Operator, Tenant (own) |
| `warden.monitoring.diagnose` | Trigger on-demand diagnostic (openclaw doctor + pod inspect + log snapshot) | Platform Operator |
| `warden.monitoring.fleet` | Get fleet-wide summary: counts by state, avg health, total throughput | Platform Operator |

### 21.8 Version & Upgrade Management

Part of inventory governance is tracking and managing OpenClaw versions across the fleet.

#### Upgrade Strategies

| Strategy | Description | Use Case |
|----------|-------------|----------|
| **Canary** | Upgrade 1–2% of instances first, monitor for 24h, then proceed | Default for minor/patch versions |
| **Rolling** | Upgrade instances in batches (10% at a time) with automated rollback on health degradation | Standard production upgrades |
| **Tenant-initiated** | Tenant triggers upgrade from self-service portal (within allowed version range) | Pro/Enterprise tenants who want control |
| **Forced** | Platform pushes upgrade to all instances (with 72h notice) | Critical security patches |

#### Version Policy

```yaml
versionPolicy:
  minimumSupported: "0.9.26"    # Instances below this are force-upgraded
  recommended: "0.9.28"          # Shown as upgrade target in portal
  latest: "0.9.29-beta"          # Available for Enterprise opt-in
  maxVersionDrift: 2              # Alert if instance is >2 minor versions behind
  autoUpgrade:
    free: true                    # Free tier auto-upgraded on rolling schedule
    pro: false                    # Pro tier notified, tenant-initiated
    enterprise: false             # Enterprise tier fully controlled by tenant
```

---

## 22. Open Questions

- [ ] Should tenants be allowed to bring custom OpenClaw images (BYOI), or must they use the platform-managed image?
- [ ] How to handle OpenClaw version upgrades across tenants — rolling, opt-in, or forced?
- [ ] Should the platform proxy LLM API calls (enabling usage metering) or let tenants use their own API keys directly?
- [x] ~~What is the trust boundary for skills from ClawHub?~~ → Resolved in Section 17: allowlist mode with platform security review, vulnerability scanning, and per-skill sandbox policies
- [ ] How to handle WhatsApp's phone-number-per-session requirement in multi-tenant (each tenant needs their own number)?
- [ ] Should device nodes (iOS/Android/macOS) be supported in multi-tenant, or is it gateway-only?
- [ ] Should Enterprise tenants be allowed to bring a private ClawHub registry (BYOR) with custom skill vetting?
- [ ] Should tenants be allowed to register their own OAuth apps with external providers, or must they use the platform's shared app?

---

## 23. Implementation Plan

### 23.1 Guiding Principles

| Principle | Rationale |
|-----------|-----------|
| **Security first, features second** | Each phase ends with a security gate; no feature ships without isolation + audit |
| **One tenant before many** | Prove the full stack for a single tenant end-to-end before scaling horizontally |
| **Progressive hardening** | Start with platform-managed controls and layer tenant self-service only after guardrails exist |
| **Ship incremental value** | Every phase delivers a usable platform with a concrete tenant capacity target |
| **Automate or block** | Manual operations are tech-debt — automate lifecycle actions or block them from production |

### 23.2 Team Structure

| Role | Count | Responsibility |
|------|-------|---------------|
| **Platform Engineering Lead** | 1 | Architecture decisions, cross-team coordination, security reviews |
| **AKS / Infra Engineers** | 2 | Cluster provisioning, networking, storage, GitOps, CI/CD pipelines |
| **Agent Warden Developers** | 2 | MCP server, policy engine, MCP tools, Kubernetes operator (CRD) |
| **Security Engineer** | 1 | Threat modeling, Defender config, Purview DLP rules, penetration testing |
| **Identity / IAM Engineer** | 1 | Entra ID, Workload Identity, Conditional Access, OAuth Broker |
| **Observability Engineer** | 1 | Log Analytics, Grafana dashboards, alerting, audit pipeline |
| **Frontend / Portal Developer** | 1 | Tenant self-service portal, dashboard embedding |
| **QA / Reliability Engineer** | 1 | Chaos testing, DR drills, load testing, compliance verification |

### 23.3 Phase 0 — Design Validation & Spike (Weeks 1–3)

**Goal:** Validate critical assumptions before committing to the full build.

| # | Task | Owner | Deliverable | Done When |
|---|------|-------|-------------|-----------|
| 0.1 | Run single OpenClaw instance in AKS with StatefulSet + PVC | Infra | Working pod with persistent state surviving reschedule | Pod drain + reattach preserves all §4.5.1 state |
| 0.2 | Validate Workload Identity → Key Vault secret injection | IAM | Pod reads secret from Key Vault without static credentials | `env | grep OPENAI_API_KEY` returns value inside pod |
| 0.3 | Prototype Agent Warden Server (3 tools: provision, suspend, health) | MCP Dev | Running MCP server callable via MCP client | `warden.tenant.provision` creates namespace + pod |
| 0.4 | Test OpenClaw `openclaw doctor` inside container | Infra | Verify deep health probe works as init/CronJob | Doctor output parseable, all checks pass |
| 0.5 | Validate graceful shutdown — SIGTERM flush behavior | MCP Dev | Confirm session JSONL + cron state flush within 30 s | Kill pod mid-conversation → no data loss on PVC |
| 0.6 | Spike: Purview DLP API latency for inline scanning | Security | Measure P50/P95 latency for classify + evaluate | Latency acceptable (< 200 ms P95) for intercept point 2 |
| 0.7 | Resolve §22 Open Questions with stakeholders | Lead | Decision log for each open question | All questions marked resolved or deferred |

**Exit criteria:** All spikes green; decision log published; architecture review sign-off.

---

### 23.4 Phase 1 — Foundation (Weeks 4–11)

**Goal:** Single-region AKS cluster capable of running isolated tenant instances with encrypted persistent storage, basic lifecycle management, and audit logging. Target: **10 tenants (internal/alpha).**

#### 23.4.1 Infrastructure (Weeks 4–6)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 1.1 | Provision AKS cluster (Azure CNI, Calico, private cluster, 3 AZ node pool) | — | Infra | §12 |
| 1.2 | Create StorageClasses (`managed-premium-zrs`, `managed-premium-lrs`, `managed-standard-zrs`) | 1.1 | Infra | §4.5.4 |
| 1.3 | Deploy Secrets Store CSI Driver + Azure Key Vault provider | 1.1 | Infra | §6.2 |
| 1.4 | Deploy Application Gateway for Containers (AGC) with WAF policy + ALB Controller | 1.1 | Infra | §7, §15 |
| 1.5 | Provision Azure Cosmos DB (tenant registry + instance registry) | — | Infra | §3.1, §21.2 |
| 1.6 | Set up Log Analytics workspace + diagnostic settings | 1.1 | Observability | §9 |
| 1.7 | Enable Microsoft Defender for Containers (eBPF sensor) | 1.1 | Security | §15.5 |
| 1.8 | Create Azure Container Registry (ACR) + image scanning | — | Infra | §17 |
| 1.9 | Set up GitOps repo (Flux/ArgoCD) for cluster state | 1.1 | Infra | §14.1 |

#### 23.4.2 Identity & Secrets (Weeks 5–7)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 1.10 | Entra ID tenant config: App Registration for platform, Workload Identity issuer | 1.1 | IAM | §18 |
| 1.11 | Automation: per-tenant Key Vault provisioning (Premium HSM-backed) | 1.10 | IAM | §6.1 |
| 1.12 | Automation: per-tenant User-Assigned Managed Identity + Workload Identity Federation | 1.10 | IAM | §18.2, §18.3 |
| 1.13 | SecretProviderClass template for per-tenant Key Vault binding | 1.3, 1.11 | IAM | §6.2 |

#### 23.4.3 Tenant Lifecycle (Weeks 6–9)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 1.14 | Kubernetes Operator: `OpenClawTenant` CRD + reconciliation controller | 1.1 | MCP Dev | §10 |
| 1.15 | Operator: create namespace, NetworkPolicy, ResourceQuota, LimitRange | 1.14 | MCP Dev | §4.1, §4.2, §8 |
| 1.16 | Operator: StatefulSet deployment with `volumeClaimTemplates` (state-vol + work-vol) | 1.14, 1.2 | MCP Dev | §4.5.3 |
| 1.17 | Operator: init container for memory index rebuild | 1.16 | MCP Dev | §4.5.8 |
| 1.18 | Operator: preStop hook for graceful shutdown | 1.16 | MCP Dev | §4.5.7 |
| 1.19 | Ingress routing: webhook path + WebSocket per-tenant routing rules | 1.4, 1.14 | Infra | §7.1, §7.2 |
| 1.20 | Agent Warden Server: `warden.tenant.provision`, `.suspend`, `.delete`, `.health` | 1.14, 1.5 | MCP Dev | §11 |
| 1.21 | Instance Registry: lifecycle state tracking (Requested → Active → Suspended → Deleted) | 1.5, 1.20 | MCP Dev | §21.2 |

#### 23.4.4 Health & Audit (Weeks 8–11)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 1.22 | Health Check Controller CronJob (pod liveness + openclaw doctor) | 1.16 | Observability | §21.3 |
| 1.23 | Health Aggregator: composite health score + Registry state update | 1.22, 1.21 | Observability | §21.3.3 |
| 1.24 | Basic audit event pipeline: OpenClawInteraction → Log Analytics | 1.6 | Observability | §9, §19 |
| 1.25 | Immutable audit blob storage (WORM policy) | — | Infra | §9 |
| 1.26 | Azure Disk snapshot schedule (every 6 h) for PVCs | 1.16 | Infra | §4.5.9 |

#### Phase 1 Milestones & Gates

| Milestone | Verification | Target |
|-----------|-------------|--------|
| **M1.1** Tenant provisioned end-to-end | `warden.tenant.provision` → namespace + StatefulSet + PVC + Key Vault + identity created | Week 8 |
| **M1.2** Pod reschedule preserves state | Drain node → pod rescheduled → all memory/skills/sessions intact | Week 9 |
| **M1.3** Tenant isolation verified | Penetration test: tenant A cannot reach tenant B (network, filesystem, secrets) | Week 10 |
| **M1.4** 10 alpha tenants onboarded | Internal users running OpenClaw with real channels | Week 11 |

**Exit criteria:** Penetration test report clean; all 10 alpha tenants active; health checks green; audit pipeline flowing.

---

### 23.5 Phase 2 — Security Hardening + DLP + Skills (Weeks 12–21)

**Goal:** Production-grade security posture with DLP, skill supply chain controls, activity tracing, and RBAC verification. Target: **50 tenants (closed beta).**

#### 23.5.1 DLP & Compliance (Weeks 12–15)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 2.1 | Deploy LLM Proxy sidecar (intercept point 2: DLP scan before LLM) | Phase 1 | MCP Dev | §16.1 |
| 2.2 | Integrate Purview DLP API for inbound message scanning (intercept point 1) | Phase 1 | Security | §16.1 |
| 2.3 | Create custom SITs: API keys, passwords, connection strings, private keys | — | Security | §16.2 |
| 2.4 | Configure sensitivity labels (Public → Highly Confidential) | — | Security | §16.3 |
| 2.5 | Agent Warden policy engine: DLP evaluation in `warden.policy.evaluate` | 2.1, 2.2 | MCP Dev | §11, §16 |
| 2.6 | Microsoft Sentinel SIEM workspace + Purview DLP alert connector | 1.6 | Security | §16.6 |
| 2.7 | Azure Policy / Gatekeeper: pod security standards (baseline + restricted) | Phase 1 | Security | §15 |

#### 23.5.2 Skills & Supply Chain (Weeks 14–17)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 2.8 | Platform skill allowlist registry (Cosmos DB collection) | Phase 1 | MCP Dev | §17.2 |
| 2.9 | Skill installation pipeline: fetch → verify → scan → sandbox test → install | 2.8 | MCP Dev | §17.3 |
| 2.10 | Vulnerability scanning: Trivy/Grype integration in skill pipeline | 2.9 | Security | §17.5 |
| 2.11 | Per-skill sandbox policies (filesystem mounts, network restrictions, CPU/mem limits) | 2.9 | MCP Dev | §17.4 |
| 2.12 | Agent Warden skill tools: `warden.skills.install`, `.remove`, `.list`, `.audit` | 2.8, 2.9 | MCP Dev | §17.8 |
| 2.13 | Skill version pinning + staged rollout engine | 2.12 | MCP Dev | §17.6 |

#### 23.5.3 Identity Hardening & Tracing (Weeks 16–19)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 2.14 | Entra ID Conditional Access policies for platform operators | Phase 1 | IAM | §18.5 |
| 2.15 | PIM (Privileged Identity Management) for operator roles | 2.14 | IAM | §18 |
| 2.16 | Automated credential rotation (Key Vault rotation policy + Event Grid → Agent Warden) | Phase 1 | IAM | §6.3 |
| 2.17 | OpenClawInteraction audit record schema (full Agent365-style schema) | 1.24 | MCP Dev | §19.2 |
| 2.18 | Audit pipeline: interaction records → Log Analytics + Sentinel + Blob WORM | 2.17, 2.6 | Observability | §19.3 |
| 2.19 | KQL saved queries: token usage, session volume, error rate, DLP blocks | 2.18 | Observability | §19.4 |
| 2.20 | Admin action audit: 14 operation types with before/after state capture | 2.17 | MCP Dev | §19.5 |
| 2.21 | Cross-tenant RBAC verification tool (`warden.permissions.verify`) | Phase 1 | MCP Dev | §18.4 |

#### 23.5.4 Persistent Storage Hardening (Weeks 18–20)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 2.22 | Customer-managed key (CMK) encryption for Enterprise tier PVCs | 1.11 | IAM / Infra | §4.5.4, §4.5.5 |
| 2.23 | PVC I/O throttling validation per tier (IOPS + throughput limits) | 1.2 | Infra | §4.5.5 |
| 2.24 | Git-sync sidecar for workspace memory versioning (opt-in) | 1.16 | Infra | §4.5.9 |
| 2.25 | Session transcript streaming to Azure Blob (near-real-time WORM) | 1.24 | Observability | §4.5.9 |
| 2.26 | Chaos test: simultaneous node drain of all nodes hosting 10 tenants | 2.23 | QA | §4.5.6 |

#### Phase 2 Milestones & Gates

| Milestone | Verification | Target |
|-----------|-------------|--------|
| **M2.1** DLP blocks sensitive data in LLM requests | Send API key in message → blocked + audit event + Sentinel alert | Week 15 |
| **M2.2** Skill install pipeline end-to-end | Install skill from ClawHub → scan → sandbox test → approve → available in tenant | Week 17 |
| **M2.3** Full audit trail queryable | KQL query returns OpenClawInteraction records with correct tenant scoping | Week 19 |
| **M2.4** Chaos test: zero data loss | Drain 3 nodes simultaneously → all 10 tenants recover with 0 data loss within SLA | Week 20 |
| **M2.5** 50 beta tenants onboarded | External beta users with signed BAA (if HIPAA applicable) | Week 21 |

**Exit criteria:** SOC 2 readiness checklist complete; pen test clean; DLP intercept points 1+2 operational; all beta tenants healthy.

---

### 23.6 Phase 3 — Governance + Operations (Weeks 22–33)

**Goal:** Self-service tenant experience, full DLP coverage, monitoring dashboards, external data source connectivity, and multi-region. Target: **500 tenants (GA launch).**

#### 23.6.1 Full DLP Pipeline (Weeks 22–25)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 3.1 | DLP intercept points 3–6 (session persist, tool I/O, outbound, cross-channel) | Phase 2 | MCP Dev / Security | §16.1 |
| 3.2 | Purview Data Map + per-tenant collection + automated scanning | Phase 2 | Security | §16.5 |
| 3.3 | Sensitivity labels on sessions + workspace files | 3.2 | Security | §16.3 |
| 3.4 | DLP scanning on data fetched from external sources | 3.1, 3.12 | Security | §20.6 |

#### 23.6.2 Monitoring & Dashboards (Weeks 23–27)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 3.5 | Azure Managed Grafana: Platform Operator Dashboard (fleet overview, health map, throughput) | Phase 2 | Observability | §21.4.1 |
| 3.6 | Azure Monitor Workbooks: Tenant Self-Service Dashboard | Phase 2 | Observability / Frontend | §21.4.2 |
| 3.7 | Fleet-wide alert rules (10 rules) + Azure Monitor Action Groups | Phase 2 | Observability | §21.6.1 |
| 3.8 | Automated response chain: Logic App / Sentinel Playbook (restart, reconnect, scale, rotate) | 3.7, 2.6 | MCP Dev / Observability | §21.6.2 |
| 3.9 | Inventory MCP tools: `warden.inventory.*` (list, get, export, reassign, tags) | Phase 2 | MCP Dev | §21.7 |
| 3.10 | Monitoring MCP tools: `warden.monitoring.*` (health, metrics, alerts, diagnose, fleet) | Phase 2 | MCP Dev | §21.7 |
| 3.11 | LLM cost metering from audit records + per-tenant cost dashboard | 2.18 | Observability | §21.5.1 |

#### 23.6.3 External Data & OAuth (Weeks 25–29)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 3.12 | Platform OAuth Broker service (token exchange, storage, refresh) | Phase 2 | MCP Dev / IAM | §20.2 |
| 3.13 | Google Workspace connector (Drive, Gmail, Calendar) | 3.12 | MCP Dev | §20.3 |
| 3.14 | Microsoft Graph connector (OneDrive, Outlook, Teams) | 3.12 | MCP Dev | §20 |
| 3.15 | GitHub connector (repos, issues, PRs) | 3.12 | MCP Dev | §20 |
| 3.16 | Token lifecycle management (auto-refresh, stale connection cleanup, revocation) | 3.12 | MCP Dev | §20.4 |
| 3.17 | Connection MCP tools: `warden.connections.*` | 3.12 | MCP Dev | §20.7 |

#### 23.6.4 Self-Service Portal & Upgrades (Weeks 27–31)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 3.18 | Self-service tenant portal: tenant signup, config, channels, skills, connections | Phase 2 | Frontend | §10, §17, §20 |
| 3.19 | Embed Workbook dashboards in portal (Entra ID RBAC scoped) | 3.6, 3.18 | Frontend | §21.4.2 |
| 3.20 | Tenant audit dashboard page with KQL query interface | 2.19, 3.18 | Frontend | §19 |
| 3.21 | Version & upgrade management: canary + rolling strategies | Phase 2 | MCP Dev / Infra | §21.8 |
| 3.22 | Version policy enforcement (minimum supported, max drift alert) | 3.21 | MCP Dev | §21.8 |

#### 23.6.5 Multi-Region & DR (Weeks 29–33)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 3.23 | Second AKS cluster in paired Azure region | Phase 2 | Infra | §12, §14 |
| 3.24 | Azure Front Door global routing with failover rules | 3.23 | Infra | §7, §15 |
| 3.25 | Cross-region Cosmos DB replication (tenant + instance registry) | 3.23 | Infra | §14 |
| 3.26 | Azure Disk cross-region snapshot copy (GRS vault) | 3.23 | Infra | §4.5.9, §14.1 |
| 3.27 | Azure Cost Management: per-tenant tags + chargeback reports | Phase 2 | Infra | §8 |
| 3.28 | Purview Unified Audit integration (OpenClaw events → M365 Unified Audit) | 2.18 | Security | §19.6 |
| 3.29 | DR drill: full region failover + recovery — validate RTO/RPO | 3.23–3.26 | QA | §14 |

#### Phase 3 Milestones & Gates

| Milestone | Verification | Target |
|-----------|-------------|--------|
| **M3.1** All 6 DLP intercept points operational | Trigger each intercept → correct block/alert | Week 25 |
| **M3.2** Operator dashboard live | Grafana shows all instances, health map, alerts | Week 27 |
| **M3.3** First external data source connected | Tenant connects Google Workspace → reads Drive files → DLP scans data | Week 29 |
| **M3.4** Self-service portal launch | Tenant signs up, provisions instance, configures channels, installs skill — no operator involvement | Week 31 |
| **M3.5** Multi-region DR drill passes | Region failover < 1 hr RTO, < 15 min RPO, zero data loss for ZRS tenants | Week 32 |
| **M3.6** 500 tenants at GA launch | Public launch, healthy fleet, SLA published | Week 33 |

**Exit criteria:** SOC 2 Type II audit initiated; HIPAA BAA available for Enterprise; SLA published (99.9% for Pro, 99.95% for Enterprise); all dashboards populated; DR drill report clean.

---

### 23.7 Phase 4 — Advanced Features + Compliance (Weeks 34–48)

**Goal:** Enterprise-grade capabilities including advanced analytics, compliance certifications, marketplace, and cross-tenant collaboration. Target: **2,000+ tenants.**

#### 23.7.1 Advanced Analytics (Weeks 34–38)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 4.1 | Log Analytics → Azure Data Explorer (ADX) continuous data export | Phase 3 | Observability | §21.5.2 |
| 4.2 | Power BI template: executive summary, per-tenant drill-down, LLM cost forecast | 4.1 | Observability | §21.5.2 |
| 4.3 | Purview Data Lineage for end-to-end data flow visibility | Phase 3 | Security | §16 |
| 4.4 | Purview + Sentinel correlation for automated DLP incident response playbooks | Phase 3 | Security | §16.6 |
| 4.5 | Orphaned instance detection + auto-reassignment workflow | Phase 3 | MCP Dev | §21.6 |

#### 23.7.2 Enterprise Isolation & Compliance (Weeks 36–41)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 4.6 | Azure Confidential VMs node pool for Enterprise tier | Phase 3 | Infra | §12 |
| 4.7 | Microsoft Defender for Cloud regulatory compliance dashboards (SOC 2, HIPAA, PCI DSS) | Phase 3 | Security | §13 |
| 4.8 | SOC 2 Type II audit completion | 4.7 | Lead / Security | §13 |
| 4.9 | HIPAA compliance validation + BAA enforcement | 4.7, 4.8 | Lead / Security | §13 |

#### 23.7.3 Marketplace & Collaboration (Weeks 39–45)

| # | Task | Depends On | Owner | Section Ref |
|---|------|-----------|-------|-------------|
| 4.10 | Tenant-scoped ClawHub skill marketplace with curated storefront | Phase 3 | MCP Dev / Frontend | §17 |
| 4.11 | Private skill registry (BYOR) for Enterprise tenants | 4.10 | MCP Dev | §17 |
| 4.12 | Skill behavioral sandbox testing in CI/CD (pre-allowlist automated analysis) | Phase 3 | MCP Dev / Security | §17.7 |
| 4.13 | Additional OAuth providers (Salesforce, Notion, Confluence, Jira, Dropbox, Linear) | Phase 3 | MCP Dev | §20 |
| 4.14 | Tenant-managed OAuth app registration (BYOA) for Enterprise tier | 3.12 | MCP Dev / IAM | §20 |
| 4.15 | Cross-tenant agent collaboration (opt-in, sandboxed, DLP-enforced) | Phase 3 | MCP Dev | — |

#### Phase 4 Milestones & Gates

| Milestone | Verification | Target |
|-----------|-------------|--------|
| **M4.1** Power BI analytics live | Executive summary with LLM cost forecasting accurate within 10% | Week 38 |
| **M4.2** SOC 2 Type II certified | Audit report received, no material findings | Week 41 |
| **M4.3** Skill marketplace live | Tenants browse, install, rate skills via portal | Week 43 |
| **M4.4** Enterprise tier fully operational | Confidential VMs + CMK encryption + private skill registry + BYOA | Week 45 |
| **M4.5** 2,000 tenants | Sustained fleet health ≥ 98% healthy | Week 48 |

---

### 23.8 Risk Register

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| Azure Disk attach latency during reschedule exceeds SLA | Medium | High | Use ZRS disks (multi-AZ attach); set `node.kubernetes.io/unreachable` toleration to 60 s; monitor PVC attach time |
| Purview DLP inline scanning adds unacceptable latency to chat | Medium | High | Validated in Phase 0 spike (0.6); fallback to async scan + hold-and-release pattern |
| OpenClaw upstream breaking changes in multi-tenant patches | High | Medium | Pin to stable release branch; maintain patch fork; contribute upstream |
| Key Vault throttling under high tenant count | Low | High | Use caching in CSI driver (rotation period ≥ 5 min); request quota increase at 200+ tenants |
| Tenant deliberately fills PVC to disk-full → pod crash | Medium | Medium | ResourceQuota + LimitRange cap PVC size; disk-near-full alert (§21.6) triggers proactive cleanup notification |
| WhatsApp per-number requirement limits scale | High | Medium | Provide BYOP (bring-your-own-phone) model; document limitation in onboarding |
| node failure during graceful shutdown → partial session JSONL | Low | Medium | Session transcript streaming to Blob (§4.5.9) provides real-time backup; memory markdown is synced by git-sync sidecar |

### 23.9 Success Criteria Summary

| Metric | Phase 1 | Phase 2 | Phase 3 | Phase 4 |
|--------|---------|---------|---------|---------|
| **Tenants** | 10 (alpha) | 50 (beta) | 500 (GA) | 2,000+ |
| **SLA** | Best effort | 99.5% | 99.9% Pro / 99.95% Ent | 99.9% Pro / 99.99% Ent |
| **Data loss on reschedule** | 0 | 0 | 0 | 0 |
| **DLP intercept points** | 0 | 2 (inbound + LLM) | 6 (all) | 6 + lineage |
| **Audit coverage** | Basic events | Full OpenClawInteraction | + Unified Audit (M365) | + compliance reports |
| **Regions** | 1 | 1 | 2 (active-passive) | 3+ (active-active) |
| **Compliance** | — | SOC 2 readiness | SOC 2 Type II initiated | SOC 2 + HIPAA certified |
| **Self-service** | CLI / API | CLI / API | Portal + API | Portal + Marketplace |
| **External integrations** | 0 | 0 | 3 (Google, MS Graph, GitHub) | 10+ providers |
| **Fleet health** | Manual checks | Health score + alerts | Grafana dashboard + auto-remediation | Power BI analytics + forecasting |

### 23.10 Dependency Graph (Critical Path)

```
Phase 0 (Weeks 1–3)
  │
  ├── 0.1 AKS + StatefulSet spike ──┐
  ├── 0.2 Workload Identity spike ──┤
  ├── 0.6 Purview DLP latency ──────┤
  └── 0.7 Open Questions ───────────┤
                                    ▼
Phase 1 (Weeks 4–11) ──────────────────────────────────────────────────┐
  │                                                                     │
  ├── 1.1–1.9   Infrastructure        ──┐                              │
  ├── 1.10–1.13 Identity & Secrets      ├── 1.14–1.21 Tenant Lifecycle │
  └── 1.22–1.26 Health & Audit     ────┘           │                   │
                                                    ▼                   │
                                             M1.1 First tenant ────────┤
                                             M1.3 Pen test ────────────┤
                                                                        │
Phase 2 (Weeks 12–21) ◄────────────────────────────────────────────────┘
  │
  ├── 2.1–2.7   DLP & Compliance          ──┐
  ├── 2.8–2.13  Skills & Supply Chain        ├── M2.1–M2.5
  ├── 2.14–2.21 Identity & Tracing          ─┤
  └── 2.22–2.26 Storage Hardening           ─┘
                    │
Phase 3 (Weeks 22–33) ◄──────────────────────┘
  │
  ├── 3.1–3.4   Full DLP       ──┐
  ├── 3.5–3.11  Dashboards       │
  ├── 3.12–3.17 OAuth Broker     ├── 3.18–3.22 Portal & Upgrades
  ├── 3.23–3.29 Multi-Region    ─┘       │
  │                                       ▼
  │                                M3.6 GA launch (500 tenants)
  │
Phase 4 (Weeks 34–48) ◄──────────────────┘
  │
  ├── 4.1–4.5   Analytics
  ├── 4.6–4.9   Compliance certs
  └── 4.10–4.15 Marketplace & collaboration
                    │
                    ▼
             M4.5 2,000 tenants
```

---

## Appendix A: Agent Warden Server Interface

```typescript
// agent-warden/src/tools.ts

interface TenantProvisionInput {
  tenantId: string;
  adminEmail: string;
  tier: "free" | "pro" | "enterprise";
  region: string;
  channels: ChannelConfig[];
}

interface PolicyEvaluationInput {
  tenantId: string;
  action: string;
  resource: string;
  context: Record<string, unknown>;
}

interface PolicyEvaluationResult {
  allowed: boolean;
  reason: string;
  warnings: string[];
}

interface AuditQueryInput {
  tenantId?: string;         // Scoped by caller's role
  eventType?: string;
  startTime: string;         // ISO 8601
  endTime: string;
  limit: number;
}
```

## Appendix B: Example `openclaw.json` for Multi-Tenant Instance

```jsonc
{
  // Generated by Provisioning Orchestrator — do not edit manually
  "_managedBy": "agent-warden",
  "_tenantId": "tenant-abc123",

  "agent": {
    "model": "anthropic/claude-opus-4-6"
    // API key injected via env var, NOT stored here
  },

  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "always",
        "networkMode": "none",
        "readOnlyRootFilesystem": true,
        "memoryLimit": "512m",
        "pidLimit": 100
      },
      "workspace": "/tenants/tenant-abc123/.openclaw/workspace"
    }
  },

  "gateway": {
    "bind": "loopback",
    "port": 18789,
    "auth": {
      "mode": "token"
    }
  },

  "channels": {
    "telegram": {
      "dmPolicy": "pairing"
      // botToken injected via TELEGRAM_BOT_TOKEN env var
    }
  }
}
```
