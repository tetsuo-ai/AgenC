import assert from 'node:assert/strict';
import test from 'node:test';
import { checkActorPermission, resolveActor } from './replay-actor.js';
import { emitAuditEntry } from './replay-audit.js';
import { getToolRiskProfile, loadToolCapsFromEnv, resolveToolCaps } from './replay-risk.js';
import type { ReplayPolicy } from './replay.js';

function buildReplayPolicy(): ReplayPolicy {
  return {
    maxSlotWindow: 2_000_000,
    maxEventCount: 250_000,
    maxConcurrentJobs: 2,
    maxToolRuntimeMs: 180_000,
    allowlist: new Set<string>(),
    denylist: new Set<string>(),
    defaultRedactions: ['signature'],
    auditEnabled: false,
  };
}

test('actor resolution: clientId present', () => {
  const actor = resolveActor({
    authInfo: { clientId: 'actor-001' },
  } as any);
  assert.deepEqual(actor, {
    id: 'actor-001',
    source: 'auth_client_id',
    authenticated: true,
  });
});

test('actor resolution: sessionId only', () => {
  const actor = resolveActor({
    sessionId: 'session-001',
  } as any);
  assert.deepEqual(actor, {
    id: 'session:session-001',
    source: 'session_id',
    authenticated: false,
  });
});

test('actor resolution: anonymous', () => {
  const actor = resolveActor(undefined);
  assert.deepEqual(actor, {
    id: 'anonymous',
    source: 'anonymous',
    authenticated: false,
  });
});

test('permission: denylisted actor', () => {
  const policy = buildReplayPolicy();
  policy.denylist.add('denylisted');
  const error = checkActorPermission(
    { id: 'denylisted', source: 'auth_client_id', authenticated: true },
    policy,
    'agenc_replay_compare',
  );
  assert.equal(error?.includes('denylisted'), true);
});

test('permission: not in allowlist', () => {
  const policy = buildReplayPolicy();
  policy.allowlist.add('allowlisted');
  const error = checkActorPermission(
    { id: 'anonymous', source: 'anonymous', authenticated: false },
    policy,
    'agenc_replay_compare',
  );
  assert.equal(error?.includes('not allowlisted'), true);
});

test('permission: high-risk tool unauthenticated', () => {
  const policy = buildReplayPolicy();
  const error = checkActorPermission(
    { id: 'anonymous', source: 'anonymous', authenticated: false },
    policy,
    'agenc_replay_backfill',
    { MCP_REPLAY_REQUIRE_AUTH_FOR_HIGH_RISK: 'true' },
  );
  assert.equal(error?.includes('requires authenticated actor'), true);
});

test('permission: allowed actor', () => {
  const policy = buildReplayPolicy();
  policy.allowlist.add('actor-123');
  const error = checkActorPermission(
    { id: 'actor-123', source: 'auth_client_id', authenticated: true },
    policy,
    'agenc_replay_backfill',
  );
  assert.equal(error, null);
});

test('risk profile: known tool', () => {
  const profile = getToolRiskProfile('agenc_replay_backfill');
  assert.equal(profile.riskLevel, 'high');
  assert.equal(profile.mutatesState, true);
  assert.equal(profile.toolName, 'agenc_replay_backfill');
  assert.equal(profile.defaultCaps.maxPayloadBytes > 0, true);
});

test('risk profile: unknown tool', () => {
  const profile = getToolRiskProfile('unknown_tool');
  assert.equal(profile.riskLevel, 'high');
  assert.equal(profile.toolName, 'unknown_tool');
  assert.equal(profile.defaultCaps.maxWindowSlots, 500_000);
});

test('cap resolution: global only', () => {
  const policy: ReplayPolicy = {
    ...buildReplayPolicy(),
    maxSlotWindow: 12_345,
    maxEventCount: 234,
    maxToolRuntimeMs: 56_789,
  };
  const caps = resolveToolCaps('agenc_replay_compare', { globalPolicy: policy });
  assert.equal(caps.maxWindowSlots, 12_345);
  assert.equal(caps.maxEventCount, 234);
  assert.equal(caps.timeoutMs, 56_789);
  assert.equal(caps.maxPayloadBytes, getToolRiskProfile('agenc_replay_compare').defaultCaps.maxPayloadBytes);
});

test('cap resolution: tool override', () => {
  const policy = buildReplayPolicy();
  const caps = resolveToolCaps('agenc_replay_compare', {
    globalPolicy: policy,
    toolOverrides: {
      agenc_replay_compare: {
        maxEventCount: 123,
        maxPayloadBytes: 456,
      },
    },
  });
  assert.equal(caps.maxEventCount, 123);
  assert.equal(caps.maxPayloadBytes, 456);
});

test('cap resolution: env var override', () => {
  const overrides = loadToolCapsFromEnv({
    MCP_REPLAY_CAPS_COMPARE_MAX_WINDOW_SLOTS: '500000',
    MCP_REPLAY_CAPS_COMPARE_MAX_EVENT_COUNT: '250',
    MCP_REPLAY_CAPS_COMPARE_TIMEOUT_MS: '1000',
    MCP_REPLAY_CAPS_COMPARE_MAX_PAYLOAD_BYTES: '2048',
  });

  assert.deepEqual(overrides.agenc_replay_compare, {
    maxWindowSlots: 500000,
    maxEventCount: 250,
    timeoutMs: 1000,
    maxPayloadBytes: 2048,
  });
});

test('audit entry: success', () => {
  const calls: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    calls.push(String(args[0]));
  };

  try {
    emitAuditEntry({
      timestamp: new Date(0).toISOString(),
      tool: 'agenc_replay_status',
      actor: { id: 'actor', source: 'auth_client_id', authenticated: true },
      requestId: 'req-1',
      status: 'success',
      durationMs: 10,
      riskLevel: 'low',
      mutatedState: false,
      effectiveCaps: {
        maxWindowSlots: 0,
        maxEventCount: 1,
        timeoutMs: 1,
        maxPayloadBytes: 1,
      },
    });
  } finally {
    console.info = original;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].startsWith('mcp.replay.audit '), true);

  const json = calls[0].slice('mcp.replay.audit '.length);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed.status, 'success');
  assert.equal(parsed.tool, 'agenc_replay_status');
  assert.equal(typeof parsed.timestamp, 'string');
  assert.equal(typeof parsed.durationMs, 'number');
});

test('audit entry: denied', () => {
  const calls: string[] = [];
  const original = console.info;
  console.info = (...args: unknown[]) => {
    calls.push(String(args[0]));
  };

  try {
    emitAuditEntry({
      timestamp: new Date(0).toISOString(),
      tool: 'agenc_replay_backfill',
      actor: { id: 'anonymous', source: 'anonymous', authenticated: false },
      requestId: 'req-2',
      status: 'denied',
      durationMs: 1,
      reason: 'denied',
      violationCode: 'replay.access_denied',
      riskLevel: 'high',
      mutatedState: true,
      effectiveCaps: {
        maxWindowSlots: 1,
        maxEventCount: 1,
        timeoutMs: 1,
        maxPayloadBytes: 1,
      },
    });
  } finally {
    console.info = original;
  }

  const json = calls[0].slice('mcp.replay.audit '.length);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  assert.equal(parsed.status, 'denied');
  assert.equal(parsed.violationCode, 'replay.access_denied');
  assert.equal(parsed.reason, 'denied');
});
