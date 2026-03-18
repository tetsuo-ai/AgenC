#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { buildUserConfigContent } from "./private-kernel-distribution.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const defaultStageRoot = path.join(repoRoot, ".tmp", "private-kernel-distribution", "stage");

function parseArgs(argv, env = process.env) {
  const options = {
    registryUrl: env.PRIVATE_KERNEL_REGISTRY_URL || "http://127.0.0.1:4873",
    scope: env.PRIVATE_KERNEL_PRIVATE_SCOPE || "@tetsuo-ai-private",
    token: env.PRIVATE_KERNEL_REGISTRY_TOKEN || null,
    stageRoot: env.PRIVATE_KERNEL_STAGE_ROOT ? path.resolve(repoRoot, env.PRIVATE_KERNEL_STAGE_ROOT) : defaultStageRoot,
    fixtureOnly: false,
    expectPublicScopePublishDenied: false,
    freshPublishReadRetries: 20,
    freshPublishReadDelayMs: 3000,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--registry-url":
        index += 1;
        options.registryUrl = argv[index];
        break;
      case "--scope":
        index += 1;
        options.scope = argv[index];
        break;
      case "--token":
        index += 1;
        options.token = argv[index];
        break;
      case "--stage-root":
        index += 1;
        options.stageRoot = path.resolve(repoRoot, argv[index]);
        break;
      case "--fixture-only":
        options.fixtureOnly = true;
        break;
      case "--expect-public-scope-publish-denied":
        options.expectPublicScopePublishDenied = true;
        break;
      case "--fresh-publish-read-retries":
        index += 1;
        options.freshPublishReadRetries = Number.parseInt(argv[index], 10);
        break;
      case "--fresh-publish-read-delay-ms":
        index += 1;
        options.freshPublishReadDelayMs = Number.parseInt(argv[index], 10);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!options.token) {
    throw new Error("PRIVATE_KERNEL_REGISTRY_TOKEN or --token is required");
  }
  if (!Number.isInteger(options.freshPublishReadRetries) || options.freshPublishReadRetries < 0) {
    throw new Error("--fresh-publish-read-retries must be a non-negative integer");
  }
  if (!Number.isInteger(options.freshPublishReadDelayMs) || options.freshPublishReadDelayMs < 0) {
    throw new Error("--fresh-publish-read-delay-ms must be a non-negative integer");
  }

  return options;
}

