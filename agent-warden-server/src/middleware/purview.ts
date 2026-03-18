import { DefaultAzureCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";

// ──────────────────────────────────────────────────────────
// Microsoft Purview DLP client — wraps the Purview REST API
// for content classification and DLP policy evaluation (§16)
//
// Purview is in the E5 tenant "ecardpoc4ecv" (2cf24558-0d31-439b-9c8d-6fdce3931ae7).
// Auth uses ClientSecretCredential with the multi-tenant app registration
// when PURVIEW_DLP_TENANT_ID is set; otherwise falls back to DefaultAzureCredential.
// ──────────────────────────────────────────────────────────

const credential: TokenCredential = (() => {
  const tenantId = process.env.PURVIEW_DLP_TENANT_ID;
  const clientId = process.env.PURVIEW_DLP_CLIENT_ID;
  const clientSecret = process.env.PURVIEW_DLP_CLIENT_SECRET;
  if (tenantId && clientId && clientSecret) {
    console.log(`[purview] Using ClientSecretCredential for cross-tenant ${tenantId}`);
    return new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  return new DefaultAzureCredential();
})();

export type ContentType =
  | "message"
  | "llm-prompt"
  | "llm-response"
  | "tool-output"
  | "file";

export type DLPAction = "allow" | "redact" | "block";

export interface SensitiveInfoMatch {
  name: string;
  confidence: number;
  count: number;
  locations: { offset: number; length: number }[];
}

export interface DLPScanResult {
  allowed: boolean;
  action: DLPAction;
  matchedPolicies: string[];
  sensitiveInfoTypes: SensitiveInfoMatch[];
  redactedContent?: string;
  sensitivityLabel: string;
  incidentId?: string;
}

export interface DLPScanInput {
  tenantId: string;
  content: string;
  contentType: ContentType;
  sourceChannel?: string;
  destinationChannel?: string;
}

// ── Built-in regex patterns for high-confidence local pre-scan ────
// These run locally before calling Purview API to catch obvious
// credential leaks with zero latency. Purview is the authoritative
// classifier, but local patterns give fast-path blocking for §16.3 IP2.

const LOCAL_PATTERNS: { name: string; regex: RegExp; action: DLPAction }[] = [
  {
    name: "OpenAI API Key",
    regex: /sk-[a-zA-Z0-9]{20,}/g,
    action: "block",
  },
  {
    name: "GitHub PAT",
    regex: /ghp_[a-zA-Z0-9]{36}/g,
    action: "block",
  },
  {
    name: "Slack Bot Token",
    regex: /xoxb-[0-9]+-[a-zA-Z0-9]+/g,
    action: "block",
  },
  {
    name: "AWS Access Key",
    regex: /AKIA[0-9A-Z]{16}/g,
    action: "block",
  },
  {
    name: "Credit Card (Luhn candidate)",
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
    action: "redact",
  },
  {
    name: "SSN",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
    action: "redact",
  },
  {
    name: "Password in chat",
    regex: /password\s*[:=]\s*\S+/gi,
    action: "redact",
  },
];

/**
 * Acquire a bearer token for the Purview API scope.
 */
async function getPurviewToken(purviewEndpoint: string): Promise<string> {
  const tokenResponse = await credential.getToken(
    `${purviewEndpoint}/.default`
  );
  if (!tokenResponse) throw new Error("Failed to acquire Purview token");
  return tokenResponse.token;
}

/**
 * Local fast-path scan using regex patterns.
 * Returns early matches without needing a Purview API call.
 */
function localPreScan(
  content: string
): { matches: SensitiveInfoMatch[]; highestAction: DLPAction } {
  const matches: SensitiveInfoMatch[] = [];
  let highestAction: DLPAction = "allow";

  for (const pattern of LOCAL_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    const locations: { offset: number; length: number }[] = [];
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      locations.push({ offset: match.index, length: match[0].length });
    }

    if (locations.length > 0) {
      matches.push({
        name: pattern.name,
        confidence: 95,
        count: locations.length,
        locations,
      });
      if (
        pattern.action === "block" ||
        (pattern.action === "redact" && highestAction === "allow")
      ) {
        highestAction = pattern.action;
      }
    }
  }

  return { matches, highestAction };
}

/**
 * Redact sensitive matches from content by replacing with masked text.
 */
function redactContent(
  content: string,
  matches: SensitiveInfoMatch[]
): string {
  // Sort locations in reverse order to replace from end to start
  const allLocations = matches
    .flatMap((m) =>
      m.locations.map((loc) => ({ ...loc, name: m.name }))
    )
    .sort((a, b) => b.offset - a.offset);

  let result = content;
  for (const loc of allLocations) {
    const mask = `[${loc.name} REDACTED]`;
    result =
      result.substring(0, loc.offset) +
      mask +
      result.substring(loc.offset + loc.length);
  }
  return result;
}

/**
 * Call Microsoft Purview classification API for deep content analysis.
 * Falls back gracefully if Purview is unavailable.
 */
async function purviewClassify(
  purviewEndpoint: string,
  content: string,
  contentType: ContentType
): Promise<SensitiveInfoMatch[]> {
  try {
    const token = await getPurviewToken(purviewEndpoint);
    const response = await fetch(
      `${purviewEndpoint}/scan/classify?api-version=2023-09-01`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          content,
          contentType,
          classificationRules: [
            "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER",
            "MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER",
            "MICROSOFT.PERSONAL.EMAIL",
            "MICROSOFT.PERSONAL.US.PHONE_NUMBER",
            "MICROSOFT.PERSONAL.NAME",
            "CUSTOM.API_KEY_PATTERN",
            "CUSTOM.PASSWORD_IN_CHAT",
          ],
        }),
      }
    );

    if (!response.ok) {
      console.error(
        `Purview classify returned ${response.status}: ${response.statusText}`
      );
      return [];
    }

    const data = (await response.json()) as {
      classifications: {
        classificationName: string;
        confidence: number;
        count: number;
        locations: { offset: number; length: number }[];
      }[];
    };

    return data.classifications.map((c) => ({
      name: c.classificationName,
      confidence: c.confidence,
      count: c.count,
      locations: c.locations,
    }));
  } catch (err) {
    console.error("Purview classification API call failed:", err);
    return []; // Fail open for classification — local patterns still enforce
  }
}

