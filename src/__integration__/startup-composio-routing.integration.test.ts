import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ComposioTriggerPayload } from "../agents/tools/composio-tools.js";
import type { JinxConfig } from "../types/config.js";
import { createTestConfig } from "../__test__/config.js";
import { cancelAllWakes } from "../heartbeat/wake.js";

type TriggerCallback = (data: ComposioTriggerPayload) => void;

const state: {
  homeDir: string;
  triggerCallback?: TriggerCallback;
  composioApiKeys: string[];
} = {
  homeDir: "",
  triggerCallback: undefined,
  composioApiKeys: [],
};

const subscribeMock = vi.fn(async (callback: TriggerCallback) => {
  state.triggerCallback = callback;
});
const unsubscribeMock = vi.fn(async () => {});

const runAgentMock = vi.fn().mockResolvedValue({
  text: "heartbeat output",
  messages: [],
  hitTurnLimit: false,
  usage: {
    inputTokens: 10,
    outputTokens: 4,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
  },
  durationMs: 12,
  model: "test-model",
});

vi.mock("@composio/core", () => ({
  Composio: class MockComposio {
    triggers = {
      subscribe: (...args: unknown[]) => subscribeMock(...args),
      unsubscribe: (...args: unknown[]) => unsubscribeMock(...args),
    };

    constructor(options: { apiKey: string }) {
      state.composioApiKeys.push(options.apiKey);
    }
  },
}));

vi.mock("../agents/runner.js", () => ({
  runAgent: (...args: unknown[]) => runAgentMock(...args),
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
    composio: {
      enabled: true,
      userId: "default",
      timeoutSeconds: 60,
    },
    ...overrides,
  });
}

describe("startup composio routing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.homeDir = mkdtempSync(path.join(tmpdir(), "jinx-composio-int-"));
    state.triggerCallback = undefined;
    state.composioApiKeys = [];
    cancelAllWakes();
    delete process.env.OPENAI_API_KEY;
    delete process.env.COMPOSIO_API_KEY;
  });

  afterEach(() => {
    cancelAllWakes();
    vi.useRealTimers();
    rmSync(state.homeDir, { recursive: true, force: true });
    delete process.env.COMPOSIO_API_KEY;
  });

  it("routes Composio trigger events into a heartbeat turn and unsubscribes on shutdown", async () => {
    vi.useFakeTimers();
    const boot = await bootGateway(
      createBootConfig({
        composio: {
          enabled: true,
          apiKey: "config-composio-key",
          userId: "default",
          timeoutSeconds: 60,
        },
      }),
    );

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(state.triggerCallback).toBeDefined();

    state.triggerCallback!({
      triggerSlug: "GITHUB_PUSH",
      payload: { repo: "OpenJinx", branch: "main" },
    });

    await vi.advanceTimersByTimeAsync(300);

    expect(runAgentMock).toHaveBeenCalledTimes(1);
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "heartbeat:default",
        sessionType: "main",
        tier: "light",
        prompt: expect.stringContaining("<system-events>"),
      }),
    );

    const runArgs = runAgentMock.mock.calls[0][0] as { prompt: string };
    expect(runArgs.prompt).toContain("[Trigger: GITHUB_PUSH]");
    expect(runArgs.prompt).toContain("repo=OpenJinx");
    expect(runArgs.prompt).toContain("branch=main");

    await boot.stop();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("does not start Composio subscriber when enabled but no API key is configured", async () => {
    const boot = await bootGateway(
      createBootConfig({
        composio: {
          enabled: true,
          userId: "default",
          timeoutSeconds: 60,
        },
      }),
    );

    expect(subscribeMock).not.toHaveBeenCalled();
    expect(state.composioApiKeys).toEqual([]);

    await boot.stop();
    expect(unsubscribeMock).not.toHaveBeenCalled();
  });

  it("uses COMPOSIO_API_KEY env fallback when config key is absent", async () => {
    process.env.COMPOSIO_API_KEY = "env-composio-key";

    const boot = await bootGateway(
      createBootConfig({
        composio: {
          enabled: true,
          userId: "default",
          timeoutSeconds: 60,
        },
      }),
    );

    expect(subscribeMock).toHaveBeenCalledTimes(1);
    expect(state.composioApiKeys).toEqual(["env-composio-key"]);

    await boot.stop();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});
