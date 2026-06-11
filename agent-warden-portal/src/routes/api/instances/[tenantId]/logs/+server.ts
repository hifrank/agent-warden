import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getEnv } from "$lib/server/env";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const GET: RequestHandler = async ({ params, url }) => {
  const env = getEnv();

  const container = url.searchParams.get("container") ?? "openclaw-gateway";
  const tail = url.searchParams.get("tail") ?? "200";
  const since = url.searchParams.get("since") ?? "3600";

  // Strip oc- prefix for warden server tenant ID
  const tenantId = params.tenantId.startsWith("oc-") ? params.tenantId.slice(3) : params.tenantId;

  // Try warden server first, fall back to local kubectl
  if (env.wardenServerUrl) {
    const upstream = `${env.wardenServerUrl}/api/tenants/${encodeURIComponent(tenantId)}/logs?container=${encodeURIComponent(container)}&tail=${tail}&since=${since}`;
    try {
      const res = await fetch(upstream);
      if (res.ok) {
        const data = await res.json();
        return json(data, { status: res.status });
      }
    } catch {
      // warden server unreachable — fall through to kubectl
    }
  }

  // Fallback: local kubectl
  const namespace = `tenant-${tenantId}`;
  const tailLines = Math.min(Math.max(parseInt(tail, 10) || 200, 10), 2000);
  const sinceSeconds = parseInt(since, 10) || 3600;

  try {
    // Find pod name
    const { stdout: podJson } = await execFileAsync("kubectl", [
      "get", "pods", "-n", namespace,
      "-l", `app.kubernetes.io/instance=${tenantId}`,
      "-o", "jsonpath={.items[0].metadata.name}",
    ], { maxBuffer: 64 * 1024 });

    const podName = podJson.trim();
    if (!podName) {
      return json({ error: "No pods found", logs: "" }, { status: 404 });
    }

    const args = [
      "logs", podName,
      "-n", namespace,
      "-c", container,
      `--tail=${tailLines}`,
      `--since=${sinceSeconds}s`,
    ];

    const { stdout: logText } = await execFileAsync("kubectl", args, { maxBuffer: 2 * 1024 * 1024 });
    return json({ podName, container, lines: tailLines, logs: logText });
  } catch (err: any) {
    return json({ error: err.message ?? "Failed to fetch logs" }, { status: 500 });
  }
};
