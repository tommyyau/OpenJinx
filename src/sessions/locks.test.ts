import { describe, expect, it, vi, afterEach } from "vitest";
import {
  acquireSessionLock,
  tryAcquireSessionLock,
  isSessionLocked,
  waitForSessionLock,
} from "./locks.js";

describe("session locks", () => {
  it("acquires and releases a lock", () => {
    const release = acquireSessionLock("test-session-1");
    expect(isSessionLocked("test-session-1")).toBe(true);
    release();
    expect(isSessionLocked("test-session-1")).toBe(false);
  });

  it("throws on double acquire", () => {
    const release = acquireSessionLock("test-session-2");
    expect(() => acquireSessionLock("test-session-2")).toThrow("already locked");
    release();
  });

  it("tryAcquire returns undefined when locked", () => {
    const release = acquireSessionLock("test-session-3");
    expect(tryAcquireSessionLock("test-session-3")).toBeUndefined();
    release();
  });

  it("tryAcquire returns release function when available", () => {
    const release = tryAcquireSessionLock("test-session-4");
    expect(release).toBeDefined();
    expect(isSessionLocked("test-session-4")).toBe(true);
    release!();
    expect(isSessionLocked("test-session-4")).toBe(false);
  });
});

describe("waitForSessionLock", () => {
  it("acquires immediately when available", async () => {
    const release = await waitForSessionLock("wait-avail-1");
    expect(typeof release).toBe("function");
    expect(isSessionLocked("wait-avail-1")).toBe(true);
    release();
    expect(isSessionLocked("wait-avail-1")).toBe(false);
  });

  it("waits for release then acquires", async () => {
    const release1 = acquireSessionLock("wait-release-1");
    expect(isSessionLocked("wait-release-1")).toBe(true);

    // Release after 50ms
    setTimeout(() => release1(), 50);

    const release2 = await waitForSessionLock("wait-release-1", 5000);
    expect(isSessionLocked("wait-release-1")).toBe(true);
    release2();
    expect(isSessionLocked("wait-release-1")).toBe(false);
  });

  it("times out when lock is not released", async () => {
    const release = acquireSessionLock("wait-timeout-1");

    await expect(waitForSessionLock("wait-timeout-1", 200)).rejects.toThrow("Timed out");

    release();
  });
});

describe("lock expiration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("auto-expires lock after LOCK_TIMEOUT_MS (5 minutes)", () => {
    vi.useFakeTimers();

    // Acquire lock
    acquireSessionLock("expire-test-1");
    expect(isSessionLocked("expire-test-1")).toBe(true);

    // Advance past the 5-minute timeout
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    // isSessionLocked calls cleanExpiredLocks internally
    expect(isSessionLocked("expire-test-1")).toBe(false);
  });
});
