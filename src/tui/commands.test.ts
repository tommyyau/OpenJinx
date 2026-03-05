import { describe, it, expect, vi } from "vitest";
import type { ChannelPlugin } from "../types/channels.js";
import type { JinxConfig } from "../types/config.js";
import type { SessionEntry, SessionStore } from "../types/sessions.js";
import { executeTuiCommand, getBuiltinCommands, type TuiContext } from "./commands.js";

function makeSessionEntry(overrides: Partial<SessionEntry>): SessionEntry {
  return {
    sessionId: "test-id",
    sessionKey: "terminal:abc",
    agentId: "default",
    channel: "terminal",
    createdAt: Date.now() - 60_000,
    lastActiveAt: Date.now() - 30_000,
    turnCount: 5,
    transcriptPath: "/tmp/test.jsonl",
    totalInputTokens: 1000,
    totalOutputTokens: 500,
    contextTokens: 0,
    locked: false,
    ...overrides,
  };
}

function makeChannel(id: string, name: string, ready: boolean): ChannelPlugin {
  return {
    id: id as ChannelPlugin["id"],
    name,
    capabilities: {
      markdown: true,
      images: false,
      audio: false,
      video: false,
      documents: false,
      reactions: false,
      editing: false,
      streaming: false,
      maxTextLength: 4096,
    },
    start: vi.fn(),
    stop: vi.fn(),
    send: vi.fn(),
    isReady: () => ready,
  };
}

function makeTuiContext(overrides?: Partial<TuiContext>): TuiContext {
  const sessions: SessionStore = {
    get: vi.fn(),
    set: vi.fn(),
    delete: vi.fn(),
    list: () => [],
    save: vi.fn(),
    load: vi.fn(),
  };

  return {
    config: {
      llm: {
        brain: "sonnet",
        subagent: "sonnet",
        light: "haiku",
        maxTokensBrain: 16_384,
        maxTokensSubagent: 16_384,
        maxTokensLight: 4_096,
        maxTurns: 10,
      },
      agents: {
        default: "jinx",
        list: [
          { id: "jinx", name: "Jinx", workspace: "~/.jinx/workspace" },
          { id: "coder", name: "Coder Bot", workspace: "~/.jinx/workspace" },
        ],
      },
      channels: {
        terminal: { enabled: true },
        telegram: { enabled: false },
        whatsapp: { enabled: false },
      },
      skills: { dirs: [], exclude: [] },
      memory: {
        enabled: true,
        dir: "~/.jinx/memory",
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        vectorWeight: 0.5,
        maxResults: 10,
      },
      heartbeat: {
        enabled: false,
        defaultIntervalMinutes: 30,
        visibility: { showOk: false, showAlerts: true, useIndicator: false },
      },
      cron: { enabled: false, maxJobs: 10, persistPath: "" },
      gateway: { host: "127.0.0.1", port: 3579 },
      logging: { level: "info" },
      webSearch: { enabled: false },
      composio: { enabled: false, userId: "default", timeoutSeconds: 30 },
    } as JinxConfig,
    sessions,
    channels: new Map(),
    searchManager: { getStatus: () => ({ totalFiles: 3, totalChunks: 42 }) },
    ...overrides,
  };
}

describe("getBuiltinCommands", () => {
  it("returns all expected commands", () => {
    const cmds = getBuiltinCommands();
    const names = cmds.map((c) => c.name);

    expect(names).toContain("status");
    expect(names).toContain("model");
    expect(names).toContain("agent");
    expect(names).toContain("sessions");
    expect(names).toContain("usage");
    expect(names).toContain("help");
    expect(names).toContain("quit");
  });
});

describe("executeTuiCommand", () => {
  it("returns handled=false for non-command input", async () => {
    const result = await executeTuiCommand("hello world");
    expect(result).toEqual({ handled: false });
  });

  it("returns handled=false for unknown commands", async () => {
    const result = await executeTuiCommand("/unknown");
    expect(result).toEqual({ handled: false });
  });

  it("handles /help command", async () => {
    const result = await executeTuiCommand("/help");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("/status");
    expect(result.output).toContain("/model");
    expect(result.output).toContain("/help");
  });
});

describe("/status command", () => {
  it("shows fallback when no context", async () => {
    const result = await executeTuiCommand("/status");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("not available");
  });

  it("shows gateway, channels, memory, and session info", async () => {
    const telegram = makeChannel("telegram", "Telegram", true);
    const channels = new Map<string, ChannelPlugin>([["telegram", telegram]]);

    const ctx = makeTuiContext({
      channels,
      sessions: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        list: () => [
          makeSessionEntry({ sessionKey: "terminal:user1" }),
          makeSessionEntry({ sessionKey: "heartbeat:jinx" }),
        ],
        save: vi.fn(),
        load: vi.fn(),
      },
    });

    const result = await executeTuiCommand("/status", ctx);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("127.0.0.1:3579");
    expect(result.output).toContain("Telegram (ready)");
    expect(result.output).toContain("3 files, 42 chunks");
    expect(result.output).toContain("1 active"); // heartbeat filtered out
  });

  it("shows memory disabled when no searchManager", async () => {
    const ctx = makeTuiContext({ searchManager: undefined });
    const result = await executeTuiCommand("/status", ctx);
    expect(result.output).toContain("Memory: disabled");
  });
});

describe("/model command", () => {
  it("shows fallback when no context", async () => {
    const result = await executeTuiCommand("/model");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("not available");
  });

  it("shows current model tiers", async () => {
    const ctx = makeTuiContext();
    const result = await executeTuiCommand("/model", ctx);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("Brain: sonnet");
    expect(result.output).toContain("Subagent: sonnet");
    expect(result.output).toContain("Light: haiku");
  });
});

describe("/agent command", () => {
  it("shows fallback when no context", async () => {
    const result = await executeTuiCommand("/agent");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("not available");
  });

  it("shows default agent and full agent list", async () => {
    const ctx = makeTuiContext();
    const result = await executeTuiCommand("/agent", ctx);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("Default agent: jinx");
    expect(result.output).toContain("jinx — Jinx (default)");
    expect(result.output).toContain("coder — Coder Bot");
  });
});

describe("/sessions command", () => {
  it("shows fallback when no context", async () => {
    const result = await executeTuiCommand("/sessions");
    expect(result.handled).toBe(true);
    expect(result.output).toContain("not available");
  });

  it("shows no active sessions message", async () => {
    const ctx = makeTuiContext();
    const result = await executeTuiCommand("/sessions", ctx);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("No active sessions");
  });

  it("lists user sessions and filters out heartbeat/cron", async () => {
    const ctx = makeTuiContext({
      sessions: {
        get: vi.fn(),
        set: vi.fn(),
        delete: vi.fn(),
        list: () => [
          makeSessionEntry({ sessionKey: "terminal:user1", channel: "terminal", turnCount: 12 }),
          makeSessionEntry({ sessionKey: "telegram:alice", channel: "telegram", turnCount: 3 }),
          makeSessionEntry({ sessionKey: "heartbeat:jinx" }),
          makeSessionEntry({ sessionKey: "cron:jinx:123" }),
        ],
        save: vi.fn(),
        load: vi.fn(),
      },
    });

    const result = await executeTuiCommand("/sessions", ctx);
    expect(result.handled).toBe(true);
    expect(result.output).toContain("terminal:user1");
    expect(result.output).toContain("12 turns");
    expect(result.output).toContain("telegram:alice");
    expect(result.output).toContain("3 turns");
    expect(result.output).not.toContain("heartbeat:");
    expect(result.output).not.toContain("cron:");
  });
});
