import { describe, expect, it } from "vitest";
import {
  CURRENT_CONFIG_VERSION,
  ConfigMigrationError,
  buildConfigSchemaSnapshot,
  compareVersions,
  configVersionToString,
  migrateConfig,
  parseConfigVersion,
  validateConfigStrict,
} from "./config-migration.js";

describe("parseConfigVersion", () => {
  it("parses valid version string", () => {
    expect(parseConfigVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
    });
  });

  it("parses zero version", () => {
    expect(parseConfigVersion("0.0.0")).toEqual({
      major: 0,
      minor: 0,
      patch: 0,
    });
  });

  it("throws on invalid version string", () => {
    expect(() => parseConfigVersion("abc")).toThrow(ConfigMigrationError);
  });

  it("throws on incomplete version", () => {
    expect(() => parseConfigVersion("1.2")).toThrow(ConfigMigrationError);
  });

  it("throws on negative version component", () => {
    expect(() => parseConfigVersion("1.-1.0")).toThrow(ConfigMigrationError);
  });

  it("throws on non-integer version component", () => {
    expect(() => parseConfigVersion("1.2.3.4")).toThrow(ConfigMigrationError);
  });
});

describe("configVersionToString", () => {
  it("serializes version to string", () => {
    expect(configVersionToString({ major: 1, minor: 2, patch: 3 })).toBe(
      "1.2.3",
    );
  });
});

describe("compareVersions", () => {
  it("returns 0 for equal versions", () => {
    expect(
      compareVersions(
        { major: 1, minor: 0, patch: 0 },
        { major: 1, minor: 0, patch: 0 },
      ),
    ).toBe(0);
  });

  it("compares major versions", () => {
    expect(
      compareVersions(
        { major: 2, minor: 0, patch: 0 },
        { major: 1, minor: 0, patch: 0 },
      ),
    ).toBeGreaterThan(0);
    expect(
      compareVersions(
        { major: 1, minor: 0, patch: 0 },
        { major: 2, minor: 0, patch: 0 },
      ),
    ).toBeLessThan(0);
  });

  it("compares minor versions when major is equal", () => {
    expect(
      compareVersions(
        { major: 1, minor: 2, patch: 0 },
        { major: 1, minor: 1, patch: 0 },
      ),
    ).toBeGreaterThan(0);
  });

  it("compares patch versions when major and minor are equal", () => {
    expect(
      compareVersions(
        { major: 1, minor: 0, patch: 2 },
        { major: 1, minor: 0, patch: 1 },
      ),
    ).toBeGreaterThan(0);
  });
});

describe("migrateConfig", () => {
  it("migrates v0 to v1 and adds configVersion field", () => {
    const old = { rpcUrl: "http://localhost:8899" };
    const result = migrateConfig(
      old,
      { major: 0, minor: 0, patch: 0 },
      { major: 1, minor: 0, patch: 0 },
    );
    expect(result.configVersion).toBe("1.0.0");
    expect(result.rpcUrl).toBe("http://localhost:8899");
  });

  it("no-op when already at current version", () => {
    const config = { configVersion: "1.0.0", rpcUrl: "http://localhost" };
    const result = migrateConfig(
      config,
      CURRENT_CONFIG_VERSION,
      CURRENT_CONFIG_VERSION,
    );
    expect(result.configVersion).toBe("1.0.0");
    expect(result.rpcUrl).toBe("http://localhost");
  });

  it("throws when no migration path exists", () => {
    expect(() =>
      migrateConfig(
        {},
        { major: 99, minor: 0, patch: 0 },
        { major: 100, minor: 0, patch: 0 },
      ),
    ).toThrow(ConfigMigrationError);
    expect(() =>
      migrateConfig(
        {},
        { major: 99, minor: 0, patch: 0 },
        { major: 100, minor: 0, patch: 0 },
      ),
    ).toThrow(/No migration path/);
  });
});

