---
name: solana-master-orchestrator
description: Master orchestration skill for Solana codebase security audit. Use when running a full security audit across the entire Solana codebase. Invoked via /solana-master-orchestrator.
allowed-tools: Bash, Read, Glob, Grep, Skill, Task
---

# Solana Master Orchestrator Skill

You orchestrate a comprehensive security audit across the entire AgenC Solana codebase. You create isolated worktrees for parallel processing and coordinate 14 group audits.

## Quick Start

When invoked, immediately begin the orchestration workflow. No additional arguments required.

## Architecture Overview

```
YOU (Master Orchestrator)
    │
    │ [Uses Skill tool to invoke group coordinators]
    │
    ├──► GROUP: anchor-core (4 files)
    ├──► GROUP: anchor-instructions (22 files)
    ├──► GROUP: anchor-utilities (3 files)
    ├──► GROUP: fuzz-targets (5 files)
    ├──► GROUP: fuzz-infra (5 files)
    ├──► GROUP: ts-sdk-core (6 files)
    ├──► GROUP: ts-sdk-tests (1 file)
    ├──► GROUP: demo-steps (6 files)
    ├──► GROUP: demo-main (1 file)
    ├──► GROUP: integration-tests (9 files)
    ├──► GROUP: migrations-ts (1 file)
    ├──► GROUP: migrations-rust (1 file)
    ├──► GROUP: examples (2 files)
    └──► GROUP: zk-circuits (1 file)
    │
    ▼
LOCAL MERGE → Final validation → Summary report
```

## Orchestration Workflow

### Phase 1: Setup (5 steps)

#### Step 1.1: Verify Clean State
```bash
cd /home/tetsuo/git/AgenC
git status --porcelain
```
If there are uncommitted changes, warn the user and ask to proceed or abort.

#### Step 1.2: Create Integration Branch
```bash
TIMESTAMP=$(date +%Y%m%d-%H%M%S)
INTEGRATION_BRANCH="audit/integration-${TIMESTAMP}"
git checkout -b ${INTEGRATION_BRANCH}
```

#### Step 1.3: Record Base Commit
```bash
BASE_COMMIT=$(git rev-parse HEAD)
echo "Base commit: ${BASE_COMMIT}"
```

#### Step 1.4: Create Worktrees Directory
```bash
WORKTREE_BASE="/tmp/agenc-audit-${TIMESTAMP}"
mkdir -p ${WORKTREE_BASE}
```

#### Step 1.5: Create 14 Worktrees
For each group, create an isolated worktree:
```bash
# Create group branch and worktree
git branch audit/${GROUP_ID}-${TIMESTAMP} ${BASE_COMMIT}
git worktree add ${WORKTREE_BASE}/${GROUP_ID} audit/${GROUP_ID}-${TIMESTAMP}
```

### Phase 2: Group Coordination (14 parallel groups)

For each group, use the **Skill tool** to invoke `solana-group-coordinator`:

```
Skill tool parameters:
- skill: solana-group-coordinator
- args: group_id={group_id} worktree_path={worktree_path} files={comma_separated_files}
```

**Group Definitions:**

