import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JinxConfig } from "../types/config.js";
import type { HeartbeatReason } from "../types/heartbeat.js";
import { createTestConfig } from "../__test__/config.js";
import { cancelAllWakes, requestHeartbeatNow } from "../heartbeat/wake.js";

const state: {
  homeDir: string;
  runOnceCalls: Array<{ agentId: string; reason: HeartbeatReason }>;
} = {
  homeDir: "",
  runOnceCalls: [],
};

class MockHeartbeatRunner {
  private agents = new Set<string>();

  registerAgent(agentId: string): void {
    this.agents.add(agentId);
  }

  start(): void {}

  stop(): void {}

  async runOnce(agentId: string, reason: HeartbeatReason = "manual") {
    state.runOnceCalls.push({ agentId, reason });
    if (!this.agents.has(agentId)) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    return {
      type: "heartbeat" as const,
      agentId,
      timestamp: Date.now(),
      hasContent: false,
      wasOk: true,
      durationMs: 1,
    };
  }
}

vi.mock("../heartbeat/runner.js", () => ({
  HeartbeatRunner: MockHeartbeatRunner,
}));

vi.mock("../infra/home-dir.js", () => ({
  resolveHomeDir: () => state.homeDir,
  expandTilde: (input: string) => input.replace(/^~(?=\/|$)/, state.homeDir),
  ensureHomeDir: () => state.homeDir,
}));

vi.mock("../gateway/server.js", () => ({
  createGatewayServer: vi.fn(() => ({
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  })),
}));

vi.mock("../gateway/server-http.js", () => ({
  createHttpServer: vi.fn(),
}));

vi.mock("../channels/telegram/bot.js", () => ({
  createTelegramChannel: vi.fn(),
}));

vi.mock("../channels/whatsapp/bot.js", () => ({
  createWhatsAppChannel: vi.fn(),
}));

vi.mock("../skills/refresh.js", () => ({
  startSkillRefresh: vi.fn(() => vi.fn()),
}));

const { bootGateway } = await import("../gateway/startup.js");

function createBootConfig(overrides?: Partial<JinxConfig>): JinxConfig {
  return createTestConfig({
    sandbox: { enabled: false },
    memory: {
      enabled: true,
      dir: "~/.jinx/memory",
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorWeight: 0.7,
      maxResults: 5,
    },
    agents: {
      default: "default",
      list: [{ id: "default", name: "TestJinx", workspace: "~/.jinx/workspace" }],
    },
    channels: {
      terminal: { enabled: true },
      telegram: { enabled: false, streaming: true, mode: "polling" },
      whatsapp: { enabled: false },
    },
    ...overrides,
  });
}

describe("startup wake retry integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    state.homeDir = mkdtempSync(path.join(tmpdir(), "jinx-startup-wake-int-"));
    state.runOnceCalls = [];
    cancelAllWakes();
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    cancelAllWakes();
    vi.useRealTimers();
    rmSync(state.homeDir, { recursive: true, force: true });
  });

  it("retries unknown-agent wakes up to max retries (1 initial + 5 retries)", async () => {
    const boot = await bootGateway(createBootConfig());

    requestHeartbeatNow("missing-agent", "manual");
    await vi.advanceTimersByTimeAsync(250 + 5_000 + 10);

    const unknownCalls = state.runOnceCalls.filter((call) => call.agentId === "missing-agent");
    expect(unknownCalls).toHaveLength(6);

    await boot.stop();
  });

  it("cancels pending wake retries on shutdown", async () => {
    const boot = await bootGateway(createBootConfig());

    requestHeartbeatNow("missing-agent", "manual");
    await vi.advanceTimersByTimeAsync(250);

    expect(state.runOnceCalls.filter((call) => call.agentId === "missing-agent")).toHaveLength(1);

    await boot.stop();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(state.runOnceCalls.filter((call) => call.agentId === "missing-agent")).toHaveLength(1);
  });

  it("coalesces rapid wake requests for a registered agent through startup wiring", async () => {
    const boot = await bootGateway(createBootConfig());

    requestHeartbeatNow("default", "manual");
    requestHeartbeatNow("default", "manual");
    requestHeartbeatNow("default", "manual");

    await vi.advanceTimersByTimeAsync(260);

    const defaultCalls = state.runOnceCalls.filter((call) => call.agentId === "default");
    expect(defaultCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.runOnceCalls.filter((call) => call.agentId === "default")).toHaveLength(1);

    await boot.stop();
  });
});
