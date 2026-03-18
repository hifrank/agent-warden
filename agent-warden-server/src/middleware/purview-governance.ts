import { DefaultAzureCredential, ClientSecretCredential, type TokenCredential } from "@azure/identity";

// ──────────────────────────────────────────────────────────
// Microsoft Purview Data Governance client — Data Map API
// Manages collections, data source registration, scans,
// classifications, lineage, and custom entity types.
//
// Purview is in E5 tenant "ecardpoc4ecv" (2cf24558-0d31-439b-9c8d-6fdce3931ae7).
// Auth uses ClientSecretCredential when PURVIEW_DLP_TENANT_ID is set.
// ──────────────────────────────────────────────────────────

const credential: TokenCredential = (() => {
  const tenantId = process.env.PURVIEW_DLP_TENANT_ID;
  const clientId = process.env.PURVIEW_DLP_CLIENT_ID;
  const clientSecret = process.env.PURVIEW_DLP_CLIENT_SECRET;
  if (tenantId && clientId && clientSecret) {
    console.log(`[purview-governance] Using ClientSecretCredential for cross-tenant ${tenantId}`);
    return new ClientSecretCredential(tenantId, clientId, clientSecret);
  }
  return new DefaultAzureCredential();
})();

const PURVIEW_SCOPE = "https://purview.azure.net/.default";

let cachedToken: { token: string; expiresAt: number } | null = null;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }
  const result = await credential.getToken(PURVIEW_SCOPE);
  if (!result) throw new Error("Failed to acquire Purview token");
  cachedToken = { token: result.token, expiresAt: result.expiresOnTimestamp };
  return result.token;
}

async function purviewFetch(
  endpoint: string,
  path: string,
  method: "GET" | "POST" | "PUT" | "DELETE" = "GET",
  body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const token = await getToken();
  const url = `${endpoint}${path}`;
  const resp = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = resp.ok ? await resp.json().catch(() => null) : await resp.text().catch(() => "");
  return { ok: resp.ok, status: resp.status, data };
}

// ── Collections ─────────────────────────────────────────

export interface Collection {
  name: string;
  friendlyName: string;
  parentCollection?: string;
  description?: string;
}

/**
 * Create or update a collection under the root.
 * Used to organize tenant data: one collection per tenant.
 */
export async function upsertCollection(
  endpoint: string,
  collection: Collection,
): Promise<{ ok: boolean; data: unknown }> {
  const body: Record<string, unknown> = {
    friendlyName: collection.friendlyName,
    description: collection.description ?? "",
  };
  if (collection.parentCollection) {
    body.parentCollection = {
      referenceName: collection.parentCollection,
    };
  }

  const result = await purviewFetch(
    endpoint,
    `/collections/${collection.name}?api-version=2019-11-01-preview`,
    "PUT",
    body,
  );
  return { ok: result.ok, data: result.data };
}

/**
 * List all collections in the Purview account.
 */
export async function listCollections(
  endpoint: string,
): Promise<{ ok: boolean; data: unknown }> {
  return purviewFetch(
    endpoint,
    "/collections?api-version=2019-11-01-preview",
  );
}

/**
 * Delete a collection (e.g., on tenant deletion for data cleanup).
 */
export async function deleteCollection(
  endpoint: string,
  collectionName: string,
): Promise<{ ok: boolean; status: number }> {
  const result = await purviewFetch(
    endpoint,
    `/collections/${collectionName}?api-version=2019-11-01-preview`,
    "DELETE",
  );
  return { ok: result.ok, status: result.status };
}

// ── Data Sources ────────────────────────────────────────

export interface DataSourceRegistration {
  name: string;
  kind: "AzureCosmosDb" | "AzureBlobStorage" | "AdlsGen2";
  collectionName: string;
  properties: Record<string, unknown>;
}

/**
 * Register a data source (Cosmos DB, Blob Storage, ADLS) in a collection.
 */
export async function registerDataSource(
  endpoint: string,
  source: DataSourceRegistration,
): Promise<{ ok: boolean; data: unknown }> {
  const body = {
    kind: source.kind,
    properties: {
      ...source.properties,
      collection: {
        referenceName: source.collectionName,
        type: "CollectionReference",
      },
    },
  };

  const result = await purviewFetch(
    endpoint,
    `/scan/datasources/${source.name}?api-version=2022-07-01-preview`,
    "PUT",
    body,
  );
  return { ok: result.ok, data: result.data };
}

/**
 * List registered data sources.
 */
export async function listDataSources(
  endpoint: string,
): Promise<{ ok: boolean; data: unknown }> {
  return purviewFetch(
    endpoint,
    "/scan/datasources?api-version=2022-07-01-preview",
  );
}

