/**
 * OpenTelemetry bootstrap — must be loaded via `node --import ./dist/telemetry.js`
 * BEFORE the main entry point so instrumentation hooks register before any
 * modules (http, express, etc.) are imported by the application.
 */
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-grpc";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-grpc";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
if (endpoint) {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? "agent-warden-server";
  // gRPC endpoint: strip http:// prefix and use port 4317
  const grpcEndpoint = endpoint.replace(/^https?:\/\//, "").replace(/:4318$/, ":4317");

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
    }),
    traceExporter: new OTLPTraceExporter({
      url: `http://${grpcEndpoint}`,
    }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({
        url: `http://${grpcEndpoint}`,
      }),
      exportIntervalMillis: 10_000,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.error(`[otel] Telemetry enabled → ${endpoint} (service: ${serviceName})`);

  const shutdown = () => {
    sdk.shutdown().catch((err) => console.error("[otel] shutdown error:", err));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
} else {
  console.error("[otel] OTEL_EXPORTER_OTLP_ENDPOINT not set — telemetry disabled");
}
