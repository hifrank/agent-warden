import { describe, it, expect } from "vitest";
import {
  TierSchema,
  TenantStateSchema,
  TenantProvisionInputSchema,
  InstanceRecordSchema,
} from "./types.js";

describe("TierSchema", () => {
  it("accepts valid tiers", () => {
    expect(TierSchema.parse("free")).toBe("free");
    expect(TierSchema.parse("pro")).toBe("pro");
    expect(TierSchema.parse("enterprise")).toBe("enterprise");
  });

  it("rejects invalid tiers", () => {
    expect(() => TierSchema.parse("premium")).toThrow();
    expect(() => TierSchema.parse("")).toThrow();
  });
});

describe("TenantStateSchema", () => {
  it("accepts all valid states", () => {
    for (const state of [
      "Requested",
      "Provisioning",
      "Active",
      "Degraded",
      "Suspended",
      "Archived",
      "Deleted",
    ]) {
      expect(TenantStateSchema.parse(state)).toBe(state);
    }
  });
});

describe("TenantProvisionInputSchema", () => {
  it("accepts valid input with defaults", () => {
    const result = TenantProvisionInputSchema.parse({
      tenantId: "my-tenant",
      adminEmail: "admin@example.com",
      tier: "pro",
    });
    expect(result.region).toBe("eastus2");
    expect(result.channels).toEqual([]);
  });

  it("rejects tenantId too short", () => {
    expect(() =>
      TenantProvisionInputSchema.parse({
        tenantId: "ab",
        adminEmail: "admin@example.com",
        tier: "free",
      })
    ).toThrow();
  });

  it("rejects tenantId with uppercase", () => {
    expect(() =>
      TenantProvisionInputSchema.parse({
        tenantId: "MyTenant",
        adminEmail: "admin@example.com",
        tier: "free",
      })
    ).toThrow();
  });

  it("rejects invalid email", () => {
    expect(() =>
      TenantProvisionInputSchema.parse({
        tenantId: "valid-tenant",
        adminEmail: "not-an-email",
        tier: "free",
      })
    ).toThrow();
  });

  it("accepts channels", () => {
    const result = TenantProvisionInputSchema.parse({
      tenantId: "my-tenant",
      adminEmail: "admin@example.com",
      tier: "enterprise",
      channels: [{ type: "slack", enabled: true }],
    });
    expect(result.channels).toHaveLength(1);
  });
});

describe("InstanceRecordSchema", () => {
  it("validates a complete instance record", () => {
    const record = InstanceRecordSchema.parse({
      tenantId: "demo-tenant",
      instanceId: "oc-demo-tenant",
      state: "Active",
      version: "2026.3.12",
      tier: "enterprise",
      region: "eastus2",
      createdAt: "2026-03-14T00:00:00.000Z",
      ownerIdentity: "admin@example.com",
    });
    expect(record.activeChannels).toEqual([]);
    expect(record.skillCount).toBe(0);
    expect(record.podCount).toBe(0);
    expect(record.messagesLast24h).toBe(0);
    expect(record.tags).toEqual({});
  });

  it("rejects invalid healthStatus", () => {
    expect(() =>
      InstanceRecordSchema.parse({
        tenantId: "demo-tenant",
        instanceId: "oc-demo-tenant",
        state: "Active",
        version: "1.0",
        tier: "free",
        region: "eastus2",
        createdAt: "2026-03-14T00:00:00.000Z",
        ownerIdentity: "admin@example.com",
        healthStatus: "Unknown",
      })
    ).toThrow();
  });
});
