export interface DisputeDriftPromptInput {
  dispute_pda: string;
  trace_id?: string;
}

export interface DisputeDriftPromptOutput {
  [key: string]: unknown;
  messages: Array<{
    role: 'user' | 'assistant';
    content: { type: 'text'; text: string };
  }>;
}

export function buildDisputeDriftPrompt(input: DisputeDriftPromptInput): DisputeDriftPromptOutput {
  const traceRef = input.trace_id ? `\nTrace ID for correlation: ${input.trace_id}` : '';

  return {
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Triage dispute drift for dispute at PDA ${input.dispute_pda}.${traceRef}

## Investigation Steps

### Step 1: Fetch Dispute State
Use \`agenc_get_dispute\` with dispute_pda="${input.dispute_pda}" to get the current dispute state.
- Record: status (Active/Resolved/Expired), votes_for, votes_against, voting_deadline, resolution_type

### Step 2: Check Voting Deadline
- If status is Active and current time > voting_deadline, this is a drift condition.
  -> The dispute should have been expired or resolved.
  -> Suggest: Use \`agenc_replay_incident\` with dispute_pda="${input.dispute_pda}" to check for missed events.

### Step 3: Verify Vote Counts
- Use \`agenc_list_disputes\` to cross-reference total vote count vs expected arbiter count.
- If votes_for + votes_against < expected quorum, arbiter participation is low.
  -> Check each arbiter's agent status with \`agenc_get_agent\`.

### Step 4: Check Resolution Consistency
- If status is Resolved, verify:
  - outcome matches vote majority
  - slash has been applied (if applicable): check agent stake changes
  - task status matches resolution type (Refund -> Cancelled, Complete -> Completed)

### Step 5: Replay Correlation
- Use \`agenc_replay_incident\` with dispute_pda="${input.dispute_pda}" to get the full event timeline.
- Look for:
  - Missing DisputeVoteCast events
  - DisputeResolved without sufficient votes
  - Duplicate vote events (DuplicateArbiter error)

### Step 6: Summarize Findings
Provide:
1. Current dispute state vs expected state
2. Specific drift conditions found
3. Root cause hypothesis
4. Recommended remediation (expire_dispute, resolve_dispute, or escalate)
${input.trace_id ? `\nInclude trace_id "${input.trace_id}" in any follow-up tool calls for correlation.` : ''}`,
      },
    }],
  };
}
