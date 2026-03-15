export {
  evaluateAutonomyStage,
  isTypedHandleTool,
} from "./agenc-autonomy-stage-evaluators.mjs";

const DEFAULT_SESSION_STAGE_TIMEOUT_MS = 20_000;
const DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS = 45_000;
const DEFAULT_RESTART_STAGE_TIMEOUT_MS = 75_000;
const DEFAULT_TYPED_ARTIFACT_STAGE_TIMEOUT_MS = 35_000;

const BASELINE_STAGE_TEMPLATES = [
  {
    id: "0",
    title: "Transport Sanity",
    timeoutMs: DEFAULT_SESSION_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Reply with exactly `AUTONOMY_STAGE0::RUN_TOKEN` and nothing else. Do not call any tools.",
        evaluationId: "stage0",
      },
    ],
  },
  {
    id: "1",
    title: "Single Tool Grounding",
    timeoutMs: DEFAULT_SESSION_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use the shell tool appropriate for the current environment to run `/usr/bin/printf` so it prints `AUTONOMY_STAGE1::RUN_TOKEN\\n`. In the `agenc-watch` desktop session, that means `desktop.bash`; in a host-only session, `system.bash` is also acceptable.\n\nThen answer with:\n- the exact output\n- the tool name you used\n\nDo not invent results. If the tool fails, explain the real failure.",
        evaluationId: "stage1",
      },
    ],
  },
  {
    id: "2",
    title: "Multi-Tool File Workflow",
    timeoutMs: DEFAULT_SESSION_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use tools to create `/tmp/agenc-autonomy-RUN_TOKEN.txt` with the exact content `AUTONOMY_STAGE2::RUN_TOKEN`, then read the file back and answer with:\n- the absolute path\n- the exact contents you verified\n\nDo not skip the verification read.",
        evaluationId: "stage2",
      },
    ],
  },
  {
    id: "3",
    title: "Policy Simulation",
    timeoutMs: DEFAULT_SESSION_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "/policy simulate system.delete {\"target\":\"/tmp/agenc-autonomy-RUN_TOKEN.txt\"}",
        evaluationId: "stage3",
      },
    ],
  },
  {
    id: "4",
    title: "Durable Background Supervision",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Start a durable background run that uses typed long-lived handle tools, not raw shell backgrounding, to run `/bin/sleep 45` under the label `autonomy-watch-RUN_TOKEN`.\n\nRequirements:\n- use the structured process/runtime path\n- keep supervising it in the background\n- emit operator-visible progress updates\n- record verified evidence\n- when setup is complete, report the run/session id, the handle id, and the latest verified evidence",
        evaluationId: "stage4",
      },
    ],
  },
  {
    id: "5",
    title: "Operator Controls",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "pause",
        kind: "command",
        input: "/pause",
        evaluationId: "stage5_pause",
      },
      {
        id: "resume",
        kind: "command",
        input: "/resume",
        evaluationId: "stage5_resume",
      },
      {
        id: "inspect",
        kind: "command",
        input: "/inspect",
        evaluationId: "stage5_inspect",
      },
    ],
  },
  {
    id: "6",
    title: "TRACE Validation",
    timeoutMs: DEFAULT_SESSION_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "trace",
        kind: "command",
        input: "/trace",
        evaluationId: "stage6",
      },
    ],
  },
  {
    id: "7",
    title: "Restart Recovery",
    timeoutMs: DEFAULT_RESTART_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "restart",
        kind: "restart",
        evaluationId: "stage7",
      },
    ],
  },
  {
    id: "8",
    title: "Cleanup Stop",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "stop",
        kind: "command",
        input: "/stop",
        evaluationId: "stage8",
      },
    ],
  },
];

