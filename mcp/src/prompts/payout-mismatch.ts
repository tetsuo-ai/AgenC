import type { DisputeDriftPromptOutput } from "./dispute-drift.js";

export interface PayoutMismatchPromptInput {
  task_pda: string;
  expected_payout_lamports?: string;
  trace_id?: string;
}

export function buildPayoutMismatchPrompt(
  input: PayoutMismatchPromptInput,
): DisputeDriftPromptOutput {
  const expectedRef = input.expected_payout_lamports
    ? `\nExpected payout: ${input.expected_payout_lamports} lamports`
    : "";
  const traceRef = input.trace_id
    ? `\nTrace ID for correlation: ${input.trace_id}`
    : "";

  return {
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Investigate payout mismatch for task at PDA ${input.task_pda}.${expectedRef}${traceRef}

## Investigation Steps

### Step 1: Fetch Task State
Use \`agenc_get_task\` with task_pda="${input.task_pda}" to get:
- reward_amount, reward_mint (SOL vs SPL token), status, completions, protocol_fee_bps
- creator, current_workers, task_type

### Step 2: Check Escrow Balance
Use \`agenc_get_escrow\` with task_pda="${input.task_pda}" to get the actual escrow balance.
- For SOL tasks: compare escrow lamport balance vs reward_amount
- For SPL token tasks: compare token account balance vs reward_amount

### Step 3: Verify Protocol Fee
Use \`agenc_get_protocol_config\` to get:
- protocol_fee_bps (current)
- Compare with task's locked protocol_fee_bps (locked at creation time)
- Calculate expected fee: reward_amount * protocol_fee_bps / 10000
- Check fee tier discount based on creator's completed task count

### Step 4: Calculate Expected Payout
- worker_payout = reward_amount - protocol_fee
- For collaborative tasks: worker_payout / max_workers per worker
- For competitive tasks: full worker_payout to first completer

### Step 5: Check Actual Distribution
Use \`agenc_replay_incident\` with task_pda="${input.task_pda}" to find:
- RewardDistributed events: verify recipient, amount, protocol_fee fields
- TaskCompleted events: verify reward_paid field
- Look for multiple RewardDistributed for same task (double-pay bug)

### Step 6: Token-Specific Checks (if SPL token task)
- Verify token escrow ATA was closed after final completion
- Verify worker token account received the correct amount
- Verify treasury token account received the fee

### Step 7: Summarize Findings
Provide:
1. Expected vs actual payout breakdown (reward, fee, net worker amount)
2. Whether discrepancy is in fee calculation, distribution, or escrow balance
3. Root cause hypothesis
4. If overpaid/underpaid: exact lamport/token difference
${input.trace_id ? `\nInclude trace_id "${input.trace_id}" in any follow-up tool calls.` : ""}`,
        },
      },
    ],
  };
}
