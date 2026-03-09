import { mkdtempSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { createCalendarTools } from "./calendar.js";

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

function writeCalendarFixture(dir: string): string {
  const path = join(dir, "team-calendar.ics");
  writeFileSync(
    path,
    [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//AgenC//Autonomy Smoke//EN",
      "X-WR-CALNAME:Team Calendar",
      "BEGIN:VEVENT",
      "UID:event-1",
      "SUMMARY:Product Review",
      "DTSTART:20260310T170000Z",
      "DTEND:20260310T173000Z",
      "LOCATION:War Room",
      "ORGANIZER:mailto:alice@example.com",
      "ATTENDEE:mailto:bob@example.com",
      "ATTENDEE:mailto:carol@example.com",
      "STATUS:CONFIRMED",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:event-2",
      "SUMMARY:Planning Day",
      "DTSTART;VALUE=DATE:20260312",
      "DTEND;VALUE=DATE:20260313",
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\n"),
    "utf8",
  );
  return path;
}

function findTool(name: string) {
  const tool = createCalendarTools({
    allowedPaths: [tmpdir()],
  }).find((entry) => entry.name === name);
  expect(tool).toBeDefined();
  return tool!;
}

describe("system.calendar tools", () => {
  it("creates the typed calendar tools", () => {
    const tools = createCalendarTools({
      allowedPaths: [tmpdir()],
    });
    expect(tools.map((tool) => tool.name)).toEqual([
      "system.calendarInfo",
      "system.calendarRead",
    ]);
  });

  it("returns calendar metadata and sample events", async () => {
    const dir = makeTempDir("agenc-calendar-info-");
    const icsPath = writeCalendarFixture(dir);

    const result = await findTool("system.calendarInfo").execute({ path: icsPath });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.format).toBe("ics");
    expect(parsed.calendarName).toBe("Team Calendar");
    expect(parsed.eventCount).toBe(2);
    expect(parsed.sampleEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: "Product Review" }),
      ]),
    );
  });

  it("returns structured events with truncation", async () => {
    const dir = makeTempDir("agenc-calendar-read-");
    const icsPath = writeCalendarFixture(dir);

    const result = await findTool("system.calendarRead").execute({
      path: icsPath,
      maxEvents: 1,
    });
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    expect(parsed.eventCount).toBe(2);
    expect(parsed.truncated).toBe(true);
    expect(parsed.events).toEqual([
      expect.objectContaining({
        summary: "Product Review",
        organizer: "alice@example.com",
        attendees: ["bob@example.com", "carol@example.com"],
        location: "War Room",
      }),
    ]);
  });

  it("rejects unsupported formats", async () => {
    const dir = makeTempDir("agenc-calendar-unsupported-");
    const badPath = join(dir, "calendar.txt");
    writeFileSync(badPath, "not a calendar", "utf8");

    const result = await findTool("system.calendarInfo").execute({ path: badPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unsupported calendar format");
  });

  it("blocks calendar paths outside the allowlist", async () => {
    const dir = makeTempDir("agenc-calendar-block-");
    const icsPath = writeCalendarFixture(dir);
    const tools = createCalendarTools({
      allowedPaths: [join(tmpdir(), "different-root")],
    });

    const result = await tools[0].execute({ path: icsPath });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("outside allowed directories");
  });
});
