import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { CronService } from "../cron/service.js";

describe("CronService timer integration", () => {
  let tmpDir: string;
  let persistPath: string;
  let runTurn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T00:00:00.000Z"));
    tmpDir = mkdtempSync(path.join(tmpdir(), "jinx-cron-int-"));
    persistPath = path.join(tmpDir, "cron.json");
    runTurn = vi.fn(async () => "ok");
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createService() {
    return new CronService({
      persistPath,
      maxJobs: 10,
      runTurn,
    });
  }

  it("fires interval jobs on due ticks and persists updated run state", async () => {
    const service = createService();
    const job = service.add({
      name: "heartbeat-reminder",
      schedule: { type: "every", intervalMs: 1_000 },
      payload: { prompt: "Check reminders", isolated: false },
      target: { agentId: "default" },
    });

    service.start();

    await vi.advanceTimersByTimeAsync(999);
    expect(runTurn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(runTurn).toHaveBeenLastCalledWith(expect.objectContaining({ id: job.id }));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(runTurn).toHaveBeenCalledTimes(2);

    const updated = service.get(job.id);
    expect(updated).toBeDefined();
    expect(updated!.lastRunAt).toBeDefined();
    expect(updated!.nextRunAt).toBeGreaterThan(updated!.lastRunAt!);

    service.stop();
  });

  it("stops timer-driven execution immediately when service is stopped", async () => {
    const service = createService();
    service.add({
      name: "stop-check",
      schedule: { type: "every", intervalMs: 500 },
      payload: { prompt: "Run until stop", isolated: false },
      target: { agentId: "default" },
    });

    service.start();
    await vi.advanceTimersByTimeAsync(600);
    expect(runTurn).toHaveBeenCalledTimes(1);

    service.stop();
    runTurn.mockClear();

    await vi.advanceTimersByTimeAsync(5_000);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("applies failure backoff before retrying and resets state after recovery", async () => {
    runTurn
      .mockImplementationOnce(async () => {
        throw new Error("planned failure");
      })
      .mockResolvedValue("recovered");

    const service = createService();
    const job = service.add({
      name: "backoff-check",
      schedule: { type: "every", intervalMs: 1_000 },
      payload: { prompt: "Run with backoff", isolated: false },
      target: { agentId: "default" },
    });

    service.start();

    await vi.advanceTimersByTimeAsync(1_001);
    expect(runTurn).toHaveBeenCalledTimes(1);

    const failed = service.get(job.id);
    expect(failed).toBeDefined();
    expect(failed!.failCount).toBe(1);
    expect(failed!.backoffMs).toBe(30_000);
    expect(failed!.enabled).toBe(true);

    await vi.advanceTimersByTimeAsync(29_000);
    expect(runTurn).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_100);
    expect(runTurn).toHaveBeenCalledTimes(2);

    const recovered = service.get(job.id);
    expect(recovered).toBeDefined();
    expect(recovered!.failCount).toBe(0);
    expect(recovered!.backoffMs).toBe(0);

    service.stop();
  });
});
