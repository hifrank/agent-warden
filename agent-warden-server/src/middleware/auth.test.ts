import { describe, it, expect, afterEach } from "vitest";
import { authenticateRequest } from "./auth.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket());
  for (const [k, v] of Object.entries(headers)) {
    req.headers[k.toLowerCase()] = v;
  }
  return req;
}

function mockRes(): ServerResponse & { statusCode: number; body: string } {
  const res = new ServerResponse(new IncomingMessage(new Socket())) as ServerResponse & {
    statusCode: number;
    body: string;
  };
  res.body = "";
  const originalEnd = res.end.bind(res);
  res.end = ((chunk?: unknown) => {
    if (typeof chunk === "string") res.body = chunk;
    return res;
  }) as typeof res.end;
  return res;
}

describe("authenticateRequest", () => {
  const origEnv = process.env.MCP_AUTH_TOKEN;

  afterEach(() => {
    if (origEnv === undefined) delete process.env.MCP_AUTH_TOKEN;
    else process.env.MCP_AUTH_TOKEN = origEnv;
  });

  it("allows all requests when MCP_AUTH_TOKEN is not set", () => {
    delete process.env.MCP_AUTH_TOKEN;
    const req = mockReq();
    const res = mockRes();
    expect(authenticateRequest(req, res)).toBe(true);
  });

  it("rejects requests without Authorization header", () => {
    process.env.MCP_AUTH_TOKEN = "secret-token";
    const req = mockReq();
    const res = mockRes();
    expect(authenticateRequest(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it("rejects requests with wrong token", () => {
    process.env.MCP_AUTH_TOKEN = "secret-token";
    const req = mockReq({ Authorization: "Bearer wrong-token" });
    const res = mockRes();
    expect(authenticateRequest(req, res)).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it("accepts requests with correct token", () => {
    process.env.MCP_AUTH_TOKEN = "secret-token";
    const req = mockReq({ Authorization: "Bearer secret-token" });
    const res = mockRes();
    expect(authenticateRequest(req, res)).toBe(true);
  });

  it("rejects non-Bearer auth schemes", () => {
    process.env.MCP_AUTH_TOKEN = "secret-token";
    const req = mockReq({ Authorization: "Basic dXNlcjpwYXNz" });
    const res = mockRes();
    expect(authenticateRequest(req, res)).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
