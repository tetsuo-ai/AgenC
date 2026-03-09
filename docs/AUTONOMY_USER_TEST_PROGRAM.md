# Autonomy User Test Program

This is the staged black-box autonomy test ladder for AgenC's live web UI.

The goal is to exercise AgenC the way an operator or end user actually uses it:

- through the live chat surface
- through the operator RUNS surface
- through the TRACE/observability surface

Do not treat this as a unit-test replacement. This program is for real runtime
behavior, user-path correctness, and operator trust.

## How To Run It

1. Open `http://127.0.0.1:5173/`.
2. Start a fresh chat session.
3. Use one unique run token for the whole ladder.
4. Copy prompts from [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt).
5. After every stage, verify the expected evidence before advancing.

If any stage fails:

- stop the ladder
- inspect `[4] TRACE`
- capture the failure mode
- fix it
- rerun the failed stage and all lower stages
- only then continue upward

This keeps the ladder incremental instead of masking basic regressions under
later complex workflows.

## Required Views

- `[1] CHAT`: prompt execution, final grounded answer, visible tool activity
- `[3] RUNS`: durable run lifecycle, operator controls, run state, verified evidence
- `[4] TRACE`: trace list/detail, tool events, verified updates, final state grounding

## Core Ladder

### Stage 0: Transport Sanity

Purpose:
- confirm websocket transport, session creation, and plain non-tool reply behavior

Prompt:
- in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 0`

Pass:
- a reply arrives in CHAT
- the reply matches the requested token exactly
- no tools are called

Fail examples:
- no response
- extra narration around the token
- spurious tool call

### Stage 1: Single Tool Grounding

Purpose:
- prove the agent can select a tool, execute it, and ground the answer in the result

Prompt:
- in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 1`

Pass:
- CHAT shows a real tool execution
- the tool result contains the token
- the final answer includes the same token
- TRACE shows the tool call and result for the same session

Fail examples:
- assistant claims a result without a tool
- wrong command shape
- tool runs but final answer ignores the result

### Stage 2: Multi-Tool File Workflow

Purpose:
- validate ordered tool chaining and grounded verification

Prompt:
- in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 2`

Pass:
- the file is created and read back
- the final answer includes both the absolute path and verified contents
- TRACE shows the write/read sequence in one trace chain

Fail examples:
- file is claimed without verification read
- final answer fabricates the path or contents
- malformed tool ordering

### Stage 3: Policy Simulation

Purpose:
- verify operator-facing policy preview on the live user path

Action:
- run the slash command in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 3`

Pass:
- CHAT returns a policy preview instead of a generic model answer
- the preview clearly states whether the action would be allowed/denied/approved
- no destructive action is executed

Fail examples:
- slash command falls through to the model
- preview omits policy/approval state
- command actually executes the risky action

### Stage 4: Durable Background Supervision

Purpose:
- validate the runtime-owned supervisor loop, typed handle usage, verified progress,
  and durable run state

Prompt:
- in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 4`

Pass:
- CHAT reports a durable run/session id and a handle id
- RUNS shows an active run for the same session
- the run uses the typed process/runtime path, not raw shell backgrounding
- verified progress updates appear while the run is active
- TRACE shows the corresponding execution and run-state transitions

Fail examples:
- assistant does setup and stops instead of supervising
- raw shell backgrounding is used when a typed handle exists
- no run appears in RUNS
- answer claims evidence that TRACE cannot support

### Stage 5: Operator Controls

Purpose:
- validate the operator control plane from the real UI

Action:
- follow the RUNS actions in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 5`

Pass:
- pause changes the run state to paused
- resume returns it to active
- stop transitions it to a clean terminal state
- the run keeps the same underlying handle across pause/resume instead of duplicating work

Fail examples:
- controls do nothing
- resume creates a duplicate handle
- stop kills only chat state but leaves the underlying workload orphaned

### Stage 6: TRACE Validation

Purpose:
- verify that observability is complete enough for operator debugging

Action:
- follow the TRACE actions in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 6`

Pass:
- TRACE lists a trace for the active session
- the trace detail contains prompt/tool/update/final-state evidence
- tool and run events are correlated to the same session/run

Fail examples:
- trace list is empty for a real run
- trace detail omits tool or update events
- operator cannot reconstruct what happened from the trace

### Stage 7: Restart/Recovery Drill

Purpose:
- validate durable recovery under daemon restart

Action:
- follow the restart drill in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt) under `Stage 7`

Pass:
- the session resumes
- RUNS still shows the durable run after restart
- the run recovers or continues with operator-visible evidence

Fail examples:
- run disappears after restart
- session cannot resume
- recovered state is inconsistent with prior evidence

## Optional Extension Suites

These are not required for the core ladder, but they should be run before
claiming a domain is production-ready.

### Desktop / Browser

Goal:
- validate typed desktop session handling, visible browser launch, and supervised
  background control

Use:
- the `Desktop/browser` extension prompt in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt)

Watch:
- `[8] DESKTOP`
- `[3] RUNS`
- `[4] TRACE`

### Sandbox

Goal:
- validate typed sandbox lifecycle, command execution, output grounding, and cleanup

Use:
- the `Sandbox` extension prompt in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt)

Watch:
- `[1] CHAT`
- `[3] RUNS`
- `[4] TRACE`

### Delegation

Goal:
- validate real delegation, not fake “background shell jobs” misdescribed as agents

Use:
- the `Delegation` extension prompt in [prompt.txt](/home/tetsuo/git/AgenC/prompt.txt)

Watch:
- `[1] CHAT`
- `[4] TRACE`

Pass:
- delegation evidence is explicit
- the final synthesis is grounded in real delegated work

## Promotion Rule

Only promote a stage to “green” when:

- the user-visible behavior is correct
- TRACE supports the claim
- the runtime path taken is the intended one
- no approval, policy, or control-plane behavior is bypassed

## Evidence To Capture On Failure

When a stage fails, capture:

- the exact prompt or slash command
- session id
- run id if present
- trace id
- last visible tool/result event
- the incorrect user-visible output

That is the minimum bundle required for a real fix, replay, and regression test.
