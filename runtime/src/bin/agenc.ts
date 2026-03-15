#!/usr/bin/env node
import { runAgencCli } from "../cli/agenc.js";

void (async () => {
  try {
    const exitCode = await runAgencCli();
    process.exitCode = exitCode;
  } catch (error) {
    process.exitCode = 1;
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
  }
})();
