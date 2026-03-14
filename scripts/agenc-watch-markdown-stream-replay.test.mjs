import test from "node:test";
import assert from "node:assert/strict";

import { createMarkdownStreamCollector } from "./lib/agenc-watch-rich-text.mjs";
import { markdownStreamReplayCases } from "./fixtures/agenc-watch-markdown-stream-replay.fixture.mjs";

function visibleLines(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.mode !== "blank")
    .map((line) => ({
      mode: String(line?.mode ?? ""),
      text: String(line?.text ?? ""),
    }));
}

for (const fixtureCase of markdownStreamReplayCases) {
  test(`markdown stream replay: ${fixtureCase.name}`, () => {
    const collector = createMarkdownStreamCollector();
    for (let index = 0; index < fixtureCase.chunks.length; index += 1) {
      collector.pushDelta(fixtureCase.chunks[index]);
      assert.deepEqual(
        visibleLines(collector.commitCompleteLines()),
        fixtureCase.expectedCommitBatches[index] ?? [],
      );
      assert.deepEqual(
        visibleLines(collector.snapshot()),
        fixtureCase.expectedSnapshots[index] ?? [],
      );
    }
    assert.deepEqual(
      visibleLines(collector.finalizeAndDrain()),
      fixtureCase.expectedFinalDrain ?? [],
    );
  });
}
