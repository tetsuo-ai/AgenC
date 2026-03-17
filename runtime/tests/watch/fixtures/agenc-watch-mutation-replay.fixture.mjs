export const mutationReplayCases = [
  {
    name: "metadata_replace",
    kind: "event",
    event: {
      previewMode: "source-write",
      mutationKind: "replace",
      filePath: "/home/tetsuo/git/AgenC/runtime/src/index.ts",
      mutationBeforeText: "const oldValue = 1;",
      mutationAfterText: "const newValue = 2;",
    },
    expectedLines: [
      { mode: "diff-header", text: "replace · runtime/src/index.ts" },
      { mode: "diff-hunk", text: "@@ replace @@" },
      { mode: "diff-section-remove", text: "--- before" },
      { mode: "diff-remove", text: "- const oldValue = 1;" },
      { mode: "diff-section-add", text: "+++ after" },
      { mode: "diff-add", text: "+ const newValue = 2;" },
    ],
    expectedHref: "file:///home/tetsuo/git/AgenC/runtime/src/index.ts",
  },
  {
    name: "unified_diff_fallback",
    kind: "event",
    event: {
      kind: "tool result",
      body: [
        "--- a/runtime/src/index.ts",
        "+++ b/runtime/src/index.ts",
        "@@ -1,2 +1,2 @@",
        "-const oldValue = 1;",
        "+const newValue = 2;",
        " console.log(newValue);",
      ].join("\n"),
    },
    expectedLines: [
      { mode: "diff-header", text: "patch · runtime/src/index.ts" },
      { mode: "diff-hunk", text: "@@ -1,2 +1,2 @@" },
      { mode: "diff-remove", text: "-const oldValue = 1;" },
      { mode: "diff-add", text: "+const newValue = 2;" },
      { mode: "diff-context", text: " console.log(newValue);" },
    ],
    expectedHref: "file:///home/tetsuo/git/AgenC/runtime/src/index.ts",
  },
  {
    name: "structured_file_link_with_spaces",
    kind: "line",
    line: {
      text: "notes/My File.ts · line 18",
      plainText: "notes/My File.ts · line 18",
      mode: "file-link",
      filePath: "/tmp/AgenC Demo/notes/My File.ts",
      fileRange: { startLine: 18 },
      fileLinkText: "notes/My File.ts",
    },
    expectedHref: "file:///tmp/AgenC%20Demo/notes/My%20File.ts#L18",
    expectedText: "notes/My File.ts · line 18",
  },
];
