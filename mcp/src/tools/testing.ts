/**
 * Anchor Test Runner MCP Tools
 *
 * Wraps ts-mocha and anchor test with structured output parsing.
 */

import { execFile } from 'child_process';
import { readdir } from 'fs/promises';
import path from 'path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Root of the AgenC repository (parent of mcp/).
 *  When bundled into dist/index.cjs, __dirname is mcp/dist/ (2 up).
 *  When running from source, __dirname is mcp/src/tools/ (4 up).
 *  We detect by checking if Anchor.toml exists at the resolved path. */
function findProjectRoot(): string {
  const { existsSync } = require('fs');
  // Try bundled path first (mcp/dist/ -> 2 up)
  const bundled = path.resolve(__dirname, '..', '..');
  if (existsSync(path.join(bundled, 'Anchor.toml'))) return bundled;
  // Try source path (mcp/src/tools/ -> 4 up)
  const source = path.resolve(__dirname, '..', '..', '..', '..');
  if (existsSync(path.join(source, 'Anchor.toml'))) return source;
  // Fallback to cwd
  return process.cwd();
}
const PROJECT_ROOT = findProjectRoot();

/** Directory containing test files */
const TESTS_DIR = path.join(PROJECT_ROOT, 'tests');

/** Known test suites mapped to file globs */
const TEST_SUITES: Record<string, { files: string[]; description: string }> = {
  smoke: {
    files: ['smoke.ts'],
    description: 'Devnet smoke tests',
  },
  integration: {
    files: ['integration.ts', 'test_1.ts'],
    description: 'Main integration test suite',
  },
  security: {
    files: ['coordination-security.ts', 'audit-high-severity.ts', 'sybil-attack.ts'],
    description: 'Security-focused tests',
  },
  zk: {
    files: ['complete_task_private.ts', 'zk-proof-lifecycle.ts', 'sdk-proof-generation.ts'],
    description: 'ZK proof and private completion tests',
  },
  fuzz: {
    files: [],
    description: 'Rust fuzz tests (run via cargo fuzz)',
  },
};

/** Test result for a single test case */
interface TestCaseResult {
  name: string;
  status: 'passed' | 'failed' | 'pending';
  duration_ms?: number;
  error?: string;
}

/** Aggregated test run result */
interface TestRunResult {
  file: string;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  duration_ms: number;
  tests: TestCaseResult[];
  raw_output: string;
}

/** Cached last result */
let lastResults: TestRunResult[] | null = null;

/**
 * Parse mocha spec output into structured results.
 */
