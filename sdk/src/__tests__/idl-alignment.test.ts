import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as agents from '../agents';
import * as tasks from '../tasks';
import * as disputes from '../disputes';
import * as protocol from '../protocol';
import * as state from '../state';
import * as governance from '../governance';
import { COORDINATION_ERROR_MAP, decodeError } from '../errors';

const idl = JSON.parse(
  readFileSync(new URL('../../../target/idl/agenc_coordination.json', import.meta.url), 'utf8'),
) as {
  instructions: Array<{ name: string }>;
  errors?: Array<{ code: number; name: string }>;
};

const EXPECTED_INSTRUCTIONS = [
  'register_agent',
  'update_agent',
  'suspend_agent',
  'unsuspend_agent',
  'deregister_agent',
  'create_task',
  'create_dependent_task',
  'claim_task',
  'expire_claim',
  'complete_task',
  'complete_task_private',
  'cancel_task',
  'update_state',
  'initiate_dispute',
  'vote_dispute',
  'resolve_dispute',
  'apply_dispute_slash',
  'apply_initiator_slash',
  'cancel_dispute',
  'expire_dispute',
  'initialize_protocol',
  'update_protocol_fee',
  'update_rate_limits',
  'migrate_protocol',
  'update_min_version',
  'initialize_governance',
  'create_proposal',
  'vote_proposal',
  'execute_proposal',
  'cancel_proposal',
] as const;

describe('IDL instruction alignment', () => {
  it('instruction set matches expected list exactly', () => {
    const idlNames = idl.instructions.map((ix) => ix.name).sort();
    const expected = [...EXPECTED_INSTRUCTIONS].sort();
    expect(idlNames).toEqual(expected);
  });

  it('every instruction has a matching camelCase SDK wrapper export', () => {
    const sdkExports = new Set<string>([
      ...Object.keys(agents),
      ...Object.keys(tasks),
      ...Object.keys(disputes),
      ...Object.keys(protocol),
      ...Object.keys(state),
      ...Object.keys(governance),
    ]);

    for (const instructionName of EXPECTED_INSTRUCTIONS) {
      const camelCase = instructionName.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      expect(sdkExports.has(camelCase)).toBe(true);
    }
  });

  it('error map covers every IDL error variant', () => {
    const idlErrors = idl.errors ?? [];
    expect(Object.keys(COORDINATION_ERROR_MAP)).toHaveLength(idlErrors.length);

    for (const err of idlErrors) {
      const decoded = decodeError(err.code);
      expect(decoded).not.toBeNull();
      expect(decoded?.name).toBe(err.name);
    }
  });
});
