import { describe, expect, it } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isSkillMarkdown,
  parseSkillContent,
  parseSkillFile,
  validateSkillMetadata,
} from "./parser.js";

const FULL_SKILL_MD = `---
name: zk-prover
description: Generate and verify ZK proofs
version: 1.0.0
metadata:
  agenc:
    emoji: "\u{1F50F}"
    primaryEnv: ZK_PROVER_HOME
    requires:
      binaries:
        - risc0-prover
        - bb
      env:
        - ZK_PROVER_HOME
      channels:
        - solana
      os:
        - linux
        - macos
    install:
      - type: brew
        package: risc0/tap/risc0-prover
      - type: download
        url: https://example.com/bb
        path: /usr/local/bin/bb
    tags:
      - zk
      - privacy
      - risc0
    requiredCapabilities: "0x03"
    onChainAuthor: 5FHwkrdxPp8A5yjft7QsiqU3Y95JyB1vKNpkaLBjj7Gk
    contentHash: QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco
---
# ZK Prover

This skill provides ZK proof generation.

## Usage

Call \`risc0-prover prove\` with the guest ELF path.
`;

const MINIMAL_SKILL_MD = `---
name: echo
description: Simple echo skill
version: 0.1.0
---
Echo back the input.
`;

const OPENCLAW_SKILL_MD = `---
name: openclaw-tool
description: An OpenClaw-compatible skill
version: 2.0.0
metadata:
  openclaw:
    emoji: "\u{1F4E6}"
    tags:
      - compat
    requires:
      binaries:
        - node
---
Body text.
`;

const AGENC_PRECEDENCE_MD = `---
name: dual-ns
description: Both namespaces present
version: 1.0.0
metadata:
  agenc:
    emoji: "\u{1F680}"
    tags:
      - agenc-tag
  openclaw:
    emoji: "\u{1F4E6}"
    tags:
      - openclaw-tag
---
Body.
`;

describe("isSkillMarkdown", () => {
  it("returns true for content with frontmatter", () => {
    expect(isSkillMarkdown(FULL_SKILL_MD)).toBe(true);
    expect(isSkillMarkdown(MINIMAL_SKILL_MD)).toBe(true);
  });

  it("returns false for plain markdown", () => {
    expect(isSkillMarkdown("# Just a heading\n\nSome text.")).toBe(false);
    expect(isSkillMarkdown("")).toBe(false);
    expect(isSkillMarkdown("--- not on its own line")).toBe(false);
  });
});