// ── Scans ───────────────────────────────────────────────

export interface ScanDefinition {
  dataSourceName: string;
  scanName: string;
  kind: "AzureCosmosDbCredentialScan" | "AzureBlobStorageCredentialScan" | "AdlsGen2CredentialScan";
  properties: Record<string, unknown>;
}

/**
 * Create or update a scan on a registered data source.
 */
export async function upsertScan(
  endpoint: string,
  scan: ScanDefinition,
): Promise<{ ok: boolean; data: unknown }> {
  const body = {
    kind: scan.kind,
    properties: scan.properties,
  };

  const result = await purviewFetch(
    endpoint,
    `/scan/datasources/${scan.dataSourceName}/scans/${scan.scanName}?api-version=2022-07-01-preview`,
    "PUT",
    body,
  );
  return { ok: result.ok, data: result.data };
}

/**
 * Trigger a scan run on a data source.
 */
export async function runScan(
  endpoint: string,
  dataSourceName: string,
  scanName: string,
): Promise<{ ok: boolean; data: unknown }> {
  const runId = `run-${Date.now()}`;
  const result = await purviewFetch(
    endpoint,
    `/scan/datasources/${dataSourceName}/scans/${scanName}/runs/${runId}?api-version=2022-07-01-preview`,
    "PUT",
    {},
  );
  return { ok: result.ok, data: result.data };
}

/**
 * List scan runs for a data source scan.
 */
export async function listScanRuns(
  endpoint: string,
  dataSourceName: string,
  scanName: string,
): Promise<{ ok: boolean; data: unknown }> {
  return purviewFetch(
    endpoint,
    `/scan/datasources/${dataSourceName}/scans/${scanName}/runs?api-version=2022-07-01-preview`,
  );
}

// ── Classification / Discovery ──────────────────────────

/**
 * Search the Purview catalog (Data Map) for classified assets.
 * Useful for discovering what sensitive data exists across tenants.
 */
export async function searchCatalog(
  endpoint: string,
  query: string,
  filter?: Record<string, unknown>,
): Promise<{ ok: boolean; data: unknown }> {
  const body: Record<string, unknown> = {
    keywords: query,
    limit: 50,
  };
  if (filter) {
    body.filter = filter;
  }

  return purviewFetch(
    endpoint,
    "/catalog/api/search/query?api-version=2022-03-01-preview",
    "POST",
    body,
  );
}

/**
 * Get classified entities for a specific tenant collection.
 * Returns assets with their classification labels.
 */
export async function getClassifiedAssets(
  endpoint: string,
  collectionName: string,
): Promise<{ ok: boolean; data: unknown }> {
  return searchCatalog(endpoint, "*", {
    and: [
      { collectionId: collectionName },
      {
        not: {
          classification: { operator: "eq", value: [] },
        },
      },
    ],
  });
}

// ── Lineage ─────────────────────────────────────────────

/**
 * Get lineage information for an asset (data flow tracking).
 */
export async function getAssetLineage(
  endpoint: string,
  assetGuid: string,
  direction: "INPUT" | "OUTPUT" | "BOTH" = "BOTH",
): Promise<{ ok: boolean; data: unknown }> {
  return purviewFetch(
    endpoint,
    `/catalog/api/atlas/v2/lineage/${assetGuid}?direction=${direction}&api-version=2022-03-01-preview`,
  );
}

// ── High-Level Operations for Tenant Lifecycle ──────────

/**
 * Register OpenClaw custom entity types in Purview Data Map (Atlas v2).
 * Idempotent — re-registering existing types is a no-op.
 *
 * Types:
 *   - openclaw_tenant        (DataSet)  — agent instance
 *   - openclaw_conversation   (DataSet)  — user session
 *   - openclaw_agent_process  (Process)  — agent run (creates lineage)
 *   - llm_invocation          (Process)  — LLM call (creates lineage)
 *   - saas_resource           (DataSet)  — SaaS resource accessed
 */
