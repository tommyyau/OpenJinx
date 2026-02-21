import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeUsageSummary,
  getMetricsPath,
  logTurnMetric,
  readMetrics,
  type TurnMetric,
} from "./metrics.js";

// Use a temp directory for tests
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(import.meta.dirname ?? "/tmp", "metrics-test-"));
  vi.stubEnv("JINX_HOME", tmpDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeTurnMetric(overrides: Partial<TurnMetric> = {}): TurnMetric {
  return {
    timestamp: Date.now(),
    sessionKey: "test-session",
    model: "claude-sonnet-4-6",
    inputTokens: 1000,
    outputTokens: 200,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    durationMs: 1500,
    turnType: "chat",
    ...overrides,
  };
}

describe("logTurnMetric", () => {
  it("writes valid JSONL to the metrics file", () => {
    const metric = makeTurnMetric();
    logTurnMetric(metric);

    const filePath = getMetricsPath();
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.sessionKey).toBe("test-session");
    expect(parsed.inputTokens).toBe(1000);
  });

  it("appends multiple metrics as separate lines", () => {
    logTurnMetric(makeTurnMetric({ sessionKey: "session-1" }));
    logTurnMetric(makeTurnMetric({ sessionKey: "session-2" }));

    const filePath = getMetricsPath();
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  it("creates file with secure permissions (0o600)", () => {
    logTurnMetric(makeTurnMetric());

    const filePath = getMetricsPath();
    const stats = fs.statSync(filePath);
    // Check owner-only rw (0o600) — mask off file type bits
    expect(stats.mode & 0o777).toBe(0o600);
  });

  it("skips writes in test mode when JINX_HOME is not set", () => {
    const appendSpy = vi.spyOn(fs, "appendFileSync");
    vi.unstubAllEnvs();

    logTurnMetric(makeTurnMetric());

    expect(appendSpy).not.toHaveBeenCalled();

    appendSpy.mockRestore();
    vi.stubEnv("JINX_HOME", tmpDir);
  });
});

describe("readMetrics", () => {
  it("returns empty array when file does not exist", async () => {
    const metrics = await readMetrics();
    expect(metrics).toEqual([]);
  });

  it("parses all metrics from file", async () => {
    logTurnMetric(makeTurnMetric({ timestamp: 1000 }));
    logTurnMetric(makeTurnMetric({ timestamp: 2000 }));

    const metrics = await readMetrics();
    expect(metrics).toHaveLength(2);
    expect(metrics[0].timestamp).toBe(1000);
    expect(metrics[1].timestamp).toBe(2000);
  });

  it("filters by since timestamp", async () => {
    logTurnMetric(makeTurnMetric({ timestamp: 1000 }));
    logTurnMetric(makeTurnMetric({ timestamp: 2000 }));
    logTurnMetric(makeTurnMetric({ timestamp: 3000 }));

    const metrics = await readMetrics(2000);
    expect(metrics).toHaveLength(2);
    expect(metrics[0].timestamp).toBe(2000);
    expect(metrics[1].timestamp).toBe(3000);
  });

  it("skips malformed lines without crashing", async () => {
    const filePath = getMetricsPath();
    fs.writeFileSync(
      filePath,
      '{"timestamp":1000,"sessionKey":"ok","model":"m","inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"durationMs":0,"turnType":"chat"}\nnot json\n{"timestamp":2000,"sessionKey":"ok2","model":"m","inputTokens":0,"outputTokens":0,"cacheCreationTokens":0,"cacheReadTokens":0,"durationMs":0,"turnType":"chat"}\n',
    );

    const metrics = await readMetrics();
    expect(metrics).toHaveLength(2);
  });
});

describe("computeUsageSummary", () => {
  it("computes totals across multiple metrics", () => {
    const metrics: TurnMetric[] = [
      makeTurnMetric({
        inputTokens: 1000,
        outputTokens: 200,
        cacheCreationTokens: 500,
        cacheReadTokens: 0,
        durationMs: 1000,
      }),
      makeTurnMetric({
        inputTokens: 800,
        outputTokens: 150,
        cacheCreationTokens: 0,
        cacheReadTokens: 500,
        durationMs: 800,
      }),
    ];

    const summary = computeUsageSummary(metrics);
    expect(summary.totalInputTokens).toBe(1800);
    expect(summary.totalOutputTokens).toBe(350);
    expect(summary.totalCacheCreationTokens).toBe(500);
    expect(summary.totalCacheReadTokens).toBe(500);
    expect(summary.totalTurns).toBe(2);
    expect(summary.totalDurationMs).toBe(1800);
  });

  it("computes cache hit rate as percentage of billable input", () => {
    const metrics: TurnMetric[] = [
      // Billable = 100 (input) + 0 (creation) + 900 (read) = 1000
      // Hit rate = 900 / 1000 = 90%
      makeTurnMetric({ inputTokens: 100, cacheCreationTokens: 0, cacheReadTokens: 900 }),
    ];

    const summary = computeUsageSummary(metrics);
    expect(summary.cacheHitRate).toBe(90);
  });

  it("returns 0% cache hit rate when no tokens", () => {
    const summary = computeUsageSummary([]);
    expect(summary.cacheHitRate).toBe(0);
    expect(summary.totalTurns).toBe(0);
  });

  it("counts turns by type", () => {
    const metrics: TurnMetric[] = [
      makeTurnMetric({ turnType: "chat" }),
      makeTurnMetric({ turnType: "chat" }),
      makeTurnMetric({ turnType: "heartbeat" }),
      makeTurnMetric({ turnType: "cron" }),
    ];

    const summary = computeUsageSummary(metrics);
    expect(summary.turnsByType.chat).toBe(2);
    expect(summary.turnsByType.heartbeat).toBe(1);
    expect(summary.turnsByType.cron).toBe(1);
    expect(summary.turnsByType.compaction).toBe(0);
  });
});
