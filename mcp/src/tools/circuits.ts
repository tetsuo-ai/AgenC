/**
 * ZK Circuit MCP Tools
 *
 * Wraps circom and snarkjs CLI tools for compiling, proving, and verifying
 * Circom ZK circuits with structured output parsing.
 */

import { execFile } from 'child_process';
import { stat, readFile } from 'fs/promises';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Root of the AgenC repository.
 *  When bundled into dist/index.cjs, __dirname is mcp/dist/ (2 up).
 *  When running from source, __dirname is mcp/src/tools/ (4 up). */
function findProjectRoot(): string {
  const { existsSync } = require('fs');
  const bundled = path.resolve(__dirname, '..', '..');
  if (existsSync(path.join(bundled, 'Anchor.toml'))) return bundled;
  const source = path.resolve(__dirname, '..', '..', '..', '..');
  if (existsSync(path.join(source, 'Anchor.toml'))) return source;
  return process.cwd();
}
const PROJECT_ROOT = findProjectRoot();

/** Default circuit directory */
const DEFAULT_CIRCUIT_DIR = path.join(PROJECT_ROOT, 'circuits-circom', 'task_completion');

/**
 * Validate a circuit path to prevent directory traversal and injection.
 */
function validatePath(inputPath: string | undefined, defaultDir: string): string {
  if (!inputPath) return defaultDir;

  // Reject path traversal
  if (inputPath.includes('..')) {
    throw new Error('Path traversal not allowed');
  }

  // Reject shell metacharacters
  const dangerousChars = /[;&|`$(){}[\]<>!]/;
  if (dangerousChars.test(inputPath)) {
    throw new Error('Invalid characters in path');
  }

  const candidate = path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(PROJECT_ROOT, inputPath);

  // Enforce project-root confinement for both absolute and relative input.
  const projectRoot = path.resolve(PROJECT_ROOT);
  if (candidate !== projectRoot && !candidate.startsWith(projectRoot + path.sep)) {
    throw new Error('Path must be inside project root');
  }

  return candidate;
}

/**
 * Run a command and capture output.
 */
function runCommand(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = execFile(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        exitCode: error
          ? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ETIMEDOUT'
            ? 124
            : (proc.exitCode ?? 1)
          : 0,
      });
    });
  });
}

/**
 * Check if a file or directory exists.
 */
async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get file size in bytes.
 */
async function getFileSize(p: string): Promise<number> {
  try {
    const s = await stat(p);
    return s.size;
  } catch {
    return 0;
  }
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function registerCircuitTools(server: McpServer): void {
  server.tool(
    'agenc_compile_circuit',
    'Compile a Circom circuit to R1CS + WASM, parsing constraint and signal counts',
    {
      circuit_path: z.string().optional().describe('Path to circuit directory (default: circuits-circom/task_completion/)'),
    },
    async ({ circuit_path }) => {
      try {
        const circuitDir = validatePath(circuit_path, DEFAULT_CIRCUIT_DIR);

        // Find the .circom file
        const circomFile = path.join(circuitDir, 'circuit.circom');
        if (!(await fileExists(circomFile))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: circuit file not found at ' + circomFile + '\nLooking for circuit.circom in ' + circuitDir,
            }],
          };
        }

        const targetDir = path.join(circuitDir, 'target');

        const { stdout, stderr, exitCode } = await runCommand(
          'circom',
          [circomFile, '--r1cs', '--wasm', '--sym', '-o', targetDir],
          circuitDir,
          120_000,
        );

        const combined = stdout + '\n' + stderr;

        if (exitCode !== 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Compilation FAILED (exit ' + exitCode + ')\n\n' + combined.slice(-3000),
            }],
          };
        }

        // Parse output for constraint and signal counts
        const constraintMatch = /non-linear constraints:\s*(\d+)/i.exec(combined)
          ?? /constraints:\s*(\d+)/i.exec(combined);
        const signalMatch = /private inputs:\s*(\d+)/i.exec(combined)
          ?? /signals:\s*(\d+)/i.exec(combined);
        const publicMatch = /public inputs:\s*(\d+)/i.exec(combined);
        const outputMatch = /outputs:\s*(\d+)/i.exec(combined);

        const lines = [
          'Compilation SUCCESS',
          '',
          '--- Circuit Stats ---',
        ];

        if (constraintMatch) lines.push('Constraints: ' + constraintMatch[1]);
        if (publicMatch) lines.push('Public Inputs: ' + publicMatch[1]);
        if (signalMatch) lines.push('Private Inputs: ' + signalMatch[1]);
        if (outputMatch) lines.push('Outputs: ' + outputMatch[1]);

        // Check output files
        const r1csPath = path.join(targetDir, 'circuit.r1cs');
        const wasmDir = path.join(targetDir, 'circuit_js');

        lines.push('');
        lines.push('--- Output Files ---');
        if (await fileExists(r1csPath)) {
          lines.push('R1CS: ' + r1csPath + ' (' + formatFileSize(await getFileSize(r1csPath)) + ')');
        }
        if (await fileExists(wasmDir)) {
          lines.push('WASM: ' + wasmDir + '/');
        }
        if (await fileExists(path.join(targetDir, 'circuit.sym'))) {
          lines.push('Symbols: ' + path.join(targetDir, 'circuit.sym'));
        }

        if (!constraintMatch && !signalMatch) {
          lines.push('', '--- Raw Output ---', combined.slice(0, 2000));
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_generate_witness',
    'Generate a witness from input signals using snarkjs',
    {
      input_json: z.string().describe('JSON string with input signals (e.g. {"task_id": "1", "agent_pubkey": "..."})'),
      circuit_path: z.string().optional().describe('Path to circuit directory (default: circuits-circom/task_completion/)'),
    },
    async ({ input_json, circuit_path }) => {
      try {
        const circuitDir = validatePath(circuit_path, DEFAULT_CIRCUIT_DIR);
        const targetDir = path.join(circuitDir, 'target');
        const wasmPath = path.join(targetDir, 'circuit_js', 'circuit.wasm');
        const witnessPath = path.join(targetDir, 'witness.wtns');

        if (!(await fileExists(wasmPath))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: compiled WASM not found at ' + wasmPath + '\nRun agenc_compile_circuit first.',
            }],
          };
        }

        // Validate JSON
        try {
          JSON.parse(input_json);
        } catch {
          return {
            content: [{ type: 'text' as const, text: 'Error: invalid JSON input' }],
          };
        }

        // Write input to temp file
        const inputPath = path.join(targetDir, 'input.json');
        const { writeFile } = await import('fs/promises');
        await writeFile(inputPath, input_json);

        const { stdout, stderr, exitCode } = await runCommand(
          'npx',
          ['snarkjs', 'wtns', 'calculate', wasmPath, inputPath, witnessPath],
          circuitDir,
          60_000,
        );

        if (exitCode !== 0) {
          const combined = stdout + '\n' + stderr;
          return {
            content: [{
              type: 'text' as const,
              text: 'Witness generation FAILED (exit ' + exitCode + ')\n\n' + combined.slice(-2000),
            }],
          };
        }

        const witnessSize = await getFileSize(witnessPath);

        return {
          content: [{
            type: 'text' as const,
            text: [
              'Witness generation SUCCESS',
              'Output: ' + witnessPath + ' (' + formatFileSize(witnessSize) + ')',
            ].join('\n'),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_generate_proof',
    'Generate a Groth16 proof from a witness using snarkjs',
    {
      witness_path: z.string().optional().describe('Path to witness file (default: target/witness.wtns in circuit dir)'),
      circuit_path: z.string().optional().describe('Path to circuit directory (default: circuits-circom/task_completion/)'),
    },
    async ({ witness_path, circuit_path }) => {
      try {
        const circuitDir = validatePath(circuit_path, DEFAULT_CIRCUIT_DIR);
        const targetDir = path.join(circuitDir, 'target');

        const witnessFile = witness_path
          ? validatePath(witness_path, targetDir)
          : path.join(targetDir, 'witness.wtns');
        const zkeyPath = path.join(targetDir, 'circuit_final.zkey');
        const proofPath = path.join(targetDir, 'proof.json');
        const publicPath = path.join(targetDir, 'public.json');

        if (!(await fileExists(witnessFile))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: witness file not found at ' + witnessFile + '\nRun agenc_generate_witness first.',
            }],
          };
        }

        if (!(await fileExists(zkeyPath))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: proving key not found at ' + zkeyPath + '\nRun trusted setup (powers of tau + phase 2) first.',
            }],
          };
        }

        const { stdout, stderr, exitCode } = await runCommand(
          'npx',
          ['snarkjs', 'groth16', 'prove', zkeyPath, witnessFile, proofPath, publicPath],
          circuitDir,
          120_000,
        );

        if (exitCode !== 0) {
          const combined = stdout + '\n' + stderr;
          return {
            content: [{
              type: 'text' as const,
              text: 'Proof generation FAILED (exit ' + exitCode + ')\n\n' + combined.slice(-2000),
            }],
          };
        }

        const proofSize = await getFileSize(proofPath);
        const publicSize = await getFileSize(publicPath);

        const lines = [
          'Proof generation SUCCESS',
          '',
          'Proof: ' + proofPath + ' (' + formatFileSize(proofSize) + ')',
          'Public inputs: ' + publicPath + ' (' + formatFileSize(publicSize) + ')',
        ];

        // Show public inputs count
        try {
          const publicData = JSON.parse(await readFile(publicPath, 'utf-8'));
          if (Array.isArray(publicData)) {
            lines.push('Public input count: ' + publicData.length);
          }
        } catch {
          // Skip if can't parse
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_verify_proof',
    'Verify a Groth16 proof locally using snarkjs',
    {
      proof_path: z.string().optional().describe('Path to proof.json (default: target/proof.json in circuit dir)'),
      public_path: z.string().optional().describe('Path to public.json (default: target/public.json in circuit dir)'),
      circuit_path: z.string().optional().describe('Path to circuit directory (default: circuits-circom/task_completion/)'),
    },
    async ({ proof_path, public_path, circuit_path }) => {
      try {
        const circuitDir = validatePath(circuit_path, DEFAULT_CIRCUIT_DIR);
        const targetDir = path.join(circuitDir, 'target');

        const proofFile = proof_path
          ? validatePath(proof_path, targetDir)
          : path.join(targetDir, 'proof.json');
        const publicFile = public_path
          ? validatePath(public_path, targetDir)
          : path.join(targetDir, 'public.json');
        const vkPath = path.join(targetDir, 'verification_key.json');

        if (!(await fileExists(proofFile))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: proof file not found at ' + proofFile,
            }],
          };
        }

        if (!(await fileExists(publicFile))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: public inputs file not found at ' + publicFile,
            }],
          };
        }

        if (!(await fileExists(vkPath))) {
          return {
            content: [{
              type: 'text' as const,
              text: 'Error: verification key not found at ' + vkPath,
            }],
          };
        }

        const { stdout, stderr, exitCode } = await runCommand(
          'npx',
          ['snarkjs', 'groth16', 'verify', vkPath, publicFile, proofFile],
          circuitDir,
          60_000,
        );

        const combined = (stdout + '\n' + stderr).trim();
        const isValid = exitCode === 0 && /OK|valid/i.test(combined);

        return {
          content: [{
            type: 'text' as const,
            text: [
              'Verification: ' + (isValid ? 'VALID' : 'INVALID'),
              '',
              'Proof: ' + proofFile,
              'Public inputs: ' + publicFile,
              'Verification key: ' + vkPath,
              '',
              combined.length > 0 ? combined.slice(0, 1000) : '(no output)',
            ].join('\n'),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_get_circuit_info',
    'Get circuit metadata: file existence, compiled artifacts, constraint counts',
    {
      circuit_path: z.string().optional().describe('Path to circuit directory (default: circuits-circom/task_completion/)'),
    },
    async ({ circuit_path }) => {
      try {
        const circuitDir = validatePath(circuit_path, DEFAULT_CIRCUIT_DIR);
        const targetDir = path.join(circuitDir, 'target');

        const lines = ['Circuit directory: ' + circuitDir, ''];

        // Check source files
        const circomFile = path.join(circuitDir, 'circuit.circom');
        const inputExample = path.join(circuitDir, 'input.example.json');

        lines.push('--- Source Files ---');
        lines.push('circuit.circom: ' + (await fileExists(circomFile) ? 'exists (' + formatFileSize(await getFileSize(circomFile)) + ')' : 'NOT FOUND'));
        lines.push('input.example.json: ' + (await fileExists(inputExample) ? 'exists' : 'not found'));

        // Check compiled artifacts
        const r1csPath = path.join(targetDir, 'circuit.r1cs');
        const wasmDir = path.join(targetDir, 'circuit_js');
        const symPath = path.join(targetDir, 'circuit.sym');
        const zkeyPath = path.join(targetDir, 'circuit_final.zkey');
        const vkPath = path.join(targetDir, 'verification_key.json');
        const proofPath = path.join(targetDir, 'proof.json');
        const publicPath = path.join(targetDir, 'public.json');

        lines.push('');
        lines.push('--- Compiled Artifacts ---');
        lines.push('R1CS: ' + (await fileExists(r1csPath) ? formatFileSize(await getFileSize(r1csPath)) : 'not compiled'));
        lines.push('WASM: ' + (await fileExists(wasmDir) ? 'exists' : 'not compiled'));
        lines.push('Symbols: ' + (await fileExists(symPath) ? 'exists' : 'not compiled'));

        lines.push('');
        lines.push('--- Proving Setup ---');
        lines.push('Proving key (zkey): ' + (await fileExists(zkeyPath) ? formatFileSize(await getFileSize(zkeyPath)) : 'not generated'));
        lines.push('Verification key: ' + (await fileExists(vkPath) ? 'exists' : 'not generated'));

        lines.push('');
        lines.push('--- Proof Artifacts ---');
        lines.push('proof.json: ' + (await fileExists(proofPath) ? formatFileSize(await getFileSize(proofPath)) : 'none'));
        lines.push('public.json: ' + (await fileExists(publicPath) ? formatFileSize(await getFileSize(publicPath)) : 'none'));

        // If R1CS exists, try to get info via snarkjs
        if (await fileExists(r1csPath)) {
          const { stdout, stderr } = await runCommand(
            'npx',
            ['snarkjs', 'r1cs', 'info', r1csPath],
            circuitDir,
            30_000,
          );
          const info = (stdout + '\n' + stderr).trim();
          if (info.length > 0) {
            lines.push('');
            lines.push('--- R1CS Info ---');
            lines.push(info.slice(0, 1500));
          }
        }

        // Show verification key protocol if available
        if (await fileExists(vkPath)) {
          try {
            const vk = JSON.parse(await readFile(vkPath, 'utf-8'));
            if (vk.protocol) {
              lines.push('');
              lines.push('Proving system: ' + vk.protocol);
            }
            if (vk.nPublic !== undefined) {
              lines.push('Public inputs (from VK): ' + vk.nPublic);
            }
          } catch {
            // Skip parse errors
          }
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_get_proving_key_info',
    'Check proving key existence and size for the ZK circuit',
    {
      circuit_path: z.string().optional().describe('Path to circuit directory (default: circuits-circom/task_completion/)'),
    },
    async ({ circuit_path }) => {
      try {
        const circuitDir = validatePath(circuit_path, DEFAULT_CIRCUIT_DIR);
        const targetDir = path.join(circuitDir, 'target');
        const zkeyPath = path.join(targetDir, 'circuit_final.zkey');
        const vkPath = path.join(targetDir, 'verification_key.json');

        const lines = ['Circuit: ' + circuitDir, ''];

        if (await fileExists(zkeyPath)) {
          const size = await getFileSize(zkeyPath);
          lines.push('Proving key: ' + zkeyPath);
          lines.push('Size: ' + formatFileSize(size));

          // Try to export VK info
          if (await fileExists(vkPath)) {
            try {
              const vk = JSON.parse(await readFile(vkPath, 'utf-8'));
              lines.push('');
              lines.push('--- Verification Key ---');
              lines.push('Protocol: ' + (vk.protocol ?? 'unknown'));
              lines.push('Curve: ' + (vk.curve ?? 'unknown'));
              if (vk.nPublic !== undefined) lines.push('Public inputs: ' + vk.nPublic);
            } catch {
              // Skip
            }
          }

          lines.push('');
          lines.push('Status: Ready for proof generation');
        } else {
          lines.push('Proving key: NOT FOUND');
          lines.push('Expected at: ' + zkeyPath);
          lines.push('');
          lines.push('To generate a proving key, run the trusted setup:');
          lines.push('  1. npx snarkjs powersoftau new bn128 <power> pot_0000.ptau');
          lines.push('  2. npx snarkjs powersoftau contribute pot_0000.ptau pot_0001.ptau');
          lines.push('  3. npx snarkjs powersoftau prepare phase2 pot_0001.ptau pot_final.ptau');
          lines.push('  4. npx snarkjs groth16 setup circuit.r1cs pot_final.ptau circuit_0000.zkey');
          lines.push('  5. npx snarkjs zkey contribute circuit_0000.zkey circuit_final.zkey');
          lines.push('  6. npx snarkjs zkey export verificationkey circuit_final.zkey verification_key.json');
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );
}
