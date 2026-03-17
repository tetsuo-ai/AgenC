#!/usr/bin/env node

import { access, mkdtemp, readFile, rm, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawn } from 'node:child_process';

const repoRoot = process.cwd();
const packages = [
  { name: '@tetsuo-ai/desktop-tool-contracts', dir: 'contracts/desktop-tool-contracts' },
  { name: '@tetsuo-ai/plugin-kit', dir: 'plugin-kit' },
  { name: '@tetsuo-ai/runtime', dir: 'runtime' },
  { name: '@tetsuo-ai/mcp', dir: 'mcp' },
  { name: '@tetsuo-ai/docs-mcp', dir: 'docs-mcp' },
];
const releasedPackages = ['@tetsuo-ai/sdk@1.3.1', '@tetsuo-ai/protocol@0.1.1'];

function run(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function logStep(message) {
  process.stdout.write(`[pack-smoke] ${message}\n`);
}

async function assertExists(filePath, label) {
  try {
    await access(filePath);
  } catch (error) {
    throw new Error(`${label} missing at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function verifyBinLaunch(tempRoot, binName) {
  const binPath = path.join(
    tempRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${binName}.cmd` : binName,
  );

  await new Promise((resolve, reject) => {
    const child = spawn(binPath, [], {
      cwd: tempRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stderr = '';
    let settled = false;

    const settle = (fn) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      fn();
    };

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settle(() => reject(error));
    });

    child.on('exit', (code) => {
      if (code === 0) {
        settle(resolve);
        return;
      }
      settle(() => reject(new Error(`${binName} exited with code ${code}: ${stderr.trim()}`)));
    });

    const timeout = setTimeout(() => {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
      }
      settle(resolve);
    }, 750);
  });
}

