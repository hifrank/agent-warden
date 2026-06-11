/**
 * Test Purview processContent API maximum payload size limit.
 * Sends increasingly larger payloads via binary search to find the exact threshold.
 *
 * Usage:
 *   export PURVIEW_DLP_CLIENT_SECRET="..."
 *   node --experimental-strip-types test/test-payload-limit.ts
 */

import { ClientSecretCredential } from "@azure/identity";

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET env var is required");
  process.exit(1);
}

const GRAPH_URL = `https://graph.microsoft.com/v1.0/users/${USER_ID}/dataSecurityAndGovernance/processContent`;

const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET);
let cachedToken: string | null = null;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const result = await credential.getToken("https://graph.microsoft.com/.default");
  if (!result) throw new Error("Failed to acquire token");
  cachedToken = result.token;
  return result.token;
}

function generateText(sizeBytes: number): string {
  // Generate repeating ASCII text of exact byte length
  const line = "This is a test line for payload size limit testing. ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789. ";
  const repeats = Math.ceil(sizeBytes / line.length);
  return line.repeat(repeats).slice(0, sizeBytes);
}

function buildPayload(text: string): string {
  return JSON.stringify({
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: crypto.randomUUID(),
          content: {
            "@odata.type": "microsoft.graph.textContent",
            data: text,
          },
          name: "payload-size-test",
          correlationId: crypto.randomUUID(),
          sequenceNumber: 0,
          isTruncated: false,
          createdDateTime: new Date().toISOString(),
          modifiedDateTime: new Date().toISOString(),
        },
      ],
      activityMetadata: { activity: "uploadText" },
      deviceMetadata: {
        deviceType: "Managed",
        operatingSystemSpecifications: {
          operatingSystemPlatform: "macOS",
          operatingSystemVersion: "test",
        },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "test",
        applicationLocation: {
          "@odata.type": "#microsoft.graph.policyLocationApplication",
          value: CLIENT_ID,
        },
      },
      integratedAppMetadata: {
        name: "Agent Warden",
        version: "test",
      },
    },
  });
}

interface TestResult {
  textSizeKB: number;
  payloadSizeKB: number;
  httpStatus: number;
  ok: boolean;
  error?: string;
  latencyMs: number;
}

async function testSize(textSizeBytes: number): Promise<TestResult> {
  const token = await getToken();
  const text = generateText(textSizeBytes);
  const payload = buildPayload(text);

  const textSizeKB = Math.round(textSizeBytes / 1024 * 10) / 10;
  const payloadSizeKB = Math.round(payload.length / 1024 * 10) / 10;

  const start = performance.now();
  try {
    const resp = await fetch(GRAPH_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: payload,
    });

    const latencyMs = Math.round(performance.now() - start);
    const respText = await resp.text();

    let error: string | undefined;
    if (!resp.ok) {
      try {
        const errData = JSON.parse(respText);
        error = errData?.error?.message ?? respText.slice(0, 200);
      } catch {
        error = respText.slice(0, 200);
      }
    }

    return { textSizeKB, payloadSizeKB, httpStatus: resp.status, ok: resp.ok, error, latencyMs };
  } catch (err: any) {
    const latencyMs = Math.round(performance.now() - start);
    return { textSizeKB, payloadSizeKB, httpStatus: 0, ok: false, error: err.message, latencyMs };
  }
}

async function main() {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║     Purview processContent — Payload Size Limit Test        ║");
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  await getToken();
  console.log("✓ Token acquired\n");

  // Phase 1: Quick scan with increasing sizes
  console.log("━━━ Phase 1: Quick scan (doubling sizes) ━━━\n");

  const quickSizes = [
    1 * 1024,       // 1 KB
    10 * 1024,      // 10 KB
    50 * 1024,      // 50 KB
    100 * 1024,     // 100 KB
    200 * 1024,     // 200 KB
    500 * 1024,     // 500 KB
    1024 * 1024,    // 1 MB
    2 * 1024 * 1024,  // 2 MB
    4 * 1024 * 1024,  // 4 MB
    8 * 1024 * 1024,  // 8 MB
    16 * 1024 * 1024, // 16 MB
  ];

  let lastOK = 0;
  let firstFail = 0;
  const results: TestResult[] = [];

  for (const size of quickSizes) {
    const result = await testSize(size);
    results.push(result);
    const status = result.ok ? "✓ OK" : `✗ FAIL`;
    console.log(`  ${result.textSizeKB.toString().padStart(8)} KB text | ${result.payloadSizeKB.toString().padStart(8)} KB payload | HTTP ${result.httpStatus} | ${result.latencyMs}ms | ${status}${result.error ? ` — ${result.error.slice(0, 80)}` : ""}`);

    if (result.ok) {
      lastOK = size;
    } else {
      firstFail = size;
      break;
    }
  }

  if (firstFail === 0) {
    console.log("\n  All sizes passed! Limit is > 16 MB.");
    printSummary(results);
    return;
  }

  // Phase 2: Binary search between lastOK and firstFail
  console.log(`\n━━━ Phase 2: Binary search between ${Math.round(lastOK / 1024)} KB and ${Math.round(firstFail / 1024)} KB ━━━\n`);

  let lo = lastOK;
  let hi = firstFail;

  while (hi - lo > 1024) { // 1 KB precision
    const mid = Math.floor((lo + hi) / 2);
    const result = await testSize(mid);
    results.push(result);
    const status = result.ok ? "✓ OK" : `✗ FAIL`;
    console.log(`  ${result.textSizeKB.toString().padStart(8)} KB text | ${result.payloadSizeKB.toString().padStart(8)} KB payload | HTTP ${result.httpStatus} | ${result.latencyMs}ms | ${status}${result.error ? ` — ${result.error.slice(0, 80)}` : ""}`);

    if (result.ok) {
      lo = mid;
    } else {
      hi = mid;
    }
  }

  console.log(`\n━━━ Result ━━━`);
  console.log(`  Max OK text size:   ~${Math.round(lo / 1024)} KB (${lo} bytes)`);
  console.log(`  First FAIL at:      ~${Math.round(hi / 1024)} KB (${hi} bytes)`);

  printSummary(results);
}

function printSummary(results: TestResult[]) {
  console.log("\n╔══════════════════════════════════════════════════════════════╗");
  console.log("║                        SUMMARY                             ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  for (const r of results) {
    const icon = r.ok ? "✓" : "✗";
    console.log(`║ ${icon} text=${r.textSizeKB.toString().padStart(7)}KB  payload=${r.payloadSizeKB.toString().padStart(7)}KB  HTTP=${r.httpStatus}  ${r.latencyMs}ms ║`);
  }
  console.log("╚══════════════════════════════════════════════════════════════╝");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
