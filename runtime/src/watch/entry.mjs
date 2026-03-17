import { runWatchApp as defaultRunWatchApp } from "./agenc-watch-app.mjs";

export async function runAgencWatchCli({ runWatchApp = defaultRunWatchApp, processLike = process } = {}) {
  try {
    const exitCode = await runWatchApp();
    processLike.exit(typeof exitCode === "number" ? exitCode : 0);
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    processLike.stderr.write(`${message}\n`);
    processLike.exit(1);
  }
}