function parseMochaOutput(stdout: string, stderr: string, file: string): TestRunResult {
  const combined = stdout + '\n' + stderr;
  const tests: TestCaseResult[] = [];

  // Match passing tests: lines with checkmark and timing
  const passRegex = /^\s*[^\S\n]*[✓✔]\s+(.+?)(?:\s+\((\d+)ms\))?\s*$/gm;
  let match;
  while ((match = passRegex.exec(combined)) !== null) {
    tests.push({
      name: match[1].trim(),
      status: 'passed',
      duration_ms: match[2] ? parseInt(match[2], 10) : undefined,
    });
  }

  // Match failing tests: numbered failures
  const failRegex = /^\s*\d+\)\s+(.+)\s*$/gm;
  const failNames = new Set<string>();
  while ((match = failRegex.exec(combined)) !== null) {
    const name = match[1].trim();
    // Avoid duplicates from error detail sections
    if (!failNames.has(name)) {
      failNames.add(name);
      tests.push({ name, status: 'failed' });
    }
  }

  // Try to extract error messages for failed tests
  const errorBlockRegex = /^\s*\d+\)\s+(.+?)\n([\s\S]*?)(?=\n\s*\d+\)|\n\s*\d+ passing|\n\s*$)/gm;
  while ((match = errorBlockRegex.exec(combined)) !== null) {
    const name = match[1].trim();
    const errorBody = match[2].trim();
    const existing = tests.find((t) => t.name === name && t.status === 'failed');
    if (existing) {
      // Extract first meaningful error line
      const errLines = errorBody.split('\n').map((l) => l.trim()).filter(Boolean);
      existing.error = errLines.slice(0, 5).join('\n');
    }
  }

  // Match pending tests
  const pendingRegex = /^\s*-\s+(.+)\s*$/gm;
  while ((match = pendingRegex.exec(combined)) !== null) {
    tests.push({ name: match[1].trim(), status: 'pending' });
  }

  // Parse summary line: "N passing (Xs)" and "N failing"
  const passingMatch = /(\d+)\s+passing\s+\(([^)]+)\)/.exec(combined);
  const failingMatch = /(\d+)\s+failing/.exec(combined);
  const pendingMatch = /(\d+)\s+pending/.exec(combined);

  const passed = passingMatch ? parseInt(passingMatch[1], 10) : tests.filter((t) => t.status === 'passed').length;
  const failed = failingMatch ? parseInt(failingMatch[1], 10) : tests.filter((t) => t.status === 'failed').length;
  const pending = pendingMatch ? parseInt(pendingMatch[1], 10) : tests.filter((t) => t.status === 'pending').length;

  // Parse duration
  let durationMs = 0;
  if (passingMatch && passingMatch[2]) {
    const durStr = passingMatch[2];
    const secMatch = /(\d+)s/.exec(durStr);
    const msMatch = /(\d+)ms/.exec(durStr);
    const minMatch = /(\d+)m/.exec(durStr);
    if (minMatch) durationMs += parseInt(minMatch[1], 10) * 60_000;
    if (secMatch) durationMs += parseInt(secMatch[1], 10) * 1000;
    if (msMatch) durationMs += parseInt(msMatch[1], 10);
    if (!secMatch && !msMatch && !minMatch) {
      // Try plain number as ms
      const plain = parseInt(durStr, 10);
      if (!isNaN(plain)) durationMs = plain;
    }
  }

  return {
    file,
    total: passed + failed + pending,
    passed,
    failed,
    pending,
    duration_ms: durationMs,
    tests,
    raw_output: combined.length > 5000 ? combined.slice(0, 5000) + '\n... (truncated)' : combined,
  };
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
        exitCode: error ? (error as NodeJS.ErrnoException & { code?: number | string }).code === 'ETIMEDOUT' ? 124 : (proc.exitCode ?? 1) : 0,
      });
    });
  });
}

function formatTestResults(results: TestRunResult[]): string {
  const lines: string[] = [];

  for (const r of results) {
    lines.push('=== ' + r.file + ' ===');
    lines.push('Total: ' + r.total + '  Passed: ' + r.passed + '  Failed: ' + r.failed + '  Pending: ' + r.pending);
    if (r.duration_ms > 0) {
      lines.push('Duration: ' + (r.duration_ms / 1000).toFixed(1) + 's');
    }
    lines.push('');

    for (const t of r.tests) {
      const icon = t.status === 'passed' ? '[PASS]' : t.status === 'failed' ? '[FAIL]' : '[SKIP]';
      const dur = t.duration_ms !== undefined ? ' (' + t.duration_ms + 'ms)' : '';
      lines.push('  ' + icon + ' ' + t.name + dur);
      if (t.error) {
        lines.push('       ' + t.error.split('\n').join('\n       '));
      }
    }
    lines.push('');
  }

  const totalPassed = results.reduce((s, r) => s + r.passed, 0);
  const totalFailed = results.reduce((s, r) => s + r.failed, 0);
  const totalPending = results.reduce((s, r) => s + r.pending, 0);
  lines.push('--- Summary ---');
  lines.push('Files: ' + results.length + '  Passed: ' + totalPassed + '  Failed: ' + totalFailed + '  Pending: ' + totalPending);
  lines.push('Result: ' + (totalFailed === 0 ? 'ALL PASSED' : 'FAILURES DETECTED'));

  return lines.join('\n');
}

