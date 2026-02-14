import type { ReplayPolicy } from './replay.js';
import type { ReplayToolRequestExtra } from './replay-internal-types.js';
import { getToolRiskProfile } from './replay-risk.js';

export interface ResolvedActor {
  id: string;
  source: 'auth_client_id' | 'session_id' | 'anonymous';
  authenticated: boolean;
}

export function resolveActor(extra: ReplayToolRequestExtra): ResolvedActor {
  const authInfo = extra?.authInfo;

  if (authInfo?.clientId) {
    return {
      id: authInfo.clientId,
      source: 'auth_client_id',
      authenticated: true,
    };
  }

  if (extra?.sessionId) {
    return {
      id: `session:${extra.sessionId}`,
      source: 'session_id',
      authenticated: false,
    };
  }

  return {
    id: 'anonymous',
    source: 'anonymous',
    authenticated: false,
  };
}

export function checkActorPermission(
  actor: ResolvedActor,
  policy: ReplayPolicy,
  toolName: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  if (policy.denylist.size > 0 && policy.denylist.has(actor.id)) {
    return `actor ${actor.id} is denylisted for replay tools`;
  }

  if (policy.allowlist.size > 0 && !policy.allowlist.has(actor.id)) {
    return `actor ${actor.id} is not allowlisted for replay tools`;
  }

  const profile = getToolRiskProfile(toolName);
  if (profile.riskLevel === 'high' && !actor.authenticated) {
    const requireAuth = env.MCP_REPLAY_REQUIRE_AUTH_FOR_HIGH_RISK === 'true';
    if (requireAuth) {
      return `tool ${toolName} requires authenticated actor (risk level: high)`;
    }
  }

  return null;
}
