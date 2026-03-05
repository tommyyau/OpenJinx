import type { IncomingHttpHeaders } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { JinxConfig } from "../types/config.js";
import { createTestConfig } from "../__test__/config.js";
import { cancelAllWakes, requestHeartbeatNow } from "../heartbeat/wake.js";

type WebhookHandler = (
  path: string,
  body: string,
  headers: IncomingHttpHeaders,
) => Promise<{ status: number; body: string }>;

const state: {
  homeDir: string;
  stopOrder: string[];
  telegramStopGate: Promise<void>;
  webhookHandler?: WebhookHandler;
  telegramWebhookResponse: { status: number; body: string };
} = {
  homeDir: "",
  stopOrder: [],
  telegramStopGate: Promise.resolve(),
  webhookHandler: undefined,
  telegramWebhookResponse: { status: 200, body: '{"ok":true}' },
};

const runAgentMock = vi.fn().mockResolvedValue({
  text: "heartbeat content for delivery checks",
  messages: [],
  hitTurnLimit: false,
  usage: {
    inputTokens: 10,
    outputTokens: 5,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  durationMs: 5,
  model: "test-model",
});

const gatewayStartMock = vi.fn();
const gatewayStopMock = vi.fn(async () => {
  state.stopOrder.push("gateway:stop");
});

const httpStartMock = vi.fn();
const httpStopMock = vi.fn(async () => {
  state.stopOrder.push("http:stop");
});
const httpOnWebhookMock = vi.fn((handler: WebhookHandler) => {
  state.webhookHandler = handler;
});

const telegramStartMock = vi.fn(async () => {
  state.stopOrder.push("telegram:start");
});
const telegramStopMock = vi.fn(async () => {
  state.stopOrder.push("telegram:stop:start");
  await state.telegramStopGate;
  state.stopOrder.push("telegram:stop:end");
});
const telegramWebhookMock = vi.fn(
  async (_body: string, _headers: IncomingHttpHeaders) => state.telegramWebhookResponse,
);

const startSkillRefreshMock = vi.fn(() => {
  return () => {
    state.stopOrder.push("skills:stop");
  };
});

vi.mock("../agents/runner.js", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
}));

vi.mock("../infra/home-dir.js", () => ({
  resolveHomeDir: () => state.homeDir,
  expandTilde: (input: string) => input.replace(/^~(?=\/|$)/, state.homeDir),
  ensureHomeDir: () => state.homeDir,
  homeRelative: (rel: string) => path.join(state.homeDir, rel),
}));

vi.mock("../gateway/server.js", () => ({
  createGatewayServer: vi.fn(() => ({
    start: gatewayStartMock,
    stop: gatewayStopMock,
  })),
}));

vi.mock("../gateway/server-http.js", () => ({
  createHttpServer: vi.fn(() => ({
    start: httpStartMock,
    stop: httpStopMock,
    onWebhook: httpOnWebhookMock,
  })),
}));

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
    start: telegramStartMock,
    stop: telegramStopMock,
    send: vi.fn(async () => "msg-id"),
    isReady: vi.fn(() => true),
    handleWebhookRequest: telegramWebhookMock,
  })),
}));

vi.mock("../channels/whatsapp/bot.js", () => ({
  createWhatsAppChannel: vi.fn(),
}));

vi.mock("../skills/refresh.js", () => ({
  startSkillRefresh: (...args: unknown[]) => startSkillRefreshMock(...args),
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

describe("bootGateway lifecycle integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.homeDir = mkdtempSync(path.join(tmpdir(), "jinx-startup-int-"));
    state.stopOrder = [];
    state.telegramStopGate = Promise.resolve();
    state.webhookHandler = undefined;
    state.telegramWebhookResponse = { status: 200, body: '{"ok":true}' };
    cancelAllWakes();
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    cancelAllWakes();
    rmSync(state.homeDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("awaits async channel teardown before stopping gateway server", async () => {
    const config = createBootConfig({
      channels: {
        terminal: { enabled: true },
        telegram: { enabled: true, botToken: "test-token", streaming: true, mode: "polling" },
        whatsapp: { enabled: false },
      },
    });

    const boot = await bootGateway(config);

    let releaseTelegramStop: (() => void) | undefined;
    state.telegramStopGate = new Promise<void>((resolve) => {
      releaseTelegramStop = resolve;
    });

    const stopPromise = boot.stop();
    await Promise.resolve();

    expect(telegramStopMock).toHaveBeenCalledTimes(1);
    expect(state.stopOrder).toContain("telegram:stop:start");
    expect(state.stopOrder).not.toContain("gateway:stop");

    releaseTelegramStop!();
    await stopPromise;

    expect(state.stopOrder.indexOf("gateway:stop")).toBeGreaterThan(
      state.stopOrder.indexOf("telegram:stop:end"),
    );
  });

  it("wires telegram webhook handler through HTTP server in webhook mode", async () => {
    const config = createBootConfig({
      channels: {
        terminal: { enabled: true },
        telegram: { enabled: true, botToken: "webhook-token", streaming: true, mode: "webhook" },
        whatsapp: { enabled: false },
      },
      gateway: {
        host: "127.0.0.1",
        port: 9790,
        http: {
          enabled: true,
          port: 9791,
          hooks: { enabled: true },
        },
      },
    });

    const boot = await bootGateway(config);

    expect(httpOnWebhookMock).toHaveBeenCalledTimes(1);
    expect(state.webhookHandler).toBeDefined();

    const telegramResult = await state.webhookHandler!("telegram/webhook", '{"update_id":1}', {});
    expect(telegramWebhookMock).toHaveBeenCalledWith('{"update_id":1}', {});
    expect(telegramResult).toEqual({ status: 200, body: '{"ok":true}' });

    const notFoundResult = await state.webhookHandler!("unknown/path", "{}", {});
    expect(notFoundResult.status).toBe(404);

    await boot.stop();
  });

  it("wires wake requests to heartbeat turns with light tier", async () => {
    vi.useFakeTimers();

    const config = createBootConfig();
    const boot = await bootGateway(config);

    requestHeartbeatNow("default", "cron-event");
    requestHeartbeatNow("default", "cron-event");
    requestHeartbeatNow("default", "cron-event");

    await vi.advanceTimersByTimeAsync(300);

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "heartbeat:default",
        sessionType: "main",
        tier: "light",
      }),
    );
    const call = runAgentMock.mock.calls[0][0] as { prompt: string };
    // Defensive fallback: event wake without pending events should use default heartbeat prompt.
    expect(call.prompt).toContain("This is a scheduled heartbeat check.");
    expect(call.prompt).not.toContain("A scheduled reminder has been triggered.");

    await boot.stop();
  });

  it("triggers fail-safe process exit when shutdown exceeds timeout", async () => {
    vi.useFakeTimers();
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    gatewayStopMock.mockImplementationOnce(
      async () =>
        await new Promise<void>(() => {
          // Keep shutdown hanging to force timeout path.
        }),
    );

    const boot = await bootGateway(createBootConfig());

    const stopPromise = boot.stop();
    await vi.advanceTimersByTimeAsync(10_050);
    await stopPromise;

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
