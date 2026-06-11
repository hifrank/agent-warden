/**
 * DLP scenario tests with checksum-VALID fake PII data.
 *
 * Unlike test-dlp-scenarios.ts (which uses the original user-provided data that
 * fails Luhn/check-digit validation), this file uses corrected fake data that
 * passes all SIT validation rules — so ALL scenarios should BLOCK.
 *
 * Usage:
 *   export PURVIEW_DLP_CLIENT_SECRET="$(kubectl get secret openclaw-demo-tenant-secrets \
 *     -n tenant-demo-tenant -o jsonpath='{.data.PURVIEW_DLP_CLIENT_SECRET}' | base64 -d)"
 *   node --experimental-strip-types test/test-dlp-scenarios-valid.ts
 */

import { ClientSecretCredential } from "@azure/identity";

// ── Configuration ──

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET env var is required");
  console.error("  export PURVIEW_DLP_CLIENT_SECRET=\"$(kubectl get secret openclaw-demo-tenant-secrets \\");
  console.error("    -n tenant-demo-tenant -o jsonpath='{.data.PURVIEW_DLP_CLIENT_SECRET}' | base64 -d)\"");
  process.exit(1);
}

// ── Types ──

interface ScanResult {
  allowed: boolean;
  actions: Array<{ action: string; [k: string]: unknown }>;
  errors: string[];
  httpStatus: number;
}

interface ScenarioResult {
  scenario: string;
  result: ScanResult;
  expected: "block" | "allow";
  pass: boolean;
}

// ── Helper: scanText ──

const GRAPH_URL = `https://graph.microsoft.com/v1.0/users/${USER_ID}/dataSecurityAndGovernance/processContent`;

let cachedToken: string | null = null;

async function getToken(): Promise<string> {
  if (cachedToken) return cachedToken;
  const credential = new ClientSecretCredential(TENANT_ID, CLIENT_ID, CLIENT_SECRET!);
  const result = await credential.getToken("https://graph.microsoft.com/.default");
  if (!result) throw new Error("Failed to acquire token");
  cachedToken = result.token;
  return result.token;
}

/**
 * Send text to Purview processContent API and return whether it's allowed or blocked.
 */
async function scanText(text: string): Promise<ScanResult> {
  const token = await getToken();

  const body = {
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: crypto.randomUUID(),
          content: {
            "@odata.type": "microsoft.graph.textContent",
            data: text,
          },
          name: "DLP scenario test (valid data)",
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
        version: "0.5.5",
        applicationLocation: {
          "@odata.type": "#microsoft.graph.policyLocationApplication",
          value: CLIENT_ID,
        },
      },
      integratedAppMetadata: {
        name: "Agent Warden",
        version: "0.5.5",
      },
    },
  };

  const resp = await fetch(GRAPH_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const responseText = await resp.text();

  if (!resp.ok) {
    return {
      allowed: true,
      actions: [],
      errors: [`HTTP ${resp.status}: ${responseText.slice(0, 300)}`],
      httpStatus: resp.status,
    };
  }

  const data = JSON.parse(responseText);
  const actions = data.policyActions ?? [];
  const errors = (data.processingErrors ?? []).map((e: any) => e.message ?? "unknown");
  const blocked = actions.some(
    (a: any) => a.action === "restrictAccess" || a.action === "block",
  );

  return { allowed: !blocked, actions, errors, httpStatus: resp.status };
}

// ── Test Scenarios (all with checksum-valid fake data) ──
//
// Changes vs original test data:
//   Scenario 1: UnionPay 6225887632109876 → 6225887632109878 (Luhn-valid)
//   Scenario 3: JCB 3528234567890123 → 3528234567890126 (Luhn-valid)
//               My Number 123456789012 → 123456789018 (valid check digit)
//   Scenario 4: INSÉE 1850672830093 → 185067283009381 (with valid 2-digit key)
//   Scenario 5: Mir 2200123456789012 → 2200123456789019 (Luhn-valid)
//               INN 770123456789 → 770123456703 (valid check digits)
//
// Passport keywords changed to proper language for each country.

interface Scenario {
  name: string;
  text: string;
  expected: "block" | "allow";
  notes: string;
}

