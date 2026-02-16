import type { Logger } from '../utils/logger.js';
import { silentLogger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CronSchedule {
  readonly minute: readonly number[];
  readonly hour: readonly number[];
  readonly dayOfMonth: readonly number[];
  readonly month: readonly number[];
  readonly dayOfWeek: readonly number[];
}

export interface CronSchedulerConfig {
  readonly logger?: Logger;
}

export interface HeartbeatActionDef {
  readonly name: string;
  readonly execute: (context: HeartbeatContext) => Promise<void>;
}

export interface HeartbeatContext {
  readonly jobName: string;
  readonly scheduledAt: Date;
  readonly logger: Logger;
}

export interface ScheduledJob {
  readonly name: string;
  readonly cron: string;
  readonly schedule: CronSchedule;
  readonly enabled: boolean;
  readonly lastRun?: number;
  readonly nextRun: number;
  readonly action: HeartbeatActionDef;
}

interface MutableJob {
  name: string;
  cron: string;
  schedule: CronSchedule;
  enabled: boolean;
  lastRun: number | undefined;
  nextRun: number;
  action: HeartbeatActionDef;
}

// ---------------------------------------------------------------------------
// Cron parser
// ---------------------------------------------------------------------------

function parseField(token: string, min: number, max: number): number[] {
  const results = new Set<number>();

  for (const segment of token.split(',')) {
    const trimmed = segment.trim();
    if (trimmed.length === 0) {
      throw new Error(`empty field segment in "${token}"`);
    }

    // Wildcard: * or */step
    if (trimmed === '*') {
      for (let i = min; i <= max; i++) {
        results.add(i);
      }
      continue;
    }

    if (trimmed.startsWith('*/')) {
      const step = parseStepValue(trimmed.slice(2), min, max);
      for (let i = min; i <= max; i += step) {
        results.add(i);
      }
      continue;
    }

    // Range: low-high or low-high/step
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(\/(\d+))?$/);
    if (rangeMatch) {
      const low = parseInt(rangeMatch[1], 10);
      const high = parseInt(rangeMatch[2], 10);
      if (isNaN(low) || isNaN(high)) {
        throw new Error(`invalid range "${trimmed}"`);
      }
      if (low < min || high > max) {
        throw new Error(`range ${low}-${high} out of bounds [${min}-${max}]`);
      }
      if (low > high) {
        throw new Error(`invalid range ${low}-${high}: low > high`);
      }
      const step = rangeMatch[4] !== undefined ? parseStepValue(rangeMatch[4], min, max) : 1;
      for (let i = low; i <= high; i += step) {
        results.add(i);
      }
      continue;
    }

    // Single value
    const value = parseInt(trimmed, 10);
    if (isNaN(value) || !/^\d+$/.test(trimmed)) {
      throw new Error(`invalid cron field value "${trimmed}"`);
    }
    if (value < min || value > max) {
      throw new Error(`value ${value} out of bounds [${min}-${max}]`);
    }
    results.add(value);
  }

  return [...results].sort((a, b) => a - b);
}

function parseStepValue(raw: string, _min: number, max: number): number {
  const step = parseInt(raw, 10);
  if (isNaN(step) || step <= 0 || !/^\d+$/.test(raw)) {
    throw new Error(`invalid step value "${raw}"`);
  }
  if (step > max) {
    throw new Error(`step ${step} exceeds maximum ${max}`);
  }
  return step;
}

export function parseCron(expression: string): CronSchedule {
  const trimmed = expression.trim().replace(/\s+/g, ' ');
  const fields = trimmed.split(' ');

  if (fields.length !== 5) {
    throw new Error(
      `invalid cron expression "${expression}": expected 5 fields, got ${fields.length}`,
    );
  }

  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);

  // Day of week: 0-7 where 0 and 7 are both Sunday
  const rawDow = parseField(fields[4], 0, 7);
  const dowSet = new Set(rawDow);
  if (dowSet.has(7)) {
    dowSet.delete(7);
    dowSet.add(0);
  }
  const dayOfWeek = [...dowSet].sort((a, b) => a - b);

  return { minute, hour, dayOfMonth, month, dayOfWeek };
}

// ---------------------------------------------------------------------------
// Cron matching
// ---------------------------------------------------------------------------

function isWildcard(field: readonly number[], min: number, max: number): boolean {
  return field.length === max - min + 1;
}

export function cronMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.minute.includes(date.getMinutes())) return false;
  if (!schedule.hour.includes(date.getHours())) return false;
  if (!schedule.month.includes(date.getMonth() + 1)) return false;

  // Standard cron: if both dayOfMonth and dayOfWeek are restricted (not *),
  // match if EITHER matches (OR). Otherwise, match the restricted field.
  const domWild = isWildcard(schedule.dayOfMonth, 1, 31);
  const dowWild = isWildcard(schedule.dayOfWeek, 0, 6);

  if (domWild && dowWild) {
    return true;
  }

  if (domWild) {
    return schedule.dayOfWeek.includes(date.getDay());
  }

  if (dowWild) {
    return schedule.dayOfMonth.includes(date.getDate());
  }

  // Both restricted — OR logic
  return (
    schedule.dayOfMonth.includes(date.getDate()) ||
    schedule.dayOfWeek.includes(date.getDay())
  );
}

// ---------------------------------------------------------------------------
// Next match computation
// ---------------------------------------------------------------------------

