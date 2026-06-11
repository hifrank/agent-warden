import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertMock = vi.fn();

vi.mock("../middleware/cosmos.js", () => ({
  getCosmosDb: vi.fn(async () => ({
    container: vi.fn(() => ({
      items: {
        upsert: upsertMock,
      },
    })),
  })),
}));

vi.mock("@azure/identity", () => {
  class MockCredential {
    async getToken(scope: string) {
      return {
        token: scope.includes("storage") ? "storage-token" : "graph-token",
        expiresOnTimestamp: Date.now() + 60 * 60 * 1000,
      };
    }
  }

  return {
    ClientSecretCredential: MockCredential,
    DefaultAzureCredential: MockCredential,
  };
});

import { submitPromptGuardIncident } from "./prompt-guard-incident.js";

describe("submitPromptGuardIncident", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    upsertMock.mockResolvedValue({});

    process.env.AZURE_COSMOS_ENDPOINT = "https://cosmos.example";
    process.env.AZURE_COSMOS_DATABASE = "agent-warden";
    process.env.PURVIEW_DLP_TENANT_ID = "tenant-id";
    process.env.PURVIEW_DLP_CLIENT_ID = "client-id";
    process.env.PURVIEW_DLP_CLIENT_SECRET = "client-secret";

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("?restype=container")) {
        return new Response("", { status: 201 });
      }
      if (url.includes("dataSecurityAndGovernance/activities/contentActivities")) {
        return new Response("", { status: 202 });
      }
      return new Response("", { status: 201 });
    }));
  });

  it("uploads evidence, submits Purview activity, and writes audit", async () => {
    process.env.EVIDENCE_BLOB_ACCOUNT_URL = "https://evidenceacct.blob.core.windows.net";
    process.env.EVIDENCE_BLOB_CONTAINER_PREFIX = "evidence";
    process.env.PURVIEW_DLP_USER_ID = "user-id";

    const result = await submitPromptGuardIncident({
      tenantId: "demo-tenant",
      reason: "L1 prompt-guard hit",
      rawEvidence: "SSN: 123-45-6789",
      safeSummary: "Detected potential SSN",
    });

    expect(result.blob.status).toBe("succeeded");
    expect(result.blob.uri).toContain("https://evidenceacct.blob.core.windows.net/evidence-demo-tenant/");
    expect(result.purview.status).toBe("succeeded");
    expect(result.purview.statusCode).toBe(202);
    expect(result.audit.status).toBe("succeeded");
    expect(result.audit.id).toBeTruthy();

    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0]?.[0]).toMatchObject({
      eventType: "dlp.prompt-guard.incident",
      tenantId: "demo-tenant",
      reason: "L1 prompt-guard hit",
      evidenceMimeType: "text/plain",
      blobStatus: "succeeded",
      purviewStatus: "succeeded",
    });
  });

  it("continues to audit when blob is disabled and Purview user is missing", async () => {
    delete process.env.EVIDENCE_BLOB_ACCOUNT_URL;
    delete process.env.PURVIEW_DLP_USER_ID;

    const result = await submitPromptGuardIncident({
      tenantId: "demo-tenant",
      reason: "L1 prompt-guard hit",
      rawEvidence: "Card: 4111 1111 1111 1111",
    });

    expect(result.blob.status).toBe("skipped");
    expect(result.purview.status).toBe("failed");
    expect(result.purview.error).toContain("PURVIEW_DLP_USER_ID is not configured");
    expect(result.audit.status).toBe("succeeded");
    expect(upsertMock).toHaveBeenCalledTimes(1);
  });
});
