import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  globMatch,
  extractAmount,
  ApprovalEngine,
  createApprovalGateHook,
  DEFAULT_APPROVAL_RULES,
} from './approvals.js';
import type {
  ApprovalRule,
  ApprovalRequest,
  ApprovalResponse,
} from './approvals.js';
import type { HookContext } from './hooks.js';
import { silentLogger } from '../utils/logger.js';

// ============================================================================
// globMatch
// ============================================================================

describe('globMatch', () => {
  it('matches exact strings', () => {
    expect(globMatch('system.bash', 'system.bash')).toBe(true);
  });

  it('rejects non-matching exact strings', () => {
    expect(globMatch('system.bash', 'system.delete')).toBe(false);
  });

  it('matches wildcard at end', () => {
    expect(globMatch('wallet.*', 'wallet.sign')).toBe(true);
    expect(globMatch('wallet.*', 'wallet.transfer')).toBe(true);
  });

  it('rejects wildcard that does not match', () => {
    expect(globMatch('wallet.*', 'system.bash')).toBe(false);
  });

  it('matches wildcard at start', () => {
    expect(globMatch('*.sign', 'wallet.sign')).toBe(true);
  });

  it('matches wildcard in middle', () => {
    expect(globMatch('system.*.run', 'system.bash.run')).toBe(true);
  });

  it('matches double wildcard', () => {
    expect(globMatch('*.*', 'wallet.sign')).toBe(true);
  });

  it('handles regex special chars in pattern', () => {
    expect(globMatch('tool(1).run', 'tool(1).run')).toBe(true);
    expect(globMatch('tool[0].run', 'tool[0].run')).toBe(true);
  });

  it('empty pattern matches empty value', () => {
    expect(globMatch('', '')).toBe(true);
  });

  it('star matches everything', () => {
    expect(globMatch('*', 'anything.at.all')).toBe(true);
  });
});

// ============================================================================
// extractAmount
// ============================================================================

describe('extractAmount', () => {
  it('extracts numeric amount', () => {
    expect(extractAmount({ amount: 5 })).toBe(5);
  });

  it('extracts string amount via coercion', () => {
    expect(extractAmount({ amount: '3.5' })).toBe(3.5);
  });

  it('extracts reward key', () => {
    expect(extractAmount({ reward: 2 })).toBe(2);
  });

  it('extracts lamports key', () => {
    expect(extractAmount({ lamports: 1000000 })).toBe(1000000);
  });

  it('prefers amount over reward over lamports', () => {
    expect(extractAmount({ amount: 1, reward: 2, lamports: 3 })).toBe(1);
  });

  it('returns undefined when no amount keys present', () => {
    expect(extractAmount({ foo: 'bar' })).toBeUndefined();
  });

  it('skips NaN values', () => {
    expect(extractAmount({ amount: 'not-a-number', reward: 10 })).toBe(10);
  });

  it('returns undefined for all NaN', () => {
    expect(extractAmount({ amount: 'abc' })).toBeUndefined();
  });

  it('returns 0 for amount: 0', () => {
    expect(extractAmount({ amount: 0 })).toBe(0);
  });

  it('skips empty string', () => {
    expect(extractAmount({ amount: '' })).toBeUndefined();
  });
});

// ============================================================================
// ApprovalEngine — rule matching
// ============================================================================

