import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  subscribeToTaskCreated,
  subscribeToTaskClaimed,
  subscribeToTaskCompleted,
  subscribeToTaskCancelled,
  subscribeToAllTaskEvents,
  subscribeToDependentTaskCreated,
} from "./task";
import {
  createId,
  createMockProgram,
  mockBN,
  TEST_PUBKEY,
} from "./test-utils/mock-program.js";

function createRawTaskCreated(taskId?: Uint8Array) {
  return {
    taskId: Array.from(taskId ?? createId(1)),
    creator: TEST_PUBKEY,
    requiredCapabilities: mockBN(3n),
    rewardAmount: mockBN(1_000_000_000n),
    taskType: 0,
    deadline: mockBN(9999999),
    minReputation: 10,
    rewardMint: null,
    timestamp: mockBN(1234567890),
  };
}

function createRawTaskClaimed(taskId?: Uint8Array) {
  return {
    taskId: Array.from(taskId ?? createId(1)),
    worker: TEST_PUBKEY,
    currentWorkers: 1,
    maxWorkers: 3,
    timestamp: mockBN(1234567890),
  };
}

function createRawTaskCompleted(taskId?: Uint8Array) {
  return {
    taskId: Array.from(taskId ?? createId(1)),
    worker: TEST_PUBKEY,
    proofHash: Array.from(createId(99)),
    resultData: Array.from({ length: 64 }, (_, index) => index),
    rewardPaid: mockBN(500_000_000n),
    timestamp: mockBN(1234567890),
  };
}

function createRawTaskCancelled(taskId?: Uint8Array) {
  return {
    taskId: Array.from(taskId ?? createId(1)),
    creator: TEST_PUBKEY,
    refundAmount: mockBN(1_000_000_000n),
    timestamp: mockBN(1234567890),
  };
}

function createRawDependentTaskCreated(taskId?: Uint8Array) {
  return {
    taskId: Array.from(taskId ?? createId(1)),
    creator: TEST_PUBKEY,
    dependsOn: TEST_PUBKEY,
    dependencyType: 2,
    rewardMint: null,
    timestamp: mockBN(1234567890),
  };
}

