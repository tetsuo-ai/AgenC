import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createPdfTools } from "./pdf.js";

const cleanupPaths: string[] = [];

afterEach(async () => {
  while (cleanupPaths.length > 0) {
    const path = cleanupPaths.pop()!;
    await rm(path, { recursive: true, force: true });
  }
});

function makeTempPdf(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "agenc-system-pdf-test-"));
  cleanupPaths.push(dir);
  const path = join(dir, name);
  writeFileSync(path, contents, "utf8");
  return path;
}

function minimalPdf(): string {
  return [
    "%PDF-1.4",
    "1 0 obj",
    "<< /Type /Catalog /Pages 2 0 R >>",
    "endobj",
    "2 0 obj",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "endobj",
    "3 0 obj",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "endobj",
    "4 0 obj",
    "<< /Length 44 >>",
    "stream",
    "BT",
    "/F1 24 Tf",
    "72 72 Td",
    "(Hello PDF) Tj",
    "ET",
    "endstream",
    "endobj",
    "5 0 obj",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "endobj",
    "xref",
    "0 6",
    "0000000000 65535 f ",
    "0000000010 00000 n ",
    "0000000060 00000 n ",
    "0000000117 00000 n ",
    "0000000243 00000 n ",
    "0000000338 00000 n ",
    "trailer",
    "<< /Root 1 0 R /Size 6 >>",
    "startxref",
    "408",
    "%%EOF",
    "",
  ].join("\n");
}

function findTool(name: string) {
  const tool = createPdfTools({
    allowedPaths: [tmpdir()],
  }).find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("system.pdf tools", () => {
  it("creates the typed PDF tools", () => {
    const tools = createPdfTools({
      allowedPaths: [tmpdir()],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.pdfInfo",
      "system.pdfExtractText",
    ]);
  });

  it("returns PDF metadata", async () => {
    const pdfPath = makeTempPdf("sample.pdf", minimalPdf());

    const result = await findTool("system.pdfInfo").execute({ path: pdfPath });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.pages).toBe(1);
    expect(parsed.metadata).toMatchObject({
      Pages: 1,
    });
  });

  it("extracts PDF text", async () => {
    const pdfPath = makeTempPdf("sample.pdf", minimalPdf());

    const result = await findTool("system.pdfExtractText").execute({
      path: pdfPath,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(String(parsed.text)).toContain("Hello PDF");
    expect(parsed.truncated).toBe(false);
  });

  it("rejects invalid PDF files", async () => {
    const pdfPath = makeTempPdf("not-a-pdf.pdf", "plain text");

    const result = await findTool("system.pdfInfo").execute({ path: pdfPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("does not look like a PDF");
  });

  it("blocks PDF paths outside the allowlist", async () => {
    const pdfPath = makeTempPdf("sample.pdf", minimalPdf());
    const tools = createPdfTools({
      allowedPaths: [join(tmpdir(), "different-root")],
    });
    const result = await tools[0].execute({ path: pdfPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
  });
});