const SERVER_STAGE_TEMPLATES = [
  {
    id: "srv1",
    title: "Durable HTTP Service Supervision",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Start a durable background run that uses typed server handle tools, not raw shell backgrounding, to run `python3 -m http.server RUN_PORT` from `/home/tetsuo/git/AgenC` under the label `autonomy-server-RUN_TOKEN`.\n\nRequirements:\n- use the structured server/runtime path\n- verify readiness on `http://127.0.0.1:RUN_PORT/`\n- keep supervising it in the background\n- emit operator-visible progress updates\n- record verified evidence\n- when setup is complete, report the run/session id, the server handle id, the process handle id, and the latest verified evidence",
        evaluationId: "server_stage_start",
      },
    ],
  },
  {
    id: "srv2",
    title: "Operator Controls",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "pause",
        kind: "command",
        input: "/pause",
        evaluationId: "stage5_pause",
      },
      {
        id: "resume",
        kind: "command",
        input: "/resume",
        evaluationId: "stage5_resume",
      },
      {
        id: "inspect",
        kind: "command",
        input: "/inspect",
        evaluationId: "stage5_inspect",
      },
    ],
  },
  {
    id: "srv3",
    title: "TRACE Validation",
    timeoutMs: DEFAULT_SESSION_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "trace",
        kind: "command",
        input: "/trace",
        evaluationId: "stage6",
      },
    ],
  },
  {
    id: "srv4",
    title: "Restart Recovery",
    timeoutMs: DEFAULT_RESTART_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "restart",
        kind: "restart",
        evaluationId: "stage7",
      },
    ],
  },
  {
    id: "srv5",
    title: "Cleanup Stop",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "stop",
        kind: "command",
        input: "/stop",
        evaluationId: "stage8",
      },
    ],
  },
];

const SPREADSHEET_STAGE_TEMPLATES = [
  {
    id: "sheet1",
    title: "Typed Spreadsheet Inspection",
    timeoutMs: DEFAULT_TYPED_ARTIFACT_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use the typed spreadsheet tools to inspect `/tmp/agenc-tool-smoke/roster.xlsx`. Summarize the workbook, then read the `Roster` sheet and answer with:\n- the exact row count\n- the name/role pairs\n\nDo not use shell unless the typed spreadsheet tools fail.",
        evaluationId: "spreadsheet_stage_read",
      },
    ],
  },
];

const OFFICE_DOCUMENT_STAGE_TEMPLATES = [
  {
    id: "doc1",
    title: "Typed Office Document Inspection",
    timeoutMs: DEFAULT_TYPED_ARTIFACT_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use the typed office document tools to inspect `/tmp/agenc-tool-smoke/launch-brief.docx`. Answer with:\n- the exact document metadata\n- the exact extracted text\n\nDo not use shell unless the typed office document tools fail.",
        evaluationId: "office_document_stage_read",
      },
    ],
  },
];

const PRODUCTIVITY_STAGE_TEMPLATES = [
  {
    id: "mail1",
    title: "Typed Email Message Inspection",
    timeoutMs: DEFAULT_TYPED_ARTIFACT_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use the typed email message tools to inspect `/tmp/agenc-tool-smoke/inbox.eml`. Answer with:\n- the exact message metadata\n- the exact extracted text\n\nDo not use shell unless the typed email message tools fail.",
        evaluationId: "email_message_stage_read",
      },
    ],
  },
  {
    id: "cal1",
    title: "Typed Calendar Inspection",
    timeoutMs: DEFAULT_TYPED_ARTIFACT_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use the typed calendar tools to inspect `/tmp/agenc-tool-smoke/team-calendar.ics`. Answer with:\n- the calendar metadata\n- the exact event count\n- the event summaries and attendees\n\nDo not use shell unless the typed calendar tools fail.",
        evaluationId: "calendar_stage_read",
      },
    ],
  },
];

const DELEGATION_STAGE_TEMPLATES = [
  {
    id: "del1",
    title: "Delegated Child Tool Grounding",
    timeoutMs: DEFAULT_BACKGROUND_STAGE_TIMEOUT_MS,
    actions: [
      {
        id: "prompt",
        kind: "input",
        input:
          "Use the execute_with_agent tool exactly once for this exact task. " +
          "In the child agent, use system.bash to run /bin/pwd with working directory /home/tetsuo/git/AgenC. " +
          "After running it, without extra words return exactly /home/tetsuo/git/AgenC. " +
          "Return exactly the child answer.",
        evaluationId: "delegation_stage_child",
      },
    ],
  },
];

