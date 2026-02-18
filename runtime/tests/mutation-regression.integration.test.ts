import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  MutationRunner,
  serializeMutationArtifact,
} from '../src/eval/mutation-runner.js';
import { runCommand } from '../src/utils/process.js';

describe('mutation regression integration', () => {
  it('runs benchmark corpus under mutation operators deterministically', async () => {
    const manifestPath = fileURLToPath(new URL('../benchmarks/v1/manifest.json', import.meta.url));
    const runnerA = new MutationRunner({
      now: () => 1700000000500,
      runId: 'mutation-corpus-v1',
    });
    const runnerB = new MutationRunner({
      now: () => 1700000000500,
      runId: 'mutation-corpus-v1',
    });

    const first = await runnerA.runFromFile(manifestPath, { mutationSeed: 31 });
    const second = await runnerB.runFromFile(manifestPath, { mutationSeed: 31 });

    expect(serializeMutationArtifact(first)).toBe(serializeMutationArtifact(second));
    expect(first.runs.length).toBeGreaterThan(0);
    expect(first.topRegressions.length).toBeGreaterThan(0);
    expect(first.topRegressions.some((entry) => entry.scope === 'scenario')).toBe(true);
  });

  it('supports CI dry-run threshold gate evaluation via CLI', async () => {
    const manifestPath = fileURLToPath(new URL('../benchmarks/v1/manifest.json', import.meta.url));
    const artifact = await new MutationRunner({
      now: () => 1700000000600,
      runId: 'mutation-corpus-ci-gate',
    }).runFromFile(manifestPath, { mutationSeed: 13 });

    const tempDir = await mkdtemp(path.join(tmpdir(), 'agenc-mutation-gates-'));
    const artifactPath = path.join(tempDir, 'mutation-artifact.json');
    await writeFile(artifactPath, `${serializeMutationArtifact(artifact)}\n`, 'utf8');

    const scriptPath = fileURLToPath(new URL('../scripts/check-mutation-gates.ts', import.meta.url));
    const strictArgs = [
      '--import',
      'tsx',
      scriptPath,
      '--artifact',
      artifactPath,
      '--max-aggregate-pass-rate-drop',
      '0.01',
      '--max-scenario-pass-rate-drop',
      '0.01',
      '--max-operator-pass-rate-drop',
      '0.01',
    ];

    const failRun = await runCommand(process.execPath, strictArgs, {
      cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    });
    expect(failRun.exitCode).toBe(1);
    expect(`${failRun.stdout}\n${failRun.stderr}`).toContain('FAIL');

    const dryRun = await runCommand(process.execPath, [...strictArgs, '--dry-run'], {
      cwd: path.resolve(fileURLToPath(new URL('..', import.meta.url))),
    });
    expect(dryRun.exitCode).toBe(0);
    expect(`${dryRun.stdout}\n${dryRun.stderr}`).toContain('FAIL');
  });
});
