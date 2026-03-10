import { describe, it, expect } from "vitest";
import type { LLMTool } from "../llm/types.js";
import { ToolRouter } from "./tool-routing.js";
import { filterLlmToolsByEnvironment } from "./tool-environment-policy.js";

function makeTool(name: string, description: string): LLMTool {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: {
        type: "object",
        properties: {
          input: { type: "string" },
        },
      },
    },
  };
}

const TOOLS: LLMTool[] = [
  makeTool("system.bash", "Run terminal commands"),
  makeTool("desktop.bash", "Run shell commands in desktop sandbox"),
  makeTool(
    "desktop.process_start",
    "Start a long-running background process with executable plus args and return a stable processId",
  ),
  makeTool(
    "desktop.process_status",
    "Check managed background process status and recent log output",
  ),
  makeTool(
    "desktop.process_stop",
    "Stop a managed background process by processId, label, or pid",
  ),
  makeTool(
    "system.processStart",
    "Start a durable host process handle and return processId, pid, pgid, and logPath",
  ),
  makeTool(
    "system.processStatus",
    "Inspect a durable host process handle and recent log output",
  ),
  makeTool(
    "system.processResume",
    "Reattach to a durable host process handle and return current state plus recent log output",
  ),
  makeTool(
    "system.processStop",
    "Stop a durable host process handle by processId or label",
  ),
  makeTool(
    "system.processLogs",
    "Read recent persisted logs for a durable host process handle",
  ),
  makeTool(
    "system.remoteJobStart",
    "Register a durable remote MCP job handle with callback or polling state",
  ),
  makeTool(
    "system.remoteJobStatus",
    "Inspect a durable remote MCP job handle",
  ),
  makeTool(
    "system.remoteJobResume",
    "Reattach to a durable remote MCP job handle",
  ),
  makeTool(
    "system.remoteJobCancel",
    "Cancel a durable remote MCP job handle",
  ),
  makeTool(
    "system.remoteJobArtifacts",
    "List durable artifacts for a remote MCP job handle",
  ),
  makeTool(
    "system.researchStart",
    "Create a durable research handle with source sets, verifier state, and artifact refs",
  ),
  makeTool(
    "system.researchStatus",
    "Inspect a durable research handle and verifier state",
  ),
  makeTool(
    "system.researchResume",
    "Resume a durable research handle",
  ),
  makeTool(
    "system.researchUpdate",
    "Update a durable research handle with progress and artifact refs",
  ),
  makeTool(
    "system.researchComplete",
    "Complete a durable research handle",
  ),
  makeTool(
    "system.researchBlock",
    "Mark a durable research handle blocked",
  ),
  makeTool(
    "system.researchArtifacts",
    "List durable research artifacts",
  ),
  makeTool(
    "system.researchStop",
    "Stop a durable research handle",
  ),
  makeTool(
    "system.sandboxStart",
    "Create a durable code-execution sandbox handle with stable workspace identity",
  ),
  makeTool(
    "system.sandboxStatus",
    "Inspect a durable sandbox handle",
  ),
  makeTool(
    "system.sandboxResume",
    "Reattach to a durable sandbox handle",
  ),
  makeTool(
    "system.sandboxStop",
    "Stop a durable sandbox handle",
  ),
  makeTool(
    "system.sandboxJobStart",
    "Start a durable sandbox job inside a sandbox handle",
  ),
  makeTool(
    "system.sandboxJobStatus",
    "Inspect a durable sandbox job handle",
  ),
  makeTool(
    "system.sandboxJobResume",
    "Resume a durable sandbox job handle",
  ),
  makeTool(
    "system.sandboxJobStop",
    "Stop a durable sandbox job handle",
  ),
  makeTool(
    "system.sandboxJobLogs",
    "Read logs for a durable sandbox job handle",
  ),
  makeTool(
    "system.serverStart",
    "Start a durable host server handle with readiness probing and health metadata",
  ),
  makeTool(
    "system.serverStatus",
    "Inspect a durable host server handle and recent log output",
  ),
  makeTool(
    "system.serverResume",
    "Reattach to a durable host server handle and fetch readiness state",
  ),
  makeTool(
    "system.serverStop",
    "Stop a durable host server handle",
  ),
  makeTool(
    "system.serverLogs",
    "Read persisted host server logs",
  ),
  makeTool("execute_with_agent", "Delegate a child objective to a subagent"),
  makeTool("system.readFile", "Read a file"),
  makeTool("system.writeFile", "Write a file"),
  makeTool("system.listDir", "List files in directory"),
  makeTool("system.pdfInfo", "Inspect PDF metadata such as pages, title, author, and encryption"),
  makeTool("system.pdfExtractText", "Extract text from a local PDF document"),
  makeTool("system.sqliteSchema", "Inspect SQLite tables, views, indexes, and columns"),
  makeTool("system.sqliteQuery", "Run a read-only SQL query against a local SQLite database"),
  makeTool(
    "system.spreadsheetInfo",
    "Inspect a local spreadsheet or CSV workbook and return sheet metadata and sample rows",
  ),
  makeTool(
    "system.spreadsheetRead",
    "Read structured rows from a local spreadsheet, workbook sheet, or CSV file",
  ),
  makeTool(
    "system.officeDocumentInfo",
    "Inspect a local DOCX or ODT office document and return metadata like title and creator",
  ),
  makeTool(
    "system.officeDocumentExtractText",
    "Extract text from a local DOCX or ODT office document",
  ),
  makeTool(
    "system.emailMessageInfo",
    "Inspect a local EML email message and return parsed headers, content types, and attachment summary",
  ),
  makeTool(
    "system.emailMessageExtractText",
    "Extract text from a local EML email message, preferring text/plain and falling back to stripped HTML",
  ),
  makeTool(
    "system.calendarInfo",
    "Inspect a local ICS calendar and return metadata such as calendar name, event count, and sample events",
  ),
  makeTool(
    "system.calendarRead",
    "Read structured VEVENT records from a local ICS calendar file with deterministic truncation",
  ),
  makeTool("system.httpGet", "HTTP GET request"),
  makeTool("desktop.click", "Click on screen"),
  makeTool("desktop.type", "Type into focused element"),
  makeTool("playwright.browser_navigate", "Navigate browser to a URL"),
  makeTool("playwright.browser_click", "Click browser element"),
  makeTool("playwright.browser_snapshot", "Read browser page content"),
  makeTool("playwright.browser_tabs", "List open browser tabs"),
  makeTool(
    "system.browserSessionStart",
    "Start a durable browser session handle and return a stable sessionId",
  ),
  makeTool(
    "system.browserSessionStatus",
    "Inspect a durable browser session handle and current page state",
  ),
  makeTool(
    "system.browserSessionResume",
    "Resume a durable browser session with actions like navigate, click, type, screenshot, and exportPdf",
  ),
  makeTool(
    "system.browserSessionArtifacts",
    "List durable browser session artifacts such as downloads and screenshots",
  ),
  makeTool(
    "system.browserSessionStop",
    "Stop a durable browser session handle",
  ),
  makeTool(
    "social.sendMessage",
    "Send a message to another agent via on-chain state or off-chain WebSocket",
  ),
  makeTool(
    "social.getRecentMessages",
    "Read recent inbound/outbound social messages observed by this daemon",
  ),
  makeTool("agenc.createTask", "Create on-chain task"),
  makeTool("agenc.getTask", "Read task details"),
  makeTool("mcp.doom.start_game", "Start a Doom scenario"),
  makeTool("mcp.doom.stop_game", "Stop the current Doom game"),
  makeTool("mcp.doom.get_state", "Read current Doom state"),
];

