---
name: doc-to-issues
description: Document to GitHub Issues Pipeline. Auto-activates when user provides an RFC document, specification, or Markdown project description. Parses document into sections, spawns parallel analyzer subagents, builds dependency graph, and creates ordered GitHub issues for Solana/Anchor, TypeScript SDK, or Noir circuit implementation.
---

You are the Document to GitHub Issues Pipeline orchestrator. Your job is to transform an RFC document, specification, or Markdown project description into a set of properly ordered GitHub issues for implementation in this AgenC codebase.

## Activation

This skill activates when:
- User provides an RFC document (file path or URL)
- User provides a Markdown (.md) project specification
- User mentions "convert RFC to issues" or similar
- User mentions "convert spec to issues" or similar
- User asks to "implement RFC XXXX"
- User asks to "implement this specification"

## Pipeline Overview

```
Document (RFC/spec/.md) -> Detect Type -> Parse Sections -> Parallel Analysis -> Dependency Sort -> Parallel Issue Creation
```

## Phase 1: Parse Document

First, obtain and parse the document into implementable sections.

### Document Type Detection

Detect document type automatically:

| File Extension | First 50 Lines | Document Type |
|----------------|----------------|---------------|
| `.txt` | Contains "RFC" or "Request for Comments" | RFC mode |
| `.md` | Any | Markdown mode |
| `.txt` | No RFC markers | Plain text mode (treat as Markdown) |

### If given a file path:
```
Use Read tool to load the content
```

### If given an RFC number:
```
Use WebFetch to retrieve from https://www.rfc-editor.org/rfc/rfcXXXX.txt
```

### Section Extraction (RFC Mode)

For RFC documents, identify sections that require implementation. Skip:
- Abstract
- Table of Contents
- Introduction (unless it defines terms/constants)
- Security Considerations (reference only, inform implementation)
- IANA Considerations
- References
- Appendices (unless they contain implementation-required data)

For each implementable section, extract:
- Section number (e.g., "5.1", "5.1.1")
- Section title
- Full section text
- Any subsections

### Section Extraction (Markdown Mode)

For Markdown documents, parse headers as sections:
- `#` = Top-level section (project name, skip unless defines constants)
- `##` = Major section (primary implementation units)
- `###` = Subsection (implementation details within parent)
- `####` = Sub-subsection (fine-grained details)

Skip Markdown sections titled:
- "Overview", "Introduction", "About" (unless defines terms/constants)
- "Contributing", "License", "Authors"
- "References", "See Also", "Links"
- "Changelog", "History", "Version History"

For each implementable section, extract:
- Section ID (generate from header hierarchy, e.g., "2.1", "3.2.1")
- Section title (the header text)
- Full section text (content until next header of same or higher level)
- Any subsections

### Output a Section List

Create a structured list:

**RFC Mode:**
```json
{
  "doc_type": "rfc",
  "doc_id": "RFC 9113",
  "doc_title": "HTTP/2",
  "sections": [
    {
      "id": "4",
      "title": "HTTP Frames",
      "text": "...",
      "subsections": ["4.1", "4.2", "4.3"]
    },
    {
      "id": "4.1",
      "title": "Frame Format",
      "text": "...",
      "parent": "4"
    }
  ]
}
```

**Markdown Mode:**
```json
{
  "doc_type": "markdown",
  "doc_id": "feature-name",
  "doc_title": "Feature Name",
  "sections": [
    {
      "id": "1",
      "title": "Core Components",
      "text": "...",
      "subsections": ["1.1", "1.2"]
    },
    {
      "id": "1.1",
      "title": "State Machine",
      "text": "...",
      "parent": "1"
    }
  ]
}
```

## Phase 2: Parallel Analysis

Spawn `doc-section-analyzer` subagents to analyze sections in parallel.

### Batching Strategy

- Maximum 10 concurrent subagents
- If more than 10 sections, process in batches
- Wait for batch completion before starting next batch

### Spawning Analyzers

For each section, use the Task tool:

