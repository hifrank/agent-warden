/**
 * agent-warden-heartbeat — Sidecar heartbeat monitor for OpenClaw gateway.
 *
 * Runs as a sidecar container in the tenant StatefulSet. Periodically:
 *   1. Probes GET /health on the gateway (HTTP latency + status)
 *   2. Execs `openclaw doctor --json` via the gateway API (deep health)
 *   3. Emits OTel metrics → OTel Collector → App Insights
 *
 * Metrics emitted:
 *   - openclaw.heartbeat.up          (gauge: 1=healthy, 0=down)
 *   - openclaw.heartbeat.latency_ms  (histogram: /health response time)
 *   - openclaw.heartbeat.doctor      (gauge: per-check pass/fail)
 *   - openclaw.heartbeat.uptime_s    (gauge: seconds since sidecar started)
 *
 * Env vars:
 *   GATEWAY_URL       — default http://127.0.0.1:18789
 *   OTEL_ENDPOINT     — default http://otel-collector.agent-warden-system.svc.cluster.local:4318/v1/metrics
 *   INTERVAL_MS       — default 30000 (30s)
 *   TENANT_ID         — tenant identifier (required)
 *   SERVICE_NAME      — OTel service name (default: openclaw-heartbeat)
 */

import { request } from "node:http";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

// ── Config ──

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://127.0.0.1:18789";
const OTEL_ENDPOINT =
  process.env.OTEL_ENDPOINT ??
  "http://otel-collector.agent-warden-system.svc.cluster.local:4318/v1/metrics";
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS ?? "30000", 10);
const TENANT_ID = process.env.TENANT_ID ?? "unknown";
const SERVICE_NAME = process.env.SERVICE_NAME ?? "openclaw-heartbeat";

// ── OTel Metrics Setup ──

const resource = resourceFromAttributes({
  [ATTR_SERVICE_NAME]: SERVICE_NAME,
  [ATTR_SERVICE_VERSION]: "0.1.0",
  "tenant.id": TENANT_ID,
});

const exporter = new OTLPMetricExporter({
  url: OTEL_ENDPOINT,
  headers: {},
});
const reader = new PeriodicExportingMetricReader({
  exporter,
  exportIntervalMillis: INTERVAL_MS,
});

const meterProvider = new MeterProvider({ resource, readers: [reader] });
const meter = meterProvider.getMeter("agent-warden-heartbeat", "0.1.0");

// ── Instruments ──

const upGauge = meter.createObservableGauge("openclaw.heartbeat.up", {
  description: "Gateway health: 1=up, 0=down",
  unit: "1",
});

const latencyHistogram = meter.createHistogram(
  "openclaw.heartbeat.latency_ms",
  {
    description: "Gateway /health response latency",
    unit: "ms",
  },
);

const doctorGauge = meter.createObservableGauge("openclaw.heartbeat.doctor", {
  description: "openclaw doctor check: 1=pass, 0=fail",
  unit: "1",
});

const uptimeGauge = meter.createObservableGauge("openclaw.heartbeat.uptime_s", {
  description: "Heartbeat sidecar uptime",
  unit: "s",
});

// ── State ──

let lastHealthUp = 0;
let lastDoctorPass = 0;
const startTime = Date.now();

// Register observable callbacks
upGauge.addCallback((obs) => {
  obs.observe(lastHealthUp, { "tenant.id": TENANT_ID });
});
doctorGauge.addCallback((obs) => {
  obs.observe(lastDoctorPass, { "tenant.id": TENANT_ID });
});
uptimeGauge.addCallback((obs) => {
  obs.observe(Math.floor((Date.now() - startTime) / 1000), {
    "tenant.id": TENANT_ID,
  });
});

// ── HTTP probe helper ──

interface ProbeResult {
  status: number;
  body: string;
  latencyMs: number;
}

function httpGet(url: string, timeoutMs: number): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const req = request(url, { timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf-8"),
          latencyMs: Date.now() - t0,
        });
      });
    });
    req.on("error", (err) => reject(err));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.end();
  });
}

// ── Heartbeat loop ──

async function heartbeat(): Promise<void> {
  // 1. Probe /health
  try {
    const result = await httpGet(`${GATEWAY_URL}/health`, 5000);
    lastHealthUp = result.status >= 200 && result.status < 400 ? 1 : 0;
    latencyHistogram.record(result.latencyMs, { "tenant.id": TENANT_ID });
    if (lastHealthUp) {
      console.log(
        `[heartbeat] /health OK (${result.status}) ${result.latencyMs}ms`,
      );
    } else {
      console.warn(
        `[heartbeat] /health FAIL (${result.status}) ${result.latencyMs}ms`,
      );
    }
  } catch (err) {
    lastHealthUp = 0;
    console.error(`[heartbeat] /health ERROR: ${(err as Error).message}`);
  }

  // 2. Probe /api/doctor (openclaw doctor via REST API if available)
  try {
    const result = await httpGet(`${GATEWAY_URL}/api/doctor`, 10000);
    if (result.status >= 200 && result.status < 400) {
      lastDoctorPass = 1;
      try {
        const doc = JSON.parse(result.body);
        const checks = doc.checks ?? doc.results ?? [];
        const failCount = Array.isArray(checks)
          ? checks.filter(
              (c: { status?: string }) =>
                c.status === "fail" || c.status === "error",
            ).length
          : 0;
        if (failCount > 0) {
          lastDoctorPass = 0;
          console.warn(
            `[heartbeat] doctor: ${failCount} failed checks`,
          );
        } else {
          console.log(
            `[heartbeat] doctor: all checks passed`,
          );
        }
      } catch {
        // Non-JSON body — just treat 2xx as pass
        console.log(`[heartbeat] doctor: OK (non-JSON response)`);
      }
    } else {
      lastDoctorPass = 0;
      console.warn(`[heartbeat] doctor: HTTP ${result.status}`);
    }
  } catch (err) {
    // /api/doctor may not exist — degrade gracefully, don't mark as fail
    lastDoctorPass = -1; // unknown
    console.log(
      `[heartbeat] doctor: unavailable (${(err as Error).message})`,
    );
  }
}

// ── Main ──

console.log(`[heartbeat] Starting for tenant=${TENANT_ID}`);
console.log(`[heartbeat]   gateway: ${GATEWAY_URL}`);
console.log(`[heartbeat]   otel:    ${OTEL_ENDPOINT}`);
console.log(`[heartbeat]   interval: ${INTERVAL_MS}ms`);

// Initial probe after short delay (let gateway start first)
setTimeout(() => {
  heartbeat();
  setInterval(heartbeat, INTERVAL_MS);
}, 10_000);

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("[heartbeat] SIGTERM received, flushing metrics...");
  await meterProvider.shutdown();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[heartbeat] SIGINT received, flushing metrics...");
  await meterProvider.shutdown();
  process.exit(0);
});
