import { describe, expect, it } from "vitest";
import {
  buildToolPolicyAction,
  classifyToolGovernance,
  inferToolAccess,
} from "./tool-governance.js";

describe("tool-governance", () => {
  it("classifies read tools as low-risk read_only", () => {
    const classified = classifyToolGovernance("system.readFile", {
      path: "/tmp/demo.txt",
    });

    expect(classified.access).toBe("read");
    expect(classified.policyClass).toBe("read_only");
    expect(classified.riskScore).toBe(0.1);
  });

  it("classifies shell surfaces as credential_secret_access", () => {
    const classified = classifyToolGovernance("system.bash", {
      command: "env",
    });

    expect(classified.access).toBe("write");
    expect(classified.policyClass).toBe("credential_secret_access");
    expect(classified.riskScore).toBe(0.9);
    expect(classified.metadata.credentialSurface).toBe(true);
  });

  it("classifies wallet transfers as irreversible financial actions", () => {
    const classified = classifyToolGovernance("wallet.transfer", {
      amount: 1,
    });

    expect(classified.policyClass).toBe("irreversible_financial_action");
    expect(classified.riskScore).toBe(0.95);
  });

  it("builds a policy action with explicit scope", () => {
    const action = buildToolPolicyAction({
      toolName: "system.processStart",
      args: { command: "/bin/sleep", args: ["10"] },
      scope: { tenantId: "tenant-a", runId: "run-1" },
    });

    expect(action.name).toBe("system.processStart");
    expect(action.scope).toEqual({ tenantId: "tenant-a", runId: "run-1" });
    expect(action.policyClass).toBe("credential_secret_access");
  });

  it("captures network hosts and write paths in metadata", () => {
    const action = buildToolPolicyAction({
      toolName: "system.httpPost",
      args: {
        url: "https://api.example.com/v1/jobs",
        path: "/srv/workspace/output.json",
      },
    });

    expect(action.metadata).toMatchObject({
      networkHosts: ["api.example.com"],
      writePaths: ["/srv/workspace/output.json"],
    });
  });

  it("captures nested browser session action hosts and upload paths", () => {
    const action = buildToolPolicyAction({
      toolName: "system.browserSessionResume",
      args: {
        sessionId: "session-1",
        actions: [
          {
            type: "navigate",
            url: "https://portal.example.com/upload",
          },
          {
            type: "upload",
            selector: "#file",
            path: "/srv/workspace/report.csv",
          },
        ],
      },
    });

    expect(action.metadata).toMatchObject({
      networkHosts: ["portal.example.com"],
      writePaths: ["/srv/workspace/report.csv"],
    });
  });

  it("infers write access for non-read tool names", () => {
    expect(inferToolAccess("system.processStart")).toBe("write");
  });
});
