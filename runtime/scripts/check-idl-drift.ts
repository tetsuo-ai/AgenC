#!/usr/bin/env node

import { checkIdlDrift, formatDriftCheckOutput } from '../src/events/idl-drift-check.js';

interface CliOptions {
  help: boolean;
}

function parseCliArgs(argv: string[]): CliOptions {
  const options: CliOptions = { help: false };

  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      return options;
    }
  }

  return options;
}

function printUsage(): void {
  console.log([
    'Usage: check-idl-drift',
    '',
    'Checks runtime event contracts in runtime/src/events/idl-contract.ts',
    'against runtime/idl/agenc_coordination.json.',
    '',
    'Exit status:',
    '  0 - contract matches IDL schema',
    '  1 - mismatch detected',
  ].join('\n'));
}

async function main(): Promise<void> {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const result = await checkIdlDrift();
  const output = formatDriftCheckOutput(result);
  if (!result.passed) {
    console.error(output.header);
    for (const line of output.details) {
      console.error(line);
    }
    process.exit(1);
  }

  console.log(output.header);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`IDL drift check failed: ${message}`);
  process.exit(1);
});
