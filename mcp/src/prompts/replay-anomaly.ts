import type { DisputeDriftPromptOutput } from "./dispute-drift.js";

export interface ReplayAnomalyPromptInput {
  anomaly_id: string;
  task_pda?: string;
  dispute_pda?: string;
  anomaly_code?: string;
  anomaly_message?: string;
  trace_id?: string;
}

export function buildReplayAnomalyPrompt(
  input: ReplayAnomalyPromptInput,
): DisputeDriftPromptOutput {
  const contextLines: string[] = [];
  if (input.task_pda) contextLines.push(`Task PDA: ${input.task_pda}`);
  if (input.dispute_pda) contextLines.push(`Dispute PDA: ${input.dispute_pda}`);
  if (input.anomaly_code)
    contextLines.push(`Anomaly code: ${input.anomaly_code}`);
  if (input.anomaly_message)
    contextLines.push(`Anomaly message: ${input.anomaly_message}`);
  if (input.trace_id) contextLines.push(`Trace ID: ${input.trace_id}`);
  const context = contextLines.length > 0 ? `\n${contextLines.join("\n")}` : "";

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Investigate replay anomaly ${input.anomaly_id}.${context}

## Investigation Steps

### Step 1: Identify Anomaly Context
The anomaly ID "${input.anomaly_id}" was reported by the replay comparison or incident tool.
${input.anomaly_code ? `Anomaly type: ${input.anomaly_code}` : "Determine the anomaly type from the original tool output."}

### Step 2: Fetch Related State
${
  input.task_pda
    ? `- Use \`agenc_get_task\` with task_pda="${input.task_pda}" to get current task state.`
    : "- If a task PDA is available, fetch it with `agenc_get_task`."
}
${
  input.dispute_pda
    ? `- Use \`agenc_get_dispute\` with dispute_pda="${input.dispute_pda}" to get dispute state.`
    : "- If a dispute PDA is available, fetch it with `agenc_get_dispute`."
}

### Step 3: Replay Timeline Reconstruction
${input.task_pda ? `Use \`agenc_replay_incident\` with task_pda="${input.task_pda}" to get the full event timeline.` : ""}
${input.dispute_pda ? `Use \`agenc_replay_incident\` with dispute_pda="${input.dispute_pda}" to get the dispute timeline.` : ""}
${!input.task_pda && !input.dispute_pda ? "Use `agenc_replay_status` to check store health, then query with relevant filters." : ""}

Look for:
- Events before and after the anomaly sequence number
- Missing events that should be present based on state transitions
- Events with unexpected field values compared to on-chain state

### Step 4: Cross-Reference On-Chain State
For each event in the anomaly window:
- Verify the on-chain account state matches what the event claims
- Check if a transaction was reverted or replaced
- Look for race conditions (multiple transactions in same slot)

### Step 5: Classify Root Cause
Determine which category the anomaly falls into:
1. **Missing event**: An expected state transition event is absent
   -> Check if the transaction was dropped or if the event parser missed it
2. **Field mismatch**: Event data doesn't match on-chain state
   -> Check if there was a concurrent modification
3. **Ordering violation**: Events appear out of expected sequence
   -> Check for slot-level reordering or clock drift
4. **Duplicate event**: Same event appears multiple times
   -> Check for transaction replay or parser bug
5. **Phantom event**: Event exists in replay but not on-chain
   -> Check if account was closed/reallocated

### Step 6: Summarize Findings
Provide:
1. Anomaly classification (from Step 5)
2. Specific evidence from on-chain state and replay timeline
3. Whether this is a replay infrastructure issue or a protocol issue
4. Recommended action (re-backfill, manual correction, bug report)
${input.trace_id ? `\nInclude trace_id "${input.trace_id}" in any follow-up tool calls for correlation.` : ""}`,
        },
      },
    ],
  };
}
