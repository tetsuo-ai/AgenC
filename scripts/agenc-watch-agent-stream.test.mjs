import test from "node:test";
import assert from "node:assert/strict";

import {
  findLatestPendingAgentEvent,
  isPendingAgentStreamState,
  nextAgentStreamState,
} from "./lib/agenc-watch-agent-stream.mjs";

test("pending agent stream states include post-stream finalization wait", () => {
  assert.equal(isPendingAgentStreamState("streaming"), true);
  assert.equal(isPendingAgentStreamState("pending-final"), true);
  assert.equal(isPendingAgentStreamState("complete"), false);
  assert.equal(nextAgentStreamState({ done: false }), "streaming");
  assert.equal(nextAgentStreamState({ done: true }), "pending-final");
});

test("findLatestPendingAgentEvent reuses a pending-final live agent card for final commit", () => {
  const event = findLatestPendingAgentEvent([
    { kind: "agent", streamState: "complete", id: "old" },
    { kind: "tool result", id: "tool" },
    { kind: "agent", streamState: "pending-final", id: "live" },
  ]);

  assert.equal(event?.id, "live");
});
