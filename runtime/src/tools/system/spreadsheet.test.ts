import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createSpreadsheetTools } from "./spreadsheet.js";

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

function writeCsvFixture(dir: string): string {
  const path = join(dir, "sample.csv");
  writeFileSync(
    path,
    ["name,role", "Ada,admin", "Linus,user", "Grace,analyst", ""].join("\n"),
    "utf8",
  );
  return path;
}

function writeXlsxFixture(dir: string): string {
  const path = join(dir, "roster.xlsx");
  execFileSync(
    "python3",
    [
      "-c",
      [
        "import sys, zipfile",
        "from pathlib import Path",
        "path = Path(sys.argv[1])",
        "shared_strings = [\"name\", \"role\", \"Ada\", \"admin\", \"Linus\", \"user\"]",
        "content_types = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">",
        "  <Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>",
        "  <Default Extension=\"xml\" ContentType=\"application/xml\"/>",
        "  <Override PartName=\"/xl/workbook.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml\"/>",
        "  <Override PartName=\"/xl/worksheets/sheet1.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml\"/>",
        "  <Override PartName=\"/xl/sharedStrings.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml\"/>",
        "  <Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>",
        "  <Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>",
        "</Types>'''",
        "rels = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "  <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"xl/workbook.xml\"/>",
        "  <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>",
        "  <Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>",
        "</Relationships>'''",
        "workbook = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<workbook xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\">",
        "  <sheets>",
        "    <sheet name=\"Roster\" sheetId=\"1\" r:id=\"rId1\"/>",
        "  </sheets>",
        "</workbook>'''",
        "workbook_rels = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
        "  <Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet\" Target=\"worksheets/sheet1.xml\"/>",
        "  <Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings\" Target=\"sharedStrings.xml\"/>",
        "</Relationships>'''",
        "shared = ['<?xml version=\"1.0\" encoding=\"UTF-8\"?>', '<sst xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\" count=\"6\" uniqueCount=\"6\">']",
        "for value in shared_strings:",
        "    shared.append(f'<si><t>{value}</t></si>')",
        "shared.append('</sst>')",
        "shared_strings_xml = ''.join(shared)",
        "sheet = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<worksheet xmlns=\"http://schemas.openxmlformats.org/spreadsheetml/2006/main\">",
        "  <sheetData>",
        "    <row r=\"1\"><c r=\"A1\" t=\"s\"><v>0</v></c><c r=\"B1\" t=\"s\"><v>1</v></c></row>",
        "    <row r=\"2\"><c r=\"A2\" t=\"s\"><v>2</v></c><c r=\"B2\" t=\"s\"><v>3</v></c></row>",
        "    <row r=\"3\"><c r=\"A3\" t=\"s\"><v>4</v></c><c r=\"B3\" t=\"s\"><v>5</v></c></row>",
        "  </sheetData>",
        "</worksheet>'''",
        "core = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">",
        "  <dc:title>Roster</dc:title>",
        "</cp:coreProperties>'''",
        "app = '''<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">",
        "  <Application>AgenC Test</Application>",
        "</Properties>'''",
        "with zipfile.ZipFile(path, 'w', compression=zipfile.ZIP_DEFLATED) as zf:",
        "    zf.writestr('[Content_Types].xml', content_types)",
        "    zf.writestr('_rels/.rels', rels)",
        "    zf.writestr('xl/workbook.xml', workbook)",
        "    zf.writestr('xl/_rels/workbook.xml.rels', workbook_rels)",
        "    zf.writestr('xl/sharedStrings.xml', shared_strings_xml)",
        "    zf.writestr('xl/worksheets/sheet1.xml', sheet)",
        "    zf.writestr('docProps/core.xml', core)",
        "    zf.writestr('docProps/app.xml', app)",
      ].join("\n"),
      path,
    ],
    { stdio: "ignore" },
  );
  return path;
}

function findTool(name: string) {
  const tool = createSpreadsheetTools({
    allowedPaths: [tmpdir()],
  }).find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("system.spreadsheet tools", () => {
  it("creates the typed spreadsheet tools", () => {
    const tools = createSpreadsheetTools({
      allowedPaths: [tmpdir()],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.spreadsheetInfo",
      "system.spreadsheetRead",
    ]);
  });

  it("returns spreadsheet info for CSV files", async () => {
    const dir = makeTempDir("agenc-system-spreadsheet-csv-");
    const csvPath = writeCsvFixture(dir);

    const result = await findTool("system.spreadsheetInfo").execute({ path: csvPath });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.format).toBe("csv");
    expect(parsed.sheetCount).toBe(1);
    expect(parsed.sheets).toEqual([
      expect.objectContaining({
        name: "Sheet1",
        rowCount: 3,
        columnCount: 2,
        columns: ["name", "role"],
      }),
    ]);
  });

  it("reads structured rows from CSV files", async () => {
    const dir = makeTempDir("agenc-system-spreadsheet-read-");
    const csvPath = writeCsvFixture(dir);

    const result = await findTool("system.spreadsheetRead").execute({
      path: csvPath,
      maxRows: 2,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.columns).toEqual(["name", "role"]);
    expect(parsed.rows).toEqual([
      { name: "Ada", role: "admin" },
      { name: "Linus", role: "user" },
    ]);
    expect(parsed.truncated).toBe(true);
  });

  it("supports XLSX workbook inspection and sheet reads", async () => {
    const dir = makeTempDir("agenc-system-spreadsheet-xlsx-");
    const xlsxPath = writeXlsxFixture(dir);

    const infoResult = await findTool("system.spreadsheetInfo").execute({ path: xlsxPath });
    expect(infoResult.isError).toBeFalsy();
    const info = JSON.parse(infoResult.content) as Record<string, unknown>;
    expect(info.format).toBe("xlsx");
    expect(info.sheets).toEqual([
      expect.objectContaining({
        name: "Roster",
        rowCount: 2,
        columns: ["name", "role"],
      }),
    ]);

    const readResult = await findTool("system.spreadsheetRead").execute({
      path: xlsxPath,
      sheet: "Roster",
    });
    expect(readResult.isError).toBeFalsy();
    const parsed = JSON.parse(readResult.content) as Record<string, unknown>;
    expect(parsed.sheet).toBe("Roster");
    expect(parsed.rows).toEqual([
      { name: "Ada", role: "admin" },
      { name: "Linus", role: "user" },
    ]);
  });

  it("rejects unknown sheet names", async () => {
    const dir = makeTempDir("agenc-system-spreadsheet-missing-sheet-");
    const xlsxPath = writeXlsxFixture(dir);

    const result = await findTool("system.spreadsheetRead").execute({
      path: xlsxPath,
      sheet: "Missing",
    });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown sheet");
  });

  it("blocks spreadsheet paths outside the allowlist", async () => {
    const dir = makeTempDir("agenc-system-spreadsheet-block-");
    const csvPath = writeCsvFixture(dir);
    const tools = createSpreadsheetTools({
      allowedPaths: [join(tmpdir(), "different-root")],
    });

    const result = await tools[0].execute({ path: csvPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
  });
});
