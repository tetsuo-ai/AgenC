import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDisputeDriftPrompt } from './dispute-drift.js';
import { buildPayoutMismatchPrompt } from './payout-mismatch.js';
import { buildReplayAnomalyPrompt } from './replay-anomaly.js';
import { registerPrompts } from './register.js';

test('dispute-drift-triage: produces valid prompt with dispute_pda only', () => {
  const result = buildDisputeDriftPrompt({
    dispute_pda: '7VHUFJHWu2CuExkJcJrzhQPJ2oygupbLbCPTtfzTYMdW',
  });
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].role, 'user');
  assert.ok(result.messages[0].content.text.includes('7VHUFJHWu2CuExkJcJrzhQPJ2oygupbLbCPTtfzTYMdW'));
  assert.ok(result.messages[0].content.text.includes('agenc_get_dispute'));
  assert.ok(result.messages[0].content.text.includes('agenc_replay_incident'));
});

test('dispute-drift-triage: includes trace_id when provided', () => {
  const result = buildDisputeDriftPrompt({
    dispute_pda: '7VHUFJHWu2CuExkJcJrzhQPJ2oygupbLbCPTtfzTYMdW',
    trace_id: 'trace-abc-123',
  });
  assert.ok(result.messages[0].content.text.includes('trace-abc-123'));
});

test('dispute-drift-triage: references all expected tool names', () => {
  const result = buildDisputeDriftPrompt({
    dispute_pda: '7VHUFJHWu2CuExkJcJrzhQPJ2oygupbLbCPTtfzTYMdW',
  });
  const text = result.messages[0].content.text;
  assert.ok(text.includes('agenc_get_dispute'));
  assert.ok(text.includes('agenc_list_disputes'));
  assert.ok(text.includes('agenc_get_agent'));
  assert.ok(text.includes('agenc_replay_incident'));
});

test('payout-mismatch: produces valid prompt with task_pda only', () => {
  const result = buildPayoutMismatchPrompt({
    task_pda: '4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N',
  });
  assert.equal(result.messages.length, 1);
  assert.ok(result.messages[0].content.text.includes('4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N'));
  assert.ok(result.messages[0].content.text.includes('agenc_get_task'));
  assert.ok(result.messages[0].content.text.includes('agenc_get_escrow'));
  assert.ok(result.messages[0].content.text.includes('agenc_get_protocol_config'));
});

test('payout-mismatch: includes expected payout when provided', () => {
  const result = buildPayoutMismatchPrompt({
    task_pda: '4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N',
    expected_payout_lamports: '1000000000',
  });
  assert.ok(result.messages[0].content.text.includes('1000000000'));
});

test('payout-mismatch: references token-specific checks', () => {
  const result = buildPayoutMismatchPrompt({
    task_pda: '4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N',
  });
  const text = result.messages[0].content.text;
  assert.ok(text.includes('SPL token'));
  assert.ok(text.includes('token escrow ATA'));
});

test('replay-anomaly-root-cause: produces valid prompt with anomaly_id only', () => {
  const result = buildReplayAnomalyPrompt({
    anomaly_id: 'a1b2c3d4e5f6g7h8',
  });
  assert.equal(result.messages.length, 1);
  assert.ok(result.messages[0].content.text.includes('a1b2c3d4e5f6g7h8'));
});

test('replay-anomaly-root-cause: includes all optional context when provided', () => {
  const result = buildReplayAnomalyPrompt({
    anomaly_id: 'a1b2c3d4e5f6g7h8',
    task_pda: '4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N',
    dispute_pda: '7VHUFJHWu2CuExkJcJrzhQPJ2oygupbLbCPTtfzTYMdW',
    anomaly_code: 'replay.missing_event',
    anomaly_message: 'Expected TaskCompleted event not found',
    trace_id: 'trace-xyz-789',
  });
  const text = result.messages[0].content.text;
  assert.ok(text.includes('4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N'));
  assert.ok(text.includes('7VHUFJHWu2CuExkJcJrzhQPJ2oygupbLbCPTtfzTYMdW'));
  assert.ok(text.includes('replay.missing_event'));
  assert.ok(text.includes('Expected TaskCompleted event not found'));
  assert.ok(text.includes('trace-xyz-789'));
});

test('replay-anomaly-root-cause: classifies five anomaly categories', () => {
  const result = buildReplayAnomalyPrompt({ anomaly_id: 'test' });
  const text = result.messages[0].content.text;
  assert.ok(text.includes('Missing event'));
  assert.ok(text.includes('Field mismatch'));
  assert.ok(text.includes('Ordering violation'));
  assert.ok(text.includes('Duplicate event'));
  assert.ok(text.includes('Phantom event'));
});

test('replay-anomaly-root-cause: suggests replay tools for investigation', () => {
  const result = buildReplayAnomalyPrompt({
    anomaly_id: 'test',
    task_pda: '4xKnMZrFqGZPMACbhfcUhbQk3TL8RE2TcDN8QLKM7u3N',
  });
  const text = result.messages[0].content.text;
  assert.ok(text.includes('agenc_replay_incident'));
  assert.ok(text.includes('agenc_get_task'));
});

test('server registration: all prompts', () => {
  const prompts: string[] = [];
  const server = {
    prompt(name: string) {
      prompts.push(name);
    },
  } as any;

  registerPrompts(server);
  assert.equal(prompts.length, 6);
  assert.ok(prompts.includes('debug-task'));
  assert.ok(prompts.includes('inspect-agent'));
  assert.ok(prompts.includes('escrow-audit'));
  assert.ok(prompts.includes('dispute-drift-triage'));
  assert.ok(prompts.includes('payout-mismatch'));
  assert.ok(prompts.includes('replay-anomaly-root-cause'));
});

