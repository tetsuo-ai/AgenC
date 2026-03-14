import test from "node:test";
import assert from "node:assert/strict";

import {
  createDisplayLine,
  createWatchFrameHarness,
} from "./fixtures/agenc-watch-frame-harness.mjs";

async function withStubbedSetTimeout(fn) {
  const originalSetTimeout = globalThis.setTimeout;
  const queued = [];
  globalThis.setTimeout = (callback) => {
    queued.push(callback);
    return 1;
  };
  try {
    return await fn({ queued });
  } finally {
    globalThis.setTimeout = originalSetTimeout;
  }
}

test("frame controller computes slash-mode layout through the extracted boundary", () => {
  const harness = createWatchFrameHarness({
    inputValue: "/st",
    suggestions: [{ usage: "/status", description: "Show runtime status", aliases: [] }],
    width: 140,
    height: 40,
  });

  const layout = harness.controller.currentTranscriptLayout();

  assert.equal(layout.width, 140);
  assert.equal(layout.height, 40);
  assert.equal(layout.bodyHeight, 29);
  assert.equal(harness.layoutCalls.length, 1);
  assert.equal(harness.layoutCalls[0].slashMode, true);
  assert.equal(harness.layoutCalls[0].detailOpen, false);
  assert.ok(harness.layoutCalls[0].popupRows > 0);
});

test("frame controller toggles detail mode using the newest expandable event", async () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "agent",
        title: "Agent Reply",
        body: "hello",
        timestamp: "12:00:00",
      },
    ],
    isMarkdownRenderableEvent() {
      return true;
    },
    wrapEventDisplayLines() {
      return [
        createDisplayLine("headline"),
        createDisplayLine("line 2"),
        createDisplayLine("line 3"),
        createDisplayLine("line 4"),
      ];
    },
    previewLines: 2,
  });

  await withStubbedSetTimeout(() => {
    harness.controller.toggleExpandedEvent();
    assert.equal(harness.watchState.expandedEventId, "evt-1");
    assert.ok(harness.statusCalls.includes("detail open: Agent Reply"));

    harness.controller.toggleExpandedEvent();
    assert.equal(harness.watchState.expandedEventId, null);
    assert.ok(harness.statusCalls.includes("detail closed"));
  });
});

test("frame controller exports transcript view through the extracted seam", () => {
  const harness = createWatchFrameHarness({
    events: [
      {
        id: "evt-1",
        kind: "agent",
        title: "Agent Reply",
        body: "hello world",
        timestamp: "12:00:00",
      },
    ],
  });

  const exportPath = harness.controller.exportCurrentView({ announce: true });

  assert.ok(exportPath);
  assert.equal(harness.fileWrites.length, 1);
  assert.match(harness.fileWrites[0].filePath, /agenc-watch-transcript-\d+\.txt$/);
  assert.equal(
    harness.fileWrites[0].text,
    "[12:00:00] Agent Reply\nhello world\n",
  );
  assert.deepEqual(harness.pushedEvents[0], {
    kind: "operator",
    title: "Transcript Export",
    body: `Transcript exported to ${exportPath}.`,
    tone: "teal",
  });
});

test("frame controller scrolls transcript and detail view independently", async () => {
  const harness = createWatchFrameHarness();

  await withStubbedSetTimeout(() => {
    harness.controller.scrollCurrentViewBy(3);
    assert.equal(harness.watchState.transcriptScrollOffset, 3);
    assert.equal(harness.watchState.transcriptFollowMode, false);

    harness.watchState.expandedEventId = "evt-1";
    harness.controller.scrollCurrentViewBy(2);
    assert.equal(harness.watchState.detailScrollOffset, 2);
  });
});
