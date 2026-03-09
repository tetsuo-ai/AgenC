/**
 * Typed spreadsheet inspection/extraction tools for @agenc/runtime.
 *
 * Provides:
 * - system.spreadsheetInfo — inspect workbook/sheet metadata and sample rows
 * - system.spreadsheetRead — extract structured rows from CSV/TSV/XLS/XLSX files
 *
 * @module
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { safePath } from "./filesystem.js";
import type { SystemSpreadsheetToolConfig } from "./types.js";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_ROWS_CAP = 1_000;
const DEFAULT_MAX_CELL_CHARS = 4_000;
const DEFAULT_INFO_SAMPLE_ROWS = 5;
const DEFAULT_INFO_SAMPLE_ROWS_CAP = 20;
const DEFAULT_MAX_BUFFER = 4 * 1024 * 1024;

const PYTHON_SPREADSHEET_HELPER = String.raw`
import csv
import json
import pathlib
import sys
import zipfile
import xml.etree.ElementTree as ET

try:
    import xlrd
except Exception:
    xlrd = None

MAIN_NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PKG_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"

def fail(message):
    raise RuntimeError(message)

def infer_format(path):
    suffix = pathlib.Path(path).suffix.lower()
    if suffix == ".csv":
        return "csv"
    if suffix in (".tsv", ".tab"):
        return "tsv"
    if suffix == ".xlsx":
        return "xlsx"
    if suffix == ".xls":
        return "xls"
    fail(f"Unsupported spreadsheet format: {suffix or 'unknown'}")

def normalize_header(values):
    headers = []
    seen = {}
    for index, value in enumerate(values):
        raw = "" if value is None else str(value).strip()
        name = raw if raw else f"column_{index + 1}"
        base = name
        suffix = 2
        while name in seen:
            name = f"{base}_{suffix}"
            suffix += 1
        seen[name] = True
        headers.append(name)
    return headers

def sanitize_cell(value, max_chars):
    if value is None:
        return ""
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    text = str(value)
    if len(text) > max_chars:
        return text[:max_chars] + "…"
    return text

def build_sheet_summary(name, rows, sample_rows, max_chars):
    if not rows:
        return {
            "name": name,
            "rowCount": 0,
            "columnCount": 0,
            "columns": [],
            "sampleRows": [],
        }
    headers = normalize_header(rows[0])
    data_rows = rows[1:]
    samples = []
    for row in data_rows[:sample_rows]:
        record = {}
        for index, header in enumerate(headers):
            record[header] = sanitize_cell(row[index] if index < len(row) else "", max_chars)
        samples.append(record)
    return {
        "name": name,
        "rowCount": len(data_rows),
        "columnCount": len(headers),
        "columns": headers,
        "sampleRows": samples,
    }

def build_read_result(name, rows, start_row, max_rows, max_chars, selected_columns):
    if not rows:
        return {
            "sheet": name,
            "columns": [],
            "rows": [],
            "rowCount": 0,
            "truncated": False,
        }
    headers = normalize_header(rows[0])
    selected = headers if not selected_columns else selected_columns
    missing = [column for column in selected if column not in headers]
    if missing:
        fail("Unknown columns requested: " + ", ".join(missing))
    indices = [headers.index(column) for column in selected]
    data_rows = rows[1:]
    begin = max(start_row - 1, 0)
    sliced = data_rows[begin:]
    truncated = len(sliced) > max_rows
    sliced = sliced[:max_rows]
    records = []
    for row in sliced:
        record = {}
        for column, index in zip(selected, indices):
            record[column] = sanitize_cell(row[index] if index < len(row) else "", max_chars)
        records.append(record)
    return {
        "sheet": name,
        "columns": selected,
        "rows": records,
        "rowCount": len(data_rows),
        "truncated": truncated,
    }

def read_delimited(path, delimiter):
    with open(path, "r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.reader(handle, delimiter=delimiter)
        return [list(row) for row in reader]

def parse_xlsx_shared_strings(zf):
    try:
        root = ET.fromstring(zf.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    strings = []
    for node in root.findall(f"{{{MAIN_NS}}}si"):
        parts = []
        for text_node in node.iterfind(f".//{{{MAIN_NS}}}t"):
            parts.append(text_node.text or "")
        strings.append("".join(parts))
    return strings

def parse_xlsx_workbook(zf):
    workbook = ET.fromstring(zf.read("xl/workbook.xml"))
    rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    rel_targets = {}
    for rel in rels_root.findall(f"{{{PKG_REL_NS}}}Relationship"):
        rel_targets[rel.attrib["Id"]] = rel.attrib["Target"]
    sheets = []
    for node in workbook.findall(f".//{{{MAIN_NS}}}sheet"):
        rel_id = node.attrib.get(f"{{{REL_NS}}}id")
        if not rel_id:
            continue
        target = rel_targets.get(rel_id)
        if not target:
            continue
        if not target.startswith("xl/"):
            target = "xl/" + target.lstrip("/")
        sheets.append({
            "name": node.attrib.get("name", "Sheet1"),
            "target": target,
        })
    return sheets

def cell_ref_to_index(ref):
    letters = []
    for char in ref:
        if char.isalpha():
            letters.append(char.upper())
        else:
            break
    index = 0
    for char in letters:
        index = index * 26 + (ord(char) - 64)
    return max(index - 1, 0)

def parse_numeric(text):
    if text is None or text == "":
        return ""
    try:
        if "." in text:
            return float(text)
        return int(text)
    except Exception:
        return text

def parse_xlsx_rows(zf, sheet_target, shared_strings):
    root = ET.fromstring(zf.read(sheet_target))
    rows = []
    for row_node in root.findall(f".//{{{MAIN_NS}}}sheetData/{{{MAIN_NS}}}row"):
        row_map = {}
        max_index = -1
        for cell in row_node.findall(f"{{{MAIN_NS}}}c"):
            ref = cell.attrib.get("r", "A1")
            index = cell_ref_to_index(ref)
            cell_type = cell.attrib.get("t")
            value_node = cell.find(f"{{{MAIN_NS}}}v")
            inline_node = cell.find(f"{{{MAIN_NS}}}is")
            value = ""
            if cell_type == "s" and value_node is not None and value_node.text is not None:
                string_index = int(value_node.text)
                value = shared_strings[string_index] if string_index < len(shared_strings) else ""
            elif cell_type == "inlineStr" and inline_node is not None:
                value = "".join(node.text or "" for node in inline_node.iterfind(f".//{{{MAIN_NS}}}t"))
            elif cell_type == "b" and value_node is not None:
                value = value_node.text == "1"
            elif value_node is not None:
                value = parse_numeric(value_node.text)
            row_map[index] = value
            max_index = max(max_index, index)
        if max_index < 0:
            rows.append([])
            continue
        row = [row_map.get(index, "") for index in range(max_index + 1)]
        rows.append(row)
    return rows

def read_xlsx(path):
    with zipfile.ZipFile(path) as zf:
        shared_strings = parse_xlsx_shared_strings(zf)
        sheets = parse_xlsx_workbook(zf)
        return [
            {
                "name": sheet["name"],
                "rows": parse_xlsx_rows(zf, sheet["target"], shared_strings),
            }
            for sheet in sheets
        ]

def read_xls(path):
    if xlrd is None:
        fail("xlrd is not installed; .xls files are unavailable")
    workbook = xlrd.open_workbook(path, on_demand=True)
    sheets = []
    for sheet in workbook.sheets():
        rows = []
        for row_index in range(sheet.nrows):
            row = []
            for column_index in range(sheet.ncols):
                value = sheet.cell_value(row_index, column_index)
                if isinstance(value, float) and value.is_integer():
                    value = int(value)
                row.append(value)
            rows.append(row)
        sheets.append({
            "name": sheet.name,
            "rows": rows,
        })
    return sheets

def read_workbook(path, fmt):
    if fmt == "csv":
        return [{"name": "Sheet1", "rows": read_delimited(path, ",")}]
    if fmt == "tsv":
        return [{"name": "Sheet1", "rows": read_delimited(path, "\t")}]
    if fmt == "xlsx":
        return read_xlsx(path)
    if fmt == "xls":
        return read_xls(path)
    fail(f"Unsupported spreadsheet format: {fmt}")

def select_sheet(sheets, requested):
    if requested is None:
        return sheets[0] if sheets else {"name": "Sheet1", "rows": []}
    for sheet in sheets:
        if sheet["name"] == requested:
            return sheet
    fail(f"Unknown sheet: {requested}")

def main():
    if len(sys.argv) < 4:
        fail("usage: spreadsheet-helper <info|read> <path> <options_json>")
    operation = sys.argv[1]
    path = sys.argv[2]
    options = json.loads(sys.argv[3])
    fmt = infer_format(path)
    sheets = read_workbook(path, fmt)
    max_chars = int(options.get("maxCellChars", 4000))
    if operation == "info":
        sample_rows = int(options.get("sampleRows", 5))
        result = {
            "path": path,
            "format": fmt,
            "sheetCount": len(sheets),
            "sheets": [
                build_sheet_summary(sheet["name"], sheet["rows"], sample_rows, max_chars)
                for sheet in sheets
            ],
        }
    elif operation == "read":
        sheet = select_sheet(sheets, options.get("sheet"))
        result = {
            "path": path,
            "format": fmt,
            **build_read_result(
                sheet["name"],
                sheet["rows"],
                int(options.get("startRow", 1)),
                int(options.get("maxRows", 200)),
                max_chars,
                options.get("columns"),
            ),
        }
    else:
        fail(f"unknown operation: {operation}")
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    main()
`;

function errorResult(message: string): ToolResult {
  return { content: safeStringify({ error: message }), isError: true };
}

function validateAllowedPaths(allowedPaths: readonly string[]): string[] {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) {
    throw new TypeError("allowedPaths must be a non-empty array of strings");
  }
  return allowedPaths.map((entry) => {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw new TypeError("Each allowedPaths entry must be a non-empty string");
    }
    return entry;
  });
}

function normalizePositiveInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError("Expected a positive finite integer");
  }
  return Math.min(Math.floor(value), maximum);
}

async function resolveSpreadsheetPath(
  rawPath: unknown,
  allowedPaths: readonly string[],
): Promise<string | ToolResult> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return errorResult("Missing or invalid path");
  }
  const safe = await safePath(rawPath, allowedPaths);
  if (!safe.safe) {
    return errorResult(
      safe.reason ?? "Spreadsheet path is outside allowed directories",
    );
  }
  return safe.resolved;
}

function normalizeSheetName(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("sheet must be a non-empty string when provided");
  }
  return value.trim();
}

function normalizeColumnSelection(value: unknown): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("columns must be a non-empty array of strings when provided");
  }
  return value.map((column) => {
    if (typeof column !== "string" || column.trim().length === 0) {
      throw new TypeError("columns must contain non-empty strings");
    }
    return column.trim();
  });
}

async function runSpreadsheetHelper<T>(
  operation: "info" | "read",
  path: string,
  options: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  const { stdout } = await execFileAsync(
    "python3",
    ["-c", PYTHON_SPREADSHEET_HELPER, operation, path, JSON.stringify(options)],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: DEFAULT_MAX_BUFFER,
    },
  );
  return JSON.parse(stdout) as T;
}

function createSpreadsheetInfoTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  infoSampleRows: number,
  maxCellChars: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.spreadsheetInfo",
    description:
      "Inspect a local spreadsheet or delimited table file and return sheet metadata, columns, and sample rows.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local CSV, TSV, XLS, or XLSX file.",
        },
        sampleRows: {
          type: "number",
          description: `Number of sample data rows to preview per sheet (default ${infoSampleRows}).`,
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveSpreadsheetPath(args.path, allowedPaths);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        const sampleRows = normalizePositiveInteger(
          args.sampleRows,
          infoSampleRows,
          DEFAULT_INFO_SAMPLE_ROWS_CAP,
        );
        const result = await runSpreadsheetHelper<Record<string, unknown>>(
          "info",
          resolved,
          {
            sampleRows,
            maxCellChars,
          },
          timeoutMs,
        );
        return { content: safeStringify(result) };
      } catch (error) {
        logger.warn?.("system.spreadsheetInfo failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to inspect spreadsheet",
        );
      }
    },
  };
}

function createSpreadsheetReadTool(
  allowedPaths: readonly string[],
  timeoutMs: number,
  defaultMaxRows: number,
  maxRowsCap: number,
  maxCellChars: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.spreadsheetRead",
    description:
      "Read structured rows from a local spreadsheet or delimited table file with optional sheet and column selection.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local CSV, TSV, XLS, or XLSX file.",
        },
        sheet: {
          type: "string",
          description: "Workbook sheet name. Omit to use the first sheet.",
        },
        startRow: {
          type: "number",
          description: "1-based data-row offset after the header row.",
          default: 1,
        },
        maxRows: {
          type: "number",
          description: `Maximum data rows to return (default ${defaultMaxRows}, capped at ${maxRowsCap}).`,
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Optional subset of normalized header names to return.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveSpreadsheetPath(args.path, allowedPaths);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        const sheet = normalizeSheetName(args.sheet);
        const startRow = normalizePositiveInteger(args.startRow, 1, Number.MAX_SAFE_INTEGER);
        const maxRows = normalizePositiveInteger(
          args.maxRows,
          defaultMaxRows,
          maxRowsCap,
        );
        const columns = normalizeColumnSelection(args.columns);
        const result = await runSpreadsheetHelper<Record<string, unknown>>(
          "read",
          resolved,
          {
            sheet,
            startRow,
            maxRows,
            columns,
            maxCellChars,
          },
          timeoutMs,
        );
        return { content: safeStringify(result) };
      } catch (error) {
        logger.warn?.("system.spreadsheetRead failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error
            ? error.message
            : "Failed to read spreadsheet",
        );
      }
    },
  };
}

export function createSpreadsheetTools(
  config: SystemSpreadsheetToolConfig,
): Tool[] {
  const allowedPaths = validateAllowedPaths(config.allowedPaths);
  const timeoutMs = normalizePositiveInteger(
    config.timeoutMs,
    DEFAULT_TIMEOUT_MS,
    Number.MAX_SAFE_INTEGER,
  );
  const defaultMaxRows = normalizePositiveInteger(
    config.defaultMaxRows,
    DEFAULT_MAX_ROWS,
    DEFAULT_MAX_ROWS_CAP,
  );
  const maxRowsCap = normalizePositiveInteger(
    config.maxRowsCap,
    DEFAULT_MAX_ROWS_CAP,
    Number.MAX_SAFE_INTEGER,
  );
  const maxCellChars = normalizePositiveInteger(
    config.maxCellChars,
    DEFAULT_MAX_CELL_CHARS,
    Number.MAX_SAFE_INTEGER,
  );
  const infoSampleRows = normalizePositiveInteger(
    config.infoSampleRows,
    DEFAULT_INFO_SAMPLE_ROWS,
    DEFAULT_INFO_SAMPLE_ROWS_CAP,
  );
  const logger = config.logger ?? silentLogger;

  return [
    createSpreadsheetInfoTool(
      allowedPaths,
      timeoutMs,
      infoSampleRows,
      maxCellChars,
      logger,
    ),
    createSpreadsheetReadTool(
      allowedPaths,
      timeoutMs,
      defaultMaxRows,
      maxRowsCap,
      maxCellChars,
      logger,
    ),
  ];
}
