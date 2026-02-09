import { describe, it, expect, vi } from 'vitest';
import { skillToTools, JUPITER_ACTION_SCHEMAS } from './skill-adapter.js';
import { ToolExecutionError } from './errors.js';
import type { Skill, SkillAction, SkillMetadata } from '../skills/types.js';
import { SkillState } from '../skills/types.js';
import type { JSONSchema } from './types.js';

function makeSkill(
  actions: SkillAction[],
  state: SkillState = SkillState.Ready,
  name = 'test-skill',
): Skill {
  return {
    metadata: {
      name,
      description: 'Test skill',
      version: '0.1.0',
      requiredCapabilities: 0n,
    } as SkillMetadata,
    state,
    initialize: vi.fn(),
    shutdown: vi.fn(),
    getActions: () => actions,
    getAction: (n: string) => actions.find((a) => a.name === n),
  };
}

function makeAction(name: string, result: unknown = { ok: true }): SkillAction {
  return {
    name,
    description: `Action: ${name}`,
    execute: vi.fn(async () => result),
  };
}

describe('skillToTools', () => {
  it('creates namespaced tools from skill actions', () => {
    const skill = makeSkill([makeAction('getQuote'), makeAction('executeSwap')]);
    const schemas: Record<string, JSONSchema> = {
      getQuote: { type: 'object', properties: {} },
      executeSwap: { type: 'object', properties: {} },
    };

    const tools = skillToTools(skill, { schemas });

    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('test-skill.getQuote');
    expect(tools[1].name).toBe('test-skill.executeSwap');
  });

  it('uses custom namespace', () => {
    const skill = makeSkill([makeAction('doStuff')]);
    const tools = skillToTools(skill, {
      schemas: { doStuff: { type: 'object' } },
      namespace: 'custom',
    });

    expect(tools[0].name).toBe('custom.doStuff');
  });

  it('skips actions without schema', () => {
    const skill = makeSkill([
      makeAction('exposed'),
      makeAction('hidden'),
    ]);

    const tools = skillToTools(skill, {
      schemas: { exposed: { type: 'object' } },
    });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('test-skill.exposed');
  });

  it('throws on non-Ready skill', () => {
    const skill = makeSkill([makeAction('a')], SkillState.Created);

    expect(() =>
      skillToTools(skill, { schemas: { a: { type: 'object' } } }),
    ).toThrow(ToolExecutionError);
  });

  it('execute wraps result with safeStringify (handles bigint)', async () => {
    const skill = makeSkill([makeAction('bigResult', { amount: 1000000000n, ok: true })]);
    const tools = skillToTools(skill, {
      schemas: { bigResult: { type: 'object' } },
    });

    const result = await tools[0].execute({});

    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content);
    expect(parsed.amount).toBe('1000000000');
    expect(parsed.ok).toBe(true);
  });

  it('catches action errors and returns ToolResult.isError', async () => {
    const action: SkillAction = {
      name: 'failing',
      description: 'Fails',
      execute: async () => { throw new Error('network error'); },
    };
    const skill = makeSkill([action]);
    const tools = skillToTools(skill, {
      schemas: { failing: { type: 'object' } },
    });

    const result = await tools[0].execute({});

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content)).toEqual({ error: 'network error' });
  });
});

describe('JUPITER_ACTION_SCHEMAS', () => {
  it('has entries for all 7 Jupiter actions', () => {
    const expected = [
      'getQuote',
      'executeSwap',
      'getSolBalance',
      'getTokenBalance',
      'transferSol',
      'transferToken',
      'getTokenPrice',
    ];
    expect(Object.keys(JUPITER_ACTION_SCHEMAS).sort()).toEqual(expected.sort());
  });

  it('each schema has type: object', () => {
    for (const schema of Object.values(JUPITER_ACTION_SCHEMAS)) {
      expect(schema.type).toBe('object');
    }
  });
});