export async function registerCustomTypes(
  endpoint: string,
): Promise<{ ok: boolean; data: unknown }> {
  const typeDefs = {
    entityDefs: [
      {
        name: "openclaw_tenant",
        description: "An OpenClaw tenant agent instance managed by Agent Warden",
        superTypes: ["DataSet"],
        serviceType: "Agent Warden",
        typeVersion: "1.0",
        attributeDefs: [
          { name: "tier", typeName: "string", isOptional: true },
          { name: "region", typeName: "string", isOptional: true },
          { name: "activeChannels", typeName: "array<string>", isOptional: true },
        ],
      },
      {
        name: "openclaw_conversation",
        description: "A user conversation session with an OpenClaw agent",
        superTypes: ["DataSet"],
        serviceType: "Agent Warden",
        typeVersion: "1.0",
        attributeDefs: [
          { name: "channel", typeName: "string", isOptional: true },
          { name: "messageCount", typeName: "int", isOptional: true },
          { name: "startedAt", typeName: "string", isOptional: true },
        ],
      },
      {
        name: "openclaw_agent_process",
        description: "Agent processing a user request — transforms input data to output",
        superTypes: ["Process"],
        serviceType: "Agent Warden",
        typeVersion: "1.0",
        attributeDefs: [
          { name: "traceId", typeName: "string", isOptional: false },
          { name: "toolsUsed", typeName: "array<string>", isOptional: true },
          { name: "durationMs", typeName: "long", isOptional: true },
          { name: "dlpViolations", typeName: "int", isOptional: true },
        ],
      },
      {
        name: "llm_invocation",
        description: "An LLM call that transforms/enriches data during agent processing",
        superTypes: ["Process"],
        serviceType: "Agent Warden",
        typeVersion: "1.0",
        attributeDefs: [
          { name: "model", typeName: "string", isOptional: true },
          { name: "promptTokens", typeName: "long", isOptional: true },
          { name: "completionTokens", typeName: "long", isOptional: true },
          { name: "provider", typeName: "string", isOptional: true },
        ],
      },
      {
        name: "saas_resource",
        description: "A specific resource in a SaaS provider accessed by an OpenClaw agent",
        superTypes: ["DataSet"],
        serviceType: "Agent Warden",
        typeVersion: "1.0",
        attributeDefs: [
          { name: "provider", typeName: "string", isOptional: false },
          { name: "resourceType", typeName: "string", isOptional: false },
          { name: "resourceId", typeName: "string", isOptional: true },
          { name: "lastAccessedAt", typeName: "string", isOptional: true },
          { name: "accessCount", typeName: "int", isOptional: true },
        ],
      },
    ],
  };

  return purviewFetch(
    endpoint,
    "/datamap/api/atlas/v2/types/typedefs?api-version=2023-09-01",
    "POST",
    typeDefs,
  );
}

// ── Entity Creation (Atlas v2 bulk) ─────────────────────

export interface AtlasEntity {
  typeName: string;
  attributes: Record<string, unknown>;
  /** For Process entities: input DataSet references */
  relationshipAttributes?: {
    inputs?: Array<{ typeName: string; uniqueAttributes: { qualifiedName: string } }>;
    outputs?: Array<{ typeName: string; uniqueAttributes: { qualifiedName: string } }>;
  };
}

/**
 * Create or update entities in Purview Data Map (batch).
 * Atlas bulk API accepts up to 50 entities per call.
 */
export async function createEntities(
  endpoint: string,
  entities: AtlasEntity[],
): Promise<{ ok: boolean; data: unknown }> {
  return purviewFetch(
    endpoint,
    "/datamap/api/atlas/v2/entity/bulk?api-version=2023-09-01",
    "POST",
    { entities },
  );
}

/**
 * Push lineage for an agent trace: creates the Process entity with input/output
 * DataSet references, plus all referenced DataSet entities in one batch.
 */
