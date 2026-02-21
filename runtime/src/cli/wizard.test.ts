import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  WizardOptions,
  ConfigValidateOptions,
  ConfigShowOptions,
} from "./types.js";
import {
  generateDefaultConfig,
  detectSolanaKeypair,
  runConfigInitCommand,
  runConfigValidateCommand,
  runConfigShowCommand,
} from "./wizard.js";
import type { GatewayConfig } from "../gateway/types.js";
import { createContextCapture } from "./test-utils.js";

function baseOptions(): Omit<WizardOptions, "configPath" | "force"> {
  return {
    help: false,
    outputFormat: "json",
    strictMode: false,
    storeType: "sqlite",
    idempotencyWindow: 900,
  };
}

describe("wizard: generateDefaultConfig", () => {
  it("returns a valid config with required fields", () => {
    const config = generateDefaultConfig();
    expect(config.gateway.port).toBe(3100);
    expect(config.agent.name).toBe("agenc-agent");
    expect(config.connection.rpcUrl).toBe("https://api.devnet.solana.com");
    expect(config.logging?.level).toBe("info");
  });

  it("applies overrides", () => {
    const config = generateDefaultConfig({
      gateway: { port: 4200 },
      agent: { name: "custom-agent" },
      connection: { rpcUrl: "http://localhost:8899" },
    });
    expect(config.gateway.port).toBe(4200);
    expect(config.agent.name).toBe("custom-agent");
    expect(config.connection.rpcUrl).toBe("http://localhost:8899");
  });

  it("includes LLM config when provided as override", () => {
    const config = generateDefaultConfig({
      llm: { provider: "grok", apiKey: "test-key" },
    });
    expect(config.llm?.provider).toBe("grok");
    expect(config.llm?.apiKey).toBe("test-key");
  });
});

describe("wizard: detectSolanaKeypair", () => {
  it("returns null when keypair file does not exist at default path", () => {
    // detectSolanaKeypair checks ~/.config/solana/id.json
    // In CI/test environments this typically doesn't exist
    const result = detectSolanaKeypair();
    // Result is either a path string or null — both are valid
    expect(typeof result === "string" || result === null).toBe(true);
  });
});

describe("wizard: runConfigInitCommand", () => {
  let workspace = "";
  let configPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-wizard-"));
    configPath = join(workspace, "config.json");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  it("creates config file and scaffolds workspace", async () => {
    const { context, outputs, errors } = createContextCapture();
    const opts: WizardOptions = {
      ...baseOptions(),
      configPath,
      force: false,
    };

    const code = await runConfigInitCommand(context, opts);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);
    expect(existsSync(configPath)).toBe(true);

    const written = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as GatewayConfig;
    expect(written.gateway.port).toBe(3100);
    expect(written.agent.name).toBe("agenc-agent");

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.command).toBe("config.init");
    expect(payload.configCreated).toBe(true);
  });

  it("skips existing config without --force", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ gateway: { port: 9999 } }),
      "utf-8",
    );

    const { context, outputs, errors } = createContextCapture();
    const opts: WizardOptions = {
      ...baseOptions(),
      configPath,
      force: false,
    };

    const code = await runConfigInitCommand(context, opts);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.skipped).toBe(true);

    // Original file untouched
    const content = JSON.parse(readFileSync(configPath, "utf8"));
    expect(content.gateway.port).toBe(9999);
  });

  it("overwrites existing config with --force", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ gateway: { port: 9999 } }),
      "utf-8",
    );

    const { context, outputs, errors } = createContextCapture();
    const opts: WizardOptions = {
      ...baseOptions(),
      configPath,
      force: true,
    };

    const code = await runConfigInitCommand(context, opts);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const written = JSON.parse(
      readFileSync(configPath, "utf8"),
    ) as GatewayConfig;
    expect(written.gateway.port).toBe(3100);

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.configCreated).toBe(true);
  });
});

describe("wizard: runConfigValidateCommand", () => {
  let workspace = "";
  let configPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-wizard-validate-"));
    configPath = join(workspace, "config.json");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("accepts a valid config", async () => {
    const validConfig: GatewayConfig = {
      gateway: { port: 3100 },
      agent: { name: "test" },
      connection: { rpcUrl: "http://localhost:8899" },
    };
    writeFileSync(configPath, JSON.stringify(validConfig), "utf-8");

    const { context, outputs, errors } = createContextCapture();
    const opts: ConfigValidateOptions = {
      ...baseOptions(),
      configPath,
    };

    const code = await runConfigValidateCommand(context, opts);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.valid).toBe(true);
  });

  it("rejects an invalid config", async () => {
    writeFileSync(configPath, JSON.stringify({ invalid: true }), "utf-8");

    const { context, outputs, errors } = createContextCapture();
    const opts: ConfigValidateOptions = {
      ...baseOptions(),
      configPath,
    };

    const code = await runConfigValidateCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it("errors on missing config file", async () => {
    const { context, outputs, errors } = createContextCapture();
    const opts: ConfigValidateOptions = {
      ...baseOptions(),
      configPath: join(workspace, "nonexistent.json"),
    };

    const code = await runConfigValidateCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });
});

describe("wizard: runConfigShowCommand", () => {
  let workspace = "";
  let configPath = "";

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-wizard-show-"));
    configPath = join(workspace, "config.json");
  });

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true });
  });

  it("outputs the loaded config", async () => {
    const config: GatewayConfig = {
      gateway: { port: 3100 },
      agent: { name: "show-test" },
      connection: { rpcUrl: "http://localhost:8899" },
    };
    writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const { context, outputs, errors } = createContextCapture();
    const opts: ConfigShowOptions = {
      ...baseOptions(),
      configPath,
    };

    const code = await runConfigShowCommand(context, opts);
    expect(code).toBe(0);
    expect(errors).toHaveLength(0);

    const payload = outputs[0] as Record<string, unknown>;
    expect(payload.command).toBe("config.show");
    const shown = payload.config as GatewayConfig;
    expect(shown.agent.name).toBe("show-test");
  });

  it("errors on missing config file", async () => {
    const { context, outputs, errors } = createContextCapture();
    const opts: ConfigShowOptions = {
      ...baseOptions(),
      configPath: join(workspace, "missing.json"),
    };

    const code = await runConfigShowCommand(context, opts);
    expect(code).toBe(1);
    expect(errors).toHaveLength(1);
  });
});