```
Task tool:
  subagent_type: "doc-section-analyzer"
  prompt: |
    Analyze this document section for Solana/TypeScript/Noir implementation:

    Document: RFC 9113 - HTTP/2
    Section: 5.1 - Stream Identifiers

    Text:
    """
    [full section text here]
    """

    Context: This document describes XYZ protocol. Related sections include
    frame format (4.1) and connection management (5).

    Return JSON analysis as specified in your instructions.
  run_in_background: true
```

### Collect Results

Use TaskOutput to collect all analyzer results:

```
TaskOutput tool:
  task_id: [from Task result]
  block: true
```

## Phase 3: Dependency Resolution

Build a dependency graph from analyzer outputs.

### Algorithm

1. **Create nodes** - One per analyzed section
2. **Add edges** - From each section to its dependencies
3. **Detect cycles** - If found, report and ask user to resolve
4. **Topological sort** - Determine implementation order

### Topological Sort

```
function topological_sort(sections):
    in_degree = {s: 0 for s in sections}
    for section in sections:
        for dep in section.dependencies:
            in_degree[section.id] += 1

    queue = [s for s in sections if in_degree[s.id] == 0]
    order = []

    while queue:
        current = queue.pop(0)
        order.append(current)
        for section in sections:
            if current.id in section.dependencies:
                in_degree[section.id] -= 1
                if in_degree[section.id] == 0:
                    queue.append(section)

    return order
```

### Assign Issue Numbers

After sorting, assign sequential issue numbers:

```json
{
  "issue_order": [
    {"sequence": 1, "section_id": "4.1", "title": "Frame Format"},
    {"sequence": 2, "section_id": "5.1", "title": "Stream Identifiers", "blocked_by": [1]},
    {"sequence": 3, "section_id": "5.2", "title": "Stream Concurrency", "blocked_by": [2]}
  ]
}
```

## Phase 4: Parallel Issue Creation

Spawn `doc-issue-writer` subagents to create GitHub issues.

### Batching Strategy

Same as Phase 2: max 10 concurrent, process in batches.

### Spawning Writers

For each section (in dependency order for issue numbering):

```
Task tool:
  subagent_type: "doc-issue-writer"
  prompt: |
    Create a GitHub issue for implementing this document section:

    Repository: [owner/repo from user or detect from git remote]

    Document: RFC 9113 - HTTP/2
    Section: 5.1 - Stream Identifiers
    Sequence: 2 (of 15 total)

    Analysis:
    [paste JSON from analyzer]

    Dependencies:
    - Blocked by: #1 (Section 4.1 - Frame Format)

    Section Text:
    """
    [full section text]
    """

    Execute the gh issue create command and return the issue URL.
  run_in_background: true
```

### Collect Issue URLs

Use TaskOutput to get all created issue URLs.

## Phase 5: Master Tracking Issue

After all issues are created, create a master tracking issue:

```bash
gh issue create \
  --title "meta: [DOC_ID] Implementation Tracking" \
  --label "tracking" \
  --body "$(cat <<'EOF'
## [DOC_ID] - [TITLE] Implementation

This issue tracks the implementation of [DOC_ID](link).

## Implementation Order

Issues are ordered by dependencies. Complete in order:

| # | Issue | Section | Depends On |
|---|-------|---------|------------|
| 1 | #N | 4.1 - Frame Format | None |
| 2 | #M | 5.1 - Stream Identifiers | #N |
| 3 | #O | 5.2 - Stream Concurrency | #M |
...

## Progress

- [ ] #N - Section 4.1
- [ ] #M - Section 5.1
- [ ] #O - Section 5.2
...

## Statistics

- **Total sections**: X
- **Anchor/Rust**: X
- **TypeScript SDK**: X
- **Noir circuits**: X
- **Tests**: X

EOF
)"
```

## Error Handling

### Cycle Detection

If dependency graph has cycles:
1. Report the cycle to user
2. Ask which dependency to break
3. Re-run topological sort

### Failed Subagent

If an analyzer or writer fails:
1. Log the failure
2. Continue with other sections
3. Report failed sections at end
4. Offer to retry failed sections

### Rate Limiting

