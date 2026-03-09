import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createEmailMessageTools } from "./email-message.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop()!;
    await rm(path, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}

function writeEmlFixture(dir: string): string {
  const path = join(dir, "message.eml");
  writeFileSync(
    path,
    [
      "From: Alice <alice@example.com>",
      "To: Bob <bob@example.com>",
      "Subject: Sprint update",
      "Date: Mon, 09 Mar 2026 08:00:00 +0000",
      "Message-ID: <sprint-update@example.com>",
      "MIME-Version: 1.0",
      "Content-Type: multipart/mixed; boundary=\"BOUNDARY\"",
      "",
      "--BOUNDARY",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Hello team,",
      "",
      "Sprint review is at 10:00 AM.",
      "",
      "--BOUNDARY",
      "Content-Type: text/plain; name=\"agenda.txt\"",
      "Content-Disposition: attachment; filename=\"agenda.txt\"",
      "",
      "agenda attachment",
      "",
      "--BOUNDARY--",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function findTool(name: string) {
  const tool = createEmailMessageTools({
    allowedPaths: [tmpdir()],
  }).find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("system.emailMessage tools", () => {
  it("creates the typed email message tools", () => {
    const tools = createEmailMessageTools({
      allowedPaths: [tmpdir()],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.emailMessageInfo",
      "system.emailMessageExtractText",
    ]);
  });

  it("returns message metadata and attachment summary", async () => {
    const dir = makeTempDir("agenc-email-info-");
    const emlPath = writeEmlFixture(dir);

    const result = await findTool("system.emailMessageInfo").execute({ path: emlPath });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.format).toBe("eml");
    expect(parsed.subject).toBe("Sprint update");
    expect(parsed.from).toContain("alice@example.com");
    expect(parsed.to).toContain("bob@example.com");
    expect(parsed.attachmentCount).toBe(1);
    expect(parsed.attachmentNames).toEqual(["agenda.txt"]);
  });

  it("extracts plain text body from the message", async () => {
    const dir = makeTempDir("agenc-email-text-");
    const emlPath = writeEmlFixture(dir);

    const result = await findTool("system.emailMessageExtractText").execute({
      path: emlPath,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.text).toContain("Hello team,");
    expect(parsed.text).toContain("Sprint review is at 10:00 AM.");
    expect(parsed.truncated).toBe(false);
  });

  it("rejects unsupported formats", async () => {
    const dir = makeTempDir("agenc-email-unsupported-");
    const badPath = join(dir, "message.txt");
    writeFileSync(badPath, "plain text", "utf8");

    const result = await findTool("system.emailMessageInfo").execute({ path: badPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported email message format");
  });

  it("blocks email message paths outside the allowlist", async () => {
    const dir = makeTempDir("agenc-email-block-");
    const emlPath = writeEmlFixture(dir);
    const tools = createEmailMessageTools({
      allowedPaths: [join(tmpdir(), "different-root")],
    });

    const result = await tools[0].execute({ path: emlPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
  });
});