export function registerTestingTools(server: McpServer): void {
  server.tool(
    'agenc_run_tests',
    'Run AgenC tests via ts-mocha with structured result parsing',
    {
      file: z.string().optional().describe('Specific test file name (e.g. "smoke.ts"). Runs all if omitted.'),
      grep: z.string().optional().describe('Mocha --grep pattern to filter test names'),
      timeout: z.number().int().positive().optional().describe('Test timeout in ms (default: 120000)'),
    },
    async ({ file, grep, timeout }) => {
      try {
        const timeoutMs = timeout ?? 120_000;
        const filesToRun: string[] = [];

        if (file) {
          // Validate filename to prevent path traversal
          const basename = path.basename(file);
          if (basename !== file || file.includes('..')) {
            return {
              content: [{ type: 'text' as const, text: 'Error: invalid test file name' }],
            };
          }
          filesToRun.push(file);
        } else {
          // Discover all .ts test files
          try {
            const entries = await readdir(TESTS_DIR);
            for (const e of entries) {
              if (e.endsWith('.ts')) filesToRun.push(e);
            }
          } catch {
            return {
              content: [{ type: 'text' as const, text: 'Error: could not read tests directory at ' + TESTS_DIR }],
            };
          }
        }

        if (filesToRun.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'No test files found' }],
          };
        }

        const results: TestRunResult[] = [];
        for (const f of filesToRun) {
          const args = [
            'ts-mocha',
            '-p', './tsconfig.json',
            '-t', String(timeoutMs),
            'tests/' + f,
          ];
          if (grep) {
            args.push('--grep', grep);
          }

          const { stdout, stderr, exitCode } = await runCommand(
            'npx', args, PROJECT_ROOT, timeoutMs + 30_000,
          );

          const result = parseMochaOutput(stdout, stderr, f);
          if (exitCode === 124) {
            result.tests.push({ name: '(timeout)', status: 'failed', error: 'Test run timed out after ' + timeoutMs + 'ms' });
            result.failed += 1;
            result.total += 1;
          }
          results.push(result);
        }

        lastResults = results;

        return {
          content: [{ type: 'text' as const, text: formatTestResults(results) }],
        };
      } catch (error) {
        return {
          content: [{ type: 'text' as const, text: 'Error: ' + (error as Error).message }],
        };
      }
    },
  );

  server.tool(
    'agenc_run_test_suite',
    'Run a named test suite (smoke, integration, security, zk, fuzz)',
    {
      suite: z.enum(['smoke', 'integration', 'security', 'zk', 'fuzz']).describe('Test suite to run'),
      timeout: z.number().int().positive().optional().describe('Test timeout in ms (default: 120000)'),
    },
    async ({ suite, timeout }) => {
      try {
        const suiteConfig = TEST_SUITES[suite];
        if (!suiteConfig) {
          return {
            content: [{ type: 'text' as const, text: 'Error: unknown suite "' + suite + '"' }],
          };
        }

        if (suite === 'fuzz') {
          return {
            content: [{
              type: 'text' as const,
              text: [
                'Fuzz tests run via cargo fuzz, not ts-mocha.',
                'Available fuzz targets:',
                '  cargo fuzz run claim_task',
                '  cargo fuzz run complete_task',
                '  cargo fuzz run vote_dispute',
                '  cargo fuzz run resolve_dispute',
                '',
                'Run from: programs/agenc-coordination/',
              ].join('\n'),
            }],
          };
        }

        if (suiteConfig.files.length === 0) {
          return {
            content: [{ type: 'text' as const, text: 'Suite "' + suite + '" has no TypeScript test files.' }],
          };
        }

        const timeoutMs = timeout ?? 120_000;
        const results: TestRunResult[] = [];

        for (const f of suiteConfig.files) {
          const args = [
            'ts-mocha',
            '-p', './tsconfig.json',
            '-t', String(timeoutMs),
            'tests/' + f,
          ];

          const { stdout, stderr, exitCode } = await runCommand(
            'npx', args, PROJECT_ROOT, timeoutMs + 30_000,
          );

          const result = parseMochaOutput(stdout, stderr, f);
          if (exitCode === 124) {
            result.tests.push({ name: '(timeout)', status: 'failed', error: 'Test run timed out' });
            result.failed += 1;
            result.total += 1;
          }
          results.push(result);
        }

        lastResults = results;

        return {
          content: [{
            type: 'text' as const,
            text: 'Suite: ' + suite + ' (' + suiteConfig.description + ')\n\n' + formatTestResults(results),
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
    'agenc_get_test_files',
    'List available test files with descriptions',
    {},
    async () => {
      try {
        const entries = await readdir(TESTS_DIR);
        const testFiles = entries.filter((e) => e.endsWith('.ts')).sort();

        const descriptions: Record<string, string> = {
          'test_1.ts': 'Main integration test suite',
          'smoke.ts': 'Devnet smoke tests',
          'coordination-security.ts': 'Security-focused tests',
          'audit-high-severity.ts': 'Audit finding tests',
          'rate-limiting.ts': 'Rate limiting behavior tests',
          'upgrades.ts': 'Protocol upgrade tests',
          'complete_task_private.ts': 'ZK private completion tests',
          'integration.ts': 'Anchor 0.32 lifecycle tests',
          'minimal.ts': 'Minimal debugging tests',
          'zk-proof-lifecycle.ts': 'ZK proof lifecycle tests',
          'sdk-proof-generation.ts': 'SDK proof generation tests',
          'sybil-attack.ts': 'Sybil attack resistance tests',
          'dispute-slash-logic.ts': 'Dispute slashing logic tests',
        };

        const lines = testFiles.map((f) => {
          const desc = descriptions[f] ?? 'Test file';
          return '  ' + f + ' - ' + desc;
        });

        const suiteLines = Object.entries(TEST_SUITES).map(([name, cfg]) => {
          return '  ' + name + ': ' + cfg.description + ' (' + (cfg.files.length > 0 ? cfg.files.join(', ') : 'cargo fuzz') + ')';
        });

        return {
          content: [{
            type: 'text' as const,
            text: [
              'Test files (' + testFiles.length + '):',
              ...lines,
              '',
              'Named suites:',
              ...suiteLines,
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
    'agenc_get_last_results',
    'Get results from the last test run',
    {},
    async () => {
      if (!lastResults) {
        return {
          content: [{ type: 'text' as const, text: 'No test results cached. Run agenc_run_tests or agenc_run_test_suite first.' }],
        };
      }

      return {
        content: [{ type: 'text' as const, text: formatTestResults(lastResults) }],
      };
    },
  );

  server.tool(
    'agenc_run_anchor_test',
    'Run full anchor test with parsed output (builds program + runs all tests)',
    {
      skip_build: z.boolean().optional().describe('Skip anchor build step (default: false)'),
      skip_deploy: z.boolean().optional().describe('Skip anchor deploy step (default: false)'),
      timeout: z.number().int().positive().optional().describe('Timeout in ms (default: 300000)'),
    },
    async ({ skip_build, skip_deploy, timeout }) => {
      try {
        const timeoutMs = timeout ?? 300_000;
        const args = ['test'];
        if (skip_build) args.push('--skip-build');
        if (skip_deploy) args.push('--skip-deploy');

        const { stdout, stderr, exitCode } = await runCommand(
          'anchor', args, PROJECT_ROOT, timeoutMs,
        );

        const result = parseMochaOutput(stdout, stderr, 'anchor test');
        if (exitCode === 124) {
          result.tests.push({ name: '(timeout)', status: 'failed', error: 'anchor test timed out after ' + timeoutMs + 'ms' });
          result.failed += 1;
          result.total += 1;
        }

        lastResults = [result];

        const lines = [
          'anchor test ' + (exitCode === 0 ? 'PASSED' : 'FAILED (exit ' + exitCode + ')'),
          '',
          formatTestResults([result]),
        ];

        // Include raw output if no tests were parsed (build failure, etc.)
        if (result.total === 0 && (stdout + stderr).length > 0) {
          const raw = (stdout + stderr).slice(-3000);
          lines.push('', '--- Raw Output (last 3000 chars) ---', raw);
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