/**
 * Determine the sensitivity label based on detected SITs.
 */
function determineSensitivityLabel(matches: SensitiveInfoMatch[]): string {
  const names = new Set(matches.map((m) => m.name.toLowerCase()));

  if (
    names.has("openai api key") ||
    names.has("github pat") ||
    names.has("aws access key") ||
    names.has("slack bot token") ||
    names.has("custom.api_key_pattern") ||
    names.has("password in chat")
  ) {
    return "Highly Confidential";
  }
  if (
    names.has("microsoft.government.us.social_security_number") ||
    names.has("ssn") ||
    names.has("microsoft.financial.credit_card_number") ||
    names.has("credit card (luhn candidate)")
  ) {
    return "Confidential";
  }
  if (
    names.has("microsoft.personal.name") ||
    names.has("microsoft.personal.email")
  ) {
    return "Internal";
  }
  return "Public";
}

/**
 * Main DLP scan function — combines local pre-scan with Purview deep classification.
 *
 * Flow (§16.8):
 *   1. Local regex pre-scan (fast path — <1ms)
 *   2. If local finds credential → block immediately (no Purview call needed)
 *   3. Otherwise call Purview API for deep classification
 *   4. Merge results, apply highest-severity action
 */
export async function scanContent(
  purviewEndpoint: string,
  input: DLPScanInput
): Promise<DLPScanResult> {
  // Step 1: Local fast-path
  const local = localPreScan(input.content);

  // Step 2: If credentials found locally, block immediately for LLM-bound content
  if (
    local.highestAction === "block" &&
    (input.contentType === "llm-prompt" || input.contentType === "message")
  ) {
    return {
      allowed: false,
      action: "block",
      matchedPolicies: ["block-credentials-to-llm"],
      sensitiveInfoTypes: local.matches,
      sensitivityLabel: determineSensitivityLabel(local.matches),
    };
  }

  // Step 3: Call Purview for deep classification
  const purviewMatches = await purviewClassify(
    purviewEndpoint,
    input.content,
    input.contentType
  );

  // Step 4: Merge results (deduplicate by name)
  const allMatches = [...local.matches];
  for (const pm of purviewMatches) {
    if (!allMatches.some((m) => m.name === pm.name)) {
      allMatches.push(pm);
    }
  }

  const sensitivityLabel = determineSensitivityLabel(allMatches);

  // Determine overall action
  let action: DLPAction = local.highestAction;
  const matchedPolicies: string[] = [];

  if (allMatches.length === 0) {
    return {
      allowed: true,
      action: "allow",
      matchedPolicies: [],
      sensitiveInfoTypes: [],
      sensitivityLabel: "Public",
    };
  }

  // Apply policy logic from §16.5
  const hasCredentials = allMatches.some(
    (m) =>
      m.name.includes("API Key") ||
      m.name.includes("PAT") ||
      m.name.includes("Token") ||
      m.name.includes("Password") ||
      m.name.includes("API_KEY")
  );
  const hasPII = allMatches.some(
    (m) =>
      m.name.includes("SSN") ||
      m.name.includes("SOCIAL_SECURITY") ||
      m.name.includes("Credit Card") ||
      m.name.includes("CREDIT_CARD")
  );

  if (hasCredentials && input.contentType === "llm-prompt") {
    action = "block";
    matchedPolicies.push("block-credentials-to-llm");
  } else if (hasPII && input.contentType === "llm-prompt") {
    action = "redact";
    matchedPolicies.push("redact-pii-in-logs");
  } else if (hasPII) {
    action = "redact";
    matchedPolicies.push("redact-pii-in-logs");
  } else if (hasCredentials) {
    action = "block";
    matchedPolicies.push("block-credentials-to-llm");
  }

  const redactedContent =
    action === "redact" ? redactContent(input.content, allMatches) : undefined;

  return {
    allowed: action !== "block",
    action,
    matchedPolicies,
    sensitiveInfoTypes: allMatches,
    redactedContent,
    sensitivityLabel,
  };
}
