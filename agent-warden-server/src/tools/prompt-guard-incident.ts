import { createHash, randomUUID } from "node:crypto";
import { ClientSecretCredential, DefaultAzureCredential, type TokenCredential } from "@azure/identity";
import { getCosmosDb } from "../middleware/cosmos.js";

export interface PromptGuardIncidentInput {
  tenantId: string;
  reason: string;
  rawEvidence: string;
  evidenceMimeType?: string;
  detectionSource?: string;
  safeSummary?: string;
  conversationId?: string;
  threadId?: string;
  sourceChannel?: string;
  modelId?: string;
  ruleName?: string;
}

type StepStatus = "succeeded" | "skipped" | "failed";

export interface PromptGuardIncidentResult {
  incidentId: string;
  contentHash: string;
  detectionSource: string;
  blob: {
    status: StepStatus;
    uri?: string;
    container?: string;
    error?: string;
  };
  purview: {
    status: StepStatus;
    statusCode?: number;
    error?: string;
  };
  audit: {
    status: StepStatus;
    id?: string;
    error?: string;
  };
}

const GRAPH_SCOPE = "https://graph.microsoft.com/.default";
const STORAGE_SCOPE = "https://storage.azure.com/.default";
const STORAGE_API_VERSION = "2023-11-03";

let graphCredential: TokenCredential | null = null;
let storageCredential: TokenCredential | null = null;
let graphTokenCache: { token: string; expiresAt: number } | null = null;
let storageTokenCache: { token: string; expiresAt: number } | null = null;

function getCredential(): TokenCredential {
  const tenantId = process.env.PURVIEW_DLP_TENANT_ID;
  const clientId = process.env.PURVIEW_DLP_CLIENT_ID;
  const clientSecret = process.env.PURVIEW_DLP_CLIENT_SECRET;
  if (tenantId && clientId && clientSecret) {
    return new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  return new DefaultAzureCredential();
}

async function getCachedToken(
  scope: string,
  cache: { token: string; expiresAt: number } | null,
  setCache: (value: { token: string; expiresAt: number }) => void,
  credential: TokenCredential,
): Promise<string> {
  const now = Date.now();
  if (cache && cache.expiresAt > now + 60_000) {
    return cache.token;
  }

  const result = await credential.getToken(scope);
  if (!result) {
    throw new Error(`Failed to acquire token for scope ${scope}`);
  }

  const next = { token: result.token, expiresAt: result.expiresOnTimestamp };
  setCache(next);
  return next.token;
}

async function getGraphToken(): Promise<string> {
  graphCredential ??= getCredential();
  return getCachedToken(GRAPH_SCOPE, graphTokenCache, (value) => {
    graphTokenCache = value;
  }, graphCredential);
}

async function getStorageToken(): Promise<string> {
  storageCredential ??= new DefaultAzureCredential();
  return getCachedToken(STORAGE_SCOPE, storageTokenCache, (value) => {
    storageTokenCache = value;
  }, storageCredential);
}

function sanitizeContainerName(prefix: string, tenantId: string): string {
  const normalized = `${prefix}-${tenantId}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const bounded = normalized.slice(0, 63).replace(/-$/g, "") || "evidence-default";
  return bounded.length >= 3 ? bounded : `${bounded}box`.slice(0, 3);
}

function buildBlobPath(incidentId: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  return `${date}/${incidentId}/evidence.txt`;
}

function encodeBlobPath(path: string): string {
  return path.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function buildContentHash(rawEvidence: string): string {
  return createHash("sha256").update(rawEvidence).digest("hex");
}

async function ensureBlobContainer(accountUrl: string, containerName: string): Promise<void> {
  const token = await getStorageToken();
  const response = await fetch(`${accountUrl}/${containerName}?restype=container`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-ms-version": STORAGE_API_VERSION,
      "x-ms-date": new Date().toUTCString(),
      "Content-Length": "0",
    },
  });

  if (response.status === 201 || response.status === 202 || response.status === 409) {
    return;
  }

  const body = await response.text().catch(() => "");
  throw new Error(`Blob container create failed: HTTP ${response.status} ${body.slice(0, 200)}`);
}

async function uploadEvidenceBlob(
  accountUrl: string,
  containerName: string,
  blobPath: string,
  rawEvidence: string,
  contentType: string,
  metadata: Record<string, string>,
): Promise<string> {
  await ensureBlobContainer(accountUrl, containerName);

  const token = await getStorageToken();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "x-ms-version": STORAGE_API_VERSION,
    "x-ms-date": new Date().toUTCString(),
    "x-ms-blob-type": "BlockBlob",
    "Content-Type": contentType,
  };

  for (const [key, value] of Object.entries(metadata)) {
    headers[`x-ms-meta-${key}`] = value;
  }

  const response = await fetch(`${accountUrl}/${containerName}/${encodeBlobPath(blobPath)}`, {
    method: "PUT",
    headers,
    body: rawEvidence,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Blob upload failed: HTTP ${response.status} ${body.slice(0, 200)}`);
  }

  return `${accountUrl}/${containerName}/${blobPath}`;
}

