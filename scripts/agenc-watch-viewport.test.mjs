import test from "node:test";
import assert from "node:assert/strict";

import {
  applyScrollDelta,
  bottomAlignRows,
  isTranscriptFollowing,
  preserveManualTranscriptViewport,
  sliceRowsAroundRange,
  sliceRowsFromBottom,
} from "./lib/agenc-watch-viewport.mjs";

test("applyScrollDelta never drops below zero", () => {
  assert.equal(applyScrollDelta(3, -10), 0);
  assert.equal(applyScrollDelta(5, 2), 7);
});

test("preserveManualTranscriptViewport keeps manual position relative to new rows", () => {
  assert.deepEqual(
    preserveManualTranscriptViewport({
      shouldFollow: false,
      beforeRows: 20,
      afterRows: 24,
      transcriptScrollOffset: 6,
    }),
    {
      transcriptScrollOffset: 10,
      transcriptFollowMode: false,
    },
  );
});

test("sliceRowsFromBottom clamps offsets and reports hidden rows", () => {
  const sliced = sliceRowsFromBottom(
    ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
    8,
    10,
  );
  assert.deepEqual(sliced.rows, ["a", "b", "c", "d", "e", "f", "g", "h"]);
  assert.equal(sliced.normalizedOffset, 2);
  assert.equal(sliced.hiddenAbove, 0);
  assert.equal(sliced.hiddenBelow, 2);
});

test("sliceRowsAroundRange focuses a recent mutation block", () => {
  const sliced = sliceRowsAroundRange(
    ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
    8,
    { start: 9, end: 11 },
    1,
  );

  assert.deepEqual(sliced.rows, ["4", "5", "6", "7", "8", "9", "10", "11"]);
  assert.equal(sliced.hiddenAbove, 4);
});

test("bottomAlignRows pads short views and isTranscriptFollowing respects offset", () => {
  assert.deepEqual(bottomAlignRows(["x", "y"], 4), ["", "", "x", "y"]);
  assert.equal(
    isTranscriptFollowing({ transcriptFollowMode: false, transcriptScrollOffset: 2 }),
    false,
  );
  assert.equal(
    isTranscriptFollowing({ transcriptFollowMode: false, transcriptScrollOffset: 0 }),
    true,
  );
});