describe("parseSkillContent", () => {
  it("parses valid SKILL.md with all fields", () => {
    const skill = parseSkillContent(
      FULL_SKILL_MD,
      "/skills/zk-prover/SKILL.md",
    );

    expect(skill.name).toBe("zk-prover");
    expect(skill.description).toBe("Generate and verify ZK proofs");
    expect(skill.version).toBe("1.0.0");
    expect(skill.sourcePath).toBe("/skills/zk-prover/SKILL.md");

    expect(skill.metadata.emoji).toBe("\u{1F50F}");
    expect(skill.metadata.primaryEnv).toBe("ZK_PROVER_HOME");
    expect(skill.metadata.requiredCapabilities).toBe("0x03");
    expect(skill.metadata.onChainAuthor).toBe(
      "5FHwkrdxPp8A5yjft7QsiqU3Y95JyB1vKNpkaLBjj7Gk",
    );
    expect(skill.metadata.contentHash).toBe(
      "QmXoypizjW3WknFiJnKLwHCnL72vedxjQkDDP1mXWo6uco",
    );

    // Requirements
    expect(skill.metadata.requires.binaries).toEqual(["risc0-prover", "bb"]);
    expect(skill.metadata.requires.env).toEqual(["ZK_PROVER_HOME"]);
    expect(skill.metadata.requires.channels).toEqual(["solana"]);
    expect(skill.metadata.requires.os).toEqual(["linux", "macos"]);

    // Install
    expect(skill.metadata.install).toHaveLength(2);
    expect(skill.metadata.install[0]).toEqual({
      type: "brew",
      package: "risc0/tap/risc0-prover",
    });
    expect(skill.metadata.install[1]).toEqual({
      type: "download",
      url: "https://example.com/bb",
      path: "/usr/local/bin/bb",
    });

    // Tags
    expect(skill.metadata.tags).toEqual(["zk", "privacy", "risc0"]);
  });

  it("parses minimal frontmatter (name, description, version only)", () => {
    const skill = parseSkillContent(MINIMAL_SKILL_MD);

    expect(skill.name).toBe("echo");
    expect(skill.description).toBe("Simple echo skill");
    expect(skill.version).toBe("0.1.0");
    expect(skill.metadata.requires.binaries).toEqual([]);
    expect(skill.metadata.requires.env).toEqual([]);
    expect(skill.metadata.requires.channels).toEqual([]);
    expect(skill.metadata.requires.os).toEqual([]);
    expect(skill.metadata.install).toEqual([]);
    expect(skill.metadata.tags).toEqual([]);
    expect(skill.sourcePath).toBeUndefined();
  });

  it("parses metadata.openclaw namespace and normalizes", () => {
    const skill = parseSkillContent(OPENCLAW_SKILL_MD);

    expect(skill.name).toBe("openclaw-tool");
    expect(skill.metadata.emoji).toBe("\u{1F4E6}");
    expect(skill.metadata.tags).toEqual(["compat"]);
    expect(skill.metadata.requires.binaries).toEqual(["node"]);
  });

  it("parses metadata.agenc namespace (takes precedence over openclaw)", () => {
    const skill = parseSkillContent(AGENC_PRECEDENCE_MD);

    // agenc should win
    expect(skill.metadata.emoji).toBe("\u{1F680}");
    expect(skill.metadata.tags).toEqual(["agenc-tag"]);
  });

  it("body preserves markdown formatting", () => {
    const skill = parseSkillContent(FULL_SKILL_MD);

    expect(skill.body).toContain("# ZK Prover");
    expect(skill.body).toContain("## Usage");
    expect(skill.body).toContain("`risc0-prover prove`");
  });

  it("parses install instructions", () => {
    const md = `---
name: installer-test
description: Test install parsing
version: 1.0.0
metadata:
  agenc:
    install:
      - type: npm
        package: "@agenc/sdk"
      - type: cargo
        package: risc0-prover
      - type: apt
        package: build-essential
---
`;
    const skill = parseSkillContent(md);

    expect(skill.metadata.install).toHaveLength(3);
    expect(skill.metadata.install[0]).toEqual({
      type: "npm",
      package: "@agenc/sdk",
    });
    expect(skill.metadata.install[1]).toEqual({
      type: "cargo",
      package: "risc0-prover",
    });
    expect(skill.metadata.install[2]).toEqual({
      type: "apt",
      package: "build-essential",
    });
  });

  it("parses requirements (binaries, env, os)", () => {
    const md = `---
name: req-test
description: Requirements parsing
version: 0.1.0
metadata:
  agenc:
    requires:
      binaries:
        - python3
        - pip
      env:
        - OPENAI_API_KEY
        - HOME
      os:
        - linux
---
`;
    const skill = parseSkillContent(md);

    expect(skill.metadata.requires.binaries).toEqual(["python3", "pip"]);
    expect(skill.metadata.requires.env).toEqual(["OPENAI_API_KEY", "HOME"]);
    expect(skill.metadata.requires.os).toEqual(["linux"]);
    expect(skill.metadata.requires.channels).toEqual([]);
  });

  it("parses AgenC extensions (requiredCapabilities, onChainAuthor)", () => {
    const md = `---
name: ext-test
description: Extensions test
version: 1.0.0
metadata:
  agenc:
    requiredCapabilities: "0xFF"
    onChainAuthor: 11111111111111111111111111111111
    contentHash: QmTest123
---
`;
    const skill = parseSkillContent(md);

    expect(skill.metadata.requiredCapabilities).toBe("0xFF");
    expect(skill.metadata.onChainAuthor).toBe(
      "11111111111111111111111111111111",
    );
    expect(skill.metadata.contentHash).toBe("QmTest123");
  });

  it("empty body returns empty string", () => {
    const md = `---
name: nobody
description: No body
version: 1.0.0
---`;
    const skill = parseSkillContent(md);

    expect(skill.body).toBe("");
  });

  it("unknown fields do not error (lenient)", () => {
    const md = `---
name: lenient
description: Lenient parsing test
version: 1.0.0
custom_field: ignored
another:
  nested: value
metadata:
  agenc:
    unknown_ext: whatever
---
Body.
`;
    const skill = parseSkillContent(md);

    expect(skill.name).toBe("lenient");
    expect(skill.body).toBe("Body.\n");
  });

  it("URL-like array items are not misidentified as objects", () => {
    const md = `---
name: url-test
description: URL array test
version: 1.0.0
metadata:
  agenc:
    tags:
      - https://example.com:443/path
      - simple-tag
---
`;
    const skill = parseSkillContent(md);

    expect(skill.metadata.tags).toEqual([
      "https://example.com:443/path",
      "simple-tag",
    ]);
  });
});

describe("parseSkillFile", () => {
  it("reads and parses from filesystem", async () => {
    const dir = await mkdtemp(join(tmpdir(), "skill-test-"));
    const filePath = join(dir, "SKILL.md");

    try {
      await writeFile(filePath, MINIMAL_SKILL_MD, "utf-8");
      const skill = await parseSkillFile(filePath);

      expect(skill.name).toBe("echo");
      expect(skill.description).toBe("Simple echo skill");
      expect(skill.version).toBe("0.1.0");
      expect(skill.sourcePath).toBe(filePath);
      expect(skill.body).toBe("Echo back the input.\n");
    } finally {
      await rm(dir, { recursive: true });
    }
  });
});

describe("validateSkillMetadata", () => {
  it("missing name produces error", () => {
    const skill = parseSkillContent(`---
description: desc
version: 1.0.0
---
`);
    const errors = validateSkillMetadata(skill);
    expect(errors.some((e) => e.field === "name")).toBe(true);
  });

  it("missing description produces error", () => {
    const skill = parseSkillContent(`---
name: test
version: 1.0.0
---
`);
    const errors = validateSkillMetadata(skill);
    expect(errors.some((e) => e.field === "description")).toBe(true);
  });

  it("missing version produces error", () => {
    const skill = parseSkillContent(`---
name: test
description: desc
---
`);
    const errors = validateSkillMetadata(skill);
    expect(errors.some((e) => e.field === "version")).toBe(true);
  });

  it("valid skill produces no errors", () => {
    const skill = parseSkillContent(MINIMAL_SKILL_MD);
    const errors = validateSkillMetadata(skill);
    expect(errors).toEqual([]);
  });
});
