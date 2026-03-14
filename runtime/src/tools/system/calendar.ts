/**
 * Typed calendar inspection/extraction tools for @agenc/runtime.
 *
 * Provides:
 * - system.calendarInfo — inspect local ICS calendar metadata
 * - system.calendarRead — extract structured events from local ICS calendars
 *
 * @module
 */

import { readFile } from "node:fs/promises";

import type { Tool, ToolResult } from "../types.js";
import { safeStringify } from "../types.js";
import { silentLogger } from "../../utils/logger.js";
import { resolveToolAllowedPaths, safePath } from "./filesystem.js";
import type { SystemCalendarToolConfig } from "./types.js";

const DEFAULT_MAX_EVENTS = 50;
const DEFAULT_MAX_EVENTS_CAP = 500;

type CalendarEventRecord = {
  readonly uid?: string;
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly status?: string;
  readonly organizer?: string;
  readonly attendees: readonly string[];
  readonly start?: string;
  readonly end?: string;
  readonly allDay?: boolean;
};

type MutableCalendarEvent = {
  uid?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  organizer?: string;
  attendees: string[];
  start?: string;
  end?: string;
  allDay?: boolean;
};

type ParsedCalendarLine = {
  readonly key: string;
  readonly value: string;
};

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

async function resolveCalendarPath(
  rawPath: unknown,
  allowedPaths: readonly string[],
  args: Record<string, unknown>,
): Promise<string | ToolResult> {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    return errorResult("Missing or invalid path");
  }
  const safe = await safePath(rawPath, resolveToolAllowedPaths(allowedPaths, args));
  if (!safe.safe) {
    return errorResult(
      safe.reason ?? "Calendar path is outside allowed directories",
    );
  }
  return safe.resolved;
}

function assertCalendarPath(path: string): void {
  if (!path.toLowerCase().endsWith(".ics")) {
    throw new Error("Unsupported calendar format: expected .ics");
  }
}

function unfoldIcsLines(raw: string): string[] {
  return raw.replace(/\r?\n[ \t]/g, "").split(/\r?\n/u);
}

function parseCalendarDate(raw: string): { value: string; allDay: boolean } {
  if (/^\d{8}$/u.test(raw)) {
    return {
      value: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
      allDay: true,
    };
  }
  if (/^\d{8}T\d{6}Z$/u.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}Z`;
    return { value: iso, allDay: false };
  }
  if (/^\d{8}T\d{6}$/u.test(raw)) {
    const iso = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(9, 11)}:${raw.slice(11, 13)}:${raw.slice(13, 15)}`;
    return { value: iso, allDay: false };
  }
  return { value: raw, allDay: false };
}

