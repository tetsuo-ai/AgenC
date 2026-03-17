import assert from "node:assert/strict";

export function normalizeSnapshotFrame(lines) {
  return (Array.isArray(lines) ? lines : String(lines ?? "").split("\n"))
    .map((line) => String(line ?? "").replace(/\s+$/g, ""))
    .join("\n");
}

function normalizeVisibleLineMarker(marker) {
  if (typeof marker === "string") {
    return marker;
  }
  return `${String(marker?.mode ?? "")}:${String(marker?.text ?? "")}`;
}

export function normalizeVisibleLineSequence(lines) {
  return (Array.isArray(lines) ? lines : [])
    .filter((line) => line?.mode !== "blank")
    .map((line) => normalizeVisibleLineMarker(line));
}

export function assertFrameExpectation(actualSnapshot, expectation, label = "frame") {
  const actual = normalizeSnapshotFrame(actualSnapshot);

  if (typeof expectation?.exact === "string") {
    assert.equal(actual, normalizeSnapshotFrame(expectation.exact), `${label} exact snapshot mismatch`);
  }

  const orderedLines = expectation?.orderedLines ?? expectation?.containsInOrder;
  if (Array.isArray(orderedLines)) {
    let cursor = 0;
    for (const marker of orderedLines) {
      const index = actual.indexOf(marker, cursor);
      assert.notEqual(index, -1, `${label} missing marker: ${marker}`);
      cursor = index + marker.length;
    }
  }

  const excludedLines = expectation?.excludedLines ?? expectation?.notContains;
  if (Array.isArray(excludedLines)) {
    for (const marker of excludedLines) {
      assert.equal(actual.includes(marker), false, `${label} unexpectedly contained marker: ${marker}`);
    }
  }
}

export function assertVisibleLineExpectation(actualLines, expectation, label = "lines") {
  const actual = normalizeVisibleLineSequence(actualLines);

  const exactLines = expectation?.exactLines ?? expectation?.exact;
  if (Array.isArray(exactLines)) {
    assert.deepEqual(
      actual,
      exactLines.map(normalizeVisibleLineMarker),
      `${label} exact lines mismatch`,
    );
  }

  const orderedLines = expectation?.orderedLines ?? expectation?.containsInOrder;
  if (Array.isArray(orderedLines)) {
    let cursor = 0;
    const normalizedMarkers = orderedLines.map(normalizeVisibleLineMarker);
    for (const marker of normalizedMarkers) {
      const index = actual.indexOf(marker, cursor);
      assert.notEqual(index, -1, `${label} missing marker: ${marker}`);
      cursor = index + 1;
    }
  }

  const excludedLines = expectation?.excludedLines ?? expectation?.notContains;
  if (Array.isArray(excludedLines)) {
    for (const marker of excludedLines.map(normalizeVisibleLineMarker)) {
      assert.equal(actual.includes(marker), false, `${label} unexpectedly contained marker: ${marker}`);
    }
  }
}

export function assertReplayBundleMatches(actualBundle, expectedBundle) {
  assert.deepEqual(actualBundle.meta, expectedBundle.meta);
  assert.equal(actualBundle.checkpoints.length, expectedBundle.checkpoints.length);

  actualBundle.checkpoints.forEach((checkpoint, index) => {
    const expectedCheckpoint = expectedBundle.checkpoints[index];
    assert.equal(checkpoint.label, expectedCheckpoint.label);
    assert.deepEqual(checkpoint.meta, expectedCheckpoint.meta);
    assert.deepEqual(checkpoint.summary, expectedCheckpoint.summary);
    assert.deepEqual(checkpoint.state, expectedCheckpoint.state);
    assertFrameExpectation(
      checkpoint.frame,
      expectedCheckpoint.frameExpectation ?? expectedCheckpoint.frame,
      `replay checkpoint ${expectedCheckpoint.label}`,
    );
  });
}

export const normalizeSnapshotLines = normalizeSnapshotFrame;
export const assertReplayBundle = assertReplayBundleMatches;
export const normalizeVisibleLines = normalizeVisibleLineSequence;