export async function pushTraceLineage(
  endpoint: string,
  trace: {
    tenantId: string;
    traceId: string;
    toolsUsed: string[];
    durationMs: number;
    dlpViolations: number;
    inputs: Array<{ provider: string; resourceType: string; qualifiedName: string; name: string }>;
    outputs: Array<{ provider: string; resourceType: string; qualifiedName: string; name: string }>;
    llm?: { model: string; provider: string; promptTokens: number; completionTokens: number };
  },
): Promise<{ ok: boolean; data: unknown }> {
  // Create DataSet entities first (saas_resource) — Purview Atlas v2
  // requires referenced entities to exist before Process entities.
  const datasetEntities: AtlasEntity[] = [];
  const processEntities: AtlasEntity[] = [];

  // Create input SaaS resource entities
  for (const input of trace.inputs) {
    datasetEntities.push({
      typeName: "saas_resource",
      attributes: {
        name: input.name,
        qualifiedName: input.qualifiedName,
        provider: input.provider,
        resourceType: input.resourceType,
        lastAccessedAt: new Date().toISOString(),
      },
    });
  }

  // Create output SaaS resource entities
  for (const output of trace.outputs) {
    datasetEntities.push({
      typeName: "saas_resource",
      attributes: {
        name: output.name,
        qualifiedName: output.qualifiedName,
        provider: output.provider,
        resourceType: output.resourceType,
        lastAccessedAt: new Date().toISOString(),
      },
    });
  }

  // Create LLM invocation (Process) if present
  if (trace.llm) {
    processEntities.push({
      typeName: "llm_invocation",
      attributes: {
        name: `${trace.llm.model} invocation`,
        qualifiedName: `agent-warden://${trace.tenantId}/llm/${trace.traceId}/call-1`,
        model: trace.llm.model,
        provider: trace.llm.provider,
        promptTokens: trace.llm.promptTokens,
        completionTokens: trace.llm.completionTokens,
      },
      relationshipAttributes: {
        inputs: trace.inputs.map((i) => ({
          typeName: "saas_resource",
          uniqueAttributes: { qualifiedName: i.qualifiedName },
        })),
        outputs: trace.outputs.map((o) => ({
          typeName: "saas_resource",
          uniqueAttributes: { qualifiedName: o.qualifiedName },
        })),
      },
    });
  }

  // Create agent process (Process) — top-level lineage
  processEntities.push({
    typeName: "openclaw_agent_process",
    attributes: {
      name: `Agent run: ${trace.traceId}`,
      qualifiedName: `agent-warden://${trace.tenantId}/process/${trace.traceId}`,
      traceId: trace.traceId,
      toolsUsed: trace.toolsUsed,
      durationMs: trace.durationMs,
      dlpViolations: trace.dlpViolations,
    },
    relationshipAttributes: {
      inputs: trace.inputs.map((i) => ({
        typeName: "saas_resource",
        uniqueAttributes: { qualifiedName: i.qualifiedName },
      })),
      outputs: trace.outputs.map((o) => ({
        typeName: "saas_resource",
        uniqueAttributes: { qualifiedName: o.qualifiedName },
      })),
    },
  });

  // Push DataSets first, then Processes
  const dsResult = await createEntities(endpoint, datasetEntities);
  if (!dsResult.ok) return dsResult;
  return createEntities(endpoint, processEntities);
}

/**
 * Set up data governance for a new tenant:
 * 1. Create tenant collection under platform root
 * 2. Register tenant data sources (Cosmos DB partition, Blob backup)
 */
export async function setupTenantGovernance(
  endpoint: string,
  tenantId: string,
  rootCollection: string,
  cosmosAccountEndpoint?: string,
  blobStorageEndpoint?: string,
): Promise<{ ok: boolean; steps: { step: string; ok: boolean; detail: unknown }[] }> {
  const steps: { step: string; ok: boolean; detail: unknown }[] = [];

  // 1. Create tenant collection
  const collResult = await upsertCollection(endpoint, {
    name: `tenant-${tenantId}`,
    friendlyName: `Tenant: ${tenantId}`,
    parentCollection: rootCollection,
    description: `Data governance collection for tenant ${tenantId}`,
  });
  steps.push({ step: "create-collection", ok: collResult.ok, detail: collResult.data });

  // 2. Register Cosmos DB data source (tenant partition)
  if (cosmosAccountEndpoint) {
    const cosmosResult = await registerDataSource(endpoint, {
      name: `cosmos-${tenantId}`,
      kind: "AzureCosmosDb",
      collectionName: `tenant-${tenantId}`,
      properties: {
        serverEndpoint: cosmosAccountEndpoint,
        resourceName: `cosmos-${tenantId}`,
      },
    });
    steps.push({ step: "register-cosmos", ok: cosmosResult.ok, detail: cosmosResult.data });
  }

  // 3. Register Blob Storage data source (session transcript backups)
  if (blobStorageEndpoint) {
    const blobResult = await registerDataSource(endpoint, {
      name: `blob-${tenantId}`,
      kind: "AzureBlobStorage",
      collectionName: `tenant-${tenantId}`,
      properties: {
        endpoint: blobStorageEndpoint,
        resourceName: `blob-${tenantId}`,
      },
    });
    steps.push({ step: "register-blob", ok: blobResult.ok, detail: blobResult.data });
  }

  const allOk = steps.every((s) => s.ok);
  return { ok: allOk, steps };
}

/**
 * Tear down data governance for a deleted tenant.
 * Removes collection and registered data sources.
 */
export async function teardownTenantGovernance(
  endpoint: string,
  tenantId: string,
): Promise<{ ok: boolean; steps: { step: string; ok: boolean }[] }> {
  const steps: { step: string; ok: boolean }[] = [];

  // Delete collection (also removes child assets)
  const result = await deleteCollection(endpoint, `tenant-${tenantId}`);
  steps.push({ step: "delete-collection", ok: result.ok });

  return { ok: steps.every((s) => s.ok), steps };
}
