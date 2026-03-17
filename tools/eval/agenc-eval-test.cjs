#!/usr/bin/env node
/**
 * Eval test harness — sends the eval prompt to the daemon
 * and captures tool events + final response via WebSocket.
 */
const WebSocket = require("ws");

const WS_URL = "ws://127.0.0.1:3100";

const EVAL_PROMPT = `You are running an agent evaluation with these tools:

- system.bash(command, args[])
  Direct process execution. command is a single binary, args is an array of flags/operands. No shell features.
- system.bash(command)
  Shell execution. command is a full shell string. Pipes, redirects, backgrounding, chaining are supported. Omit args to use this mode.
- system.writeFile(path, content)
  Write a file with exact contents.
- system.readFile(path)
  Read a file.
- system.mkdir(path)
  Create a directory (recursive).
- system.httpGet(url)
  HTTP GET — blocks localhost/private addresses by design.
- playwright.browser_navigate(url)
  Optional. Only available inside a desktop container.

Rules:

1. Prefer system.bash with args (direct mode) whenever shell syntax is not required.
2. Use system.bash without args (shell mode) only when shell features are genuinely needed:
   redirection, heredoc, pipes, backgrounding, globbing, variable assignment, or multi-command shell control flow.
3. Do not tunnel shell through direct mode. Using sh -c or bash -lc via system.bash with args counts as shell use.
4. system.httpGet blocks localhost — use system.bash with curl instead for local service checks.
5. Ground every step status in actual tool output.
6. Never claim success after a failing tool call.
7. Final answer must be valid JSON only and match the schema exactly. No prose, no markdown fences.

Task

Step 1 — Create the directory:
/tmp/agent-eval/site assets

Step 2 — Create this file with exact contents:
/tmp/agent-eval/site assets/index.html

<!doctype html><title>Agent Eval</title><h1>agent-ok</h1>

Step 3 — Start a local HTTP server rooted at:
/tmp/agent-eval/site assets

Requirements:
- bind to 127.0.0.1
- choose a free port
- write this file exactly:
/tmp/agent-eval/state.json

with contents:
{"port":<port>,"pid":<pid>}

- wait until the server is actually reachable before continuing

Step 4 — Read /tmp/agent-eval/state.json and use its port and pid for all later steps.

Step 5 — Fetch:
http://127.0.0.1:<port>/

Verify that the response body contains:
agent-ok

Step 6 — Fetch:
http://127.0.0.1:<port>/missing.txt

This request is expected to fail.
Record status "expected_error" only if the tool output really shows failure.

Step 7 — Create this file with exact contents:
/tmp/agent-eval/site assets/missing.txt

now-exists

Step 8 — Fetch:
http://127.0.0.1:<port>/missing.txt

Verify that the response body is exactly:
now-exists

Step 9 — If browser navigation is available and local file access is allowed, navigate to:
file:///tmp/agent-eval/site%20assets/index.html

If browser navigation is unavailable or blocked, mark this step "skipped" and continue.

Step 10 — Stop the exact pid from /tmp/agent-eval/state.json, wait briefly, and verify that the same port from state.json is no longer serving the page.

Final output

Return JSON only in this exact shape:

{"overall":"pass|fail","steps":[{"step":1,"status":"pass|fail|skipped|expected_error","tool":"system.bash|system.writeFile|system.readFile|system.mkdir|playwright.browser_navigate","preview":"..."}],"server":{"port":12345,"pid":12345},"violations":[]}`;

let toolCalls = 0;
let toolErrors = 0;
let sessionId = null;
let promptSent = false;

const ws = new WebSocket(WS_URL);

ws.on("open", () => {
  console.log("[TEST] Connected to daemon");
  ws.send(JSON.stringify({ type: "chat.new" }));
});

ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString());

  if (msg.type === "chat.session") {
    sessionId = msg.payload?.sessionId;
    console.log("[TEST] Session:", sessionId);
    return;
  }

  if (msg.type === "chat.history" && sessionId && !promptSent) {
    promptSent = true;
    ws.send(JSON.stringify({ type: "chat.message", payload: { content: EVAL_PROMPT } }));
    console.log("[TEST] Eval prompt sent, waiting for response...");
    return;
  }

  if (msg.type === "tools.executing") {
    const p = msg.payload || {};
    toolCalls++;
    console.log(`[TOOL] Executing: ${p.toolName} ${JSON.stringify(p.args || {}).slice(0, 200)}`);
  }

  if (msg.type === "tools.result") {
    const p = msg.payload || {};
    const ok = p.isError ? "ERROR" : "OK";
    if (p.isError) toolErrors++;
    const preview = JSON.stringify(p.result || p.content || "").slice(0, 200);
    console.log(`[TOOL] Result (${ok}, ${p.durationMs}ms): ${p.toolName} → ${preview}`);
  }

  if (msg.type === "chat.message" && msg.payload?.sender === "agent") {
    const text = msg.payload?.content || msg.payload?.text || "";
    console.log(`\n========== AGENT RESPONSE ==========`);
    console.log(text.slice(0, 3000));
    console.log(`====================================\n`);

    console.log(`Tool calls: ${toolCalls}, Errors: ${toolErrors}`);

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const result = JSON.parse(jsonMatch[0]);
        console.log(`\nOverall: ${result.overall}`);
        if (result.steps) {
          result.steps.forEach((s) => {
            console.log(`  Step ${s.step}: ${s.status} (${s.tool}) ${s.preview}`);
          });
        }
        if (result.server) {
          console.log(`Server: port=${result.server.port}, pid=${result.server.pid}`);
        }
      }
    } catch (e) {
      console.log("(Could not parse JSON from response)");
    }

    console.log("[TEST] Done");
    ws.close();
    process.exit(0);
  }
});

ws.on("error", (err) => {
  console.error("[TEST] WS Error:", err.message);
  process.exit(1);
});

setTimeout(() => {
  console.error("[TEST] Timeout after 5 minutes");
  ws.close();
  process.exit(1);
}, 300000);
