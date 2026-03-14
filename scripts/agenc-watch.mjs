import { pathToFileURL } from "node:url";
import { runWatchApp as defaultRunWatchApp } from "./lib/agenc-watch-app.mjs";

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

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  await runAgencWatchCli();
}