describe('ApprovalEngine', () => {
  let engine: ApprovalEngine;
  let idSeq: number;

  beforeEach(() => {
    idSeq = 0;
    engine = new ApprovalEngine({
      rules: DEFAULT_APPROVAL_RULES,
      timeoutMs: 100,
      now: () => 1000,
      generateId: () => `req-${++idSeq}`,
    });
  });

  describe('requiresApproval', () => {
    it('matches exact tool name', () => {
      const rule = engine.requiresApproval('system.delete', {});
      expect(rule).not.toBeNull();
      expect(rule!.tool).toBe('system.delete');
    });

    it('does not require approval for system.bash by default', () => {
      expect(engine.requiresApproval('system.bash', { command: 'npm' })).toBeNull();
    });

    it('returns null for unmatched tool', () => {
      expect(engine.requiresApproval('memory.store', {})).toBeNull();
    });

    it('matches tool with glob pattern', () => {
      const eng = new ApprovalEngine({
        rules: [{ tool: 'wallet.*' }],
        generateId: () => 'x',
      });
      expect(eng.requiresApproval('wallet.sign', {})).not.toBeNull();
      expect(eng.requiresApproval('wallet.transfer', {})).not.toBeNull();
      expect(eng.requiresApproval('system.bash', {})).toBeNull();
    });

    it('applies minAmount condition — blocks above threshold', () => {
      const rule = engine.requiresApproval('wallet.transfer', { amount: 0.5 });
      expect(rule).not.toBeNull();
    });

    it('applies minAmount condition — allows at/below threshold', () => {
      expect(engine.requiresApproval('wallet.transfer', { amount: 0.1 })).toBeNull();
      expect(engine.requiresApproval('wallet.transfer', { amount: 0.05 })).toBeNull();
    });

    it('applies minAmount with no amount key — skips rule', () => {
      expect(engine.requiresApproval('wallet.transfer', {})).toBeNull();
    });

    it('matches agenc.createTask with reward > 1 SOL (lamports)', () => {
      expect(engine.requiresApproval('agenc.createTask', { reward: 1_000_000_001 })).not.toBeNull();
      expect(engine.requiresApproval('agenc.createTask', { reward: 1_000_000_000 })).toBeNull();
    });

    it('always requires approval for agenc.registerAgent', () => {
      expect(engine.requiresApproval('agenc.registerAgent', {})).not.toBeNull();
    });

    it('checks argPatterns condition', () => {
      const eng = new ApprovalEngine({
        rules: [
          {
            tool: 'system.bash',
            conditions: { argPatterns: { command: 'rm *' } },
          },
        ],
        generateId: () => 'x',
      });
      expect(eng.requiresApproval('system.bash', { command: 'rm -rf /' })).not.toBeNull();
      expect(eng.requiresApproval('system.bash', { command: 'ls' })).toBeNull();
    });

    it('returns first matching rule', () => {
      const eng = new ApprovalEngine({
        rules: [
          { tool: 'wallet.*', description: 'first' },
          { tool: 'wallet.sign', description: 'second' },
        ],
        generateId: () => 'x',
      });
      const rule = eng.requiresApproval('wallet.sign', {});
      expect(rule!.description).toBe('first');
    });

    it('requires both minAmount AND argPatterns to pass', () => {
      const eng = new ApprovalEngine({
        rules: [
          {
            tool: 'wallet.transfer',
            conditions: {
              minAmount: 1,
              argPatterns: { to: 'enemy*' },
            },
          },
        ],
        generateId: () => 'x',
      });
      // Both pass
      expect(eng.requiresApproval('wallet.transfer', { amount: 5, to: 'enemy123' })).not.toBeNull();
      // Amount passes, argPattern fails
      expect(eng.requiresApproval('wallet.transfer', { amount: 5, to: 'friend1' })).toBeNull();
      // ArgPattern passes, amount fails
      expect(eng.requiresApproval('wallet.transfer', { amount: 0.5, to: 'enemy123' })).toBeNull();
      // Neither passes
      expect(eng.requiresApproval('wallet.transfer', { amount: 0.5, to: 'friend1' })).toBeNull();
    });
  });

  // ============================================================================
  // Approval flow
  // ============================================================================

  describe('approval flow', () => {
    it('resolves with yes — returns approved response', async () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);

      const promise = engine.requestApproval(req);
      engine.resolve(req.id, { requestId: req.id, disposition: 'yes' });

      const response = await promise;
      expect(response.disposition).toBe('yes');
    });

    it('resolves with no — returns denied response', async () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);

      const promise = engine.requestApproval(req);
      engine.resolve(req.id, { requestId: req.id, disposition: 'no' });

      const response = await promise;
      expect(response.disposition).toBe('no');
    });

    it('auto-denies on timeout', async () => {
      vi.useFakeTimers();
      try {
        const eng = new ApprovalEngine({
          rules: DEFAULT_APPROVAL_RULES,
          timeoutMs: 200,
          generateId: () => 'timeout-req',
        });
        const rule = DEFAULT_APPROVAL_RULES[0];
        const req = eng.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);

        const promise = eng.requestApproval(req);
        vi.advanceTimersByTime(200);

        const response = await promise;
        expect(response.disposition).toBe('no');
        expect(response.requestId).toBe('timeout-req');
      } finally {
        vi.useRealTimers();
      }
    });

    it('always disposition elevates the session', async () => {
      const rule = DEFAULT_APPROVAL_RULES[0]; // system.delete
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);

      const promise = engine.requestApproval(req);
      engine.resolve(req.id, { requestId: req.id, disposition: 'always' });

      await promise;
      expect(engine.isToolElevated('sess-1', 'system.delete')).toBe(true);
    });

    it('resolve of nonexistent request is a no-op', () => {
      // Should not throw
      engine.resolve('nonexistent', { requestId: 'nonexistent', disposition: 'yes' });
    });
  });

  // ============================================================================
  // onResponse callbacks
  // ============================================================================

  describe('onResponse', () => {
    it('notifies registered handlers on resolve', async () => {
      const handler = vi.fn();
      engine.onResponse(handler);

      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);

      const promise = engine.requestApproval(req);
      const response: ApprovalResponse = { requestId: req.id, disposition: 'yes' };
      engine.resolve(req.id, response);
      await promise;

      expect(handler).toHaveBeenCalledWith(req, response);
    });

    it('notifies on timeout auto-deny', async () => {
      vi.useFakeTimers();
      try {
        const handler = vi.fn();
        const eng = new ApprovalEngine({
          rules: DEFAULT_APPROVAL_RULES,
          timeoutMs: 100,
          generateId: () => 'to-req',
        });
        eng.onResponse(handler);

        const rule = DEFAULT_APPROVAL_RULES[0];
        const req = eng.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);

        const promise = eng.requestApproval(req);
        vi.advanceTimersByTime(100);
        await promise;

        expect(handler).toHaveBeenCalledTimes(1);
        expect(handler.mock.calls[0][1].disposition).toBe('no');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ============================================================================
  // Elevation management
  // ============================================================================

  describe('elevation', () => {
    it('isElevated returns false for unelevated session', () => {
      expect(engine.isElevated('sess-1')).toBe(false);
    });

    it('elevate + isElevated', () => {
      engine.elevate('sess-1', 'system.bash');
      expect(engine.isElevated('sess-1')).toBe(true);
    });

    it('isToolElevated checks specific tool against patterns', () => {
      engine.elevate('sess-1', 'wallet.*');
      expect(engine.isToolElevated('sess-1', 'wallet.sign')).toBe(true);
      expect(engine.isToolElevated('sess-1', 'wallet.transfer')).toBe(true);
      expect(engine.isToolElevated('sess-1', 'system.bash')).toBe(false);
    });

    it('revokeElevation clears all patterns', () => {
      engine.elevate('sess-1', 'system.bash');
      engine.elevate('sess-1', 'wallet.*');
      engine.revokeElevation('sess-1');
      expect(engine.isElevated('sess-1')).toBe(false);
    });

    it('sessions are isolated', () => {
      engine.elevate('sess-1', 'system.bash');
      expect(engine.isToolElevated('sess-2', 'system.bash')).toBe(false);
    });
  });

  // ============================================================================
  // getPending
  // ============================================================================

  describe('getPending', () => {
    it('returns empty array when nothing pending', () => {
      expect(engine.getPending()).toEqual([]);
    });

    it('returns pending requests', () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
      engine.requestApproval(req);

      const pending = engine.getPending();
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe(req.id);

      // Clean up the dangling timer
      engine.dispose();
    });

    it('removes resolved requests from pending', async () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
      const promise = engine.requestApproval(req);
      engine.resolve(req.id, { requestId: req.id, disposition: 'yes' });
      await promise;

      expect(engine.getPending()).toHaveLength(0);
    });
  });

  // ============================================================================
  // dispose
  // ============================================================================

  describe('dispose', () => {
    it('clears all pending timers and requests', () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req1 = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
      const req2 = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
      engine.requestApproval(req1);
      engine.requestApproval(req2);

      expect(engine.getPending()).toHaveLength(2);

      engine.dispose();

      expect(engine.getPending()).toHaveLength(0);
    });

    it('auto-denies pending requests so promises resolve', async () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
      const promise = engine.requestApproval(req);

      engine.dispose();

      const response = await promise;
      expect(response.disposition).toBe('no');
      expect(response.requestId).toBe(req.id);
    });
  });

  // ============================================================================
  // notifyHandlers error isolation
  // ============================================================================

  describe('notifyHandlers error isolation', () => {
    it('resolve still completes when onResponse handler throws', async () => {
      engine.onResponse(() => {
        throw new Error('handler crash');
      });

      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
      const promise = engine.requestApproval(req);
      engine.resolve(req.id, { requestId: req.id, disposition: 'yes' });

      const response = await promise;
      expect(response.disposition).toBe('yes');
    });

    it('timeout auto-deny still completes when onResponse handler throws', async () => {
      vi.useFakeTimers();
      try {
        const eng = new ApprovalEngine({
          rules: DEFAULT_APPROVAL_RULES,
          timeoutMs: 100,
          generateId: () => 'crash-req',
        });
        eng.onResponse(() => {
          throw new Error('handler crash');
        });

        const rule = DEFAULT_APPROVAL_RULES[0];
        const req = eng.createRequest('system.delete', {}, 'sess-1', 'Approve?', rule);
        const promise = eng.requestApproval(req);
        vi.advanceTimersByTime(100);

        const response = await promise;
        expect(response.disposition).toBe('no');
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // ============================================================================
  // createRequest
  // ============================================================================

  describe('createRequest', () => {
    it('creates a request with injected id and timestamp', () => {
      const rule = DEFAULT_APPROVAL_RULES[0];
      const req = engine.createRequest('system.delete', { cmd: 'ls' }, 'sess-1', 'Check', rule);

      expect(req.id).toBe('req-1');
      expect(req.toolName).toBe('system.delete');
      expect(req.args).toEqual({ cmd: 'ls' });
      expect(req.sessionId).toBe('sess-1');
      expect(req.message).toBe('Check');
      expect(req.createdAt).toBe(1000);
      expect(req.rule).toBe(rule);
    });
  });

  // ============================================================================
  // DEFAULT_APPROVAL_RULES
  // ============================================================================

  describe('DEFAULT_APPROVAL_RULES', () => {
    it('has 10 rules', () => {
      expect(DEFAULT_APPROVAL_RULES).toHaveLength(10);
    });

    it('covers system.delete and system.evaluateJs', () => {
      const tools = DEFAULT_APPROVAL_RULES.map((r) => r.tool);
      expect(tools).toContain('system.delete');
      expect(tools).toContain('system.evaluateJs');
    });

    it('covers wallet.sign, wallet.transfer, agenc.createTask, agenc.registerAgent', () => {
      const tools = DEFAULT_APPROVAL_RULES.map((r) => r.tool);
      expect(tools).toContain('wallet.sign');
      expect(tools).toContain('wallet.transfer');
      expect(tools).toContain('agenc.createTask');
      expect(tools).toContain('agenc.registerAgent');
    });

    it('wallet.transfer has minAmount 0.1', () => {
      const rule = DEFAULT_APPROVAL_RULES.find((r) => r.tool === 'wallet.transfer');
      expect(rule!.conditions!.minAmount).toBe(0.1);
    });

    it('agenc.createTask has minAmount 1 SOL in lamports', () => {
      const rule = DEFAULT_APPROVAL_RULES.find((r) => r.tool === 'agenc.createTask');
      expect(rule!.conditions!.minAmount).toBe(1_000_000_000);
    });
  });
});

// ============================================================================
// createApprovalGateHook
// ============================================================================

describe('createApprovalGateHook', () => {
  function makeCtx(payload: Record<string, unknown>): HookContext {
    return {
      event: 'tool:before',
      payload,
      logger: silentLogger,
      timestamp: Date.now(),
    };
  }

  it('has correct event, name, and priority', () => {
    const engine = new ApprovalEngine({ rules: [] });
    const hook = createApprovalGateHook(engine);

    expect(hook.event).toBe('tool:before');
    expect(hook.name).toBe('approval-gate');
    expect(hook.priority).toBe(5);
  });

  it('allows tool with no matching rule', async () => {
    const engine = new ApprovalEngine({ rules: [] });
    const hook = createApprovalGateHook(engine);

    const result = await hook.handler(makeCtx({ toolName: 'memory.store', args: {} }));
    expect(result.continue).toBe(true);
  });

  it('blocks tool when denied', async () => {
    let idSeq = 0;
    const engine = new ApprovalEngine({
      rules: [{ tool: 'system.bash' }],
      timeoutMs: 50,
      generateId: () => `req-${++idSeq}`,
    });
    const hook = createApprovalGateHook(engine);

    // Deny immediately
    engine.onResponse(() => {});
    const resultPromise = hook.handler(
      makeCtx({ toolName: 'system.bash', args: {}, sessionId: 'sess-1' }),
    );

    // Resolve with 'no' as soon as pending
    setTimeout(() => {
      const pending = engine.getPending();
      if (pending.length > 0) {
        engine.resolve(pending[0].id, { requestId: pending[0].id, disposition: 'no' });
      }
    }, 5);

    const result = await resultPromise;
    expect(result.continue).toBe(false);
    expect(result.payload?.blocked).toBe(true);
  });

  it('allows tool when approved', async () => {
    let idSeq = 0;
    const engine = new ApprovalEngine({
      rules: [{ tool: 'system.bash' }],
      timeoutMs: 1000,
      generateId: () => `req-${++idSeq}`,
    });
    const hook = createApprovalGateHook(engine);

    const resultPromise = hook.handler(
      makeCtx({ toolName: 'system.bash', args: {}, sessionId: 'sess-1' }),
    );

    setTimeout(() => {
      const pending = engine.getPending();
      if (pending.length > 0) {
        engine.resolve(pending[0].id, { requestId: pending[0].id, disposition: 'yes' });
      }
    }, 5);

    const result = await resultPromise;
    expect(result.continue).toBe(true);
  });

  it('skips approval for elevated tool', async () => {
    const engine = new ApprovalEngine({
      rules: [{ tool: 'system.bash' }],
    });
    engine.elevate('sess-1', 'system.bash');
    const hook = createApprovalGateHook(engine);

    const result = await hook.handler(
      makeCtx({ toolName: 'system.bash', args: {}, sessionId: 'sess-1' }),
    );
    expect(result.continue).toBe(true);
  });

  it('continues when no toolName in payload', async () => {
    const engine = new ApprovalEngine({ rules: [{ tool: '*' }] });
    const hook = createApprovalGateHook(engine);

    const result = await hook.handler(makeCtx({ args: {} }));
    expect(result.continue).toBe(true);
  });
});
