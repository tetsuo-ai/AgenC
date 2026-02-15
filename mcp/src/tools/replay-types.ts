import { z } from 'zod';
import { computeSchemaHash } from '../utils/schema-hash.js';

/**
 * Alert schema version referenced by replay tools.
 * Must match REPLAY_ALERT_SCHEMA_VERSION in @agenc/runtime.
 */
export const REPLAY_ALERT_SCHEMA_VERSION = 'replay.alert.v1';

export const REPLAY_BACKFILL_OUTPUT_SCHEMA = 'replay.backfill.output.v1';
export const REPLAY_COMPARE_OUTPUT_SCHEMA = 'replay.compare.output.v1';
export const REPLAY_INCIDENT_OUTPUT_SCHEMA = 'replay.incident.output.v1';
export const REPLAY_STATUS_OUTPUT_SCHEMA = 'replay.status.output.v1';

const baseSchema = z.object({
  store_type: z.enum(['memory', 'sqlite']).default('memory'),
  sqlite_path: z.string().optional(),
  trace_id: z.string().optional(),
  strict_mode: z.boolean().default(false),
  max_payload_bytes: z.number().int().positive().default(120_000),
  redact_fields: z.array(z.string()).default([]),
  sections: z.array(z.string()).optional(),
});

export const ReplayBackfillInputSchema = baseSchema.extend({
  rpc: z.string().min(1).describe('RPC endpoint URL'),
  to_slot: z.number().int().positive().describe('Highest slot to scan'),
  page_size: z.number().int().positive().max(1_000).default(100),
  command: z.string().optional(),
  program_id: z.string().optional(),
});
export type ReplayBackfillInput = z.infer<typeof ReplayBackfillInputSchema>;

export const ReplayCompareInputSchema = baseSchema.extend({
  local_trace_path: z.string().min(1).describe('Path to local trajectory trace JSON'),
  task_pda: z.string().optional(),
  dispute_pda: z.string().optional(),
  from_slot: z.number().int().nonnegative().optional(),
  to_slot: z.number().int().positive().optional(),
  command: z.string().optional(),
});
export type ReplayCompareInput = z.infer<typeof ReplayCompareInputSchema>;

export const ReplayIncidentInputSchema = baseSchema.extend({
  task_pda: z.string().optional(),
  dispute_pda: z.string().optional(),
  query: z.string().optional().describe('Analyst query DSL key=value filters'),
  from_slot: z.number().int().nonnegative().optional(),
  to_slot: z.number().int().positive().optional(),
  command: z.string().optional(),
});
export type ReplayIncidentInput = z.infer<typeof ReplayIncidentInputSchema>;

export const ReplayStatusInputSchema = baseSchema.extend({
  task_pda: z.string().optional(),
  dispute_pda: z.string().optional(),
  command: z.string().optional(),
});
export type ReplayStatusInput = z.infer<typeof ReplayStatusInputSchema>;

export const ReplayBackfillResultSchema = z.object({
  processed: z.number().nonnegative(),
  duplicates: z.number().nonnegative(),
  cursor: z.object({
    slot: z.number(),
    signature: z.string(),
    event_name: z.string().optional(),
    trace_id: z.string().optional(),
    trace_span_id: z.string().optional(),
  }).nullable(),
});

export const ReplayCompareAnomalySchema = z.object({
  anomaly_id: z.string(),
  code: z.string(),
  severity: z.string(),
  message: z.string(),
  source_event_name: z.string().optional(),
  signature: z.string().optional(),
  seq: z.number().int().optional(),
});

export const ReplayCompareResultSchema = z.object({
  status: z.enum(['clean', 'mismatched']),
  strictness: z.enum(['strict', 'lenient']),
  local_event_count: z.number().nonnegative(),
  projected_event_count: z.number().nonnegative(),
  mismatch_count: z.number().nonnegative(),
  match_rate: z.number().nonnegative(),
  anomaly_ids: z.array(z.string()),
  top_anomalies: z.array(ReplayCompareAnomalySchema),
  hashes: z.object({
    local: z.string(),
    projected: z.string(),
  }),
  local_summary: z.record(z.unknown()),
  projected_summary: z.record(z.unknown()),
});

export const ReplayIncidentValidationSchema = z.object({
  strict_mode: z.boolean(),
  event_validation: z.object({
    errors: z.array(z.string()),
    warnings: z.array(z.string()),
    replay_task_count: z.number().nonnegative(),
  }),
  anomaly_ids: z.array(z.string()),
  deterministic_hash: z.string().optional(),
});