async function main() {
  const keepTemp = process.argv.includes('--keep-temp');
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'tetsuo-ai-pack-smoke.'));
  const tarballs = [];

  try {
    for (const pkg of packages) {
      const packageDir = path.join(repoRoot, pkg.dir);
      logStep(`packing ${pkg.name}`);
      const output = run('npm', ['pack', '--json'], packageDir);
      const [packed] = JSON.parse(output);
      if (!packed?.filename) {
        throw new Error(`npm pack did not return a filename for ${pkg.name}`);
      }
      tarballs.push(path.join(packageDir, packed.filename));
    }

    logStep(`creating clean install at ${tempRoot}`);
    run('npm', ['init', '-y'], tempRoot);
    run(
      'npm',
      ['install', '--no-fund', '--no-audit', ...releasedPackages, ...tarballs],
      tempRoot,
    );

    const smokeSource = [
      "require('@tetsuo-ai/desktop-tool-contracts');",
      "const sdk = require('@tetsuo-ai/sdk');",
      "const internalSpl = require('@tetsuo-ai/sdk/internal/spl-token');",
      "const pluginKit = require('@tetsuo-ai/plugin-kit');",
      "const channelHostMatrixModule = require('@tetsuo-ai/plugin-kit/channel-host-matrix');",
      "const channelHostMatrixJson = require('@tetsuo-ai/plugin-kit/channel-host-matrix.json');",
      "const protocol = require('@tetsuo-ai/protocol');",
      "if (typeof internalSpl.createMint !== 'function') throw new Error('missing createMint export on internal SPL subpath');",
      "if (typeof internalSpl.createAssociatedTokenAccountInstruction !== 'function') throw new Error('missing ATA instruction export on internal SPL subpath');",
      "const leakedSplHelpers = ['createMint', 'mintTo', 'createAssociatedTokenAccount', 'createAssociatedTokenAccountInstruction', 'createInitializeMint2Instruction', 'createMintToInstruction'].filter((key) => key in sdk);",
      "if (leakedSplHelpers.length > 0) throw new Error(`internal SPL helpers leaked onto the public SDK surface: ${leakedSplHelpers.join(', ')}`);",
      "if (typeof pluginKit.certifyChannelAdapterModule !== 'function') throw new Error('missing plugin-kit certification export');",
      "const channelHostMatrix = Array.isArray(channelHostMatrixModule) ? channelHostMatrixModule : channelHostMatrixModule.channel_host_matrix ?? channelHostMatrixModule.default;",
      "if (!Array.isArray(channelHostMatrix) || channelHostMatrix.length === 0) throw new Error('missing channel-host-matrix subpath export');",
      "if (!Array.isArray(channelHostMatrixJson) || channelHostMatrixJson.length === 0) throw new Error('missing channel-host-matrix json export');",
      "if (!protocol.AGENC_COORDINATION_IDL || !protocol.AGENC_PROTOCOL_MANIFEST) throw new Error('missing protocol exports');",
      "require('@tetsuo-ai/runtime');",
      "require('@tetsuo-ai/runtime/browser');",
      "require('@tetsuo-ai/runtime/operator-events');",
      "require('@tetsuo-ai/mcp');",
      "require('@tetsuo-ai/docs-mcp');",
      "console.log('smoke-ok');",
    ].join(' ');
    const smokeOutput = run('node', ['-e', smokeSource], tempRoot).trim();
    if (smokeOutput !== 'smoke-ok') {
      throw new Error(`unexpected smoke output: ${smokeOutput}`);
    }

    logStep('verifying installed bins');
    await verifyBinLaunch(tempRoot, 'agenc-mcp');
    await verifyBinLaunch(tempRoot, 'agenc-docs');

    logStep('verifying sdk packaged subpath artifacts');
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'sdk',
        'dist',
        'spl-token.js',
      ),
      'sdk internal SPL CommonJS bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'sdk',
        'dist',
        'spl-token.mjs',
      ),
      'sdk internal SPL ESM bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'sdk',
        'dist',
        'spl-token.d.ts',
      ),
      'sdk internal SPL type declarations',
    );

    logStep('verifying desktop tool contract packaged artifacts');
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'desktop-tool-contracts',
        'dist',
        'index.cjs',
      ),
      'desktop tool contract CommonJS bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'desktop-tool-contracts',
        'dist',
        'index.mjs',
      ),
      'desktop tool contract ESM bundle',
    );

    logStep('verifying plugin-kit packaged artifacts');
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'plugin-kit',
        'dist',
        'index.cjs',
      ),
      'plugin-kit CommonJS bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'plugin-kit',
        'dist',
        'index.mjs',
      ),
      'plugin-kit ESM bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'plugin-kit',
        'dist',
        'channel-host-matrix.cjs',
      ),
      'plugin-kit channel host matrix CommonJS bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'plugin-kit',
        'dist',
        'channel-host-matrix.mjs',
      ),
      'plugin-kit channel host matrix ESM bundle',
    );
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'plugin-kit',
        'dist',
        'channel-host-matrix.json',
      ),
      'plugin-kit channel host matrix JSON artifact',
    );

    logStep('verifying published protocol packaged artifacts');
    const protocolIdlPath = path.join(
      tempRoot,
      'node_modules',
      '@tetsuo-ai',
      'protocol',
      'src',
      'generated',
      'agenc_coordination.json',
    );
    await assertExists(protocolIdlPath, 'published protocol IDL');
    const protocolIdl = JSON.parse(await readFile(protocolIdlPath, 'utf8'));
    if (
      protocolIdl?.metadata?.name !== 'agenc_coordination' ||
      !Array.isArray(protocolIdl?.instructions) ||
      protocolIdl.instructions.length === 0
    ) {
      throw new Error(
        `unexpected published protocol IDL payload at ${protocolIdlPath}: ${JSON.stringify({
          name: protocolIdl?.metadata?.name ?? null,
          instructionCount: Array.isArray(protocolIdl?.instructions)
            ? protocolIdl.instructions.length
            : null,
        })}`,
      );
    }
    await assertExists(
      path.join(
        tempRoot,
        'node_modules',
        '@tetsuo-ai',
        'runtime',
        'dist',
        'bin',
        'agenc-watch.js',
      ),
      'runtime operator console bin',
    );

    logStep('verifying installed dependency tree');
    const treeOutput = run(
      'npm',
      [
        'ls',
        '@tetsuo-ai/desktop-tool-contracts',
        '@tetsuo-ai/sdk',
        '@tetsuo-ai/plugin-kit',
        '@tetsuo-ai/protocol',
        '@tetsuo-ai/runtime',
        '@tetsuo-ai/mcp',
        '@tetsuo-ai/docs-mcp',
      ],
      tempRoot,
    ).trim();
    process.stdout.write(`${treeOutput}\n`);
    logStep('smoke-ok');
  } finally {
    await Promise.all(
      tarballs.map(async (tarball) => {
        try {
          await unlink(tarball);
        } catch {
          // Best-effort cleanup only; pack output is reproducible.
        }
      }),
    );
    if (keepTemp) {
      logStep(`kept temp directory ${tempRoot}`);
      return;
    }
    await rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`[pack-smoke] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