describe("validateConfigStrict", () => {
  it("rejects unknown key in strict mode", () => {
    const config = { foo: "bar", rpcUrl: "http://localhost" };
    const result = validateConfigStrict(config, true);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.code).toBe("unknown_key");
    expect(result.errors[0]!.path).toBe("foo");
  });

  it("warns for unknown key in lenient mode", () => {
    const config = { foo: "bar", rpcUrl: "http://localhost" };
    const result = validateConfigStrict(config, false);
    expect(result.valid).toBe(true);
    expect(
      result.warnings.some((w) => w.code === "unknown_key" && w.path === "foo"),
    ).toBe(true);
  });

  it("warns for deprecated key", () => {
    const config = { verbose: "info" };
    const result = validateConfigStrict(config, false);
    expect(
      result.warnings.some(
        (w) => w.code === "deprecated_value" && w.path === "verbose",
      ),
    ).toBe(true);
    expect(result.warnings.some((w) => w.suggestion === "logLevel")).toBe(true);
  });

  it("migrates config from v0 to current", () => {
    const config = { rpcUrl: "http://localhost" };
    const result = validateConfigStrict(config, false);
    expect(result.migratedConfig.configVersion).toBe(
      configVersionToString(CURRENT_CONFIG_VERSION),
    );
    expect(result.fromVersion).toEqual({ major: 0, minor: 0, patch: 0 });
    expect(result.toVersion).toEqual(CURRENT_CONFIG_VERSION);
  });

  it("does not migrate config already at current version", () => {
    const config = { configVersion: "1.0.0", rpcUrl: "http://localhost" };
    const result = validateConfigStrict(config, false);
    expect(result.migratedConfig.configVersion).toBe("1.0.0");
    expect(result.fromVersion).toEqual(CURRENT_CONFIG_VERSION);
  });

  it("validates nested known keys", () => {
    const config = {
      replay: {
        enabled: true,
        store: { type: "sqlite", sqlitePath: "/tmp/db" },
      },
    };
    const result = validateConfigStrict(config, true);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects unknown nested keys in strict mode", () => {
    const config = {
      replay: {
        unknownField: true,
      },
    };
    const result = validateConfigStrict(config, true);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.path === "replay.unknownField")).toBe(
      true,
    );
  });
});

describe("buildConfigSchemaSnapshot", () => {
  it("produces deterministic hash for same version", () => {
    const snap1 = buildConfigSchemaSnapshot(CURRENT_CONFIG_VERSION, "default");
    const snap2 = buildConfigSchemaSnapshot(CURRENT_CONFIG_VERSION, "default");
    expect(snap1.sha256).toBe(snap2.sha256);
    expect(snap1.keys).toEqual(snap2.keys);
  });

  it("keys are sorted", () => {
    const snap = buildConfigSchemaSnapshot(CURRENT_CONFIG_VERSION, "default");
    const sorted = [...snap.keys].sort();
    expect(snap.keys).toEqual(sorted);
  });

  it("includes version and profile", () => {
    const snap = buildConfigSchemaSnapshot(
      { major: 2, minor: 0, patch: 0 },
      "production",
    );
    expect(snap.version).toEqual({ major: 2, minor: 0, patch: 0 });
    expect(snap.profile).toBe("production");
  });

  it("hash is a valid hex string", () => {
    const snap = buildConfigSchemaSnapshot(CURRENT_CONFIG_VERSION, "test");
    expect(snap.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("migration fixture round-trip", () => {
  it("v0 config migrates and validates without errors", () => {
    const v0Config = {
      rpcUrl: "http://localhost:8899",
      programId: "ABC123",
      storeType: "sqlite",
      sqlitePath: "/tmp/replay.db",
      strictMode: true,
      idempotencyWindow: 600,
    };

    const migrated = migrateConfig(
      v0Config,
      { major: 0, minor: 0, patch: 0 },
      CURRENT_CONFIG_VERSION,
    );
    expect(migrated.configVersion).toBe("1.0.0");

    const validation = validateConfigStrict(migrated, true);
    expect(validation.valid).toBe(true);
    expect(validation.errors).toHaveLength(0);
  });
});
