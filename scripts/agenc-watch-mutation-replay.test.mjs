import test from "node:test";
import assert from "node:assert/strict";

import { buildDiffDisplayLines } from "./lib/agenc-watch-diff-render.mjs";
import { renderDisplayLine } from "./lib/agenc-watch-rich-text.mjs";
import { mutationReplayCases } from "./fixtures/agenc-watch-mutation-replay.fixture.mjs";

function visibleLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => ({
    mode: String(line?.mode ?? ""),
    text: String(line?.text ?? ""),
  }));
}

for (const fixtureCase of mutationReplayCases) {
  test(`mutation replay: ${fixtureCase.name}`, () => {
    if (fixtureCase.kind === "event") {
      const lines = buildDiffDisplayLines(fixtureCase.event, {
        cwd: "/home/tetsuo/git/AgenC",
        maxPathChars: 72,
      });
      assert.deepEqual(visibleLines(lines), fixtureCase.expectedLines);

      const header = lines[0];
      const rendered = renderDisplayLine(header, {
        enableHyperlinks: true,
        cwd: "/home/tetsuo/git/AgenC",
      });
      assert.match(rendered, new RegExp(fixtureCase.expectedHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      return;
    }

    const rendered = renderDisplayLine(fixtureCase.line, {
      enableHyperlinks: true,
      cwd: "/tmp/AgenC Demo",
    });
    assert.match(rendered, new RegExp(fixtureCase.expectedHref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(rendered, /notes\/My File\.ts/);
    assert.match(rendered, / · line 18/);
  });
}
