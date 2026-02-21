import { describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../gateway/scheduler.js";
import type { HeartbeatActionDef } from "../gateway/scheduler.js";
import { createContextCapture } from "./test-utils.js";
import {
  runJobsListCommand,
  runJobsRunCommand,
  runJobsEnableCommand,
  runJobsDisableCommand,
} from "./jobs.js";

const silentLogger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
};

function makeAction(fn?: () => Promise<void>): HeartbeatActionDef {
  return {
    name: "test-action",
    execute: fn ?? (async () => {}),
  };
}

describe("jobs CLI commands", () => {
  function createScheduler(): CronScheduler {
    const scheduler = new CronScheduler({ logger: silentLogger });
    scheduler.addJob("job-a", "*/30 * * * *", makeAction());
    scheduler.addJob("job-b", "0 8 * * 1-5", makeAction());
    return scheduler;
  }

  describe("runJobsListCommand", () => {
    it("returns all jobs", async () => {
      const { context, outputs } = createContextCapture();
      const scheduler = createScheduler();

      const code = await runJobsListCommand(context, scheduler);
      expect(code).toBe(0);
      expect(outputs).toHaveLength(1);

      const output = outputs[0] as Record<string, unknown>;
      expect(output.status).toBe("ok");
      expect(output.command).toBe("jobs.list");
      expect(output.schema).toBe("jobs.list.output.v1");

      const jobs = output.jobs as Array<Record<string, unknown>>;
      expect(jobs).toHaveLength(2);
      expect(jobs[0].name).toBe("job-a");
      expect(jobs[1].name).toBe("job-b");
    });

    it("returns empty list when no jobs", async () => {
      const { context, outputs } = createContextCapture();
      const scheduler = new CronScheduler({ logger: silentLogger });

      const code = await runJobsListCommand(context, scheduler);
      expect(code).toBe(0);

      const output = outputs[0] as Record<string, unknown>;
      expect((output.jobs as unknown[]).length).toBe(0);
    });
  });

  describe("runJobsRunCommand", () => {
    it("runs a job successfully", async () => {
      const { context, outputs } = createContextCapture();
      let executed = false;
      const scheduler = new CronScheduler({ logger: silentLogger });
      scheduler.addJob(
        "run-me",
        "* * * * *",
        makeAction(async () => {
          executed = true;
        }),
      );

      const code = await runJobsRunCommand(context, scheduler, "run-me");
      expect(code).toBe(0);
      expect(executed).toBe(true);

      const output = outputs[0] as Record<string, unknown>;
      expect(output.status).toBe("ok");
      expect(output.command).toBe("jobs.run");
      expect(output.job).toBe("run-me");
    });

    it("returns error for non-existent job", async () => {
      const { context, errors } = createContextCapture();
      const scheduler = new CronScheduler({ logger: silentLogger });

      const code = await runJobsRunCommand(context, scheduler, "missing");
      expect(code).toBe(1);
      expect(errors).toHaveLength(1);

      const err = errors[0] as Record<string, unknown>;
      expect(err.status).toBe("error");
    });
  });

  describe("runJobsEnableCommand", () => {
    it("enables a disabled job", async () => {
      const { context, outputs } = createContextCapture();
      const scheduler = createScheduler();
      scheduler.disableJob("job-a");

      const code = await runJobsEnableCommand(context, scheduler, "job-a");
      expect(code).toBe(0);

      const output = outputs[0] as Record<string, unknown>;
      expect(output.status).toBe("ok");
      expect(output.command).toBe("jobs.enable");
      expect(output.job).toBe("job-a");

      const jobs = scheduler.listJobs();
      const jobA = jobs.find((j) => j.name === "job-a");
      expect(jobA?.enabled).toBe(true);
    });

    it("returns error for non-existent job", async () => {
      const { context, errors } = createContextCapture();
      const scheduler = new CronScheduler({ logger: silentLogger });

      const code = await runJobsEnableCommand(context, scheduler, "nope");
      expect(code).toBe(1);
      expect(errors).toHaveLength(1);
    });
  });

  describe("runJobsDisableCommand", () => {
    it("disables an enabled job", async () => {
      const { context, outputs } = createContextCapture();
      const scheduler = createScheduler();

      const code = await runJobsDisableCommand(context, scheduler, "job-a");
      expect(code).toBe(0);

      const output = outputs[0] as Record<string, unknown>;
      expect(output.status).toBe("ok");
      expect(output.command).toBe("jobs.disable");
      expect(output.job).toBe("job-a");

      const jobs = scheduler.listJobs();
      const jobA = jobs.find((j) => j.name === "job-a");
      expect(jobA?.enabled).toBe(false);
    });

    it("returns error for non-existent job", async () => {
      const { context, errors } = createContextCapture();
      const scheduler = new CronScheduler({ logger: silentLogger });

      const code = await runJobsDisableCommand(context, scheduler, "nope");
      expect(code).toBe(1);
      expect(errors).toHaveLength(1);
    });
  });
});