function unescapeIcsText(value: string): string {
  return value
    .replace(/\\n/giu, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function extractCalendarPrincipal(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.replace(/^mailto:/iu, "");
}

function parseCalendarContentLine(line: string): ParsedCalendarLine | undefined {
  if (!line) return undefined;
  const separator = line.indexOf(":");
  if (separator <= 0) return undefined;
  const rawKey = line.slice(0, separator);
  const rawValue = line.slice(separator + 1);
  const [keyPart] = rawKey.split(";", 1);
  return {
    key: keyPart.toUpperCase(),
    value: unescapeIcsText(rawValue.trim()),
  };
}

function createMutableCalendarEvent(): MutableCalendarEvent {
  return { attendees: [] };
}

function finalizeCalendarEvent(
  current: MutableCalendarEvent,
): CalendarEventRecord {
  return {
    uid: current.uid,
    summary: current.summary,
    description: current.description,
    location: current.location,
    status: current.status,
    organizer: current.organizer,
    attendees: current.attendees,
    start: current.start,
    end: current.end,
    allDay: current.allDay,
  };
}

function applyCalendarDate(
  current: MutableCalendarEvent,
  field: "start" | "end",
  rawValue: string,
): void {
  const parsed = parseCalendarDate(rawValue);
  current[field] = parsed.value;
  if (field === "start") {
    current.allDay = parsed.allDay;
    return;
  }
  if (current.allDay === undefined) {
    current.allDay = parsed.allDay;
  }
}

function applyCalendarEventField(
  current: MutableCalendarEvent,
  parsedLine: ParsedCalendarLine,
): void {
  switch (parsedLine.key) {
    case "UID":
      current.uid = parsedLine.value;
      break;
    case "SUMMARY":
      current.summary = parsedLine.value;
      break;
    case "DESCRIPTION":
      current.description = parsedLine.value;
      break;
    case "LOCATION":
      current.location = parsedLine.value;
      break;
    case "STATUS":
      current.status = parsedLine.value;
      break;
    case "ORGANIZER":
      current.organizer = extractCalendarPrincipal(parsedLine.value);
      break;
    case "ATTENDEE":
      current.attendees.push(extractCalendarPrincipal(parsedLine.value));
      break;
    case "DTSTART":
      applyCalendarDate(current, "start", parsedLine.value);
      break;
    case "DTEND":
      applyCalendarDate(current, "end", parsedLine.value);
      break;
    default:
      break;
  }
}

function parseCalendarFile(raw: string): {
  readonly calendarName?: string;
  readonly events: readonly CalendarEventRecord[];
} {
  const lines = unfoldIcsLines(raw);
  const events: CalendarEventRecord[] = [];
  let calendarName: string | undefined;
  let current: MutableCalendarEvent | null = null;

  for (const line of lines) {
    const parsedLine = parseCalendarContentLine(line);
    if (!parsedLine) continue;

    if (parsedLine.key === "X-WR-CALNAME" || parsedLine.key === "NAME") {
      calendarName ??= parsedLine.value;
      continue;
    }

    if (parsedLine.key === "BEGIN" && parsedLine.value.toUpperCase() === "VEVENT") {
      current = createMutableCalendarEvent();
      continue;
    }

    if (parsedLine.key === "END" && parsedLine.value.toUpperCase() === "VEVENT") {
      if (current) {
        events.push(finalizeCalendarEvent(current));
      }
      current = null;
      continue;
    }

    if (!current) {
      continue;
    }
    applyCalendarEventField(current, parsedLine);
  }

  return { calendarName, events };
}

function createCalendarInfoTool(
  allowedPaths: readonly string[],
  logger = silentLogger,
): Tool {
  return {
    name: "system.calendarInfo",
    description:
      "Inspect a local ICS calendar and return metadata such as calendar name, event count, and sample events.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local ICS calendar file.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveCalendarPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        assertCalendarPath(resolved);
        const raw = await readFile(resolved, "utf8");
        const parsed = parseCalendarFile(raw);
        return {
          content: safeStringify({
            path: resolved,
            format: "ics",
            calendarName: parsed.calendarName,
            eventCount: parsed.events.length,
            sampleEvents: parsed.events.slice(0, 3),
          }),
        };
      } catch (error) {
        logger.warn?.("system.calendarInfo failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error ? error.message : "Failed to inspect calendar",
        );
      }
    },
  };
}

function createCalendarReadTool(
  allowedPaths: readonly string[],
  defaultMaxEvents: number,
  maxEventsCap: number,
  logger = silentLogger,
): Tool {
  return {
    name: "system.calendarRead",
    description:
      "Read structured VEVENT records from a local ICS calendar file with deterministic truncation.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Path to a local ICS calendar file.",
        },
        maxEvents: {
          type: "number",
          description: "Maximum number of events to return.",
        },
      },
      required: ["path"],
    },
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const resolved = await resolveCalendarPath(args.path, allowedPaths, args);
      if (typeof resolved !== "string") {
        return resolved;
      }
      try {
        assertCalendarPath(resolved);
        const maxEvents = normalizePositiveInteger(
          args.maxEvents,
          defaultMaxEvents,
          maxEventsCap,
        );
        const raw = await readFile(resolved, "utf8");
        const parsed = parseCalendarFile(raw);
        const events = parsed.events.slice(0, maxEvents);
        return {
          content: safeStringify({
            path: resolved,
            format: "ics",
            calendarName: parsed.calendarName,
            eventCount: parsed.events.length,
            events,
            truncated: parsed.events.length > events.length,
          }),
        };
      } catch (error) {
        logger.warn?.("system.calendarRead failed", {
          path: resolved,
          error: error instanceof Error ? error.message : String(error),
        });
        return errorResult(
          error instanceof Error ? error.message : "Failed to read calendar",
        );
      }
    },
  };
}

export function createCalendarTools(config: SystemCalendarToolConfig): Tool[] {
  const allowedPaths = validateAllowedPaths(config.allowedPaths);
  const defaultMaxEvents = normalizePositiveInteger(
    config.defaultMaxEvents,
    DEFAULT_MAX_EVENTS,
    DEFAULT_MAX_EVENTS_CAP,
  );
  const maxEventsCap = normalizePositiveInteger(
    config.maxEventsCap,
    DEFAULT_MAX_EVENTS_CAP,
    5_000,
  );
  const logger = config.logger ?? silentLogger;

  return [
    createCalendarInfoTool(allowedPaths, logger),
    createCalendarReadTool(
      allowedPaths,
      defaultMaxEvents,
      maxEventsCap,
      logger,
    ),
  ];
}
