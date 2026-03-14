import test from "node:test";
import assert from "node:assert/strict";

import { createWatchLiveReplayHarness } from "./fixtures/agenc-watch-live-replay-harness.mjs";
import { WATCH_LIVE_REPLAY_FIXTURES } from "./fixtures/agenc-watch-live-replay.fixture.mjs";
import { WATCH_LIVE_REPLAY_RAW_SCENARIOS } from "./fixtures/agenc-watch-live-replay-raw.fixture.mjs";

async function playRawReplayScenario(name, expectedBundle) {
  const scenario = WATCH_LIVE_REPLAY_RAW_SCENARIOS[name];
  assert.ok(scenario, `expected raw replay scenario ${name}`);

  const harness = await createWatchLiveReplayHarness({
    width: scenario.width,
    height: scenario.height,
    startMs: scenario.startMs,
  });

  await harness.start();

  try {
    for (const step of scenario.steps) {
      switch (step.kind) {
        case "open":
          harness.openSocket();
          break;
        case "close":
          harness.closeSocket();
          break;
        case "socket":
          harness.socketMessage(step.message);
          break;
        case "input":
          harness.input(step.value);
          break;
        case "flush":
          harness.flushTimers();
          break;
        case "capture":
          harness.capture(step.label);
          break;
        default:
          assert.fail(`Unknown live replay step kind: ${step.kind}`);
      }
    }

    assert.deepEqual(
      harness.buildBundle({ scenario: scenario.scenario }),
      expectedBundle,
    );
  } finally {
    harness.dispose(0);
  }
}

test("live replay capture covers bootstrap, prompt dispatch, stream, and final agent reconciliation", async () => {
  await playRawReplayScenario("bootstrapChat", WATCH_LIVE_REPLAY_FIXTURES.bootstrapChat);
});

test("live replay capture covers planner and subagent-heavy operator state", async () => {
  await playRawReplayScenario("plannerSubagent", WATCH_LIVE_REPLAY_FIXTURES.plannerSubagent);
});

test("live replay capture covers reconnect transition and post-reconnect recovery", async () => {
  await playRawReplayScenario("reconnect", WATCH_LIVE_REPLAY_FIXTURES.reconnect);
});