const MCP_TERMINAL_TOOLS: LLMTool[] = [
  ...TOOLS,
  makeTool("desktop.window_list", "List desktop windows"),
  makeTool("desktop.window_focus", "Focus a desktop window"),
  makeTool("desktop.keyboard_key", "Press desktop keyboard shortcut"),
  makeTool("mcp.kitty.launch", "Launch kitty terminal window"),
  makeTool("mcp.kitty.close", "Close kitty terminal window"),
  makeTool("mcp.kitty.send_text", "Send text to a kitty instance"),
  makeTool("mcp.tmux.execute-command", "Execute command in tmux session"),
  makeTool("mcp.tmux.list-sessions", "List tmux sessions"),
];

describe("ToolRouter", () => {
  it("returns full toolset when disabled", () => {
    const router = new ToolRouter(TOOLS, { enabled: false });
    const decision = router.route({
      sessionId: "s1",
      messageText: "run ls",
      history: [],
    });

    expect(decision.routedToolNames.length).toBe(TOOLS.length);
    expect(decision.expandedToolNames.length).toBe(TOOLS.length);
    expect(decision.diagnostics.invalidatedReason).toBe("disabled");
  });

  it("routes to a compact subset and keeps mandatory tools pinned", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 6,
      minToolsPerTurn: 4,
      maxExpandedToolsPerTurn: 10,
    });

    const decision = router.route({
      sessionId: "s2",
      messageText: "open the browser and click the page",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.bash");
    expect(decision.routedToolNames).toContain("desktop.bash");
    expect(decision.routedToolNames).toContain("execute_with_agent");
    expect(decision.routedToolNames.length).toBeLessThan(TOOLS.length);
    expect(decision.expandedToolNames.length).toBeGreaterThanOrEqual(
      decision.routedToolNames.length,
    );
    expect(decision.diagnostics.schemaCharsSaved).toBeGreaterThan(0);
  });

  it("prefers navigation-oriented browser tools over tab state checks", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-browser",
      messageText: "research the website in the browser and inspect the page",
      history: [],
    });

    expect(decision.routedToolNames).toContain("playwright.browser_navigate");
    expect(
      decision.expandedToolNames.some((name) =>
        name === "playwright.browser_snapshot" ||
        name === "system.browserSessionStatus" ||
        name === "system.browserSessionArtifacts"
      ),
    ).toBe(true);
    const tabIndex = decision.routedToolNames.indexOf("playwright.browser_tabs");
    if (tabIndex >= 0) {
      expect(
        decision.routedToolNames.indexOf("playwright.browser_navigate"),
      ).toBeLessThan(tabIndex);
    }
  });

  it("routes durable browser session tools when the prompt names handle-based browser work", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 10,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-browser-session",
      messageText:
        "Use system.browserSessionStart, browserSessionResume, and browserSessionArtifacts to capture a screenshot artifact from a browser session",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.browserSessionStart");
    expect(decision.routedToolNames).toContain("system.browserSessionResume");
    expect(decision.routedToolNames).toContain("system.browserSessionArtifacts");
  });

  it("prioritizes typed PDF tools for document extraction prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-pdf",
      messageText: "extract text from this pdf report and inspect its metadata",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.pdfInfo");
    expect(decision.routedToolNames).toContain("system.pdfExtractText");
  });

  it("prioritizes typed SQLite tools for database prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-sqlite",
      messageText: "inspect the sqlite schema and query the database tables",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.sqliteSchema");
    expect(decision.routedToolNames).toContain("system.sqliteQuery");
  });

  it("prioritizes typed spreadsheet tools for workbook prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-spreadsheet",
      messageText:
        "inspect this spreadsheet workbook, summarize the sheet headers, and read the csv rows",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.spreadsheetInfo");
    expect(decision.routedToolNames).toContain("system.spreadsheetRead");
  });

  it("prioritizes typed office document tools for docx prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-office-doc",
      messageText:
        "inspect this docx office brief, extract the text, and summarize the document metadata",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.officeDocumentInfo");
    expect(decision.routedToolNames).toContain("system.officeDocumentExtractText");
  });

  it("prioritizes typed email tools for eml prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-email",
      messageText:
        "inspect this eml email message, summarize the subject and sender, and extract the attachment-aware body text",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.emailMessageInfo");
    expect(decision.routedToolNames).toContain("system.emailMessageExtractText");
  });

  it("does not route email tools for explicit social inbox reads", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-social-inbox",
      messageText:
        "Use social.getRecentMessages with direction incoming and limit 3. Read the newest message from agent 1 and then use social.sendMessage to reply to recipient 6YvDdmWCcpU5wKWqutEvrKW7vzMfZhFqX8TLt64vxAQw.",
      history: [],
    });

    expect(decision.routedToolNames).toContain("social.getRecentMessages");
    expect(decision.routedToolNames).toContain("social.sendMessage");
    expect(decision.routedToolNames).not.toContain("system.emailMessageInfo");
    expect(decision.routedToolNames).not.toContain("system.emailMessageExtractText");
  });

  it("prioritizes typed calendar tools for ics prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-calendar",
      messageText:
        "inspect this ics calendar invite, list the attendees, and read the scheduled meeting events",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.calendarInfo");
    expect(decision.routedToolNames).toContain("system.calendarRead");
  });

  it.each([
    {
      label: "PDF",
      sessionId: "s-desktop-pdf",
      messageText: "extract text from this pdf report and inspect its metadata",
      blockedTools: ["system.pdfInfo", "system.pdfExtractText"],
    },
    {
      label: "SQLite",
      sessionId: "s-desktop-sqlite",
      messageText: "inspect the sqlite schema and query the database tables",
      blockedTools: ["system.sqliteSchema", "system.sqliteQuery"],
    },
  ])(
    "does not route host-side typed artifact readers in desktop mode for $label prompts",
    ({ sessionId, messageText, blockedTools }) => {
      const router = new ToolRouter(filterLlmToolsByEnvironment(TOOLS, "desktop"), {
        maxToolsPerTurn: 8,
        minToolsPerTurn: 4,
      });

      const decision = router.route({
        sessionId,
        messageText,
        history: [],
      });

      for (const toolName of blockedTools) {
        expect(decision.routedToolNames).not.toContain(toolName);
        expect(decision.expandedToolNames).not.toContain(toolName);
      }
    },
  );

  it("prefers typed server handles for server monitoring tasks", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 10,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-server",
      messageText:
        "start a local server, monitor its health, read the logs, and stop it when done",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.serverStart");
    expect(decision.expandedToolNames).toContain("system.serverStatus");
    expect(decision.expandedToolNames).toContain("system.serverLogs");
    expect(decision.expandedToolNames).toContain("system.serverStop");
  });

  it("routes durable remote job tools for callback or polling workflows", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 12,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-remote-job",
      messageText:
        "register a remote MCP job, wait for webhook callbacks, resume it later, and inspect returned artifacts",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.remoteJobStart");
    expect(decision.expandedToolNames).toEqual(
      expect.arrayContaining([
        "system.remoteJobStatus",
        "system.remoteJobResume",
        "system.remoteJobArtifacts",
      ]),
    );
  });

  it("routes durable research tools for resumable report workflows", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 12,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-research-handle",
      messageText:
        "start a research handle, track sources and notes, block it if evidence is missing, then complete the report with artifacts",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.researchStart");
    expect(decision.expandedToolNames).toEqual(
      expect.arrayContaining([
        "system.researchUpdate",
        "system.researchArtifacts",
        "system.researchComplete",
      ]),
    );
  });

  it("routes durable sandbox tools for isolated code-execution workflows", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 12,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-sandbox",
      messageText:
        "start an isolated sandbox environment, run a job inside the container workspace, inspect the logs, then stop the sandbox",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.sandboxStart");
    expect(decision.expandedToolNames).toEqual(
      expect.arrayContaining([
        "system.sandboxJobStart",
        "system.sandboxJobStatus",
        "system.sandboxJobLogs",
        "system.sandboxStop",
      ]),
    );
  });

  it("keeps browser tab tools when the intent explicitly mentions tabs", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-tabs",
      messageText: "list the browser tabs and switch windows",
      history: [],
    });

    expect(decision.routedToolNames).toContain("playwright.browser_tabs");
  });

  it("reuses cached routing decision for similar turns", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 6,
      minCacheConfidence: 0,
      pivotSimilarityThreshold: 0,
    });

    const first = router.route({
      sessionId: "s3",
      messageText: "read a file and write changes",
      history: [],
    });

    const second = router.route({
      sessionId: "s3",
      messageText: "also read files in this folder",
      history: [],
    });

    expect(second.diagnostics.cacheHit).toBe(true);
    expect(second.routedToolNames).toEqual(first.routedToolNames);
  });

  it("invalidates cached cluster on explicit pivot", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 6,
      minCacheConfidence: 0,
    });

    router.route({
      sessionId: "s4",
      messageText: "read a file and write changes",
      history: [],
    });

    const next = router.route({
      sessionId: "s4",
      messageText: "instead switch to browser navigation",
      history: [],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("explicit_redirect");
  });

  it("invalidates cached typed email routing when the next turn requests calendar tools", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
      minCacheConfidence: 0,
    });

    router.route({
      sessionId: "s-email-calendar-pivot",
      messageText:
        "inspect this eml email message, summarize the subject and sender, and extract the body text",
      history: [],
    });

    const next = router.route({
      sessionId: "s-email-calendar-pivot",
      messageText:
        "use the typed calendar tools to inspect this ics calendar invite, list the attendees, and read the scheduled meeting events",
      history: [
        {
          role: "user",
          content:
            "inspect this eml email message, summarize the subject and sender, and extract the body text",
          toolCalls: undefined,
        },
      ],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("missing_required_tools");
    expect(next.diagnostics.clusterKey).not.toContain("email");
    expect(next.routedToolNames).toContain("system.calendarInfo");
    expect(next.routedToolNames).toContain("system.calendarRead");
  });

  it("does not blend previous user terms into strong typed-domain prompts", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
      minCacheConfidence: 0,
    });

    const decision = router.route({
      sessionId: "s-strong-prompt",
      messageText:
        "use the typed calendar tools to inspect this ics calendar invite, list the attendees, and read the scheduled meeting events",
      history: [
        {
          role: "user",
          content:
            "use the typed email message tools to inspect this eml email message and extract the body text",
          toolCalls: undefined,
        },
      ],
    });

    expect(decision.diagnostics.clusterKey).toContain("calendar");
    expect(decision.diagnostics.clusterKey).not.toContain("email");
    expect(decision.routedToolNames).toContain("system.calendarInfo");
    expect(decision.routedToolNames).toContain("system.calendarRead");
  });

  it("invalidates cached route when explicit tmux intent needs mcp.tmux family", () => {
    const router = new ToolRouter(MCP_TERMINAL_TOOLS, {
      maxToolsPerTurn: 8,
      minCacheConfidence: 0,
    });

    const first = router.route({
      sessionId: "s-tmux",
      messageText: "open a kitty terminal and keep using it",
      history: [],
    });
    expect(first.routedToolNames.some((name) => name.startsWith("mcp.kitty."))).toBe(true);
    expect(first.routedToolNames.some((name) => name.startsWith("mcp.tmux."))).toBe(false);

    const second = router.route({
      sessionId: "s-tmux",
      messageText: "in that same terminal start tmux",
      history: [{ role: "user", content: "open a kitty terminal", toolCalls: undefined }],
    });

    expect(second.diagnostics.cacheHit).toBe(false);
    expect(second.diagnostics.invalidatedReason).toBe("missing_required_family");
    expect(second.routedToolNames.some((name) => name.startsWith("mcp.tmux."))).toBe(true);
  });

  it("prefers direct kitty open and close tools for terminal window actions", () => {
    const router = new ToolRouter(MCP_TERMINAL_TOOLS, {
      maxToolsPerTurn: 8,
      minCacheConfidence: 0,
    });

    const openDecision = router.route({
      sessionId: "s-kitty-open",
      messageText: "open a terminal",
      history: [],
    });
    const closeDecision = router.route({
      sessionId: "s-kitty-close",
      messageText: "close the terminal",
      history: [],
    });

    expect(openDecision.routedToolNames).toContain("mcp.kitty.launch");
    expect(closeDecision.routedToolNames).toContain("mcp.kitty.close");
    const windowListIndex = closeDecision.routedToolNames.indexOf("desktop.window_list");
    if (windowListIndex >= 0) {
      expect(
        closeDecision.routedToolNames.indexOf("mcp.kitty.close"),
      ).toBeLessThan(windowListIndex);
    }
  });

  it("invalidates cached open-terminal route when the user switches to closing the terminal", () => {
    const router = new ToolRouter(MCP_TERMINAL_TOOLS, {
      maxToolsPerTurn: 8,
      minCacheConfidence: 0,
    });

    router.route({
      sessionId: "s-kitty-pivot",
      messageText: "open a terminal",
      history: [],
    });

    const next = router.route({
      sessionId: "s-kitty-pivot",
      messageText: "close the terminal",
      history: [{ role: "user", content: "open a terminal", toolCalls: undefined }],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("terminal_action_shift");
    expect(next.routedToolNames).toContain("mcp.kitty.close");
  });

  it("invalidates cache after repeated routing misses", () => {
    const router = new ToolRouter(TOOLS, {
      minCacheConfidence: 0,
      pivotMissThreshold: 2,
    });

    router.route({
      sessionId: "s5",
      messageText: "read files",
      history: [],
    });

    router.recordOutcome("s5", {
      enabled: true,
      initialToolCount: 4,
      finalToolCount: 8,
      routeMisses: 1,
      expanded: true,
    });
    router.recordOutcome("s5", {
      enabled: true,
      initialToolCount: 4,
      finalToolCount: 8,
      routeMisses: 1,
      expanded: true,
    });

    const next = router.route({
      sessionId: "s5",
      messageText: "read files",
      history: [],
    });

    expect(next.diagnostics.cacheHit).toBe(false);
    expect(next.diagnostics.invalidatedReason).toBe("tool_miss_threshold");
  });

  it("prefers structured desktop process tools for background process workflows", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-process",
      messageText:
        "start a background server, check its status and logs, then stop it when I ask",
      history: [],
    });

    expect(decision.routedToolNames).toContain("desktop.process_start");
    expect(decision.routedToolNames).toContain("desktop.process_status");
    expect(decision.expandedToolNames).toContain("desktop.process_stop");
  });

  it("pins host process tools when the prompt explicitly names the durable handle family", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 12,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-host-process",
      messageText:
        "Use system.processStart, system.processStatus, system.processResume, system.processLogs, and system.processStop for a durable host process handle",
      history: [],
    });

    expect(decision.routedToolNames).toContain("system.processStart");
    expect(decision.routedToolNames).toContain("system.processStatus");
    expect(decision.routedToolNames).toContain("system.processResume");
    expect(decision.routedToolNames).toContain("system.processLogs");
    expect(decision.routedToolNames).toContain("system.processStop");
  });

  it("prefers the Doom MCP stop tool over generic process stop tools", () => {
    const router = new ToolRouter(TOOLS, {
      maxToolsPerTurn: 8,
      minToolsPerTurn: 4,
    });

    const decision = router.route({
      sessionId: "s-doom-stop",
      messageText: "stop Doom now",
      history: [],
    });

    expect(decision.routedToolNames).toContain("mcp.doom.stop_game");
    const doomStopIndex = decision.routedToolNames.indexOf("mcp.doom.stop_game");
    const processStopIndex = decision.routedToolNames.indexOf("desktop.process_stop");
    if (processStopIndex >= 0) {
      expect(doomStopIndex).toBeLessThan(processStopIndex);
    }
  });
});
