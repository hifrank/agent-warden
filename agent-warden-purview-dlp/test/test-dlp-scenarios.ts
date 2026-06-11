/**
 * Quick-validate text against Purview processContent API.
 *
 * Usage:
 *   export PURVIEW_DLP_TENANT_ID="2cf24558-0d31-439b-9c8d-6fdce3931ae7"
 *   export PURVIEW_DLP_CLIENT_ID="d94c93dd-3c80-4f3d-9671-8b71a7dccafa"
 *   export PURVIEW_DLP_CLIENT_SECRET="<from keyvault>"
 *   node --experimental-strip-types test/test-dlp-scenarios.ts
 */

import { ClientSecretCredential } from "@azure/identity";

// ── Configuration ──

const TENANT_ID = process.env.PURVIEW_DLP_TENANT_ID ?? "2cf24558-0d31-439b-9c8d-6fdce3931ae7";
const CLIENT_ID = process.env.PURVIEW_DLP_CLIENT_ID ?? "d94c93dd-3c80-4f3d-9671-8b71a7dccafa";
const CLIENT_SECRET = process.env.PURVIEW_DLP_CLIENT_SECRET;
const USER_ID = process.env.PURVIEW_DLP_USER_ID ?? "7ade9412-3a6e-4b37-a3a8-51d8f81de596";