describe("Task Event Subscriptions", () => {
  let mockProgram: ReturnType<typeof createMockProgram>;

  beforeEach(() => {
    mockProgram = createMockProgram();
  });

  describe("subscribeToTaskCreated", () => {
    it("registers with correct camelCase event name", () => {
      const callback = vi.fn();
      subscribeToTaskCreated(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "taskCreated",
        expect.any(Function),
      );
    });

    it("parses raw events and forwards to callback", () => {
      const callback = vi.fn();
      subscribeToTaskCreated(mockProgram, callback);

      mockProgram._emit("taskCreated", createRawTaskCreated(), 100, "sig1");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.creator).toBe(TEST_PUBKEY);
      expect(event.requiredCapabilities).toBe(3n);
      expect(event.rewardAmount).toBe(1_000_000_000n);
      expect(event.taskType).toBe(0);
      expect(event.deadline).toBe(9999999);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(100);
      expect(sig).toBe("sig1");
    });

    it("filters by taskId when provided", () => {
      const callback = vi.fn();
      const filterTaskId = createId(42);
      subscribeToTaskCreated(mockProgram, callback, { taskId: filterTaskId });

      // Matching event
      mockProgram._emit(
        "taskCreated",
        createRawTaskCreated(filterTaskId),
        1,
        "sig1",
      );
      // Non-matching event
      mockProgram._emit(
        "taskCreated",
        createRawTaskCreated(createId(99)),
        2,
        "sig2",
      );

      expect(callback).toHaveBeenCalledTimes(1);
    });

    it("passes all events when no filter", () => {
      const callback = vi.fn();
      subscribeToTaskCreated(mockProgram, callback);

      mockProgram._emit(
        "taskCreated",
        createRawTaskCreated(createId(1)),
        1,
        "sig1",
      );
      mockProgram._emit(
        "taskCreated",
        createRawTaskCreated(createId(2)),
        2,
        "sig2",
      );

      expect(callback).toHaveBeenCalledTimes(2);
    });

    it("unsubscribe removes listener", async () => {
      const callback = vi.fn();
      const subscription = subscribeToTaskCreated(mockProgram, callback);

      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledWith(1);
    });
  });

  describe("subscribeToTaskClaimed", () => {
    it("registers with correct camelCase event name", () => {
      const callback = vi.fn();
      subscribeToTaskClaimed(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "taskClaimed",
        expect.any(Function),
      );
    });

    it("parses raw events and forwards to callback", () => {
      const callback = vi.fn();
      subscribeToTaskClaimed(mockProgram, callback);

      mockProgram._emit("taskClaimed", createRawTaskClaimed(), 200, "sig2");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.worker).toBe(TEST_PUBKEY);
      expect(event.currentWorkers).toBe(1);
      expect(event.maxWorkers).toBe(3);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(200);
      expect(sig).toBe("sig2");
    });

    it("filters by taskId when provided", () => {
      const callback = vi.fn();
      const filterTaskId = createId(42);
      subscribeToTaskClaimed(mockProgram, callback, { taskId: filterTaskId });

      mockProgram._emit(
        "taskClaimed",
        createRawTaskClaimed(filterTaskId),
        1,
        "sig1",
      );
      mockProgram._emit(
        "taskClaimed",
        createRawTaskClaimed(createId(99)),
        2,
        "sig2",
      );

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("subscribeToTaskCompleted", () => {
    it("registers with correct camelCase event name", () => {
      const callback = vi.fn();
      subscribeToTaskCompleted(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "taskCompleted",
        expect.any(Function),
      );
    });

    it("parses raw events and forwards to callback", () => {
      const callback = vi.fn();
      subscribeToTaskCompleted(mockProgram, callback);

      mockProgram._emit("taskCompleted", createRawTaskCompleted(), 300, "sig3");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.worker).toBe(TEST_PUBKEY);
      expect(event.proofHash).toBeInstanceOf(Uint8Array);
      expect(event.rewardPaid).toBe(500_000_000n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(300);
      expect(sig).toBe("sig3");
    });

    it("filters by taskId when provided", () => {
      const callback = vi.fn();
      const filterTaskId = createId(42);
      subscribeToTaskCompleted(mockProgram, callback, { taskId: filterTaskId });

      mockProgram._emit(
        "taskCompleted",
        createRawTaskCompleted(filterTaskId),
        1,
        "sig1",
      );
      mockProgram._emit(
        "taskCompleted",
        createRawTaskCompleted(createId(99)),
        2,
        "sig2",
      );

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("subscribeToTaskCancelled", () => {
    it("registers with correct camelCase event name", () => {
      const callback = vi.fn();
      subscribeToTaskCancelled(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "taskCancelled",
        expect.any(Function),
      );
    });

    it("parses raw events and forwards to callback", () => {
      const callback = vi.fn();
      subscribeToTaskCancelled(mockProgram, callback);

      mockProgram._emit("taskCancelled", createRawTaskCancelled(), 400, "sig4");

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.creator).toBe(TEST_PUBKEY);
      expect(event.refundAmount).toBe(1_000_000_000n);
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(400);
      expect(sig).toBe("sig4");
    });

    it("filters by taskId when provided", () => {
      const callback = vi.fn();
      const filterTaskId = createId(42);
      subscribeToTaskCancelled(mockProgram, callback, { taskId: filterTaskId });

      mockProgram._emit(
        "taskCancelled",
        createRawTaskCancelled(filterTaskId),
        1,
        "sig1",
      );
      mockProgram._emit(
        "taskCancelled",
        createRawTaskCancelled(createId(99)),
        2,
        "sig2",
      );

      expect(callback).toHaveBeenCalledTimes(1);
    });
  });

  describe("subscribeToDependentTaskCreated", () => {
    it("registers with correct camelCase event name", () => {
      const callback = vi.fn();
      subscribeToDependentTaskCreated(mockProgram, callback);

      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "dependentTaskCreated",
        expect.any(Function),
      );
    });

    it("parses raw events and forwards to callback", () => {
      const callback = vi.fn();
      subscribeToDependentTaskCreated(mockProgram, callback);

      mockProgram._emit(
        "dependentTaskCreated",
        createRawDependentTaskCreated(),
        500,
        "sig5",
      );

      expect(callback).toHaveBeenCalledTimes(1);
      const [event, slot, sig] = callback.mock.calls[0];
      expect(event.taskId).toBeInstanceOf(Uint8Array);
      expect(event.creator).toBe(TEST_PUBKEY);
      expect(event.dependsOn).toBe(TEST_PUBKEY);
      expect(event.dependencyType).toBe(2);
      expect(event.rewardMint).toBeNull();
      expect(event.timestamp).toBe(1234567890);
      expect(slot).toBe(500);
      expect(sig).toBe("sig5");
    });
  });

  describe("subscribeToAllTaskEvents", () => {
    it("routes events to correct callbacks", () => {
      const callbacks = {
        onTaskCreated: vi.fn(),
        onTaskClaimed: vi.fn(),
        onTaskCompleted: vi.fn(),
        onTaskCancelled: vi.fn(),
        onDependentTaskCreated: vi.fn(),
      };

      subscribeToAllTaskEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(5);

      mockProgram._emit("taskCreated", createRawTaskCreated(), 1, "sig1");
      mockProgram._emit("taskClaimed", createRawTaskClaimed(), 2, "sig2");
      mockProgram._emit("taskCompleted", createRawTaskCompleted(), 3, "sig3");
      mockProgram._emit("taskCancelled", createRawTaskCancelled(), 4, "sig4");
      mockProgram._emit(
        "dependentTaskCreated",
        createRawDependentTaskCreated(),
        5,
        "sig5",
      );

      expect(callbacks.onTaskCreated).toHaveBeenCalledTimes(1);
      expect(callbacks.onTaskClaimed).toHaveBeenCalledTimes(1);
      expect(callbacks.onTaskCompleted).toHaveBeenCalledTimes(1);
      expect(callbacks.onTaskCancelled).toHaveBeenCalledTimes(1);
      expect(callbacks.onDependentTaskCreated).toHaveBeenCalledTimes(1);
    });

    it("only subscribes to provided callbacks", () => {
      const callbacks = {
        onTaskCreated: vi.fn(),
      };

      subscribeToAllTaskEvents(mockProgram, callbacks);

      expect(mockProgram.addEventListener).toHaveBeenCalledTimes(1);
      expect(mockProgram.addEventListener).toHaveBeenCalledWith(
        "taskCreated",
        expect.any(Function),
      );
    });

    it("unsubscribe removes all listeners", async () => {
      const callbacks = {
        onTaskCreated: vi.fn(),
        onTaskClaimed: vi.fn(),
        onTaskCompleted: vi.fn(),
        onTaskCancelled: vi.fn(),
        onDependentTaskCreated: vi.fn(),
      };

      const subscription = subscribeToAllTaskEvents(mockProgram, callbacks);
      await subscription.unsubscribe();

      expect(mockProgram.removeEventListener).toHaveBeenCalledTimes(5);
    });

    it("applies taskId filter to all subscriptions", () => {
      const callbacks = {
        onTaskCreated: vi.fn(),
        onTaskClaimed: vi.fn(),
      };

      const filterTaskId = createId(50);
      subscribeToAllTaskEvents(mockProgram, callbacks, {
        taskId: filterTaskId,
      });

      // Matching
      mockProgram._emit(
        "taskCreated",
        createRawTaskCreated(filterTaskId),
        1,
        "sig1",
      );
      // Non-matching
      mockProgram._emit(
        "taskClaimed",
        createRawTaskClaimed(createId(99)),
        2,
        "sig2",
      );

      expect(callbacks.onTaskCreated).toHaveBeenCalledTimes(1);
      expect(callbacks.onTaskClaimed).not.toHaveBeenCalled();
    });

    it("empty callbacks object creates no subscriptions", () => {
      const subscription = subscribeToAllTaskEvents(mockProgram, {});

      expect(mockProgram.addEventListener).not.toHaveBeenCalled();
      expect(subscription.unsubscribe).toBeDefined();
    });
  });
});
