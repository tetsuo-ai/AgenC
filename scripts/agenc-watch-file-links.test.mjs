import test from "node:test";
import assert from "node:assert/strict";

import {
  buildInlineFileSegments,
  buildFileTagHref,
  buildFileReferenceHref,
  buildStructuredFileReference,
  compactFileTag,
  compactFileTagsInText,
  compactFileReference,
  compactFileReferencesInText,
  replaceStructuredFileReference,
  styleFileReferencesInText,
  styleFileTagsInText,
} from "./lib/agenc-watch-file-links.mjs";

test("compactFileReference shortens repo-local absolute paths and preserves line suffixes", () => {
  const compacted = compactFileReference(
    "/home/tetsuo/git/AgenC/runtime/src/channels/webchat/operator-events.ts:42",
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxChars: 44,
    },
  );

  assert.equal(compacted, "runtime/…/webchat/operator-events.ts:42");
});

test("compactFileReferencesInText compacts inline file references without touching surrounding text", () => {
  const text = "See /home/tetsuo/git/AgenC/runtime/src/operator-events.ts#L12 for details.";
  const compacted = compactFileReferencesInText(text, {
    cwd: "/home/tetsuo/git/AgenC",
    maxChars: 36,
  });

  assert.equal(compacted, "See runtime/src/operator-events.ts#L12 for details.");
});

test("compactFileReferencesInText preserves quotes around spaced inline file references", () => {
  const compacted = compactFileReferencesInText(
    'See "/tmp/AgenC Demo/notes/My File.ts:18" next.',
    {
      cwd: "/tmp/AgenC Demo",
      maxChars: 48,
    },
  );

  assert.equal(compacted, 'See "notes/My File.ts:18" next.');
});