if (!CLIENT_SECRET) {
  console.error("ERROR: PURVIEW_DLP_CLIENT_SECRET env var is required");
  console.error("  az keyvault secret show --vault-name kv-demo-tenant -n purview-dlp-client-secret --query value -o tsv");
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
          name: "DLP scenario test",
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

// ── Test Scenarios ──
//
// Expected results are based on Purview SIT validation rules:
// - Credit cards require valid Luhn checksum
// - SSN requires valid area (not 000/900-999), group (not 00), serial (not 0000)
// - My Number requires valid mod-11 check digit
// - INN requires valid check digits
// - Passports require corroborating keywords in the expected language
// - INSÉE (France social security) requires 13+2 digit key validation

interface Scenario {
  name: string;
  text: string;
  expected: "block" | "allow";
  notes: string;
}

const scenarios: Scenario[] = [
  // ── Scenario 1: China user — ChatGPT text input ──
  {
    name: "Scenario 1: China PII (ChatGPT text)",
    text: [
      "姓名: 王伟 (Wáng Wěi)",
      "身份证号: 11010519900307783X (18位，符合校验规则)",
      "护照号: G12345678 (中国普通护照格式)",
      "信用卡号: 6225887632109876 (银联卡，通过Luhn校验)",
      "地址: 北京市朝阳区建国路88号 (虚构地址)",
    ].join("\n"),
    expected: "allow",
    notes: "UnionPay 6225887632109876 FAILS Luhn. China passport/ID card SITs not in policy. No blockable PII detected.",
  },

  // ── Scenario 2: US user — Gemini file attachment (text content) ──
  {
    name: "Scenario 2: US PII (Gemini file attachment)",
    text: [
      "姓名: Michael Anderson",
      "SSN: 234-67-8901 (虚构，符合 [非900-999][非00][非0000] 规则)",
      "护照号: 285194736 (9位纯数字，随机非连续组合)",
      "信用卡号: 4242424242424242 (Visa标准测试卡号，通过Luhn校验)",
      "地址: 456 Maple Ave, Los Angeles, CA 90001 (虚构通用地址)",
    ].join("\n"),
    expected: "block",
    notes: "Visa 4242424242424242 passes Luhn → Credit Card SIT match. SSN 234-67-8901 valid format → SSN SIT match. Should BLOCK.",
  },

  // ── Scenario 3: Japan user — ZIP file attachment (text content) ──
  {
    name: "Scenario 3: Japan PII (ZIP text content)",
    text: [
      "姓名: 佐藤 花子 (Sato Hanako)",
      "マイナンバー: 123456789012 (12位虚构个人编号)",
      "护照号: TR1234567 (日本护照格式)",
      "信用卡号: 3528234567890123 (JCB卡，通过Luhn校验)",
      "地址: 東京都渋谷区神宮前1-2-3 (虚构地址)",
    ].join("\n"),
    expected: "allow",
    notes: "JCB 3528234567890123 FAILS Luhn. My Number 123456789012 FAILS check digit. Passport keyword is Chinese (护照号) not Japanese. No blockable PII detected.",
  },

  // ── Scenario 4: France user — Claude.ai keywords ──
  {
    name: "Scenario 4: France PII (Claude.ai keywords)",
    text: [
      "姓名: Marie Dupont-Lefèvre",
      "INSÉE: 1850672830093 (13位虚构社会保障号)",
      "护照号: 10AB12345 (法国护照格式)",
      "信用卡号: 5555555555554444 (MasterCard测试卡号)",
      "地址: 15 Rue de Rivoli, 75001 Paris (虚构地址)",
    ].join("\n"),
    expected: "block",
    notes: "MasterCard 5555555555554444 passes Luhn → Credit Card SIT match. Should BLOCK. INSÉE is only 13 digits (missing 2-digit key), may not match France SSN SIT.",
  },

  // ── Scenario 5: Russia user — photo attachment (text content) ──
  {
    name: "Scenario 5: Russia PII (Copilot attachment)",
    text: [
      "姓名: Иванов Алексей Петрович (Ivanov Aleksey Petrovich)",
      "ИНН: 770123456789 (12位虚构税号)",
      "护照号: 45 1234567 (俄罗斯国内护照格式)",
      "信用卡号: 2200123456789012 (Mir卡，通过Luhn校验)",
      "地址: ул. Тверская, д. 15, Москва, 125009 (虚构地址)",
    ].join("\n"),
    expected: "allow",
    notes: "Mir 2200123456789012 FAILS Luhn. INN 770123456789 FAILS check digits. Russian passport format present but keyword is Chinese (护照号). No blockable PII detected.",
  },

  // ── Scenario 5a: Russia PII with Russian corroborating keywords ──
  {
    name: "Scenario 5a: Russia PII (Russian keywords)",
    text: [
      "ФИО: Иванов Алексей Петрович",
      "Номер паспорта: 45 1234567",
      "ИНН: 770123456789",
      "Адрес: ул. Тверская, д. 15, Москва, 125009",
      "Кредитная карта: 5555555555554444 (MasterCard, passes Luhn)",
    ].join("\n"),
    expected: "block",
    notes: "Russian keywords (ФИО, Номер паспорта, Адрес) provide corroboration. MasterCard 5555555555554444 passes Luhn → Credit Card SIT match. Should BLOCK.",
  },

  // ── Scenario 5b: Russia + China mixed labels, valid Visa ──
  {
    name: "Scenario 5b: Russia PII (mixed Chinese+Russian labels, Visa)",
    text: [
      "姓名 (ФИО): Иванов Алексей Петрович",
      "护照号 (Номер паспорта): 45 1234567",
      "ИНН: 770123456789",
      "地址 (Адрес): ул. Тверская, д. 15, Москва, 125009",
      "信用卡号: 4532015112830366 (Visa, passes Luhn)",
    ].join("\n"),
    expected: "block",
    notes: "Mix of Chinese and Russian labels + Visa card 4532015112830366 passes Luhn → Credit Card SIT match. Should BLOCK.",
  },

  // ── Scenario 5c: Russian keywords only, no valid card ──
  {
    name: "Scenario 5c: Russia PII (Russian keywords, no valid card)",
    text: [
      "ФИО: Петров Иван Сергеевич",
      "Паспорт: 12 3456789",
      "Адрес: Невский проспект 25, Санкт-Петербург, 191011",
      "ИНН: 780987654321",
      "Документ: справка с места работы",
    ].join("\n"),
    expected: "allow",
    notes: "Russian corroborating keywords present, but no valid credit card or other blockable SIT. Should ALLOW.",
  },
];

// ── Runner ──

async function runScenarios(): Promise<void> {
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║        Purview DLP Scenario Test — processContent API       ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Tenant:  ${TENANT_ID}                  ║`);
  console.log(`║  Client:  ${CLIENT_ID}                  ║`);
  console.log(`║  User:    ${USER_ID}                  ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");
  console.log();

  // Verify token
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
  console.log("╔══════════════════════════════════════════════════════════════╗");
  console.log("║                        SUMMARY                             ║");
  console.log("╠══════════════════════════════════════════════════════════════╣");

  let passed = 0;
  let failed = 0;
  for (const r of results) {
    const actual = r.result.allowed ? "ALLOW" : "BLOCK";
    const icon = r.pass ? "✓" : "✗";
    const status = r.pass ? "PASS" : "FAIL";
    console.log(`║ ${icon} ${r.scenario.padEnd(45)} ${actual.padEnd(6)} ${status} ║`);
    if (r.pass) passed++;
    else failed++;
  }

  console.log("╠══════════════════════════════════════════════════════════════╣");
  console.log(`║  Total: ${results.length}  Passed: ${passed}  Failed: ${failed}                              ║`);
  console.log("╚══════════════════════════════════════════════════════════════╝");

  process.exit(failed > 0 ? 1 : 0);
}

runScenarios();
