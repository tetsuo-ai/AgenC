export type CliOutputFormat = 'json' | 'jsonl' | 'table';

export interface CliReplayOutput<TPayload = unknown> {
  format: CliOutputFormat;
  payload: TPayload;
}

export interface BaseCliOptions {
  help: boolean;
  outputFormat: CliOutputFormat;
  strictMode: boolean;
  rpcUrl?: string;
  programId?: string;
  storeType: 'memory' | 'sqlite';
  sqlitePath?: string;
  traceId?: string;
  idempotencyWindow: number;
}

export interface ReplayBackfillOptions extends BaseCliOptions {
  toSlot: number;
  pageSize?: number;
}

export interface ReplayCompareOptions extends BaseCliOptions {
  localTracePath?: string;
  taskPda?: string;
  disputePda?: string;
}

export interface ReplayIncidentOptions extends BaseCliOptions {
  taskPda?: string;
  disputePda?: string;
  fromSlot?: number;
  toSlot?: number;
}

export interface CliUsage {
  command: string;
  description: string;
}

export interface ParsedCliArguments {
  command: 'replay' | null;
  replayCommand: 'backfill' | 'compare' | 'incident' | null;
  positional: string[];
  options: Record<string, string | number | boolean>;
  outputFormat: CliOutputFormat;
}
