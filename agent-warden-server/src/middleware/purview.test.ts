import { describe, it, expect } from "vitest";
import { localPreScan, redactContent, determineSensitivityLabel } from "./purview.js";

describe("localPreScan", () => {
  it("detects OpenAI API keys", () => {
    const { matches, highestAction } = localPreScan(
      "My key is sk-abcdefghijklmnopqrstuvwxyz1234"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("OpenAI API Key");
    expect(highestAction).toBe("block");
  });

  it("detects GitHub PATs", () => {
    const { matches, highestAction } = localPreScan(
      "Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("GitHub PAT");
    expect(highestAction).toBe("block");
  });

  it("detects SSNs", () => {
    const { matches, highestAction } = localPreScan(
      "SSN is 123-45-6789"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("SSN");
    expect(highestAction).toBe("redact");
  });

  it("detects credit card numbers", () => {
    const { matches, highestAction } = localPreScan(
      "Card: 4111 1111 1111 1111"
    );
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Credit Card (Luhn candidate)");
    expect(highestAction).toBe("redact");
  });

  it("detects AWS access keys", () => {
    const { matches } = localPreScan("Key: AKIAIOSFODNN7EXAMPLE");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("AWS Access Key");
  });

  it("detects passwords in chat", () => {
    const { matches } = localPreScan("my password = hunter2");
    expect(matches).toHaveLength(1);
    expect(matches[0].name).toBe("Password in chat");
  });

  it("returns allow when no sensitive data found", () => {
    const { matches, highestAction } = localPreScan("Hello, world!");
    expect(matches).toHaveLength(0);
    expect(highestAction).toBe("allow");
  });

  it("detects multiple patterns in one input", () => {
    const { matches, highestAction } = localPreScan(
      "SSN: 123-45-6789, Key: sk-abcdefghijklmnopqrstuvwxyz1234"
    );
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(highestAction).toBe("block"); // block > redact
  });

  it("block takes priority over redact", () => {
    const { highestAction } = localPreScan(
      "SSN 111-22-3333 and key sk-abcdefghijklmnopqrstuvwxyz1234"
    );
    expect(highestAction).toBe("block");
  });
});

describe("redactContent", () => {
  it("redacts SSN with label", () => {
    const matches = localPreScan("SSN: 123-45-6789").matches;
    const result = redactContent("SSN: 123-45-6789", matches);
    expect(result).toContain("[SSN REDACTED]");
    expect(result).not.toContain("123-45-6789");
  });

  it("redacts multiple matches", () => {
    const text = "SSN: 123-45-6789 and 987-65-4321";
    const { matches } = localPreScan(text);
    const result = redactContent(text, matches);
    expect(result).not.toContain("123-45-6789");
    expect(result).not.toContain("987-65-4321");
    expect((result.match(/\[SSN REDACTED\]/g) ?? []).length).toBe(2);
  });

  it("returns original when no matches", () => {
    const result = redactContent("Hello, world!", []);
    expect(result).toBe("Hello, world!");
  });
});

describe("determineSensitivityLabel", () => {
  it("returns Highly Confidential for API keys", () => {
    const label = determineSensitivityLabel([
      { name: "OpenAI API Key", confidence: 95, count: 1, locations: [] },
    ]);
    expect(label).toBe("Highly Confidential");
  });

  it("returns Confidential for SSN", () => {
    const label = determineSensitivityLabel([
      { name: "SSN", confidence: 95, count: 1, locations: [] },
    ]);
    expect(label).toBe("Confidential");
  });

  it("returns Public for no matches", () => {
    const label = determineSensitivityLabel([]);
    expect(label).toBe("Public");
  });

  it("returns highest label when mixed", () => {
    const label = determineSensitivityLabel([
      { name: "SSN", confidence: 95, count: 1, locations: [] },
      { name: "OpenAI API Key", confidence: 95, count: 1, locations: [] },
    ]);
    expect(label).toBe("Highly Confidential");
  });
});
