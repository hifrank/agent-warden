import {
  scanContent,
  type DLPScanInput,
  type DLPScanResult,
  type ContentType,
} from "../middleware/purview.js";
import { getCosmosDb } from "../middleware/cosmos.js";

// ──────────────────────────────────────────────────────────
// Sentinel DLP Tools (§16.7)
// ──────────────────────────────────────────────────────────

/**
 * warden.dlp.scan — Scan content for sensitive data via local patterns + Purview API.
 */
export async function dlpScan(
  tenantId: string,
  content: string,
  contentType: ContentType,
  purviewEndpoint: string,
  cosmosEndpoint: string,
  cosmosDatabase: string,
  sourceChannel?: string,
  destinationChannel?: string
): Promise<DLPScanResult> {
  const input: DLPScanInput = {
    tenantId,
    content,
    contentType,
    sourceChannel,
    destinationChannel,
  };

  const result = await scanContent(purviewEndpoint, input);

  // Write audit record for any non-trivial scan
  if (result.sensitiveInfoTypes.length > 0 || result.action !== "allow") {
    const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
    await db.container("audit").items.create({
      id: `dlp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      eventType: "dlp.scan",
      timestamp: new Date().toISOString(),
      contentType,
      action: result.action,
      matchedPolicies: result.matchedPolicies,
      sensitiveInfoCount: result.sensitiveInfoTypes.length,
      sensitivityLabel: result.sensitivityLabel,
      incidentId: result.incidentId,
      sourceChannel,
      destinationChannel,
    });
  }

  return result;
}

/**
 * warden.dlp.policy.list — List active DLP policies and their configuration.
 */
export function listDLPPolicies(): object[] {
  // These policies are defined in §16.5 and enforced by the scan middleware
  return [
    {
      name: "block-credentials-to-llm",
      description:
        "Block API keys, tokens, and passwords from being sent to LLM providers",
      locations: ["llm.outbound"],
      action: "block",
      severity: "critical",
      sensitiveInfoTypes: [
        "OpenAI API Key",
        "GitHub PAT",
        "Slack Bot Token",
        "AWS Access Key",
        "Password in chat",
        "CUSTOM.API_KEY_PATTERN",
      ],
    },
    {
      name: "redact-pii-in-logs",
      description: "Redact PII (SSN, credit cards) before persistence or LLM",
      locations: ["session.persist", "log.write", "llm.outbound"],
      action: "redact",
      severity: "high",
      sensitiveInfoTypes: [
        "SSN",
        "Credit Card",
        "MICROSOFT.GOVERNMENT.US.SOCIAL_SECURITY_NUMBER",
        "MICROSOFT.FINANCIAL.CREDIT_CARD_NUMBER",
      ],
    },
    {
      name: "phi-handling",
      description:
        "Block PHI in non-enterprise tenants; require HIPAA tier for health data",
      locations: ["all"],
      action: "block",
      severity: "high",
      tierRestriction: "enterprise",
      sensitiveInfoTypes: ["PHI", "MICROSOFT.HEALTH.*"],
    },
    {
      name: "bulk-pii-detection",
      description: "Alert when bulk PII is detected in a single interaction",
      locations: ["all"],
      action: "alert",
      severity: "high",
      threshold: 10,
    },
  ];
}

/**
 * warden.dlp.incidents — Query recent DLP incidents for a tenant from audit log.
 */
export async function listDLPIncidents(
  tenantId: string,
  cosmosEndpoint: string,
  cosmosDatabase: string,
  limit: number = 50
): Promise<object[]> {
  const db = await getCosmosDb(cosmosEndpoint, cosmosDatabase);
  const { resources } = await db
    .container("audit")
    .items.query({
      query:
        "SELECT * FROM c WHERE c.tenantId = @tid AND c.eventType = 'dlp.scan' AND c.action != 'allow' ORDER BY c.timestamp DESC OFFSET 0 LIMIT @limit",
      parameters: [
        { name: "@tid", value: tenantId },
        { name: "@limit", value: limit },
      ],
    })
    .fetchAll();

  return resources;
}
