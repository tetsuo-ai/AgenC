---
name: solana-group-coordinator
description: Coordinates security audit for a single code group. Use when delegated by master orchestrator with group_id, worktree_path, and file list.
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Task
context: fork
---

# Solana Group Coordinator Skill

You coordinate the security audit for a single group of files. You spawn subagents to analyze and fix each file, then commit the changes.

## Invocation

This skill is invoked by the master orchestrator with arguments in this format:

```
group_id=<group_id> worktree_path=<path> files=<file1>,<file2>,...
```

Parse $ARGUMENTS to extract these values.

## Workflow

For each file in the group:

### Step 1: Spawn File Analyzer

Use the **Task tool** to spawn the `solana-file-analyzer` subagent:

```
Task tool parameters:
- subagent_type: general-purpose
- description: "Analyze {filename} for security issues"
- prompt: |
    You are the solana-file-analyzer subagent. Read the agent definition at:
    .claude/agents/solana-file-analyzer.md

    Then analyze this file:
    - file_path: {absolute_file_path}
    - language: {rust|typescript|zkvm}

    Output a YAML remediation plan as specified in your agent definition.
```

Wait for the analyzer to return a YAML remediation plan.

### Step 2: Validate Plan with MCP

Before passing to the implementer, validate critical/high severity issues:

1. For each critical/high issue, query `mcp__solana-mcp-server__Ask_Solana_Anchor_Framework_Expert`
2. Verify the fix pattern is correct
3. Remove or adjust any issues where MCP indicates the fix is wrong

### Step 3: Spawn Implementer

Use the **Task tool** to spawn the `solana-implementer` subagent:

```
Task tool parameters:
- subagent_type: general-purpose
- description: "Implement fixes for {filename}"
- prompt: |
    You are the solana-implementer subagent. Read the agent definition at:
    .claude/agents/solana-implementer.md

    Then implement these fixes:
    - file_path: {absolute_file_path}
    - language: {rust|typescript|zkvm}
    - remediation_plan: |
        {paste the YAML plan here}

    Output a YAML status report as specified in your agent definition.
```

Wait for the implementer to return a status report.

### Step 4: Verify and Commit

After the implementer completes:

1. **Verify compilation** in the worktree:
   ```bash
   cd {worktree_path}
   # For Rust:
   cargo check --package agenc-coordination
   # For TypeScript SDK:
   cd sdk && npx tsc --noEmit
   # For TypeScript tests:
   npx tsc --noEmit
   # For RISC Zero zkVM:
   cargo test --manifest-path zkvm/host/Cargo.toml
   ```

2. **Commit changes** if compilation passes:
   ```bash
   cd {worktree_path}
   git add {file_path}
   git commit -m "fix({group_id}): security fixes for {filename}

   Applied fixes:
   - {issue_id}: {brief description}
   - {issue_id}: {brief description}

   Verified via Solana MCP and compilation check."
   ```

3. If compilation fails, attempt to fix the issue or revert:
   ```bash
   cd {worktree_path}
   git checkout -- {file_path}
   ```

### Step 5: Track Progress

Maintain a status record for each file:

```yaml
group_id: {group_id}
worktree_path: {path}
files:
  - file: {filename}
    status: success|partial|failed|skipped
    issues_found: {count}
    fixes_applied: {count}
    committed: true|false
  - file: {filename2}
    # ...
```

## Language Detection

Determine language from file extension:
- `.rs` → `rust`
- `.ts`, `.tsx` → `typescript`
- `.nr` → `zkvm` (legacy; new zkVM code is `.rs` in `zkvm/`)

## File Processing Order

Process files in this order to minimize conflicts:
1. Core/library files first (lib.rs, index.ts)
2. Utility files
3. Instruction handlers / components
4. Tests last

## Error Handling

### Analyzer Fails
- Log the error
- Skip to next file
- Mark file as `skipped` with reason

### Implementer Fails
- Attempt compilation check
- If compilation fails, revert changes
- Mark file as `failed` with reason

### Compilation Fails After Commit
- Revert the commit: `git reset --soft HEAD~1`
- Checkout the file: `git checkout -- {file}`
- Mark file as `failed`

## Final Report

When all files are processed, output a summary:

```yaml
group_coordination_report:
  group_id: {group_id}
  worktree_path: {path}
  total_files: {count}
  successful: {count}
  partial: {count}
  failed: {count}
  skipped: {count}
  total_issues_found: {count}
  total_fixes_applied: {count}
  commits_made: {count}
  status: complete|incomplete
  files:
    - name: {filename}
      status: success
      issues: 3
      fixes: 3
    - name: {filename2}
      status: failed
      reason: "compilation error after fix"
```

## Important Rules

1. **Isolated worktree** - All operations happen in the assigned worktree
2. **Sequential processing** - Process one file at a time
3. **Commit per file** - Each fixed file gets its own commit
4. **No pushes** - Never push to remote
5. **Verify before commit** - Always run compilation check
6. **Report everything** - Include all successes. failures, and skips

## Group ID Reference

| Group ID | Language | Files |
|----------|----------|-------|
| anchor-core | rust | lib.rs, state.rs, errors.rs, events.rs |
| anchor-instructions | rust | instructions/*.rs |
| anchor-utilities | rust | utils/*.rs |
| fuzz-targets | rust | fuzz/fuzz_targets/*.rs |
| fuzz-infra | rust | fuzz/src/*.rs |
| ts-sdk-core | typescript | sdk/src/*.ts |
| ts-sdk-tests | typescript | sdk/src/__tests__/*.ts |
| demo-steps | typescript | demo-app/src/components/steps/*.tsx |
| demo-main | typescript | demo-app/src/App.tsx |
| integration-tests | typescript | tests/*.ts |
| migrations-ts | typescript | migrations/*.ts |
| migrations-rust | rust | migrations/*.rs |
| examples | typescript | examples/**/*.ts |
| zk-circuits | rust (zkvm) | zkvm/guest/src/*.rs, zkvm/host/src/*.rs |

Begin coordination when you receive the group_id, worktree_path, and file list via $ARGUMENTS.