export const ReplayIncidentSummarySchema = z.object({
  total_events: z.number().nonnegative(),
  task_pda_filters: z.array(z.string().nullable()),
  dispute_pda_filters: z.array(z.string().nullable()),
  from_slot: z.number().int().nonnegative().optional(),
  to_slot: z.number().int().positive().optional(),
  unique_task_ids: z.array(z.string()),
  unique_dispute_ids: z.array(z.string()),
  source_event_type_counts: z.record(z.number().nonnegative()),
  source_event_name_counts: z.record(z.number().nonnegative()),
  trace_id_counts: z.record(z.number().nonnegative()),
  events: z.array(z.record(z.unknown())),
});

export const ReplayIncidentNarrativeSchema = z.object({
  lines: z.array(z.string()),
  anomaly_ids: z.array(z.string()),
  deterministic_hash: z.string().optional(),
});

export const ReplayBackfillOutputSchema = z.object({
  status: z.literal('ok'),
  command: z.literal('agenc_replay_backfill'),
  schema: z.literal(REPLAY_BACKFILL_OUTPUT_SCHEMA),
  schema_hash: z.string().optional(),
  mode: z.literal('backfill'),
  to_slot: z.number().int().positive(),
  store_type: z.enum(['memory', 'sqlite']),
  page_size: z.number().int().positive().optional(),
  result: ReplayBackfillResultSchema,
  sections: z.array(z.string()),
  redactions: z.array(z.string()),
  command_params: z.record(z.unknown()),
  truncated: z.boolean(),
  truncation_reason: z.string().nullable().optional(),
});

export const ReplayCompareOutputSchema = z.object({
  status: z.literal('ok'),
  command: z.literal('agenc_replay_compare'),
  schema: z.literal(REPLAY_COMPARE_OUTPUT_SCHEMA),
  schema_hash: z.string().optional(),
  strictness: z.enum(['strict', 'lenient']),
  local_trace_path: z.string(),
  result: ReplayCompareResultSchema,
  task_pda: z.string().nullable().optional(),
  dispute_pda: z.string().nullable().optional(),
  sections: z.array(z.string()),
  redactions: z.array(z.string()),
  command_params: z.record(z.unknown()),
  truncated: z.boolean(),
  truncation_reason: z.string().nullable().optional(),
});

export const ReplayIncidentOutputSchema = z.object({
  status: z.literal('ok'),
  command: z.literal('agenc_replay_incident'),
  schema: z.literal(REPLAY_INCIDENT_OUTPUT_SCHEMA),
  schema_hash: z.string().optional(),
  command_params: z.record(z.unknown()),
  sections: z.array(z.string()),
  redactions: z.array(z.string()),
  summary: ReplayIncidentSummarySchema.nullable(),
  validation: ReplayIncidentValidationSchema.nullable(),
  narrative: ReplayIncidentNarrativeSchema.nullable(),
  truncated: z.boolean(),
  truncation_reason: z.string().nullable().optional(),
});

export const ReplayStatusOutputSchema = z.object({
  status: z.literal('ok'),
  command: z.literal('agenc_replay_status'),
  schema: z.literal(REPLAY_STATUS_OUTPUT_SCHEMA),
  schema_hash: z.string().optional(),
  store_type: z.enum(['memory', 'sqlite']),
  event_count: z.number().nonnegative(),
  unique_task_count: z.number().nonnegative(),
  unique_dispute_count: z.number().nonnegative(),
  active_cursor: z.record(z.unknown()).nullable(),
  sections: z.array(z.string()),
  redactions: z.array(z.string()),
});

export const ReplayToolErrorSchema = z.object({
  status: z.literal('error'),
  command: z.string(),
  schema: z.string(),
  schema_hash: z.string().optional(),
  code: z.string(),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  retriable: z.boolean(),
});

export const REPLAY_SCHEMA_HASHES = {
  [REPLAY_BACKFILL_OUTPUT_SCHEMA]: computeSchemaHash(ReplayBackfillOutputSchema),
  [REPLAY_COMPARE_OUTPUT_SCHEMA]: computeSchemaHash(ReplayCompareOutputSchema),
  [REPLAY_INCIDENT_OUTPUT_SCHEMA]: computeSchemaHash(ReplayIncidentOutputSchema),
  [REPLAY_STATUS_OUTPUT_SCHEMA]: computeSchemaHash(ReplayStatusOutputSchema),
} as const;

export const REPLAY_TOOL_ERROR_SCHEMA_HASH = computeSchemaHash(ReplayToolErrorSchema);
