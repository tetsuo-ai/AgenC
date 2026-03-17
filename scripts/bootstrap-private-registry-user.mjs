#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { withTemporaryUserConfig } from "./private-kernel-distribution.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");
const serviceScriptPath = path.join(__dirname, "private-registry-service.mjs");
const defaultWaitMs = 15000;
const privateRegistryScope = "@tetsuo-ai-private";

function parseArgs(argv, env = process.env) {
  const options = {
    instance: env.PRIVATE_REGISTRY_INSTANCE ?? null,
    port: env.PRIVATE_REGISTRY_PORT ?? null,
    username: env.PRIVATE_REGISTRY_USERNAME ?? null,
    password: env.PRIVATE_REGISTRY_PASSWORD ?? null,
    email: env.PRIVATE_REGISTRY_EMAIL ?? null,
    tokenFile: env.PRIVATE_REGISTRY_TOKEN_FILE ?? null,
    waitMs: env.PRIVATE_REGISTRY_HEALTH_WAIT_MS
      ? Number.parseInt(env.PRIVATE_REGISTRY_HEALTH_WAIT_MS, 10)
      : defaultWaitMs,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    switch (argument) {
      case "--instance":
        index += 1;
        options.instance = argv[index];
        break;
      case "--port":
        index += 1;
        options.port = argv[index];
        break;
      case "--username":
        index += 1;
        options.username = argv[index];
        break;
      case "--password":
        index += 1;
        options.password = argv[index];
        break;
      case "--email":
        index += 1;
        options.email = argv[index];
        break;
      case "--token-file":
        index += 1;
        options.tokenFile = argv[index];
        break;
      case "--wait-ms":
        index += 1;
        options.waitMs = Number.parseInt(argv[index], 10);
        break;
      default:
        throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!options.username || !options.password || !options.email) {
    throw new Error("username, password, and email are required (via flags or PRIVATE_REGISTRY_* env vars)");
  }

  if (!Number.isInteger(options.waitMs) || options.waitMs <= 0) {
    throw new Error("--wait-ms must be a positive integer");
  }

  return options;
}

function runNodeScript(scriptPath, args, env = process.env) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if ((result.status ?? 1) !== 0) {
    const detail = [result.stdout?.trim(), result.stderr?.trim()].filter(Boolean).join("\n");
    throw new Error(
      `${path.relative(repoRoot, scriptPath)} ${args.join(" ")} failed with status ${result.status ?? 1}${detail ? `\n${detail}` : ""}`,
    );
  }

  return result.stdout;
}

