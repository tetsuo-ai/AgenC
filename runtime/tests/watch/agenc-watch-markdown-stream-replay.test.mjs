import test from "node:test";

import { createMarkdownStreamCollector } from "../../src/watch/agenc-watch-rich-text.mjs";
import { markdownStreamReplayCases } from "./fixtures/agenc-watch-markdown-stream-replay.fixture.mjs";
import { assertVisibleLineExpectation } from "./fixtures/agenc-watch-snapshot-assertions.mjs";

for (const fixtureCase of markdownStreamReplayCases) {
  test(`markdown stream replay: ${fixtureCase.name}`, () => {
    const collector = createMarkdownStreamCollector();
    for (let index = 0; index < fixtureCase.chunks.length; index += 1) {
      collector.pushDelta(fixtureCase.chunks[index]);
      assertVisibleLineExpectation(
        collector.commitCompleteLines(),
        fixtureCase.commitExpectations[index] ?? { exact: [] },
        `${fixtureCase.name} commit batch ${index + 1}`,
      );
      assertVisibleLineExpectation(
        collector.snapshot(),
        fixtureCase.snapshotExpectations[index] ?? { exact: [] },
        `${fixtureCase.name} snapshot ${index + 1}`,
      );
    }
    assertVisibleLineExpectation(
      collector.finalizeAndDrain(),
      fixtureCase.finalDrainExpectation ?? { exact: [] },
      `${fixtureCase.name} final drain`,
    );
  });
}
