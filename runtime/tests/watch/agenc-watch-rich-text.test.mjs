import test from "node:test";
import assert from "node:assert/strict";

import {
  buildMarkdownDisplayLines,
  buildStreamingMarkdownDisplayLines,
  highlightSourceLine,
  normalizeDisplayLineFileLinks,
  renderDisplayLine,
  wrapRichDisplayLines,
} from "../../src/watch/agenc-watch-rich-text.mjs";

test("buildMarkdownDisplayLines keeps structural markdown without raw decorators", () => {
  const lines = buildMarkdownDisplayLines(`
# Heading

- first
1. second
> quoted

\`\`\`js
const answer = 42;
\`\`\`
  `);

  const actual = lines
      .filter((line) => line.mode !== "blank")
      .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      { mode: "heading", text: "Heading" },
      { mode: "list", text: "• first" },
      { mode: "list", text: "1. second" },
      { mode: "quote", text: "quoted" },
      { mode: "code-meta", text: "code · js" },
      { mode: "code", text: "const answer = 42;" },
    ]),
  );
});

test("buildMarkdownDisplayLines strips terminal control sequences before display", () => {
  const lines = buildMarkdownDisplayLines("\u001b]2;owned\u0007# Title");
  assert.equal(lines[0].text, "Title");
});

test("buildMarkdownDisplayLines normalizes links, inline code, images, and tables", () => {
  const lines = buildMarkdownDisplayLines(`
Paragraph with [docs](https://example.com/docs), ![diagram](asset.png), and \`npm test\`.

| Name | Value |
| --- | --- |
| alpha | 42 |
`);

  const actual = lines
      .filter((line) => line.mode !== "blank")
      .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      {
        mode: "paragraph",
        text: "Paragraph with docs (https://example.com/docs), image: diagram (asset.png), and 'npm test'.",
      },
      { mode: "table-header", text: "Name  │ Value" },
      { mode: "table-divider", text: "──────┼──────" },
      { mode: "table-row", text: "alpha │ 42   " },
    ]),
  );
});

test("wrapRichDisplayLines preserves list and quote continuation prefixes", () => {
  const lines = wrapRichDisplayLines(
    buildMarkdownDisplayLines(`
- a list item with enough words to wrap cleanly
> a quoted sentence with enough words to wrap
`),
    18,
  );

  const actual = lines
      .filter((line) => line.mode !== "blank")
      .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      { mode: "list", text: "• a list item with" },
      { mode: "list", text: "  enough words to" },
      { mode: "list", text: "  wrap cleanly" },
      { mode: "quote", text: "a quoted sentence" },
      { mode: "quote", text: "  with enough" },
      { mode: "quote", text: "  words to wrap" },
    ]),
  );
});

test("buildStreamingMarkdownDisplayLines hides incomplete inline markdown syntax on the active line", () => {
  const lines = buildStreamingMarkdownDisplayLines(
    "This paragraph includes [example](https://example.com and `npm test",
  );

  const actual = lines
    .filter((line) => line.mode !== "blank")
    .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      {
        mode: "stream-tail",
        text: "This paragraph includes example (https://example.com and 'npm test",
      },
    ]),
  );
});

test("buildStreamingMarkdownDisplayLines keeps incomplete table blocks out of raw pipe form", () => {
  const lines = buildStreamingMarkdownDisplayLines(`
Intro

| Column A | Column B |
| -------- | -----
`);

  const actual = lines
    .filter((line) => line.mode !== "blank")
    .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      { mode: "paragraph", text: "Intro" },
      { mode: "stream-tail", text: "Column A │ Column B" },
      { mode: "stream-tail", text: "-------- │ -----" },
    ]),
  );
});

test("buildStreamingMarkdownDisplayLines preserves open fenced code blocks while streaming", () => {
  const lines = buildStreamingMarkdownDisplayLines("```js\nconsole.log(\"hi\");");

  const actual = lines
    .filter((line) => line.mode !== "blank")
    .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      { mode: "code-meta", text: "code · js" },
      { mode: "code", text: "console.log(\"hi\");" },
    ]),
  );
});

