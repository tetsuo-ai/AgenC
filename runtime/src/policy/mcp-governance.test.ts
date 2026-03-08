import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
  buildMCPApprovalRules,
  computeMCPToolCatalogSha256,
  filterMCPToolCatalog,
  validateMCPServerBinaryIntegrity,
  validateMCPServerStaticPolicy,
  validateMCPToolCatalogIntegrity,
} from "./mcp-governance.js";

describe("mcp governance", () => {
  it("requires sandboxed and untrusted servers to run in the desktop container", () => {
    expect(
      validateMCPServerStaticPolicy({
        name: "dangerous",
        command: "npx",
        args: ["-y", "@pkg/server@1.2.3"],
        trustTier: "untrusted",
      }),
    ).toEqual([
      expect.objectContaining({
        code: "trust_requires_desktop_container",
      }),
    ]);
  });

  it("rejects unpinned npx package specs when supply-chain pinning is required", () => {
    expect(
      validateMCPServerStaticPolicy({
        name: "peekaboo",
        command: "npx",
        args: ["-y", "@steipete/peekaboo@latest"],
        supplyChain: {
          requirePinnedPackageVersion: true,
        },
      }),
    ).toEqual([
      expect.objectContaining({
        code: "pinned_package_required",
      }),
    ]);
  });

  it("requires digest-pinned desktop images when configured", () => {
    expect(
      validateMCPServerStaticPolicy(
        {
          name: "doom",
          command: "doom-mcp-server",
          args: [],
          container: "desktop",
          supplyChain: {
            requireDesktopImageDigest: true,
          },
        },
        { desktopImage: "agenc/desktop:latest" },
      ),
    ).toEqual([
      expect.objectContaining({
        code: "desktop_image_digest_required",
      }),
    ]);
  });

  it("filters tool catalogs before hashing and approval generation", () => {
    const server = {
      name: "server-a",
      command: "npx",
      args: ["-y", "@pkg/server@1.2.3"],
      riskControls: {
        toolAllowList: ["allowed*"],
        toolDenyList: ["allowedDangerous"],
        requireApproval: true,
      },
    } as const;
    const filtered = filterMCPToolCatalog(server, [
      { name: "allowedRead" },
      { name: "allowedDangerous" },
      { name: "blockedWrite" },
    ]);
    expect(filtered).toEqual([{ name: "allowedRead" }]);
    expect(buildMCPApprovalRules([server])).toEqual([
      expect.objectContaining({
        tool: "mcp.server-a.*",
      }),
    ]);
  });

  it("verifies binary and catalog digests when provided", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "agenc-mcp-integrity-"));
    const binaryPath = join(tmpDir, "server-bin");
    writeFileSync(binaryPath, "#!/bin/sh\necho ok\n", { mode: 0o755 });
    const binarySha = await (async () => {
      const { createHash } = await import("node:crypto");
      const { readFile } = await import("node:fs/promises");
      return createHash("sha256")
        .update(await readFile(binaryPath))
        .digest("hex");
    })();

    await expect(
      validateMCPServerBinaryIntegrity({
        server: {
          name: "integrity",
          command: binaryPath,
          args: [],
          supplyChain: { binarySha256: binarySha },
        },
      }),
    ).resolves.toEqual([]);

    const catalog = [{ name: "toolA", description: "desc" }];
    const catalogSha = computeMCPToolCatalogSha256(catalog);
    expect(
      validateMCPToolCatalogIntegrity(
        {
          name: "integrity",
          command: binaryPath,
          args: [],
          supplyChain: { catalogSha256: catalogSha },
        },
        catalog,
      ),
    ).toEqual([]);
  });
});
