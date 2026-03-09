import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createOfficeDocumentTools } from "./office-document.js";

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

function writeDocxFixture(dir: string): string {
  const path = join(dir, "brief.docx");
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys, zipfile",
        "from pathlib import Path",
        "path = Path(sys.argv[1])",
        "content_types = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "  <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "  <Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "  <Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>",
        "  <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>",
        "</Types>'''",
        "rels = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "  <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>",
        "  <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>",
        "</Relationships>'''",
        "document = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\">",
        "  <w:body>",
        "    <w:p><w:r><w:t>Hello DOCX Brief</w:t></w:r></w:p>",
        "    <w:p><w:r><w:t>Status update line two.</w:t></w:r></w:p>",
        "  </w:body>",
        "</w:document>'''",
        "core = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">",
        "  <dc:title>Launch Brief</dc:title>",
        "  <dc:creator>AgenC Test</dc:creator>",
        "</cp:coreProperties>'''",
        "with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:",
        "    zf.writestr('[Content_Types].xml', content_types)",
        "    zf.writestr('_rels/.rels', rels)",
        "    zf.writestr('word/document.xml', document)",
        "    zf.writestr('docProps/core.xml', core)",
      ].join("\n"),
      path,
    ],
    { stdio: "ignore" },
  );
  return path;
}

function writeOdtFixture(dir: string): string {
  const path = join(dir, "brief.odt");
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys, zipfile",
        "from pathlib import Path",
        "path = Path(sys.argv[1])",
        "mimetype = 'application/vnd.oasis.opendocument.text'",
        "content = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<office:document-content xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:text=\"urn:oasis:names:tc:opendocument:xmlns:text:1.0\">",
        "  <office:body><office:text>",
        "    <text:p>Hello ODT Brief</text:p>",
        "    <text:p>Status update line two.</text:p>",
        "  </office:text></office:body>",
        "</office:document-content>'''",
        "meta = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<office:document-meta xmlns:office=\"urn:oasis:names:tc:opendocument:xmlns:office:1.0\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">",
        "  <office:meta>",
        "    <dc:title>Launch Brief</dc:title>",
        "    <dc:creator>AgenC Test</dc:creator>",
        "  </office:meta>",
        "</office:document-meta>'''",
        "manifest = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<manifest:manifest xmlns:manifest=\"urn:oasis:names:tc:opendocument:xmlns:manifest:1.0\">",
        "  <manifest:file-entry manifest:full-path=\"/\" manifest:media-type=\"application/vnd.oasis.opendocument.text\"/>",
        "  <manifest:file-entry manifest:full-path=\"content.xml\" manifest:media-type=\"text/xml\"/>",
        "  <manifest:file-entry manifest:full-path=\"meta.xml\" manifest:media-type=\"text/xml\"/>",
        "</manifest:manifest>'''",
        "with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:",
        "    zf.writestr('mimetype', mimetype, compress_type=zipfile.ZIP_STORED)",
        "    zf.writestr('content.xml', content)",
        "    zf.writestr('meta.xml', meta)",
        "    zf.writestr('META-INF/manifest.xml', manifest)",
      ].join("\n"),
      path,
    ],
    { stdio: "ignore" },
  );
  return path;
}

function findTool(name: string) {
  const tool = createOfficeDocumentTools({
    allowedPaths: [tmpdir()],
  }).find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("system.officeDocument tools", () => {
  it("creates the typed office document tools", () => {
    const tools = createOfficeDocumentTools({
      allowedPaths: [tmpdir()],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.officeDocumentInfo",
      "system.officeDocumentExtractText",
    ]);
  });

  it("returns DOCX metadata", async () => {
    const dir = makeTempDir("agenc-office-docx-");
    const docxPath = writeDocxFixture(dir);

    const result = await findTool("system.officeDocumentInfo").execute({ path: docxPath });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.format).toBe("docx");
    expect(parsed.metadata).toMatchObject({
      title: "Launch Brief",
      creator: "AgenC Test",
    });
    expect(parsed.paragraphs).toBe(2);
  });

  it("extracts DOCX text", async () => {
    const dir = makeTempDir("agenc-office-docx-text-");
    const docxPath = writeDocxFixture(dir);

    const result = await findTool("system.officeDocumentExtractText").execute({
      path: docxPath,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(String(parsed.text)).toContain("Hello DOCX Brief");
    expect(parsed.truncated).toBe(false);
  });

  it("extracts ODT text", async () => {
    const dir = makeTempDir("agenc-office-odt-text-");
    const odtPath = writeOdtFixture(dir);

    const result = await findTool("system.officeDocumentExtractText").execute({
      path: odtPath,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.format).toBe("odt");
    expect(String(parsed.text)).toContain("Hello ODT Brief");
  });

  it("rejects unsupported formats", async () => {
    const dir = makeTempDir("agenc-office-unsupported-");
    const badPath = join(dir, "brief.txt");
    writeFileSync(badPath, "plain text", "utf8");

    const result = await findTool("system.officeDocumentInfo").execute({ path: badPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported office document format");
  });

  it("blocks office document paths outside the allowlist", async () => {
    const dir = makeTempDir("agenc-office-block-");
    const docxPath = writeDocxFixture(dir);
    const tools = createOfficeDocumentTools({
      allowedPaths: [join(tmpdir(), "different-root")],
    });

    const result = await tools[0].execute({ path: docxPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
  });
});
