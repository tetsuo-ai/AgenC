export const markdownStreamReplayCases = [
  {
    name: "mixed_markdown_reply",
    chunks: [
      "## Plan\n\n",
      "- step one\n- step with [docs](https://example.com",
      ")\n\n```js\nconst answer = 42",
      ";\n```\n",
    ],
    expectedCommitBatches: [
      [{ mode: "heading", text: "Plan" }],
      [{ mode: "list", text: "• step one" }],
      [
        { mode: "list", text: "• step with docs (https://example.com)" },
        { mode: "code-meta", text: "code · js" },
      ],
      [{ mode: "code", text: "const answer = 42;" }],
    ],
    expectedSnapshots: [
      [{ mode: "heading", text: "Plan" }],
      [
        { mode: "heading", text: "Plan" },
        { mode: "list", text: "• step one" },
        { mode: "stream-tail", text: "- step with docs (https://example.com" },
      ],
      [
        { mode: "heading", text: "Plan" },
        { mode: "list", text: "• step one" },
        { mode: "list", text: "• step with docs (https://example.com)" },
        { mode: "code-meta", text: "code · js" },
        { mode: "code", text: "const answer = 42" },
      ],
      [
        { mode: "heading", text: "Plan" },
        { mode: "list", text: "• step one" },
        { mode: "list", text: "• step with docs (https://example.com)" },
        { mode: "code-meta", text: "code · js" },
        { mode: "code", text: "const answer = 42;" },
      ],
    ],
    expectedFinalDrain: [],
  },
  {
    name: "table_reply_commits_header_before_partial_row",
    chunks: [
      "| Component | Status |\n",
      "| --------- | ------ |\n",
      "| Input",
    ],
    expectedCommitBatches: [
      [],
      [
        { mode: "table-header", text: "Component │ Status" },
        { mode: "table-divider", text: "──────────┼───────" },
      ],
      [],
    ],
    expectedSnapshots: [
      [{ mode: "stream-tail", text: "Component │ Status" }],
      [
        { mode: "table-header", text: "Component │ Status" },
        { mode: "table-divider", text: "──────────┼───────" },
      ],
      [
        { mode: "table-header", text: "Component │ Status" },
        { mode: "table-divider", text: "──────────┼───────" },
        { mode: "stream-tail", text: "Input" },
      ],
    ],
    expectedFinalDrain: [
      { mode: "table-row", text: "Input     │       " },
    ],
  },
];