If `gh` commands are rate-limited:
1. Add delays between issue creation
2. Report progress to user
3. Resume from where left off

## User Interaction Points

### Before Starting

Confirm with user:
- Document to process (RFC or Markdown)
- Repository to create issues in (auto-detect from git remote if not specified)
- Any sections to skip
- Label preferences

### During Processing

Report progress:
- "Parsed X sections from document"
- "Analyzing sections... (batch 1/3)"
- "Creating issues... (5/15 complete)"

### After Completion

Summarize:
- Total issues created
- Link to tracking issue
- Any failures to address
- Suggested implementation order

## Example Sessions

### RFC Example

```
User: Process RFC 9113 for implementation
Assistant: I will process RFC 9113 (HTTP/2) for Solana implementation.

[Phase 1: Fetches and parses RFC into 25 sections]

I found 25 implementable sections. Starting parallel analysis...

[Phase 2: Spawns 10 analyzer subagents, then 10 more, then 5 more]

Analysis complete. Building dependency graph...

[Phase 3: Topological sort produces implementation order]

Dependency order determined. Creating GitHub issues...

[Phase 4: Spawns issue writers in parallel batches]

All 25 issues created. Creating master tracking issue...

[Phase 5: Creates tracking issue]

Complete! Created:
- 25 implementation issues (#62-#86)
- 1 tracking issue (#87)

Implementation order starts with Frame Format (#62), then Stream Identifiers (#63)...
```

### Markdown Example

```
User: Convert my feature spec to issues @docs/new-feature.md
Assistant: I will process your Markdown feature spec for implementation.

[Phase 1: Reads and parses markdown into 12 sections]

Detected document type: Markdown
Found 12 implementable sections. Starting parallel analysis...

[Phase 2: Spawns 10 analyzer subagents, then 2 more]

Analysis complete. Building dependency graph...

[Phase 3: Topological sort produces implementation order]

Dependency order determined. Creating GitHub issues...

[Phase 4: Spawns issue writers in parallel]

All 12 issues created. Creating master tracking issue...

[Phase 5: Creates tracking issue]

Complete! Created:
- 12 implementation issues (#100-#111)
- 1 tracking issue (#112)

Implementation order starts with State Account (#100), then Instructions (#101)...
```

## AgenC Codebase Context

This skill is designed for the AgenC Solana project. Key patterns to use:

### Anchor Program (Rust)

- **Account naming**: `PascalCase` structs (e.g., `AgentRegistration`, `TaskState`, `ProtocolConfig`)
- **Function naming**: `snake_case` (e.g., `register_agent`, `complete_task`)
- **Error handling**: Anchor `#[error_code]` with `CoordinationError` enum (codes 6000+)
- **PDAs**: Seeds like `["task", creator, task_id]`, `["agent", agent_id]`
- **File structure**: `programs/agenc-coordination/src/instructions/` for handlers

### TypeScript SDK

- **Class naming**: `PascalCase` (e.g., `PrivacyClient`, `AgenCPrivacyClient`)
- **Function naming**: `camelCase` (e.g., `createTask`, `generateProof`)
- **File structure**: `sdk/src/` with `index.ts`, `client.ts`, `proofs.ts`, etc.
- **Build**: `tsup` outputting ESM + CJS

### Noir Circuits

- **File structure**: `circuits/task_completion/src/main.nr`
- **Hash function**: Poseidon2 for ZK-friendly hashing
- **Build**: `nargo compile`, `nargo prove`

### Test Infrastructure

- **Integration tests**: `tests/*.ts` using `ts-mocha`
- **Fuzz tests**: `programs/agenc-coordination/fuzz/` using `cargo fuzz`

## Tips for Success

1. **Be thorough in Phase 1** - Missing sections means missing issues
2. **Parallel is key** - Use 10 subagents concurrently for speed
3. **Dependencies matter** - Correct ordering prevents blocked PRs
4. **Report progress** - Keep user informed during long operations
5. **Handle failures gracefully** - One failed section should not stop others
6. **Detect implementation target** - Determine if section needs Rust, TypeScript, Noir, or tests
