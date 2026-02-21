import type { CronScheduler } from "../gateway/scheduler.js";
import type { CliRuntimeContext, CliStatusCode } from "./types.js";

export async function runJobsListCommand(
  context: CliRuntimeContext,
  scheduler: CronScheduler,
): Promise<CliStatusCode> {
  const jobs = scheduler.listJobs().map((job) => ({
    name: job.name,
    cron: job.cron,
    enabled: job.enabled,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun,
  }));

  context.output({
    status: "ok",
    command: "jobs.list",
    schema: "jobs.list.output.v1",
    jobs,
  });

  return 0;
}

export async function runJobsRunCommand(
  context: CliRuntimeContext,
  scheduler: CronScheduler,
  jobName: string,
): Promise<CliStatusCode> {
  try {
    await scheduler.triggerJob(jobName);
  } catch (error) {
    context.error({
      status: "error",
      command: "jobs.run",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "jobs.run",
    schema: "jobs.run.output.v1",
    job: jobName,
  });

  return 0;
}

export async function runJobsEnableCommand(
  context: CliRuntimeContext,
  scheduler: CronScheduler,
  jobName: string,
): Promise<CliStatusCode> {
  const found = scheduler.enableJob(jobName);
  if (!found) {
    context.error({
      status: "error",
      command: "jobs.enable",
      message: `job "${jobName}" not found`,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "jobs.enable",
    schema: "jobs.enable.output.v1",
    job: jobName,
  });

  return 0;
}

export async function runJobsDisableCommand(
  context: CliRuntimeContext,
  scheduler: CronScheduler,
  jobName: string,
): Promise<CliStatusCode> {
  const found = scheduler.disableJob(jobName);
  if (!found) {
    context.error({
      status: "error",
      command: "jobs.disable",
      message: `job "${jobName}" not found`,
    });
    return 1;
  }

  context.output({
    status: "ok",
    command: "jobs.disable",
    schema: "jobs.disable.output.v1",
    job: jobName,
  });

  return 0;
}