const scenarios: Scenario[] = [
  // ── Scenario 1: China user — ChatGPT text input ──
  // UnionPay fixed to pass Luhn. China passport/ID SITs still not in policy,
  // but credit card SIT should now trigger.
  {
    name: "Scenario 1: China PII (valid Luhn)",
    text: [
      "姓名: 王伟 (Wáng Wěi)",
      "身份证号: 11010519900307783X",
      "Passport number: G12345678",
      "Credit card number: 6225887632109878",
      "地址: 北京市朝阳区建国路88号",
    ].join("\n"),
    expected: "block",
    notes: "UnionPay 6225887632109878 passes Luhn → Credit Card SIT should match. Added English keyword 'Credit card number' for corroboration.",
  },

  // ── Scenario 2: US user — Gemini file attachment (text content) ──
  // Already had valid data (Visa 4242... passes Luhn, SSN format valid).
  {
    name: "Scenario 2: US PII (valid Luhn + SSN)",
    text: [
      "Name: Michael Anderson",
      "SSN: 234-67-8901",
      "Passport number: 285194736",
      "Credit card number: 4242424242424242",
      "Address: 456 Maple Ave, Los Angeles, CA 90001",
    ].join("\n"),
    expected: "block",
    notes: "Visa 4242424242424242 passes Luhn + SSN 234-67-8901 valid. English keywords for corroboration.",
  },

  // ── Scenario 3: Japan user — ZIP file attachment (text content) ──
  // JCB fixed to pass Luhn. My Number fixed with valid check digit.
  // Added Japanese keywords for passport corroboration.
  {
    name: "Scenario 3: Japan PII (valid Luhn + My Number)",
    text: [
      "氏名: 佐藤 花子 (Sato Hanako)",
      "マイナンバー: 123456789018",
      "パスポート番号: TR1234567",
      "クレジットカード番号: 3528234567890126",
      "住所: 東京都渋谷区神宮前1-2-3",
    ].join("\n"),
    expected: "block",
    notes: "JCB 3528234567890126 passes Luhn. My Number 123456789018 has valid check digit. Japanese keywords (パスポート, マイナンバー, クレジットカード) for corroboration.",
  },

  // ── Scenario 4: France user — Claude.ai keywords ──
  // Already had valid MC card. INSÉE updated with 2-digit key.
  // Added French keywords for passport corroboration.
  {
    name: "Scenario 4: France PII (valid Luhn + INSÉE)",
    text: [
      "Nom: Marie Dupont-Lefèvre",
      "Numéro de sécurité sociale: 185067283009381",
      "Numéro de passeport: 10AB12345",
      "Numéro de carte de crédit: 5555555555554444",
      "Adresse: 15 Rue de Rivoli, 75001 Paris",
    ].join("\n"),
    expected: "block",
    notes: "MasterCard 5555555555554444 passes Luhn. INSÉE 185067283009381 has valid key (81). French keywords for corroboration.",
  },

  // ── Scenario 5: Russia user — photo attachment (text content) ──
  // Original Mir card (2200xxxx) passes Luhn but Purview Credit Card SIT doesn't
  // recognize Mir BIN range (2200-2204). Mir falls outside MC range (2221-2720).
  // Changed to MC 2221 prefix which Purview does recognize.
  // INN fixed with valid check digits. Russian keywords for corroboration.
  {
    name: "Scenario 5: Russia PII (valid Luhn + INN)",
    text: [
      "ФИО: Иванов Алексей Петрович",
      "ИНН: 770123456703",
      "Номер паспорта: 45 1234567",
      "Номер кредитной карты: 2221001234567896",
      "Адрес: ул. Тверская, д. 15, Москва, 125009",
    ].join("\n"),
    expected: "block",
    notes: "MC 2221001234567896 passes Luhn (Mir 2200 not recognized by Purview). INN 770123456703 has valid check digits. Russian keywords for corroboration.",
  },
];

// ── Runner ──

async function runScenarios(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║   Purview DLP Scenario Test — CHECKSUM-VALID fake data          ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  Tenant:  ${TENANT_ID}                      ║`);
  console.log(`║  Client:  ${CLIENT_ID}                      ║`);
  console.log(`║  User:    ${USER_ID}                      ║`);
  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log("║  All fake PII data has been corrected to pass checksum/format   ║");
  console.log("║  validation. Keywords are in the correct language per scenario.  ║");
  console.log("║  ALL scenarios should now BLOCK.                                ║");
  console.log("╚══════════════════════════════════════════════════════════════════╝");
  console.log();

  try {
    await getToken();
    console.log("✓ Token acquired successfully\n");
  } catch (err: any) {
    console.error(`✗ Failed to acquire token: ${err.message}`);
    process.exit(1);
  }

  const results: ScenarioResult[] = [];

  for (const scenario of scenarios) {
    console.log(`━━━ ${scenario.name} ━━━`);
    console.log(`  Text: "${scenario.text.slice(0, 80)}..."`);
    console.log(`  Expected: ${scenario.expected.toUpperCase()}`);
    console.log(`  Notes: ${scenario.notes}`);

    const result = await scanText(scenario.text);
    const actual = result.allowed ? "allow" : "block";
    const pass = actual === scenario.expected;

    console.log(`  HTTP: ${result.httpStatus}`);
    console.log(`  Result: ${actual.toUpperCase()} ${pass ? "✓" : "✗ MISMATCH"}`);
    if (result.actions.length > 0) {
      console.log(`  Actions: ${JSON.stringify(result.actions)}`);
    }
    if (result.errors.length > 0) {
      console.log(`  Errors: ${result.errors.join("; ")}`);
    }
    console.log();

    results.push({ scenario: scenario.name, result, expected: scenario.expected, pass });
  }

  // ── Summary ──
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║                          SUMMARY                               ║");
  console.log("╠══════════════════════════════════════════════════════════════════╣");

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const actual = r.result.allowed ? "ALLOW" : "BLOCK";
    const icon = r.pass ? "✓" : "✗";
    const status = r.pass ? "PASS" : "FAIL";
    console.log(`║ ${icon} ${r.scenario.padEnd(48)} ${actual.padEnd(6)} ${status} ║`);
    if (r.pass) passed++;
    else failed++;
  }

  console.log("╠══════════════════════════════════════════════════════════════════╣");
  console.log(`║  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}                                 ║`);
  console.log("╚══════════════════════════════════════════════════════════════════╝");

  process.exit(failed > 0 ? 1 : 0);
}

runScenarios();