| Group ID | Worktree Suffix | Files |
|----------|-----------------|-------|
| anchor-core | anchor-core | programs/agenc-coordination/src/lib.rs, programs/agenc-coordination/src/state.rs, programs/agenc-coordination/src/errors.rs, programs/agenc-coordination/src/events.rs |
| anchor-instructions | anchor-instructions | programs/agenc-coordination/src/instructions/mod.rs, programs/agenc-coordination/src/instructions/initialize_protocol.rs, programs/agenc-coordination/src/instructions/register_agent.rs, programs/agenc-coordination/src/instructions/deregister_agent.rs, programs/agenc-coordination/src/instructions/update_agent.rs, programs/agenc-coordination/src/instructions/create_task.rs, programs/agenc-coordination/src/instructions/claim_task.rs, programs/agenc-coordination/src/instructions/expire_claim.rs, programs/agenc-coordination/src/instructions/complete_task.rs, programs/agenc-coordination/src/instructions/complete_task_private.rs, programs/agenc-coordination/src/instructions/cancel_task.rs, programs/agenc-coordination/src/instructions/update_state.rs, programs/agenc-coordination/src/instructions/initiate_dispute.rs, programs/agenc-coordination/src/instructions/vote_dispute.rs, programs/agenc-coordination/src/instructions/resolve_dispute.rs, programs/agenc-coordination/src/instructions/apply_dispute_slash.rs, programs/agenc-coordination/src/instructions/expire_dispute.rs, programs/agenc-coordination/src/instructions/migrate.rs, programs/agenc-coordination/src/instructions/update_protocol_fee.rs, programs/agenc-coordination/src/instructions/update_rate_limits.rs, programs/agenc-coordination/src/instructions/completion_helpers.rs, programs/agenc-coordination/src/instructions/constants.rs |
| anchor-utilities | anchor-utilities | programs/agenc-coordination/src/utils/mod.rs, programs/agenc-coordination/src/utils/multisig.rs, programs/agenc-coordination/src/utils/version.rs |
| fuzz-targets | fuzz-targets | programs/agenc-coordination/fuzz/fuzz_targets/claim_task.rs, programs/agenc-coordination/fuzz/fuzz_targets/complete_task.rs, programs/agenc-coordination/fuzz/fuzz_targets/vote_dispute.rs, programs/agenc-coordination/fuzz/fuzz_targets/resolve_dispute.rs |
| fuzz-infra | fuzz-infra | programs/agenc-coordination/fuzz/src/lib.rs, programs/agenc-coordination/fuzz/src/accounts.rs, programs/agenc-coordination/fuzz/src/state.rs, programs/agenc-coordination/fuzz/src/instructions.rs |
| ts-sdk-core | ts-sdk-core | sdk/src/index.ts, sdk/src/client.ts, sdk/src/proofs.ts, sdk/src/tasks.ts, sdk/src/privacy.ts, sdk/src/constants.ts |
| ts-sdk-tests | ts-sdk-tests | sdk/src/__tests__/*.ts |
| demo-steps | demo-steps | demo-app/src/components/steps/Step1.tsx, demo-app/src/components/steps/Step2.tsx, demo-app/src/components/steps/Step3.tsx, demo-app/src/components/steps/Step4.tsx, demo-app/src/components/steps/Step5.tsx, demo-app/src/components/steps/Step6.tsx |
| demo-main | demo-main | demo-app/src/App.tsx |
| integration-tests | integration-tests | tests/test_1.ts, tests/smoke.ts, tests/coordination-security.ts, tests/audit-high-severity.ts, tests/rate-limiting.ts, tests/upgrades.ts, tests/complete_task_private.ts, tests/integration.ts, tests/minimal.ts |
| migrations-ts | migrations-ts | migrations/migration_utils.ts |
| migrations-rust | migrations-rust | migrations/v1_to_v2.rs |
| examples | examples | examples/helius-webhook/index.ts, examples/tetsuo-integration/demo.ts |
| zk-circuits | zk-circuits | circuits/task_completion/src/main.nr |

**Parallel Execution Strategy:**

Launch groups in batches to avoid overwhelming the system:

- **Batch 1:** anchor-core, ts-sdk-core, demo-main, zk-circuits (small groups)
- **Batch 2:** anchor-utilities, fuzz-infra, ts-sdk-tests, migrations-ts, migrations-rust
- **Batch 3:** anchor-instructions (largest group - run alone or with small groups)
- **Batch 4:** fuzz-targets, demo-steps, integration-tests, examples

Wait for each batch to complete before starting the next.

### Phase 3: Merge Integration

After all groups complete:

#### Step 3.1: Return to Main Repo
```bash
cd /home/tetsuo/git/AgenC
git checkout ${INTEGRATION_BRANCH}
```

#### Step 3.2: Merge Each Group Branch
```bash
for GROUP in anchor-core anchor-instructions anchor-utilities fuzz-targets fuzz-infra ts-sdk-core ts-sdk-tests demo-steps demo-main integration-tests migrations-ts migrations-rust examples zk-circuits; do
  git merge audit/${GROUP}-${TIMESTAMP} --no-edit -m "Merge ${GROUP} security fixes"
done
```

Handle merge conflicts if they occur:
1. Identify conflicting files
2. Use Read tool to examine conflicts
3. Resolve manually with Edit tool
4. Continue merge: `git add . && git merge --continue`

#### Step 3.3: Clean Up Worktrees
```bash
for GROUP in anchor-core anchor-instructions anchor-utilities fuzz-targets fuzz-infra ts-sdk-core ts-sdk-tests demo-steps demo-main integration-tests migrations-ts migrations-rust examples zk-circuits; do
  git worktree remove ${WORKTREE_BASE}/${GROUP} --force
  git branch -D audit/${GROUP}-${TIMESTAMP}
done
rm -rf ${WORKTREE_BASE}
```

### Phase 4: Validation

#### Step 4.1: Build Anchor Program
```bash
cd /home/tetsuo/git/AgenC
anchor build 2>&1
```

#### Step 4.2: Build TypeScript SDK
```bash
cd /home/tetsuo/git/AgenC/sdk
npm run build 2>&1
```

#### Step 4.3: Type Check Tests
```bash
cd /home/tetsuo/git/AgenC
npx tsc --noEmit 2>&1
```

#### Step 4.4: Check ZK Circuits (if Noir installed)
```bash
cd /home/tetsuo/git/AgenC/circuits/task_completion
risc0-host-prover check 2>&1 || echo "Noir not installed, skipping circuit check"
```

If any validation fails:
1. Identify the failing component
2. Attempt to fix or revert problematic commits
3. Re-run validation

### Phase 5: Summary Report

Generate a comprehensive report:

```yaml
solana_audit_report:
  timestamp: {ISO timestamp}
  base_commit: {commit hash}
  integration_branch: {branch name}

  groups:
    - group_id: anchor-core
      files_processed: 4
      issues_found: {count}
      fixes_applied: {count}
      status: success|partial|failed

    - group_id: anchor-instructions
      files_processed: 22
      issues_found: {count}
      fixes_applied: {count}
      status: success|partial|failed

    # ... all 14 groups

  totals:
    files_audited: 67
    total_issues_found: {count}
    total_fixes_applied: {count}
    groups_successful: {count}/14
    groups_partial: {count}/14
    groups_failed: {count}/14

  validation:
    anchor_build: passed|failed
    sdk_build: passed|failed
    type_check: passed|failed
    zk_circuits: passed|failed|skipped

  final_status: success|partial_success|failed

  next_steps:
    - "Review changes: git log ${BASE_COMMIT}..HEAD"
    - "Run full test suite: anchor test"
    - "If satisfied, merge to main"
```

## Critical Constraints

1. **ALL LOCAL** - Never push to remote, never create PRs
2. **Worktree isolation** - Each group works in its own worktree
3. **Sequential merges** - Merge groups one at a time to catch conflicts
4. **Validate before report** - Always run build validation
5. **Clean up** - Always remove worktrees and temporary branches

## Error Recovery

### Group Coordinator Fails
- Log the failure
- Continue with other groups
- Mark group as failed in report
- Include error details

### Merge Conflict
- Attempt automatic resolution
- If complex, mark as manual intervention needed
- Do not force or skip conflicts

### Build Validation Fails
- Identify which group's changes caused the failure
- Attempt to revert that group's merge
- Re-run validation
- Document in report

## MCP Tools Available

Use these for validation queries:
- `mcp__solana-mcp-server__Ask_Solana_Anchor_Framework_Expert`
- `mcp__solana-mcp-server__Solana_Documentation_Search`
- `mcp__solana-mcp-server__Solana_Expert__Ask_For_Help`

## Invocation

This skill is invoked via: `/solana-master-orchestrator`

No arguments required. The skill will:
1. Auto-detect the repository
2. Create necessary infrastructure
3. Orchestrate all 14 groups
4. Merge and validate
5. Generate final report

Begin orchestration immediately upon invocation.