test("styleFileReferencesInText applies ANSI styling to file references only", () => {
  const rendered = styleFileReferencesInText("Open runtime/src/app.ts:10 next", {
    color: {
      cyan: "\u001b[36m",
      yellow: "\u001b[33m",
      bold: "\u001b[1m",
      reset: "\u001b[0m",
    },
    baseTone: "\u001b[35m",
  });

  assert.match(rendered, /\u001b\[36m\u001b\[1mruntime\/src\/app\.ts/);
  assert.match(rendered, /\u001b\[33m:10/);
  assert.match(rendered, /next$/);
});

test("compactFileTag shortens repo-local file tags and preserves suffixes", () => {
  const compacted = compactFileTag(
    "@/home/tetsuo/git/AgenC/runtime/src/channels/webchat/operator-events.ts:42",
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxChars: 44,
    },
  );

  assert.equal(compacted, "@runtime/…/webchat/operator-events.ts:42");
});

test("compactFileTagsInText compacts inline @file tags without touching prose", () => {
  const compacted = compactFileTagsInText(
    "Review @/home/tetsuo/git/AgenC/runtime/src/operator-events.ts#L12 now.",
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxChars: 36,
    },
  );

  assert.equal(compacted, "Review @runtime/src/operator-events.ts#L12 now.");
});

test("compactFileTagsInText preserves quotes around spaced inline @file tags", () => {
  const compacted = compactFileTagsInText(
    'Review @"/tmp/AgenC Demo/notes/My File.ts:18" now.',
    {
      cwd: "/tmp/AgenC Demo",
      maxChars: 48,
    },
  );

  assert.equal(compacted, 'Review @"notes/My File.ts:18" now.');
});

test("styleFileTagsInText applies ANSI styling to @file tags only", () => {
  const rendered = styleFileTagsInText("See @runtime/src/app.ts:10 next", {
    color: {
      cyan: "\u001b[36m",
      magenta: "\u001b[35m",
      yellow: "\u001b[33m",
      bold: "\u001b[1m",
      reset: "\u001b[0m",
    },
    baseTone: "\u001b[37m",
  });

  assert.match(rendered, /\u001b\[35m\u001b\[1m@/);
  assert.match(rendered, /\u001b\[36m\u001b\[1mruntime\/src\/app\.ts/);
  assert.match(rendered, /\u001b\[33m:10/);
});

test("buildFileTagHref resolves repo-relative @file tags into file URLs", () => {
  const href = buildFileTagHref("@./runtime/src/index.ts:12:4", {
    cwd: "/home/tetsuo/git/AgenC",
  });

  assert.equal(href, "file:///home/tetsuo/git/AgenC/runtime/src/index.ts#L12C4");
});

test("buildFileReferenceHref normalizes colon suffixes into file URLs", () => {
  const href = buildFileReferenceHref("./runtime/src/index.ts:12:4", {
    cwd: "/home/tetsuo/git/AgenC",
  });

  assert.equal(href, "file:///home/tetsuo/git/AgenC/runtime/src/index.ts#L12C4");
});

test("buildInlineFileSegments preserves inline tag display text and href metadata", () => {
  const model = buildInlineFileSegments(
    "Inspect @/home/tetsuo/git/AgenC/runtime/src/index.ts:12 next",
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxChars: 28,
    },
  );

  assert.equal(model.text, "Inspect @runtime/src/index.ts:12 next");
  assert.equal(model.plainText, "Inspect @runtime/src/index.ts:12 next");
  assert.equal(model.segments.length, 3);
  assert.deepEqual(model.segments[0], {
    kind: "text",
    text: "Inspect ",
    start: 0,
    end: 8,
  });
  assert.deepEqual(model.segments[1], {
    kind: "file-reference",
    mentionKind: "tag",
    rawText: "@/home/tetsuo/git/AgenC/runtime/src/index.ts:12",
    rawReference: "/home/tetsuo/git/AgenC/runtime/src/index.ts:12",
    displayText: "@runtime/src/index.ts:12",
    text: "@runtime/src/index.ts:12",
    start: 8,
    end: 32,
    markerText: "@",
    openingDecorationText: "",
    closingDecorationText: "",
    pathText: "runtime/src/index.ts",
    suffixText: ":12",
    filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts",
    href: "file:///home/tetsuo/git/AgenC/runtime/src/index.ts#L12",
    valid: true,
  });
  assert.deepEqual(model.segments[2], {
    kind: "text",
    text: " next",
    start: 32,
    end: 37,
  });
});

test("buildInlineFileSegments preserves quoted spaced @file tags as canonical inline segments", () => {
  const model = buildInlineFileSegments(
    'Inspect @"/tmp/AgenC Demo/notes/My File.ts:18" next',
    {
      cwd: "/tmp/AgenC Demo",
      maxChars: 48,
    },
  );

  assert.equal(model.text, 'Inspect @"notes/My File.ts:18" next');
  const fileSegment = model.segments.find((segment) => segment.kind === "file-reference");
  assert.deepEqual(fileSegment, {
    kind: "file-reference",
    mentionKind: "tag",
    rawText: '@"/tmp/AgenC Demo/notes/My File.ts:18"',
    rawReference: "/tmp/AgenC Demo/notes/My File.ts:18",
    displayText: '@"notes/My File.ts:18"',
    text: '@"notes/My File.ts:18"',
    start: 8,
    end: 30,
    markerText: "@",
    openingDecorationText: '"',
    closingDecorationText: '"',
    pathText: "notes/My File.ts",
    suffixText: ":18",
    filePath: "/tmp/AgenC Demo/notes/My File.ts",
    href: "file:///tmp/AgenC%20Demo/notes/My%20File.ts#L18",
    valid: true,
  });
});

test("buildStructuredFileReference preserves spaced paths for metadata-backed rendering", () => {
  const reference = buildStructuredFileReference(
    {
      filePath: "/tmp/AgenC Demo/notes/My File.ts",
      fileRange: { startLine: 18 },
      displayText: "notes/My File.ts",
    },
    {
      cwd: "/tmp/AgenC Demo",
    },
  );

  assert.equal(reference.displayText, "notes/My File.ts");
  assert.equal(reference.href, "file:///tmp/AgenC%20Demo/notes/My%20File.ts#L18");
});

test("replaceStructuredFileReference replaces only the structured display target", () => {
  const rendered = replaceStructuredFileReference(
    "open notes/My File.ts · line 18 now",
    {
      displayText: "notes/My File.ts",
    },
    () => "[link]",
  );

  assert.equal(rendered, "open [link] · line 18 now");
});
