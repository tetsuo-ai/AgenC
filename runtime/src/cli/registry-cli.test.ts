import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createContextCapture } from "./test-utils.js";
import type {
  SkillRegistryClient,
  SkillListing,
  SkillListingEntry,
} from "../skills/registry/types.js";
import {
  SkillRegistryNotFoundError,
  SkillDownloadError,
  SkillVerificationError,
  SkillPublishError,
} from "../skills/registry/errors.js";
import {
  runRegistrySearchCommand,
  runRegistryInstallCommand,
  runRegistryPublishCommand,
  runRegistryRateCommand,
  runRegistryVerifyCommand,
  runImportOpenclawCommand,
} from "./registry-cli.js";

function makeListing(overrides: Partial<SkillListing> = {}): SkillListing {
  return {
    id: "test-skill",
    name: "Test Skill",
    description: "A test skill",
    version: "1.0.0",
    author: "11111111111111111111111111111111",
    downloads: 42,
    rating: 4.5,
    ratingCount: 10,
    tags: ["defi"],
    contentHash: "abc123",
    priceLamports: 0n,
    registeredAt: new Date("2025-01-01"),
    updatedAt: new Date("2025-06-01"),
    ...overrides,
  };
}

function makeEntry(
  overrides: Partial<SkillListingEntry> = {},
): SkillListingEntry {
  return {
    id: "test-skill",
    name: "Test Skill",
    author: "11111111111111111111111111111111",
    rating: 4.5,
    tags: ["defi"],
    priceLamports: 0n,
    ...overrides,
  };
}

function createMockClient(
  overrides: Partial<SkillRegistryClient> = {},
): SkillRegistryClient {
  return {
    search: vi.fn().mockResolvedValue([makeEntry()]),
    get: vi.fn().mockResolvedValue(makeListing()),
    install: vi.fn().mockResolvedValue(makeListing()),
    publish: vi.fn().mockResolvedValue("abc123hash"),
    rate: vi.fn().mockResolvedValue(undefined),
    listByAuthor: vi.fn().mockResolvedValue([makeEntry()]),
    verify: vi.fn().mockResolvedValue(true),
    ...overrides,
  };
}

const VALID_SKILL_MD = `---
name: test-skill
description: A test skill
version: 1.0.0
metadata:
  agenc:
    tags:
      - testing
    requires:
      binaries: []
      env: []
      channels: []
      os: []
    install: []
---

# Test Skill

This is a test skill body.
`;

const OPENCLAW_SKILL_MD = `---
name: openclaw-test
description: An OpenClaw skill
version: 0.1.0
metadata:
  openclaw:
    tags:
      - compat
    requires:
      binaries: []
      env: []
      channels: []
      os: []
    install: []
---

# OpenClaw Skill

Body.
`;