test("buildStreamingMarkdownDisplayLines keeps partial table rows sanitized while the table is open", () => {
  const lines = buildStreamingMarkdownDisplayLines(`
| Component | Status |
| --------- | ------ |
| Input
`);

  const actual = lines
    .filter((line) => line.mode !== "blank")
    .map((line) => ({ mode: line.mode, text: line.text }));

  assert.equal(
    JSON.stringify(actual),
    JSON.stringify([
      { mode: "table-header", text: "Component │ Status" },
      { mode: "table-divider", text: "──────────┼───────" },
      { mode: "stream-tail", text: "Input" },
    ]),
  );
});

test("highlightSourceLine and renderDisplayLine add ansi styling for code and headings", () => {
  const code = highlightSourceLine("const answer = 42;");
  const heading = renderDisplayLine({ text: "Heading", mode: "heading" });
  assert.match(code, /\x1b\[[0-9;]*mconst\x1b\[[0-9;]*m/);
  assert.match(heading, /\x1b\[[0-9;]*mHeading\x1b\[[0-9;]*m/);
});

test("renderDisplayLine emits OSC 8 hyperlinks for structured file-link entries", () => {
  const rendered = renderDisplayLine(
    {
      text: "notes/My File.ts · line 18",
      plainText: "notes/My File.ts · line 18",
      mode: "file-link",
      filePath: "/tmp/AgenC Demo/notes/My File.ts",
      fileRange: { startLine: 18 },
      fileLinkText: "notes/My File.ts",
    },
    {
      enableHyperlinks: true,
      cwd: "/tmp/AgenC Demo",
    },
  );

  assert.match(rendered, /\u001b]8;;file:\/\/\/tmp\/AgenC%20Demo\/notes\/My%20File\.ts#L18\u0007/);
  assert.match(rendered, /notes\/My File\.ts/);
});

test("normalizeDisplayLineFileLinks compacts local file references before wrapping", () => {
  const [line] = normalizeDisplayLineFileLinks(
    [
      {
        text: "See /home/tetsuo/git/AgenC/runtime/src/index.ts:12 next",
        plainText: "See /home/tetsuo/git/AgenC/runtime/src/index.ts:12 next",
        mode: "paragraph",
      },
    ],
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxPathChars: 28,
    },
  );

  assert.equal(line.text, "See runtime/src/index.ts:12 next");
});

test("normalizeDisplayLineFileLinks compacts @file tags before wrapping", () => {
  const [line] = normalizeDisplayLineFileLinks(
    [
      {
        text: "See @/home/tetsuo/git/AgenC/runtime/src/index.ts:12 next",
        plainText: "See @/home/tetsuo/git/AgenC/runtime/src/index.ts:12 next",
        mode: "paragraph",
      },
    ],
    {
      cwd: "/home/tetsuo/git/AgenC",
      maxChars: 28,
    },
  );

  assert.equal(line.text, "See @runtime/src/index.ts:12 next");
  const fileSegments = line.inlineSegments.filter((segment) => segment.kind === "file-reference");
  assert.equal(fileSegments.length, 1);
  assert.equal(fileSegments[0].href, "file:///home/tetsuo/git/AgenC/runtime/src/index.ts#L12");
});

test("renderDisplayLine styles @file tags inside paragraph text", () => {
  const [line] = normalizeDisplayLineFileLinks(
    [
      {
        text: "Inspect @runtime/src/channels/webchat/types.ts next",
        plainText: "Inspect @runtime/src/channels/webchat/types.ts next",
        mode: "paragraph",
      },
    ],
    {
      cwd: "/home/tetsuo/git/AgenC",
    },
  );
  const rendered = renderDisplayLine(line);

  assert.match(rendered, /@/);
  assert.match(rendered, /runtime\/src\/channels\/webchat\/types\.ts/);
  assert.match(rendered, /\x1b\[[0-9;]*m@/);
});

test("renderDisplayLine emits OSC 8 hyperlinks for inline @file tags", () => {
  const [line] = normalizeDisplayLineFileLinks(
    [
      {
        text: "Inspect @/tmp/agenc-demo/notes/my-file.ts:18 next",
        plainText: "Inspect @/tmp/agenc-demo/notes/my-file.ts:18 next",
        mode: "paragraph",
      },
    ],
    {
      cwd: "/tmp/agenc-demo",
    },
  );
  const rendered = renderDisplayLine(line, {
    enableHyperlinks: true,
    cwd: "/tmp/agenc-demo",
  });

  assert.match(rendered, /\u001b]8;;file:\/\/\/tmp\/agenc-demo\/notes\/my-file\.ts#L18\u0007/);
  assert.match(rendered, /\x1b\[[0-9;]*m@/);
  assert.match(rendered, /notes\/my-file\.ts/);
  assert.match(rendered, /:18/);
});

test("renderDisplayLine emits OSC 8 hyperlinks for quoted spaced inline @file tags", () => {
  const [line] = normalizeDisplayLineFileLinks(
    [
      {
        text: 'Inspect @"/tmp/AgenC Demo/notes/My File.ts:18" next',
        plainText: 'Inspect @"/tmp/AgenC Demo/notes/My File.ts:18" next',
        mode: "paragraph",
      },
    ],
    {
      cwd: "/tmp/AgenC Demo",
    },
  );
  const rendered = renderDisplayLine(line, {
    enableHyperlinks: true,
    cwd: "/tmp/AgenC Demo",
  });

  assert.match(rendered, /\u001b]8;;file:\/\/\/tmp\/AgenC%20Demo\/notes\/My%20File\.ts#L18\u0007/);
  assert.equal(line.text, 'Inspect @"notes/My File.ts:18" next');
  assert.match(rendered, /notes\/My File\.ts/);
  assert.match(rendered, /:18/);
});

test("wrapRichDisplayLines preserves inline @file hyperlink metadata on wrapped lines", () => {
  const wrapped = wrapRichDisplayLines(
    normalizeDisplayLineFileLinks(
      [
        {
          text: "Inspect @runtime/src/channels/webchat/types.ts next",
          plainText: "Inspect @runtime/src/channels/webchat/types.ts next",
          mode: "paragraph",
        },
      ],
      {
        cwd: "/home/tetsuo/git/AgenC",
      },
    ),
    42,
  );

  const tagLine = wrapped.find((line) => String(line.text).includes("@runtime/src/channels/webchat/types.ts"));
  assert.ok(tagLine);
  const fileSegments = tagLine.inlineSegments.filter((segment) => segment.kind === "file-reference");
  assert.equal(fileSegments.length, 1);
  const rendered = renderDisplayLine(tagLine, {
    enableHyperlinks: true,
    cwd: "/home/tetsuo/git/AgenC",
  });
  assert.match(rendered, /\u001b]8;;file:\/\/\/home\/tetsuo\/git\/AgenC\/runtime\/src\/channels\/webchat\/types\.ts\u0007/);
});

test("wrapRichDisplayLines preserves quoted inline @file hyperlink metadata on wrapped lines", () => {
  const wrapped = wrapRichDisplayLines(
    normalizeDisplayLineFileLinks(
      [
        {
          text: 'Inspect @"/tmp/AgenC Demo/notes/My File.ts:18" for follow-up',
          plainText: 'Inspect @"/tmp/AgenC Demo/notes/My File.ts:18" for follow-up',
          mode: "paragraph",
        },
      ],
      {
        cwd: "/tmp/AgenC Demo",
      },
    ),
    24,
  );

  const tagLine = wrapped.find((line) => String(line.text).includes('@"notes/My File.ts:18"'));
  assert.ok(tagLine);
  const fileSegments = tagLine.inlineSegments.filter((segment) => segment.kind === "file-reference");
  assert.equal(fileSegments.length, 1);
  const rendered = renderDisplayLine(tagLine, {
    enableHyperlinks: true,
    cwd: "/tmp/AgenC Demo",
  });
  assert.equal(tagLine.text, '@"notes/My File.ts:18"');
  assert.match(rendered, /\u001b]8;;file:\/\/\/tmp\/AgenC%20Demo\/notes\/My%20File\.ts#L18\u0007/);
});

test("highlightSourceLine falls back to plain tint on low color depth", () => {
  const code = highlightSourceLine("const answer = 42;", undefined, { colorDepth: 1 });
  assert.doesNotMatch(code, /\x1b\[[0-9;]*m42\x1b\[[0-9;]*m/);
  assert.match(code, /\x1b\[[0-9;]*mconst answer = 42;/);
});
