import test from "node:test";
import assert from "node:assert/strict";

import {
  computeTranscriptPreviewMaxLines,
  splitTranscriptPreviewForHeadline,
} from "../../src/watch/agenc-watch-transcript-cards.mjs";

test("splitTranscriptPreviewForHeadline consumes the first preview line for agent and user cards", () => {
  const previewLines = [
    { text: "Linked List in C", plainText: "Linked List in C" },
    { text: "Here's a clean example", plainText: "Here's a clean example" },
  ];

  const agentCard = splitTranscriptPreviewForHeadline({ kind: "agent" }, previewLines);
  assert.equal(agentCard.headline, "Linked List in C");
  assert.deepEqual(agentCard.bodyLines.map((line) => line.plainText), ["Here's a clean example"]);

  const toolCard = splitTranscriptPreviewForHeadline({ kind: "tool result" }, previewLines);
  assert.equal(toolCard.headline, "");
  assert.deepEqual(toolCard.bodyLines.map((line) => line.plainText), [
    "Linked List in C",
    "Here's a clean example",
  ]);
});

test("computeTranscriptPreviewMaxLines gives the latest followed agent more room", () => {
  const followedLatest = computeTranscriptPreviewMaxLines({
    eventKind: "agent",
    latestIsCurrent: true,
    following: true,
    viewportLines: 28,
    maxPreviewSourceLines: 160,
  });
  const olderAgent = computeTranscriptPreviewMaxLines({
    eventKind: "agent",
    latestIsCurrent: false,
    following: true,
    viewportLines: 28,
    maxPreviewSourceLines: 160,
  });

  assert.equal(followedLatest, Infinity);
  assert.ok(followedLatest > olderAgent);
});
