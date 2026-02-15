/**
 * Integration: Session lane concurrency control.
 * Tests serial execution, queue depth limits, error isolation,
 * lane reuse, and cross-session independence using real Lane instances.
 */
import { describe, it, expect, afterAll } from "vitest";
import { Lane, getSessionLane, stopLaneSweep } from "../pipeline/lanes.js";

afterAll(() => stopLaneSweep());

describe("Session lanes", () => {
  it("executes tasks serially on maxConcurrent=1", async () => {
    const lane = new Lane("serial-test", 1);
    const order: number[] = [];

    const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    const p1 = lane.enqueue(async () => {
      await delay(30);
      order.push(1);
    });
    const p2 = lane.enqueue(async () => {
      await delay(10);
      order.push(2);
    });
    const p3 = lane.enqueue(async () => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);

    expect(order).toEqual([1, 2, 3]);
  });

  it("rejects the 11th task when queue depth reaches MAX_QUEUE_DEPTH", async () => {
    const lane = new Lane("depth-test", 1);
    const blocker = new Promise<void>((resolve) => {
      // First task blocks so all subsequent tasks queue up
      lane.enqueue(async () => {
        await new Promise<void>((r) => setTimeout(r, 200));
        resolve();
      });
    });

    // Enqueue 10 more tasks (fills the queue to MAX_QUEUE_DEPTH=10)
    const queued: Promise<void>[] = [];
    for (let i = 0; i < 10; i++) {
      queued.push(lane.enqueue(async () => {}));
    }

    // The 11th enqueue should reject
    await expect(lane.enqueue(async () => {})).rejects.toThrow("queue full");

    // Clean up: let the blocker finish so queued tasks can drain
    await blocker;
    await Promise.all(queued);
  });

  it("isolates errors — failing task does not block subsequent tasks", async () => {
    const lane = new Lane("error-test", 1);
    const results: string[] = [];

    const pA = lane.enqueue(async () => {
      throw new Error("task A failed");
    });
    const pB = lane.enqueue(async () => {
      results.push("B completed");
    });

    await expect(pA).rejects.toThrow("task A failed");
    await pB;

    expect(results).toEqual(["B completed"]);
  });

  it("returns the same Lane instance for the same session key", () => {
    const lane1 = getSessionLane("reuse-test-key");
    const lane2 = getSessionLane("reuse-test-key");

    expect(lane1).toBe(lane2);
  });

  it("runs cross-session tasks independently", async () => {
    const laneA = getSessionLane("cross-session-A");
    const laneB = getSessionLane("cross-session-B");

    const completionOrder: string[] = [];

    const pA = laneA.enqueue(async () => {
      await new Promise<void>((r) => setTimeout(r, 100));
      completionOrder.push("A");
    });

    const pB = laneB.enqueue(async () => {
      completionOrder.push("B");
    });

    await Promise.all([pA, pB]);

    expect(completionOrder).toEqual(["B", "A"]);
  });
});
