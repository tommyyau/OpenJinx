/**
 * Integration: Telegram inbound message simulation.
 *
 * Simulates Telegram messages at the dispatch level and verifies access control.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("../agents/runner.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    text: "tg-inbound reply",
    messages: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 50,
  }),
}));

vi.mock("../heartbeat/wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../pipeline/classifier.js", () => ({
  classifyTask: vi.fn().mockResolvedValue({ classification: "quick", reason: "test" }),
}));

vi.mock("../pipeline/deep-work.js", () => ({
  launchDeepWork: vi.fn(),
}));

import type { MsgContext } from "../types/messages.js";
import { createTestConfig } from "../__test__/config.js";
import { checkTelegramAccess } from "../channels/telegram/access.js";
import { dispatchTelegramMessage } from "../channels/telegram/dispatch.js";
import { stopLaneSweep } from "../pipeline/lanes.js";
import { createSessionStore } from "../sessions/store.js";

afterAll(() => {
  stopLaneSweep();
});

beforeEach(() => {
  vi.clearAllMocks();
});

function makeMsgContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    messageId: "tg-msg-1",
    channel: "telegram",
    sessionKey: "telegram:dm:42",
    agentId: "default",
    accountId: "telegram-bot",
    senderId: "42",
    senderName: "TG User",
    text: "hello",
    isGroup: false,
    isCommand: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("Telegram inbound dispatch", () => {
  it("dispatches a valid DM through the pipeline", async () => {
    const config = createTestConfig({
      channels: { telegram: { dmPolicy: "open" } },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchTelegramMessage(ctx, deps);
    expect(result).toBeDefined();
  });

  it("rejects DM when dmPolicy is disabled", async () => {
    const config = createTestConfig({
      channels: { telegram: { dmPolicy: "disabled" } },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchTelegramMessage(ctx, deps);
    expect(result.text).toBe("Access denied.");
  });

  it("rejects group message when groupPolicy is disabled", async () => {
    const config = createTestConfig({
      channels: { telegram: { dmPolicy: "open", groupPolicy: "disabled" } },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext({
      isGroup: true,
      groupId: "-100123",
      sessionKey: "telegram:group:-100123",
    });

    const result = await dispatchTelegramMessage(ctx, deps);
    expect(result.text).toBe("Access denied.");
  });

  it("allows DM from allowedChatIds when dmPolicy is allowlist", async () => {
    const config = createTestConfig({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowedChatIds: [42],
        },
      },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchTelegramMessage(ctx, deps);
    expect(result.text).not.toBe("Access denied.");
  });

  it("rejects DM not in allowedChatIds when dmPolicy is allowlist", async () => {
    const config = createTestConfig({
      channels: {
        telegram: {
          dmPolicy: "allowlist",
          allowedChatIds: [999],
        },
      },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchTelegramMessage(ctx, deps);
    expect(result.text).toBe("Access denied.");
  });

  it("allows group message when group is in allowedChatIds", async () => {
    const config = createTestConfig({
      channels: {
        telegram: {
          dmPolicy: "open",
          allowedChatIds: [-100123],
        },
      },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext({
      isGroup: true,
      groupId: "-100123",
      sessionKey: "telegram:group:-100123",
    });

    const result = await dispatchTelegramMessage(ctx, deps);
    expect(result.text).not.toBe("Access denied.");
  });
});

describe("Telegram access control", () => {
  it("open dmPolicy allows any DM", () => {
    expect(
      checkTelegramAccess({
        chatId: 42,
        isGroup: false,
        dmPolicy: "open",
      }),
    ).toBe(true);
  });

  it("disabled dmPolicy blocks all DMs", () => {
    expect(
      checkTelegramAccess({
        chatId: 42,
        isGroup: false,
        dmPolicy: "disabled",
      }),
    ).toBe(false);
  });

  it("allowlist dmPolicy checks allowedChatIds", () => {
    expect(
      checkTelegramAccess({
        chatId: 42,
        isGroup: false,
        dmPolicy: "allowlist",
        allowedChatIds: [42],
      }),
    ).toBe(true);

    expect(
      checkTelegramAccess({
        chatId: 43,
        isGroup: false,
        dmPolicy: "allowlist",
        allowedChatIds: [42],
      }),
    ).toBe(false);
  });

  it("groups disabled rejects all groups", () => {
    expect(
      checkTelegramAccess({
        chatId: -100123,
        isGroup: true,
        dmPolicy: "open",
        groupPolicy: "disabled",
      }),
    ).toBe(false);
  });

  it("groups reject when no allowedChatIds", () => {
    expect(
      checkTelegramAccess({
        chatId: -100123,
        isGroup: true,
        dmPolicy: "open",
      }),
    ).toBe(false);
  });

  it("groups allow when chatId in allowedChatIds", () => {
    expect(
      checkTelegramAccess({
        chatId: -100123,
        isGroup: true,
        dmPolicy: "open",
        allowedChatIds: [-100123],
      }),
    ).toBe(true);
  });

  it("unknown dmPolicy defaults to deny", () => {
    expect(
      checkTelegramAccess({
        chatId: 42,
        isGroup: false,
        dmPolicy: "unknown_policy",
      }),
    ).toBe(false);
  });
});