function runNpm(args, { cwd, env, input = "" }) {
  return spawnSync("npm", args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function assertNpm(result, context) {
  if ((result.status ?? 1) !== 0) {
    const detail = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(`${context} failed${detail ? `\n${detail}` : ""}`);
  }
}

function isRetryableFreshPublishRead(result) {
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.toLowerCase();
  return (
    (result.status ?? 1) !== 0
    && (
      text.includes("npm error code e404")
      || text.includes(" 404 ")
      || text.includes("could not be found")
      || text.includes("not found")
    )
  );
}

async function runNpmWithRetry(
  args,
  { cwd, env, retries = 8, delayMs = 1500, shouldRetry = isRetryableFreshPublishRead } = {},
) {
  let result = runNpm(args, { cwd, env });
  for (let attempt = 1; attempt <= retries && shouldRetry(result); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    result = runNpm(args, { cwd, env });
  }
  return result;
}

async function withTempUserConfig(registryUrl, scope, token, callback) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "agenc-private-registry-userconfig-"));
  const userConfigPath = path.join(tempDir, ".npmrc");

  try {
    await writeFile(userConfigPath, buildUserConfigContent(registryUrl, scope, token), {
      encoding: "utf8",
      mode: 0o600,
    });

    return await callback({
      env: {
        ...process.env,
        NPM_CONFIG_USERCONFIG: userConfigPath,
      },
      userConfigPath,
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

function randomNonce() {
  return `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2, 10)}`;
}

async function createFixturePackage(rootDir, { name, version }) {
  await writeFile(
    path.join(rootDir, "package.json"),
    JSON.stringify(
      {
        name,
        version,
        description: "private registry rehearsal fixture",
        type: "module",
        main: "index.js",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await writeFile(path.join(rootDir, "index.js"), `export default ${JSON.stringify(name)};\n`, "utf8");
}

async function runRehearsal(options) {
  const stageManifestPath = path.join(options.stageRoot, "staging-manifest.json");
  if (!existsSync(stageManifestPath)) {
    throw new Error(`staging manifest missing at ${stageManifestPath}; run stage first`);
  }
  const stageManifest = JSON.parse(await readFile(stageManifestPath, "utf8"));
  const nonce = randomNonce();

  await withTempUserConfig(options.registryUrl, options.scope, options.token, async ({ env }) => {
    const publicFixtureDir = await mkdtemp(path.join(os.tmpdir(), "agenc-public-publish-fixture-"));
    const privateFixtureDir = await mkdtemp(path.join(os.tmpdir(), "agenc-private-publish-fixture-"));
    const privateInstallDir = await mkdtemp(path.join(os.tmpdir(), "agenc-private-install-fixture-"));
    const stagedInstallDir = await mkdtemp(path.join(os.tmpdir(), "agenc-private-install-staged-"));

    try {
      const publicFixtureName = `@tetsuo-ai/private-registry-public-fixture-${nonce}`;
      const privateFixtureName = `@tetsuo-ai-private/private-registry-fixture-${nonce}`;
      const fixtureVersion = "0.0.1";

      assertNpm(
        runNpm(["view", "@tetsuo-ai/sdk", "version", "--registry", options.registryUrl], {
          cwd: repoRoot,
          env,
        }),
        "public scope uplink npm view",
      );
      if (!options.fixtureOnly) {
        const privatePrePublishView = runNpm(
          ["view", "@tetsuo-ai-private/runtime", "version", "--registry", options.registryUrl],
          {
            cwd: repoRoot,
            env,
          },
        );
        if ((privatePrePublishView.status ?? 1) === 0) {
          throw new Error("private scope unexpectedly resolved before staged publish");
        }
      }

      await createFixturePackage(publicFixtureDir, {
        name: publicFixtureName,
        version: fixtureVersion,
      });
      await createFixturePackage(privateFixtureDir, {
        name: privateFixtureName,
        version: fixtureVersion,
      });

      if (options.expectPublicScopePublishDenied) {
        const publicPublish = runNpm(
          ["publish", "--registry", options.registryUrl],
          { cwd: publicFixtureDir, env },
        );
        if ((publicPublish.status ?? 1) === 0) {
          throw new Error("public-scope publish unexpectedly succeeded against private registry");
        }
        const publicFailureText = `${publicPublish.stdout}\n${publicPublish.stderr}`.toLowerCase();
        if (!publicFailureText.includes("403") && !publicFailureText.includes("forbidden")) {
          throw new Error(`public-scope publish failed for the wrong reason\n${publicPublish.stdout}\n${publicPublish.stderr}`);
        }
      }

      assertNpm(
        runNpm(["publish", "--registry", options.registryUrl], { cwd: privateFixtureDir, env }),
        "private fixture publish",
      );
      assertNpm(
        await runNpmWithRetry(["view", privateFixtureName, "version", "--registry", options.registryUrl], {
          cwd: repoRoot,
          env,
          retries: options.freshPublishReadRetries,
          delayMs: options.freshPublishReadDelayMs,
        }),
        "private fixture npm view",
      );
      assertNpm(runNpm(["init", "-y"], { cwd: privateInstallDir, env }), "fixture consumer npm init");
      assertNpm(
        await runNpmWithRetry(["install", `${privateFixtureName}@${fixtureVersion}`, "--registry", options.registryUrl], {
          cwd: privateInstallDir,
          env,
          retries: options.freshPublishReadRetries,
          delayMs: options.freshPublishReadDelayMs,
        }),
        "private fixture install",
      );

      const stagedConsumers = ["@tetsuo-ai-private/mcp", "@tetsuo-ai-private/desktop-server"].filter((name) =>
        stageManifest.packages.some((pkg) => pkg.stagedName === name),
      );

      if (!options.fixtureOnly) {
        for (const pkg of stageManifest.packages) {
          const stagedDir = path.join(repoRoot, pkg.stagedDir);
          assertNpm(
            runNpm(["publish", "--registry", options.registryUrl], { cwd: stagedDir, env }),
            `staged publish ${pkg.stagedName}`,
          );
        }

        assertNpm(runNpm(["init", "-y"], { cwd: stagedInstallDir, env }), "staged consumer npm init");

        for (const packageName of stagedConsumers) {
          assertNpm(
            await runNpmWithRetry(["install", packageName, "--registry", options.registryUrl], {
              cwd: stagedInstallDir,
              env,
              retries: options.freshPublishReadRetries,
              delayMs: options.freshPublishReadDelayMs,
            }),
            `staged consumer install ${packageName}`,
          );
        }
      }

      process.stdout.write(
        `${JSON.stringify(
          {
            registryUrl: options.registryUrl,
            fixtureVersion,
            fixtureOnly: options.fixtureOnly,
            expectPublicScopePublishDenied: options.expectPublicScopePublishDenied,
            freshPublishReadRetries: options.freshPublishReadRetries,
            freshPublishReadDelayMs: options.freshPublishReadDelayMs,
            privateFixtureName,
            stagedConsumers: options.fixtureOnly ? [] : stagedConsumers,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await Promise.all([
        rm(publicFixtureDir, { force: true, recursive: true }),
        rm(privateFixtureDir, { force: true, recursive: true }),
        rm(privateInstallDir, { force: true, recursive: true }),
        rm(stagedInstallDir, { force: true, recursive: true }),
      ]);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runRehearsal(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { isRetryableFreshPublishRead, parseArgs, runRehearsal };
