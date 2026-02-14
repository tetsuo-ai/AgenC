import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { expect } from 'vitest';

export interface GoldenContractSnapshot<TInput = Record<string, unknown>, TOutput = Record<string, unknown>> {
  id: string;
  version: number;
  command: string;
  input: TInput;
  output: {
    schema: string;
    shape: TOutput;
  };
  metadata: {
    generatedAt: string;
    generatedBy: string;
  };
}

export interface ContractCase<TInput, TOutput> {
  id: string;
  command: string;
  fixturePath: string;
  outputSchema: string;
  expectedStatus: 'ok' | 'error';
  requiredTopLevelKeys: ReadonlyArray<string>;
  optionalTopLevelKeys?: ReadonlyArray<string>;
  input: TInput;
  execute: (input: TInput) => Promise<unknown>;
  shape: (output: unknown) => TOutput;
}

const UPDATE_GOLDENS = process.env.UPDATE_GOLDENS === '1';
const SNAPSHOT_VERSION = 1;

export function loadGoldenSnapshot<TInput = Record<string, unknown>, TOutput = Record<string, unknown>>(
  path: string,
): GoldenContractSnapshot<TInput, TOutput> {
  const raw = readFileSync(path, 'utf8');
  return JSON.parse(raw) as GoldenContractSnapshot<TInput, TOutput>;
}

function writeGoldenSnapshot<TInput, TOutput>(
  path: string,
  snapshot: GoldenContractSnapshot<TInput, TOutput>,
): void {
  const normalized = JSON.stringify(snapshot, null, 2) + '\n';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, normalized, 'utf8');
}

function assertTopLevelKeys(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
  command: string,
): void {
  expect(value).toBeTypeOf('object');
  expect(value).toBeTruthy();

  const payload = value as Record<string, unknown>;
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys, 'command']);
  const actualKeys = Object.keys(payload).sort();

  for (const key of requiredKeys) {
    expect(actualKeys).toContain(key);
  }

  for (const key of actualKeys) {
    if (key === 'command') {
      expect(typeof payload.command, `${command}: command should be a string`).toBe('string');
      continue;
    }

    expect(
      allowedKeys.has(key),
      `${command}: unexpected top-level key: ${key}`,
    ).toBe(true);
  }
}

export async function runContractCase<TInput, TOutput>(
  testCase: ContractCase<TInput, TOutput>,
): Promise<void> {
  const rawOutput = await testCase.execute(testCase.input);
  expect(rawOutput).toBeTypeOf('object');
  expect(rawOutput).not.toBeNull();

  const payload = rawOutput as Record<string, unknown>;

  assertTopLevelKeys(
    rawOutput,
    testCase.requiredTopLevelKeys,
    testCase.optionalTopLevelKeys,
    testCase.command,
  );
  expect(payload.status).toBe(testCase.expectedStatus);

  const shape = testCase.shape(rawOutput);
  const snapshot = {
    id: testCase.id,
    version: SNAPSHOT_VERSION,
    command: testCase.command,
    input: testCase.input,
    output: {
      schema: testCase.outputSchema,
      shape,
    },
    metadata: {
      generatedAt: new Date().toISOString(),
      generatedBy: 'contract-validator',
    },
  } as const;

  if (UPDATE_GOLDENS) {
    writeGoldenSnapshot(testCase.fixturePath, snapshot);
    return;
  }

  const expected = loadGoldenSnapshot<TInput, TOutput>(testCase.fixturePath);
  expect(expected.id).toBe(testCase.id);
  expect(expected.version).toBe(SNAPSHOT_VERSION);
  expect(expected.command).toBe(testCase.command);
  expect(expected.output.schema).toBe(testCase.outputSchema);
  expect(expected.output.shape).toEqual(shape);
}