const SCENARIO_STAGE_TEMPLATES = {
  baseline: BASELINE_STAGE_TEMPLATES,
  server: SERVER_STAGE_TEMPLATES,
  spreadsheet: SPREADSHEET_STAGE_TEMPLATES,
  "office-document": OFFICE_DOCUMENT_STAGE_TEMPLATES,
  productivity: PRODUCTIVITY_STAGE_TEMPLATES,
  delegation: DELEGATION_STAGE_TEMPLATES,
};

export function replaceRunToken(value, runToken) {
  return value.replaceAll("RUN_TOKEN", runToken);
}

export function deriveRunPort(runToken, base = 9200, span = 600) {
  const normalized = String(runToken ?? "");
  let hash = 0;
  for (const char of normalized) {
    hash = (hash * 33 + char.charCodeAt(0)) % span;
  }
  return base + hash;
}

export function replaceRunVariables(value, runToken, runPort) {
  return replaceRunToken(value, runToken).replaceAll("RUN_PORT", String(runPort));
}

export function normalizeInteractiveInput(value) {
  return value.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
}

export function buildAutonomyStages(runToken, scenario = "baseline") {
  const templates = SCENARIO_STAGE_TEMPLATES[scenario];
  if (!templates) {
    throw new Error(`Unknown autonomy scenario: ${scenario}`);
  }
  const runPort = deriveRunPort(runToken);
  return templates.map((stage) => ({
    ...stage,
    actions: stage.actions.map((action) => ({
      ...action,
      ...(action.input
        ? {
            input: normalizeInteractiveInput(
              replaceRunVariables(action.input, runToken, runPort),
            ),
          }
        : {}),
    })),
  }));
}

export function parseStageSelection(selection, stages) {
  if (!selection || selection.trim().length === 0 || selection.trim() === "all") {
    return stages;
  }

  const byId = new Map(stages.map((stage) => [stage.id, stage]));
  const orderedIds = stages.map((stage) => stage.id);
  const selected = [];

  for (const rawPart of selection.split(",")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    if (part.includes("-")) {
      const [start, end] = part.split("-", 2).map((value) => value.trim());
      const startIndex = orderedIds.indexOf(start);
      const endIndex = orderedIds.indexOf(end);
      if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
        throw new Error(`Invalid stage range: ${part}`);
      }
      for (let index = startIndex; index <= endIndex; index += 1) {
        const stage = byId.get(orderedIds[index]);
        if (stage && !selected.some((item) => item.id === stage.id)) {
          selected.push(stage);
        }
      }
      continue;
    }

    const stage = byId.get(part);
    if (!stage) {
      throw new Error(`Unknown stage id: ${part}`);
    }
    if (!selected.some((item) => item.id === stage.id)) {
      selected.push(stage);
    }
  }

  return selected;
}

export function pickLatestSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return undefined;
  }
  return [...sessions].sort((left, right) => {
    const leftTime = Number(left?.lastActiveAt ?? 0);
    const rightTime = Number(right?.lastActiveAt ?? 0);
    return rightTime - leftTime;
  })[0];
}

export function pickTrackedSession(sessions, preferredSessionId) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return undefined;
  }
  if (typeof preferredSessionId === "string" && preferredSessionId.length > 0) {
    const preferred = sessions.find(
      (session) => session?.sessionId === preferredSessionId,
    );
    if (preferred) {
      return preferred;
    }
  }
  return pickLatestSession(sessions);
}

export function pickLatestTrace(traces, startedAt = 0) {
  if (!Array.isArray(traces) || traces.length === 0) {
    return undefined;
  }
  const sorted = [...traces].sort((left, right) => {
    const leftTime = Number(left?.updatedAt ?? left?.startedAt ?? 0);
    const rightTime = Number(right?.updatedAt ?? right?.startedAt ?? 0);
    return rightTime - leftTime;
  });
  const roots = sorted.filter((trace) => !String(trace?.traceId ?? "").includes(":sub:"));
  const pool = roots.length > 0 ? roots : sorted;
  if (startedAt > 0) {
    return pool.find((trace) => Number(trace?.updatedAt ?? trace?.startedAt ?? 0) >= startedAt);
  }
  return pool[0];
}
