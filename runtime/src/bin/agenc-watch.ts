#!/usr/bin/env node
import { runAgencWatchCli } from "../watch/entry.mjs";

void (async () => {
  try {
    await runAgencWatchCli();
  } catch (error) {
    process.exitCode = 1;
    // eslint-disable-next-line no-console
    console.error(error instanceof Error ? error.message : String(error));
  }
})();
