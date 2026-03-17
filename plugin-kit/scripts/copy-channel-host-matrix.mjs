import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.dirname(scriptDir);
const sourcePath = path.join(
  packageDir,
  "src",
  "compatibility",
  "channel-host-matrix.json",
);
const distDir = path.join(packageDir, "dist");
const outputPath = path.join(distDir, "channel-host-matrix.json");

await mkdir(distDir, { recursive: true });
await cp(sourcePath, outputPath);
