import { describe, expect, it, vi } from "vitest";
import { KeyedAsyncQueue } from "./keyed-async-queue.js";

describe("KeyedAsyncQueue", () => {
  it("serializes operations for the same key", async () => {
    const queue = new KeyedAsyncQueue();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("alpha", async () => {
      order.push("first:start");
      await firstStarted;
      order.push("first:end");
      return 1;
    });
    const second = queue.run("alpha", async () => {
      order.push("second:start");
      order.push("second:end");
      return 2;
    });

    await vi.waitFor(() => {
      expect(order).toEqual(["first:start"]);
    });
    releaseFirst?.();

    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("allows operations on different keys to proceed independently", async () => {
    const queue = new KeyedAsyncQueue();
    const order: string[] = [];

    await Promise.all([
      queue.run("alpha", async () => {
        order.push("alpha");
      }),
      queue.run("beta", async () => {
        order.push("beta");
      }),
    ]);

    expect(order.sort()).toEqual(["alpha", "beta"]);
  });
});
