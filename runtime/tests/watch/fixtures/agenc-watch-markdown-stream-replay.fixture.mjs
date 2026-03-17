export const markdownStreamReplayCases = [
  {
    name: "mixed_markdown_reply",
    chunks: [
      "## Plan\n\n",
      "- step one\n- step with [docs](https://example.com",
      ")\n\n```js\nconst answer = 42",
      ";\n```\n",
    ],
    commitExpectations: [
      { exact: ["heading:Plan"] },
      { exact: ["list:• step one"] },
      {
        exact: [
          "list:• step with docs (https://example.com)",
          "code-meta:code · js",
        ],
      },
      { exact: ["code:const answer = 42;"] },
    ],
    snapshotExpectations: [
      { exact: ["heading:Plan"] },
      {
        exact: [
          "heading:Plan",
          "list:• step one",
          "stream-tail:- step with docs (https://example.com",
        ],
      },
      {
        exact: [
          "heading:Plan",
          "list:• step one",
          "list:• step with docs (https://example.com)",
          "code-meta:code · js",
          "code:const answer = 42",
        ],
      },
      {
        exact: [
          "heading:Plan",
          "list:• step one",
          "list:• step with docs (https://example.com)",
          "code-meta:code · js",
          "code:const answer = 42;",
        ],
      },
    ],
    finalDrainExpectation: { exact: [] },
  },
  {
    name: "table_reply_commits_header_before_partial_row",
    chunks: [
      "| Component | Status |\n",
      "| --------- | ------ |\n",
      "| Input",
    ],
    commitExpectations: [
      { exact: [] },
      {
        exact: [
          "table-header:Component │ Status",
          "table-divider:──────────┼───────",
        ],
      },
      { exact: [] },
    ],
    snapshotExpectations: [
      { exact: ["stream-tail:Component │ Status"] },
      {
        exact: [
          "table-header:Component │ Status",
          "table-divider:──────────┼───────",
        ],
      },
      {
        exact: [
          "table-header:Component │ Status",
          "table-divider:──────────┼───────",
          "stream-tail:Input",
        ],
      },
    ],
    finalDrainExpectation: {
      exact: ["table-row:Input     │       "],
    },
  },
];