function runNpm(args, { env, input }) {
  return spawnSync("npm", args, {
    cwd: repoRoot,
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function buildRegistryUserPayload({ username, password, email }) {
  return {
    name: username,
    password,
    email,
    type: "user",
    roles: [],
    date: new Date().toISOString(),
  };
}

function buildRegistryUserEndpoint(registryUrl, username) {
  const baseUrl = registryUrl.endsWith("/") ? registryUrl : `${registryUrl}/`;
  return new URL(`-/user/org.couchdb.user:${encodeURIComponent(username)}`, baseUrl).toString();
}

function parseJsonBody(text, context) {
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${context} returned non-JSON response\n${text}`, { cause: error });
  }
}

function readResponseMessage(body, fallbackText) {
  if (body && typeof body === "object") {
    if (typeof body.error === "string" && body.error.trim()) {
      return body.error.trim();
    }
    if (typeof body.ok === "string" && body.ok.trim()) {
      return body.ok.trim();
    }
  }

  return fallbackText.trim();
}

async function createRegistryUser({ registryUrl, username, password, email }) {
  const response = await fetch(buildRegistryUserEndpoint(registryUrl, username), {
    method: "PUT",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(buildRegistryUserPayload({ username, password, email })),
  });
  const responseText = await response.text();
  const responseBody = parseJsonBody(responseText, "registry create-user");

  if (response.status === 409) {
    return {
      kind: "exists",
      message: readResponseMessage(responseBody, responseText),
    };
  }

  if (!response.ok) {
    throw new Error(
      `registry create-user failed with status ${response.status}: ${readResponseMessage(responseBody, responseText)}`,
    );
  }

  if (typeof responseBody.token !== "string" || responseBody.token.trim() === "") {
    throw new Error(`registry create-user response did not include a token\n${responseText}`);
  }

  return {
    kind: "created",
    message: readResponseMessage(responseBody, responseText),
    token: responseBody.token.trim(),
  };
}

async function readTokenFileIfExists(filePath) {
  if (!existsSync(filePath)) {
    return null;
  }

  const token = (await readFile(filePath, "utf8")).trim();
  if (!token) {
    throw new Error(`existing token file is empty: ${filePath}`);
  }

  return token;
}

async function ensureSecureFile(filePath, content) {
  await writeFile(filePath, content, { encoding: "utf8", mode: 0o600 });
}

function verifyWhoami(registryUrl, token) {
  return withTemporaryUserConfig(
    {
      registryUrl,
      scope: privateRegistryScope,
      token,
    },
    async (userConfigPath) => {
      const whoamiResult = runNpm(["whoami", "--registry", registryUrl], {
        env: {
          ...process.env,
          NPM_CONFIG_USERCONFIG: userConfigPath,
        },
        input: "",
      });
      if ((whoamiResult.status ?? 1) !== 0) {
        const detail = [whoamiResult.stdout?.trim(), whoamiResult.stderr?.trim()].filter(Boolean).join("\n");
        throw new Error(`npm whoami failed after locked restart${detail ? `\n${detail}` : ""}`);
      }

      return whoamiResult.stdout.trim();
    },
  );
}

async function bootstrap(options) {
  const tokenFilePath =
    options.tokenFile
      ? path.resolve(repoRoot, options.tokenFile)
      : path.join(os.tmpdir(), `agenc-private-registry-token-${Date.now()}-${process.pid}`);
  const tokenFileExisted = existsSync(tokenFilePath);

  const serviceArgs = [];
  if (options.instance) {
    serviceArgs.push("--instance", options.instance);
  }
  if (options.port) {
    serviceArgs.push("--port", options.port);
  }

  let registryUrl = null;
  let tokenFileWrittenByScript = false;

  try {
    const bootstrapStart = JSON.parse(
      runNodeScript(serviceScriptPath, ["start", "--mode", "bootstrap", "--json", ...serviceArgs]),
    );
    registryUrl = bootstrapStart.registryUrl;

    runNodeScript(serviceScriptPath, ["health", "--json", "--wait-ms", String(options.waitMs), ...serviceArgs]);

    const createResult = await createRegistryUser({
      registryUrl,
      username: options.username,
      password: options.password,
      email: options.email,
    });

    let token = null;
    if (createResult.kind === "created") {
      token = createResult.token;
    } else {
      token = await readTokenFileIfExists(tokenFilePath);
      if (!token) {
        throw new Error(
          `registry user '${options.username}' already exists at ${registryUrl}; rerun with the existing token file or reset the registry instance`,
        );
      }
    }

    const lockedStart = JSON.parse(
      runNodeScript(serviceScriptPath, ["start", "--mode", "locked", "--json", ...serviceArgs]),
    );
    registryUrl = lockedStart.registryUrl;

    runNodeScript(serviceScriptPath, ["health", "--json", "--wait-ms", String(options.waitMs), ...serviceArgs]);

    const whoamiUser = await verifyWhoami(registryUrl, token);
    if (whoamiUser !== options.username) {
      throw new Error(`npm whoami returned '${whoamiUser}' after locked restart; expected '${options.username}'`);
    }

    await mkdir(path.dirname(tokenFilePath), { recursive: true });
    await ensureSecureFile(tokenFilePath, `${token}\n`);
    tokenFileWrittenByScript = true;

    process.stdout.write(
      `${JSON.stringify(
        {
          instance: options.instance ?? null,
          registryUrl,
          tokenFile: tokenFilePath,
          username: options.username,
          source: createResult.kind,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    try {
      runNodeScript(serviceScriptPath, ["stop", "--json", ...serviceArgs]);
    } catch {
      // best effort cleanup
    }
    if (tokenFileWrittenByScript && !tokenFileExisted) {
      await rm(tokenFilePath, { force: true });
    }
    throw error;
  }
}

export {
  buildRegistryUserEndpoint,
  buildRegistryUserPayload,
  createRegistryUser,
  parseArgs,
  readResponseMessage,
  readTokenFileIfExists,
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  bootstrap(parseArgs(process.argv.slice(2))).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
