import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Lane } from "./lanes.js";

describe("Lane", () => {
  it("processes items sequentially with concurrency=1", async () => {
    const lane = new Lane("test", 1);
    const order: number[] = [];

    const p1 = lane.enqueue(async () => {
      await sleep(20);
      order.push(1);
    });
    const p2 = lane.enqueue(async () => {
      order.push(2);
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("processes items concurrently with concurrency>1", async () => {
    const lane = new Lane("test", 4);
    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 8 }, () =>
      lane.enqueue(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(10);
        current--;
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBeLessThanOrEqual(4);
    expect(maxConcurrent).toBeGreaterThan(1);
  });

  it("tracks pending and running counts", async () => {
    const lane = new Lane("test", 1);
    expect(lane.pending).toBe(0);
    expect(lane.running).toBe(0);

    let resolve: () => void;
    const blocker = new Promise<void>((r) => (resolve = r));

    const p = lane.enqueue(async () => {
      await blocker;
    });

    // Give it a tick to start
    await sleep(5);
    expect(lane.running).toBe(1);

    resolve!();
    await p;
    // Give the .finally() handler a tick to decrement
    await sleep(5);
    expect(lane.running).toBe(0);
  });
});

describe("getSessionLane", () => {
  // Import dynamically to avoid module state leaking
  it("returns the same lane for the same session key", async () => {
    const { getSessionLane } = await import("./lanes.js");
    const lane1 = getSessionLane("test-session-singleton-a");
    const lane2 = getSessionLane("test-session-singleton-a");
    expect(lane1).toBe(lane2);
  });

  it("returns different lanes for different session keys", async () => {
    const { getSessionLane } = await import("./lanes.js");
    const lane1 = getSessionLane("test-session-diff-1");
    const lane2 = getSessionLane("test-session-diff-2");
    expect(lane1).not.toBe(lane2);
  });

  it("session lanes have max concurrency of 1", async () => {
    const { getSessionLane } = await import("./lanes.js");
    const lane = getSessionLane("test-session-serial");

    let maxConcurrent = 0;
    let current = 0;

    const tasks = Array.from({ length: 3 }, () =>
      lane.enqueue(async () => {
        current++;
        maxConcurrent = Math.max(maxConcurrent, current);
        await sleep(10);
        current--;
      }),
    );

    await Promise.all(tasks);
    expect(maxConcurrent).toBe(1);
  });
});

describe("getGlobalLane", () => {
  it("returns singleton", async () => {
    const { getGlobalLane } = await import("./lanes.js");
    const lane1 = getGlobalLane();
    const lane2 = getGlobalLane();
    expect(lane1).toBe(lane2);
  });
});

describe("Lane queue depth limit", () => {
  it("rejects enqueue when queue is full", async () => {
    const lane = new Lane("overflow-test", 1);

    // Block the lane with a slow task
    let unblock: () => void;
    const blocker = new Promise<void>((r) => (unblock = r));
    const first = lane.enqueue(() => blocker);

    // Fill the queue to max (10 pending)
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      pending.push(lane.enqueue(async () => {}));
    }

    // 11th should be rejected
    await expect(lane.enqueue(async () => {})).rejects.toThrow("queue full");

    // Unblock and let everything drain
    unblock!();
    await first;
    await Promise.all(pending);
  });

  it("accepts new items after queue drains", async () => {
    const lane = new Lane("drain-test", 1);

    let unblock: () => void;
    const blocker = new Promise<void>((r) => (unblock = r));
    const first = lane.enqueue(() => blocker);

    // Fill queue
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      pending.push(lane.enqueue(async () => {}));
    }

    // Unblock
    unblock!();
    await first;
    await Promise.all(pending);

    // Should accept new items now
    await lane.enqueue(async () => {});
  });
});

describe("Lane error handling", () => {
  it("rejects promise when enqueued function throws", async () => {
    const lane = new Lane("error-test", 1);
    const err = new Error("boom");

    await expect(
      lane.enqueue(async () => {
        throw err;
      }),
    ).rejects.toThrow("boom");
  });

  it("continues processing after a rejection", async () => {
    const lane = new Lane("recover-test", 1);

    const p1 = lane
      .enqueue(async () => {
        throw new Error("fail");
      })
      .catch(() => {});

    const order: number[] = [];
    const p2 = lane.enqueue(async () => {
      order.push(2);
    });

    await p1;
    await p2;
    expect(order).toEqual([2]);
  });
});

describe("Lane TTL eviction", () => {
  beforeEach(async () => {
    // Stop any existing sweep timer (from prior tests) before enabling fake timers
    const { stopLaneSweep } = await import("./lanes.js");
    stopLaneSweep();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { stopLaneSweep } = await import("./lanes.js");
    stopLaneSweep();
    vi.useRealTimers();
  });

  it("evicts idle lanes past TTL", async () => {
    const { getSessionLane } = await import("./lanes.js");

    const key = "ttl-evict-unique-xyz";
    // getSessionLane restarts sweep timer (now under fake timers)
    const lane = getSessionLane(key);
    expect(lane.running).toBe(0);
    expect(lane.pending).toBe(0);

    // Advance past TTL (30 min) + sweep interval to trigger eviction
    vi.advanceTimersByTime(31 * 60_000);

    // Requesting the same key should yield a NEW lane instance (old was evicted)
    const lane2 = getSessionLane(key);
    expect(lane2).not.toBe(lane);
  });

  it("does not evict lane with running tasks", async () => {
    const { getSessionLane } = await import("./lanes.js");

    const lane = getSessionLane("ttl-active-test-unique");

    // Keep a task running
    let unblock: () => void;
    const blocker = new Promise<void>((r) => (unblock = r));
    const task = lane.enqueue(() => blocker);

    // Let the enqueue start
    vi.advanceTimersByTime(10);
    expect(lane.running).toBe(1);

    // Advance past TTL
    vi.advanceTimersByTime(31 * 60_000);

    // Lane with running task should still exist (not evicted)
    const lane2 = getSessionLane("ttl-active-test-unique");
    expect(lane2).toBe(lane);

    // Clean up
    unblock!();
    vi.useRealTimers();
    await task;
  });

  it("does not evict lane with pending items", async () => {
    const { getSessionLane } = await import("./lanes.js");

    const lane = getSessionLane("ttl-pending-test-unique");

    // Block the lane with a task, then enqueue a pending one
    let unblock: () => void;
    const blocker = new Promise<void>((r) => (unblock = r));
    const task1 = lane.enqueue(() => blocker);
    vi.advanceTimersByTime(10);

    const task2 = lane.enqueue(async () => {});
    expect(lane.pending).toBeGreaterThanOrEqual(1);

    // Advance past TTL
    vi.advanceTimersByTime(31 * 60_000);

    // Lane should not be evicted (still has pending+running work)
    const lane2 = getSessionLane("ttl-pending-test-unique");
    expect(lane2).toBe(lane);

    // Clean up
    unblock!();
    vi.useRealTimers();
    await task1;
    await task2;
  });
});

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
