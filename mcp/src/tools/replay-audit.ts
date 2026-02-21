import type { ResolvedActor } from "./replay-actor.js";
import type { RiskLevel, ToolRiskCaps } from "./replay-risk.js";

export interface ReplayAuditEntry {
  timestamp: string;
  tool: string;
  actor: ResolvedActor;
  requestId: string;
  status: "start" | "success" | "failure" | "denied";
  durationMs: number;
  reason?: string;
  violationCode?: string;
  riskLevel: RiskLevel;
  mutatedState: boolean;
  effectiveCaps: ToolRiskCaps;
}

export function emitAuditEntry(entry: ReplayAuditEntry): void {
  const clean = JSON.parse(JSON.stringify(entry)) as ReplayAuditEntry;
  console.info(`mcp.replay.audit ${JSON.stringify(clean)}`);
}
