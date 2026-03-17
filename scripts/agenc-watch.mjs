#!/usr/bin/env node

import { pathToFileURL } from "node:url";
import { runAgencWatchCli as defaultRunAgencWatchCli } from "../runtime/src/watch/entry.mjs";

export { runAgencWatchCli } from "../runtime/src/watch/entry.mjs";

const isMainModule = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMainModule) {
  await defaultRunAgencWatchCli();
}
