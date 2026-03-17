import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWatchRenderCacheSignature,
  createWatchRenderCache,
  getCachedEventDisplayLines,
  getCachedWrappedDisplayLines,
} from "../../src/watch/agenc-watch-render-cache.mjs";

test("render cache reuses parsed display lines until the event signature changes", () => {
  const cache = createWatchRenderCache();
  const event = {
    kind: "agent",
    title: "Agent Reply",
    body: "hello",
    renderMode: "markdown",
    previewMode: "",
    renderSignature: "",
  };
  let builds = 0;
  const build = () => {
    builds += 1;
    return [{ text: "hello", mode: "paragraph", plainText: "hello" }];
  };

  const first = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
  );
  const second = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
  );

  assert.equal(builds, 1);
  assert.equal(first, second);

  event.body = "updated";
  const third = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
  );

  assert.equal(builds, 2);
  assert.notEqual(third, first);
});

test("render cache slices cached base lines without rebuilding", () => {
  const cache = createWatchRenderCache();
  const event = {
    kind: "agent",
    title: "Agent Reply",
    body: "hello",
    renderMode: "markdown",
    previewMode: "",
    renderSignature: "",
  };
  let builds = 0;
  const build = () => {
    builds += 1;
    return [
      { text: "one", mode: "paragraph", plainText: "one" },
      { text: "two", mode: "paragraph", plainText: "two" },
      { text: "three", mode: "paragraph", plainText: "three" },
    ];
  };

  const preview = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
    { maxLines: 2 },
  );
  const full = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
  );

  assert.equal(builds, 1);
  assert.deepEqual(preview.map((line) => line.text), ["one", "two"]);
  assert.deepEqual(full.map((line) => line.text), ["one", "two", "three"]);
});

test("render cache reuses wrapped lines per width and invalidates on width or signature changes", () => {
  const cache = createWatchRenderCache();
  const event = {
    kind: "agent",
    title: "Agent Reply",
    body: "hello",
    renderMode: "markdown",
    previewMode: "",
    renderSignature: "",
  };
  let wrappedBuilds = 0;
  const buildWrapped = () => {
    wrappedBuilds += 1;
    return [{ text: `wrapped:${wrappedBuilds}`, plainText: `wrapped:${wrappedBuilds}` }];
  };

  const first = getCachedWrappedDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    80,
    Infinity,
    buildWrapped,
  );
  const second = getCachedWrappedDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    80,
    Infinity,
    buildWrapped,
  );
  const differentWidth = getCachedWrappedDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    120,
    Infinity,
    buildWrapped,
  );

  event.title = "Agent Reply · live";
  const signatureChanged = getCachedWrappedDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    80,
    Infinity,
    buildWrapped,
  );

  assert.equal(wrappedBuilds, 3);
  assert.equal(first, second);
  assert.notEqual(first, differentWidth);
  assert.notEqual(first, signatureChanged);
});

test("render cache invalidates when metadata-driven renderSignature changes", () => {
  const cache = createWatchRenderCache();
  const event = {
    kind: "tool result",
    title: "Edited runtime/src/index.ts",
    body: "path: runtime/src/index.ts",
    renderMode: "",
    previewMode: "source-write",
    renderSignature: "{\"mutationKind\":\"write\"}",
  };
  let builds = 0;
  const build = () => {
    builds += 1;
    return [{ text: `render:${builds}`, mode: "diff-header", plainText: `render:${builds}` }];
  };

  const first = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
  );

  event.renderSignature = "{\"mutationKind\":\"replace\"}";
  const second = getCachedEventDisplayLines(
    cache,
    event,
    buildWatchRenderCacheSignature(event),
    build,
  );

  assert.equal(builds, 2);
  assert.notEqual(first, second);
});