describe("registry-cli", () => {
  let workspace: string;
  let userSkillsDir: string;

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "agenc-registry-cli-"));
    userSkillsDir = join(workspace, "skills");
    mkdirSync(userSkillsDir, { recursive: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(workspace, { recursive: true, force: true });
  });

  // =========================================================================
  // search
  // =========================================================================

  describe("search", () => {
    it("returns results with correct schema", async () => {
      const client = createMockClient();
      const { context, outputs } = createContextCapture();

      const code = await runRegistrySearchCommand(
        context,
        { query: "defi", rpcUrl: "http://localhost:8899" },
        { client },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.status).toBe("ok");
      expect(payload.command).toBe("skill.search");
      expect(payload.schema).toBe("skill.search.output.v1");
      expect(payload.query).toBe("defi");
      expect(payload.count).toBe(1);
      expect(payload.results).toHaveLength(1);
    });

    it("returns empty results", async () => {
      const client = createMockClient({
        search: vi.fn().mockResolvedValue([]),
      });
      const { context, outputs } = createContextCapture();

      const code = await runRegistrySearchCommand(
        context,
        { query: "nonexistent", rpcUrl: "http://localhost:8899" },
        { client },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.count).toBe(0);
      expect(payload.results).toEqual([]);
    });

    it("passes tags and limit to client", async () => {
      const searchFn = vi.fn().mockResolvedValue([]);
      const client = createMockClient({ search: searchFn });
      const { context } = createContextCapture();

      await runRegistrySearchCommand(
        context,
        {
          query: "swap",
          tags: ["defi", "dex"],
          limit: 5,
          rpcUrl: "http://localhost:8899",
        },
        { client },
      );

      expect(searchFn).toHaveBeenCalledWith("swap", {
        tags: ["defi", "dex"],
        limit: 5,
      });
    });

    it("errors on network failure", async () => {
      const client = createMockClient({
        search: vi.fn().mockRejectedValue(new Error("Connection refused")),
      });
      const { context, errors } = createContextCapture();

      const code = await runRegistrySearchCommand(
        context,
        { query: "defi", rpcUrl: "http://localhost:8899" },
        { client },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("REGISTRY_ERROR");
    });

    it("errors when no RPC configured", async () => {
      const { context, errors } = createContextCapture();

      const code = await runRegistrySearchCommand(context, { query: "defi" });

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("RPC_NOT_CONFIGURED");
    });
  });

  // =========================================================================
  // registry-install
  // =========================================================================

  describe("registry-install", () => {
    it("installs a skill successfully", async () => {
      const client = createMockClient();
      const { context, outputs } = createContextCapture();

      const code = await runRegistryInstallCommand(
        context,
        { skillId: "test-skill", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.status).toBe("ok");
      expect(payload.command).toBe("skill.registry-install");
      expect(payload.skillId).toBe("test-skill");
    });

    it("errors on SkillRegistryNotFoundError", async () => {
      const client = createMockClient({
        install: vi
          .fn()
          .mockRejectedValue(new SkillRegistryNotFoundError("missing-skill")),
      });
      const { context, errors } = createContextCapture();

      const code = await runRegistryInstallCommand(
        context,
        { skillId: "missing-skill", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("SKILL_NOT_FOUND");
    });

    it("errors on SkillDownloadError", async () => {
      const client = createMockClient({
        install: vi
          .fn()
          .mockRejectedValue(new SkillDownloadError("test-skill", "timeout")),
      });
      const { context, errors } = createContextCapture();

      const code = await runRegistryInstallCommand(
        context,
        { skillId: "test-skill", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("DOWNLOAD_FAILED");
    });

    it("errors on SkillVerificationError", async () => {
      const client = createMockClient({
        install: vi
          .fn()
          .mockRejectedValue(
            new SkillVerificationError("test-skill", "abc", "def"),
          ),
      });
      const { context, errors } = createContextCapture();

      const code = await runRegistryInstallCommand(
        context,
        { skillId: "test-skill", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("VERIFICATION_FAILED");
    });

    it("errors when no RPC configured", async () => {
      const { context, errors } = createContextCapture();

      const code = await runRegistryInstallCommand(
        context,
        { skillId: "test-skill" },
        { userSkillsDir },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("RPC_NOT_CONFIGURED");
    });
  });

  // =========================================================================
  // publish
  // =========================================================================

  describe("publish", () => {
    it("publishes successfully with hash output", async () => {
      const skillPath = join(workspace, "skill.md");
      writeFileSync(skillPath, VALID_SKILL_MD, "utf-8");

      const client = createMockClient();
      const { context, outputs } = createContextCapture();

      const code = await runRegistryPublishCommand(
        context,
        { skillPath, rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.status).toBe("ok");
      expect(payload.command).toBe("skill.publish");
      expect(payload.contentHash).toBe("abc123hash");
      expect(payload.name).toBe("test-skill");
    });

    it("errors when no wallet", async () => {
      const skillPath = join(workspace, "skill.md");
      writeFileSync(skillPath, VALID_SKILL_MD, "utf-8");

      const client = createMockClient();
      const { context, errors } = createContextCapture();

      const code = await runRegistryPublishCommand(
        context,
        { skillPath, rpcUrl: "http://localhost:8899" },
        { client, wallet: undefined },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("WALLET_NOT_FOUND");
    });

    it("errors when file not found", async () => {
      const client = createMockClient();
      const { context, errors } = createContextCapture();

      const code = await runRegistryPublishCommand(
        context,
        { skillPath: "/nonexistent/path.md", rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("SOURCE_NOT_FOUND");
    });

    it("errors on SkillPublishError", async () => {
      const skillPath = join(workspace, "skill.md");
      writeFileSync(skillPath, VALID_SKILL_MD, "utf-8");

      const client = createMockClient({
        publish: vi
          .fn()
          .mockRejectedValue(
            new SkillPublishError(skillPath, "invalid format"),
          ),
      });
      const { context, errors } = createContextCapture();

      const code = await runRegistryPublishCommand(
        context,
        { skillPath, rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("PUBLISH_FAILED");
    });

    it("converts --price string to bigint", async () => {
      const skillPath = join(workspace, "skill.md");
      writeFileSync(skillPath, VALID_SKILL_MD, "utf-8");

      const publishFn = vi.fn().mockResolvedValue("hash123");
      const client = createMockClient({ publish: publishFn });
      const { context } = createContextCapture();

      await runRegistryPublishCommand(
        context,
        {
          skillPath,
          priceLamports: "1000000",
          rpcUrl: "http://localhost:8899",
        },
        { client, wallet: {} },
      );

      const metadata = publishFn.mock.calls[0][1];
      expect(metadata.priceLamports).toBe(1000000n);
    });
  });

  // =========================================================================
  // rate
  // =========================================================================

  describe("rate", () => {
    it("rates successfully", async () => {
      const client = createMockClient();
      const { context, outputs } = createContextCapture();

      const code = await runRegistryRateCommand(
        context,
        { skillId: "test-skill", rating: 5, rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.status).toBe("ok");
      expect(payload.command).toBe("skill.rate");
      expect(payload.skillId).toBe("test-skill");
      expect(payload.rating).toBe(5);
    });

    it("rejects rating 0", async () => {
      const client = createMockClient();
      const { context, errors } = createContextCapture();

      const code = await runRegistryRateCommand(
        context,
        { skillId: "test-skill", rating: 0, rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("INVALID_VALUE");
    });

    it("rejects rating 6", async () => {
      const client = createMockClient();
      const { context, errors } = createContextCapture();

      const code = await runRegistryRateCommand(
        context,
        { skillId: "test-skill", rating: 6, rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("INVALID_VALUE");
    });

    it("rejects non-integer rating", async () => {
      const client = createMockClient();
      const { context, errors } = createContextCapture();

      const code = await runRegistryRateCommand(
        context,
        { skillId: "test-skill", rating: 3.5, rpcUrl: "http://localhost:8899" },
        { client, wallet: {} },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("INVALID_VALUE");
    });

    it("errors when no wallet", async () => {
      const client = createMockClient();
      const { context, errors } = createContextCapture();

      const code = await runRegistryRateCommand(
        context,
        { skillId: "test-skill", rating: 4, rpcUrl: "http://localhost:8899" },
        { client, wallet: undefined },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("WALLET_NOT_FOUND");
    });

    it("passes review text", async () => {
      const rateFn = vi.fn().mockResolvedValue(undefined);
      const client = createMockClient({ rate: rateFn });
      const { context, outputs } = createContextCapture();

      await runRegistryRateCommand(
        context,
        {
          skillId: "test-skill",
          rating: 5,
          review: "Excellent!",
          rpcUrl: "http://localhost:8899",
        },
        { client, wallet: {} },
      );

      expect(rateFn).toHaveBeenCalledWith("test-skill", 5, "Excellent!");
      const payload = outputs[0] as any;
      expect(payload.review).toBe("Excellent!");
    });
  });

  // =========================================================================
  // verify
  // =========================================================================

  describe("verify", () => {
    it("verified true when hashes match", async () => {
      const content = VALID_SKILL_MD;
      const hash = createHash("sha256")
        .update(Buffer.from(content, "utf-8"))
        .digest("hex");

      const filePath = join(userSkillsDir, "test-skill.md");
      writeFileSync(filePath, content, "utf-8");

      const client = createMockClient({
        get: vi.fn().mockResolvedValue(makeListing({ contentHash: hash })),
      });
      const { context, outputs } = createContextCapture();

      const code = await runRegistryVerifyCommand(
        context,
        { skillId: "test-skill", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.verified).toBe(true);
      expect(payload.localHash).toBe(hash);
      expect(payload.onChainHash).toBe(hash);
    });

    it("reports on-chain hash when no local file exists", async () => {
      const client = createMockClient({
        get: vi
          .fn()
          .mockResolvedValue(makeListing({ contentHash: "onchain123" })),
      });
      const { context, outputs } = createContextCapture();

      const code = await runRegistryVerifyCommand(
        context,
        { skillId: "nonexistent-skill", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.verified).toBeNull();
      expect(payload.onChainHash).toBe("onchain123");
      expect(payload.localFile).toBeNull();
    });

    it("errors when skill not found", async () => {
      const client = createMockClient({
        get: vi
          .fn()
          .mockRejectedValue(new SkillRegistryNotFoundError("missing")),
      });
      const { context, errors } = createContextCapture();

      const code = await runRegistryVerifyCommand(
        context,
        { skillId: "missing", rpcUrl: "http://localhost:8899" },
        { client, userSkillsDir },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("SKILL_NOT_FOUND");
    });

    it("uses explicit --path flag", async () => {
      const content = "custom content";
      const hash = createHash("sha256")
        .update(Buffer.from(content, "utf-8"))
        .digest("hex");

      const customPath = join(workspace, "custom.md");
      writeFileSync(customPath, content, "utf-8");

      const client = createMockClient({
        get: vi.fn().mockResolvedValue(makeListing({ contentHash: hash })),
      });
      const { context, outputs } = createContextCapture();

      const code = await runRegistryVerifyCommand(
        context,
        {
          skillId: "test-skill",
          localPath: customPath,
          rpcUrl: "http://localhost:8899",
        },
        { client, userSkillsDir },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.verified).toBe(true);
      expect(payload.localFile).toBe(customPath);
    });
  });

  // =========================================================================
  // import-openclaw
  // =========================================================================

  describe("import-openclaw", () => {
    it("converts openclaw skill", async () => {
      const sourcePath = join(workspace, "openclaw.md");
      writeFileSync(sourcePath, OPENCLAW_SKILL_MD, "utf-8");

      const { context, outputs } = createContextCapture();

      const code = await runImportOpenclawCommand(
        context,
        { source: sourcePath },
        { userSkillsDir },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.status).toBe("ok");
      expect(payload.command).toBe("skill.import-openclaw");
      expect(payload.converted).toBe(true);
      expect(payload.filePath).toContain("openclaw-test.md");

      // Verify the file was written and converted
      const written = readFileSync(payload.filePath, "utf-8");
      expect(written).toContain("agenc:");
      expect(written).not.toContain("openclaw:");
    });

    it("passes through agenc skill unchanged", async () => {
      const sourcePath = join(workspace, "agenc.md");
      writeFileSync(sourcePath, VALID_SKILL_MD, "utf-8");

      const { context, outputs } = createContextCapture();

      const code = await runImportOpenclawCommand(
        context,
        { source: sourcePath },
        { userSkillsDir },
      );

      expect(code).toBe(0);
      const payload = outputs[0] as any;
      expect(payload.converted).toBe(false);
    });

    it("errors for nonexistent source", async () => {
      const { context, errors } = createContextCapture();

      const code = await runImportOpenclawCommand(
        context,
        { source: "/nonexistent/file.md" },
        { userSkillsDir },
      );

      expect(code).toBe(1);
      expect((errors[0] as any).code).toBe("IMPORT_FAILED");
    });
  });
});