async function submitPurviewContentActivity(
  incidentId: string,
  reason: string,
  safeSummary: string | undefined,
  correlationId: string,
): Promise<{ statusCode: number }> {
  const userId = process.env.PURVIEW_DLP_USER_ID;
  const appId = process.env.PURVIEW_DLP_CLIENT_ID ?? "agent-warden-server";

  if (!userId) {
    throw new Error("PURVIEW_DLP_USER_ID is not configured");
  }

  const token = await getGraphToken();
  const body = {
    contentToProcess: {
      contentEntries: [
        {
          "@odata.type": "microsoft.graph.processConversationMetadata",
          identifier: incidentId,
          name: safeSummary?.slice(0, 256) || `Agent Warden prompt guard incident: ${reason.slice(0, 128)}`,
          correlationId,
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
          operatingSystemPlatform: "AKS",
          operatingSystemVersion: "agent-warden-server",
        },
      },
      protectedAppMetadata: {
        name: "Agent Warden",
        version: "0.1.0",
        applicationLocation: {
          "@odata.type": "#microsoft.graph.policyLocationApplication",
          value: appId,
        },
      },
      integratedAppMetadata: {
        name: "Agent Warden",
        version: "0.1.0",
      },
    },
  };

  const response = await fetch(
    `https://graph.microsoft.com/v1.0/users/${userId}/dataSecurityAndGovernance/activities/contentActivities`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );

  if (response.status === 200 || response.status === 201 || response.status === 202) {
    return { statusCode: response.status };
  }

  const payload = await response.text().catch(() => "");
  throw new Error(`Purview contentActivities failed: HTTP ${response.status} ${payload.slice(0, 200)}`);
}

async function writeAuditRecord(
  input: PromptGuardIncidentInput,
  incidentId: string,
  contentHash: string,
  blobUri: string | undefined,
  blobStatus: StepStatus,
  purviewStatus: StepStatus,
  purviewStatusCode?: number,
  purviewError?: string,
): Promise<string> {
  const db = await getCosmosDb(
    process.env.AZURE_COSMOS_ENDPOINT!,
    process.env.AZURE_COSMOS_DATABASE ?? "agent-warden",
  );

  const auditId = `prompt-guard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await db.container("audit").items.upsert({
    id: auditId,
    tenantId: input.tenantId,
    eventType: "dlp.prompt-guard.incident",
    timestamp: new Date().toISOString(),
    action: "alert",
    detectionSource: input.detectionSource ?? "l1-prompt-guard-tool",
    incidentId,
    reason: input.reason,
    ruleName: input.ruleName,
    contentHash,
    contentLength: input.rawEvidence.length,
    evidenceMimeType: input.evidenceMimeType ?? "text/plain",
    evidenceBlobUri: blobUri,
    blobStatus,
    purviewStatus,
    purviewStatusCode,
    purviewError,
    conversationId: input.conversationId,
    threadId: input.threadId,
    sourceChannel: input.sourceChannel,
    modelId: input.modelId,
    safeSummary: input.safeSummary,
  });
  return auditId;
}

export async function submitPromptGuardIncident(
  input: PromptGuardIncidentInput,
): Promise<PromptGuardIncidentResult> {
  const detectionSource = input.detectionSource ?? "l1-prompt-guard-tool";
  const incidentId = randomUUID();
  const contentHash = buildContentHash(input.rawEvidence);
  const evidenceMimeType = input.evidenceMimeType ?? "text/plain";
  const blobAccountUrl = process.env.EVIDENCE_BLOB_ACCOUNT_URL;
  const containerPrefix = process.env.EVIDENCE_BLOB_CONTAINER_PREFIX ?? "evidence";

  let blobStatus: PromptGuardIncidentResult["blob"] = { status: "skipped" };
  let purviewStatus: PromptGuardIncidentResult["purview"] = { status: "skipped" };
  let auditStatus: PromptGuardIncidentResult["audit"] = { status: "skipped" };

  try {
    if (blobAccountUrl) {
      const container = sanitizeContainerName(containerPrefix, input.tenantId);
      const blobUri = await uploadEvidenceBlob(
        blobAccountUrl.replace(/\/$/, ""),
        container,
        buildBlobPath(incidentId),
        input.rawEvidence,
        evidenceMimeType,
        {
          tenantid: input.tenantId.toLowerCase(),
          source: detectionSource.toLowerCase(),
          incidentid: incidentId,
          contenthash: contentHash,
        },
      );
      blobStatus = { status: "succeeded", uri: blobUri, container };
    }
  } catch (error) {
    blobStatus = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const correlationId = input.threadId ?? input.conversationId ?? incidentId;
    const result = await submitPurviewContentActivity(
      incidentId,
      input.reason,
      input.safeSummary,
      correlationId,
    );
    purviewStatus = { status: "succeeded", statusCode: result.statusCode };
  } catch (error) {
    purviewStatus = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const auditId = await writeAuditRecord(
      input,
      incidentId,
      contentHash,
      blobStatus.uri,
      blobStatus.status,
      purviewStatus.status,
      purviewStatus.statusCode,
      purviewStatus.error,
    );
    auditStatus = { status: "succeeded", id: auditId };
  } catch (error) {
    auditStatus = {
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    incidentId,
    contentHash,
    detectionSource,
    blob: blobStatus,
    purview: purviewStatus,
    audit: auditStatus,
  };
}