export function nextCronMatch(schedule: CronSchedule, after?: Date): Date {
  const start = after ? new Date(after.getTime()) : new Date();
  // Round up to the next minute boundary
  start.setSeconds(0, 0);
  start.setTime(start.getTime() + 60_000);

  const candidate = new Date(start.getTime());

  for (let dayOffset = 0; dayOffset < 366; dayOffset++) {
    candidate.setTime(start.getTime() + dayOffset * 86_400_000);
    candidate.setHours(0, 0, 0, 0);

    // Check month
    if (!schedule.month.includes(candidate.getMonth() + 1)) {
      continue;
    }

    // Check day (dayOfMonth/dayOfWeek logic)
    const domWild = isWildcard(schedule.dayOfMonth, 1, 31);
    const dowWild = isWildcard(schedule.dayOfWeek, 0, 6);
    let dayMatch: boolean;

    if (domWild && dowWild) {
      dayMatch = true;
    } else if (domWild) {
      dayMatch = schedule.dayOfWeek.includes(candidate.getDay());
    } else if (dowWild) {
      dayMatch = schedule.dayOfMonth.includes(candidate.getDate());
    } else {
      dayMatch =
        schedule.dayOfMonth.includes(candidate.getDate()) ||
        schedule.dayOfWeek.includes(candidate.getDay());
    }

    if (!dayMatch) {
      continue;
    }

    for (const hour of schedule.hour) {
      for (const minute of schedule.minute) {
        candidate.setHours(hour, minute, 0, 0);

        // Skip times that are before or equal to `start`
        if (candidate.getTime() < start.getTime()) {
          continue;
        }

        // Verify month hasn't rolled (e.g. day 31 in a 30-day month)
        if (candidate.getMonth() + 1 !== schedule.month.find(m => m === candidate.getMonth() + 1)) {
          continue;
        }

        if (cronMatches(schedule, candidate)) {
          return new Date(candidate.getTime());
        }
      }
    }
  }

  throw new Error('no matching cron time found within 366 days');
}

// ---------------------------------------------------------------------------
// CronScheduler class
// ---------------------------------------------------------------------------

export class CronScheduler {
  private readonly jobs: Map<string, MutableJob> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly running: Set<string> = new Set();
  private readonly logger: Logger;

  constructor(config?: CronSchedulerConfig) {
    this.logger = config?.logger ?? silentLogger;
  }

  addJob(name: string, cron: string, action: HeartbeatActionDef): void {
    if (this.jobs.has(name)) {
      throw new Error(`job "${name}" already exists`);
    }

    const schedule = parseCron(cron);
    const nextRun = nextCronMatch(schedule).getTime();

    this.jobs.set(name, {
      name,
      cron,
      schedule,
      enabled: true,
      lastRun: undefined,
      nextRun,
      action,
    });

    this.logger.debug(`added job "${name}" with cron "${cron}", next run at ${new Date(nextRun).toISOString()}`);
  }

  removeJob(name: string): boolean {
    const removed = this.jobs.delete(name);
    if (removed) {
      this.running.delete(name);
      this.logger.debug(`removed job "${name}"`);
    }
    return removed;
  }

  enableJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job) return false;

    job.enabled = true;
    job.nextRun = nextCronMatch(job.schedule).getTime();
    this.logger.debug(`enabled job "${name}"`);
    return true;
  }

  disableJob(name: string): boolean {
    const job = this.jobs.get(name);
    if (!job) return false;

    job.enabled = false;
    this.logger.debug(`disabled job "${name}"`);
    return true;
  }

  start(): void {
    if (this.timer !== null) return;

    this.timer = setInterval(() => {
      this.tick();
    }, 60_000);

    this.logger.info('cron scheduler started');
  }

  stop(): void {
    if (this.timer === null) return;

    clearInterval(this.timer);
    this.timer = null;
    this.logger.info('cron scheduler stopped');
  }

  async triggerJob(name: string): Promise<void> {
    const job = this.jobs.get(name);
    if (!job) {
      throw new Error(`job "${name}" not found`);
    }

    const context: HeartbeatContext = {
      jobName: name,
      scheduledAt: new Date(),
      logger: this.logger,
    };

    await job.action.execute(context);
    job.lastRun = Date.now();
  }

  listJobs(): readonly ScheduledJob[] {
    const result: ScheduledJob[] = [];
    for (const job of this.jobs.values()) {
      result.push({
        name: job.name,
        cron: job.cron,
        schedule: job.schedule,
        enabled: job.enabled,
        lastRun: job.lastRun,
        nextRun: job.nextRun,
        action: job.action,
      });
    }
    return result;
  }

  getDueJobs(now?: Date): readonly ScheduledJob[] {
    const date = now ?? new Date();
    const result: ScheduledJob[] = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled) continue;
      if (cronMatches(job.schedule, date)) {
        result.push({
          name: job.name,
          cron: job.cron,
          schedule: job.schedule,
          enabled: job.enabled,
          lastRun: job.lastRun,
          nextRun: job.nextRun,
          action: job.action,
        });
      }
    }

    return result;
  }

  private tick(): void {
    const now = new Date();
    const due = this.getDueJobs(now);

    for (const job of due) {
      if (this.running.has(job.name)) {
        this.logger.warn(`job "${job.name}" still running, skipping`);
        continue;
      }

      this.running.add(job.name);

      const context: HeartbeatContext = {
        jobName: job.name,
        scheduledAt: now,
        logger: this.logger,
      };

      const mutableJob = this.jobs.get(job.name);

      job.action
        .execute(context)
        .then(() => {
          if (mutableJob) {
            mutableJob.lastRun = Date.now();
            mutableJob.nextRun = nextCronMatch(mutableJob.schedule).getTime();
          }
        })
        .catch((error: unknown) => {
          this.logger.error(`job "${job.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => {
          this.running.delete(job.name);
        });
    }
  }
}
