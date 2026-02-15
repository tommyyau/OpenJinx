import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JinxConfig } from "../types/config.js";
import type { CronJob } from "../types/cron.js";
import { createTestConfig } from "../__test__/config.js";

const state: {
  homeDir: string;
  cronRunTurn?: (job: CronJob) => Promise<string>;
  telegramReady: boolean;
} = {
  homeDir: "",
  cronRunTurn: undefined,
  telegramReady: true,
};

const runAgentMock = vi.fn().mockResolvedValue({
  text: "generated cron output",
  messages: [],
  hitTurnLimit: false,
  usage: {
    inputTokens: 10,
    outputTokens: 3,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  durationMs: 12,
  model: "test-model",
});

const deliverOutboundPayloadsMock = vi.fn().mockResolvedValue({
  channel: "telegram",
  to: "user-1",
  textChunks: 1,
  mediaItems: 0,
  success: true,
});

const deliverHeartbeatEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();

class MockCronService {
  start = vi.fn();
  stop = vi.fn();

  constructor(deps: { runTurn: (job: CronJob) => Promise<string> }) {
    state.cronRunTurn = deps.runTurn;
  }
}

vi.mock("../agents/runner.js", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

vi.mock("../delivery/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => deliverOutboundPayloadsMock(...args),
}));

vi.mock("../heartbeat/delivery.js", () => ({
  deliverHeartbeatEvent: (...args: unknown[]) => deliverHeartbeatEventMock(...args),
}));

vi.mock("../heartbeat/wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
  onHeartbeatWake: vi.fn(),
  cancelAllWakes: vi.fn(),
}));

vi.mock("../cron/service.js", () => ({
  CronService: MockCronService,
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

const telegramStopMock = vi.fn(async () => {});

vi.mock("../channels/telegram/bot.js", () => ({
  createTelegramChannel: vi.fn(() => ({
    id: "telegram",
    name: "Telegram",
    capabilities: {
      markdown: true,
      images: true,
      audio: true,
      video: true,
      documents: true,
      reactions: true,
      editing: true,
      streaming: true,
      maxTextLength: 4096,
    },
    start: vi.fn(async () => {}),
    stop: telegramStopMock,
    send: vi.fn(async () => "msg-id"),
    isReady: vi.fn(() => state.telegramReady),
  })),
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
      telegram: { enabled: true, botToken: "token", streaming: true, mode: "polling" },
      whatsapp: { enabled: false },
    },
    ...overrides,
  });
}

function makeJob(overrides?: Partial<CronJob>): CronJob {
  const now = Date.now();
  return {
    id: "job-1",
    name: "daily-summary",
    schedule: { type: "every", intervalMs: 60_000 },
    payload: { prompt: "Summarize pending work", isolated: true },
    target: {
      agentId: "default",
      deliverTo: { channel: "telegram", to: "user-1" },
    },
    enabled: true,
    createdAt: now,
    lastRunAt: undefined,
    nextRunAt: now + 60_000,
    failCount: 0,
    backoffMs: 0,
    ...overrides,
  };
}

describe("startup cron routing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.homeDir = mkdtempSync(path.join(tmpdir(), "jinx-cron-routing-"));
    state.cronRunTurn = undefined;
    state.telegramReady = true;
  });

  afterEach(() => {
    rmSync(state.homeDir, { recursive: true, force: true });
  });

  it("isolated cron delivers directly when target channel is ready", async () => {
    const boot = await bootGateway(createBootConfig());
    expect(state.cronRunTurn).toBeDefined();

    const output = await state.cronRunTurn!(makeJob());
    expect(output).toBe("generated cron output");

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionType: "subagent",
        tier: "light",
        prompt: expect.stringContaining("automatically delivered"),
      }),
    );

    expect(deliverOutboundPayloadsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { channel: "telegram", to: "user-1" },
        payload: expect.objectContaining({
          text: expect.stringContaining("⏰ [daily-summary] generated cron output"),
        }),
      }),
    );
    expect(deliverHeartbeatEventMock).not.toHaveBeenCalled();

    await boot.stop();
  });

  it("isolated cron falls back to heartbeat delivery when channel is unavailable", async () => {
    state.telegramReady = false;
    const boot = await bootGateway(createBootConfig());

    await state.cronRunTurn!(makeJob());

    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();
    expect(deliverHeartbeatEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "heartbeat",
        agentId: "default",
        hasContent: true,
        text: expect.stringContaining("⏰ [daily-summary] generated cron output"),
      }),
      expect.any(Object),
    );

    await boot.stop();
  });

  it("non-isolated cron enqueues heartbeat wake instead of running agent turn", async () => {
    const boot = await bootGateway(createBootConfig());

    const result = await state.cronRunTurn!(
      makeJob({
        payload: { prompt: "Queue heartbeat event", isolated: false },
        target: { agentId: "default" },
      }),
    );

    expect(result).toBe("enqueued");
    expect(requestHeartbeatNowMock).toHaveBeenCalledWith("default", "cron-event");
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(deliverOutboundPayloadsMock).not.toHaveBeenCalled();

    await boot.stop();
  });
});
