import { describe, expect, it } from "vitest";
import { isAbortError, sleep, throwIfAborted, withAbort } from "./marathon-runtime.js";

describe("marathon-runtime", () => {
  it("throwIfAborted throws with the provided message", () => {
    const controller = new AbortController();
    controller.abort();

    expect(() => throwIfAborted(controller.signal, "stop-now")).toThrow("stop-now");
  });

  it("withAbort rejects immediately if signal already aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(withAbort(Promise.resolve("ok"), controller.signal, "aborted")).rejects.toThrow(
      "aborted",
    );
  });

  it("withAbort rejects when signal aborts before promise resolves", async () => {
    const controller = new AbortController();

    const pending = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 50);
    });

    const work = withAbort(pending, controller.signal, "cancelled");
    setTimeout(() => controller.abort(), 5);

    await expect(work).rejects.toThrow("cancelled");
  });

  it("isAbortError detects signal and abort-like messages", () => {
    const controller = new AbortController();
    controller.abort();

    expect(isAbortError(new Error("anything"), controller.signal)).toBe(true);
    expect(isAbortError(new Error("request cancelled"))).toBe(true);
    expect(isAbortError(new Error("aborted by user"))).toBe(true);
    expect(isAbortError(new Error("unexpected failure"))).toBe(false);
  });

  it("sleep resolves early when signal aborts", async () => {
    const controller = new AbortController();

    const start = Date.now();
    const delayed = sleep(1000, controller.signal);
    setTimeout(() => controller.abort(), 5);

    await delayed;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);
  });
});
