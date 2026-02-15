/**
 * Integration: WhatsApp inbound message simulation.
 *
 * Simulates messages.upsert events at the Baileys socket level and verifies
 * they flow through WhatsApp dispatch with correct access control.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

vi.mock("../agents/runner.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    text: "wa-inbound reply",
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
import { checkWhatsAppAccess } from "../channels/whatsapp/access.js";
import { dispatchWhatsAppMessage } from "../channels/whatsapp/dispatch.js";
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
    messageId: "wa-msg-1",
    channel: "whatsapp",
    sessionKey: "whatsapp:dm:123_s.whatsapp.net",
    agentId: "default",
    accountId: "whatsapp-bot",
    senderId: "123@s.whatsapp.net",
    senderName: "Test Sender",
    text: "hello",
    isGroup: false,
    isCommand: false,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("WhatsApp inbound dispatch", () => {
  it("dispatches a valid DM through the pipeline", async () => {
    const config = createTestConfig({
      channels: { whatsapp: { dmPolicy: "open" } },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchWhatsAppMessage(ctx, deps);
    // dispatch returns empty text (streaming delivers the response)
    expect(result).toBeDefined();
  });

  it("rejects DM when dmPolicy is disabled", async () => {
    const config = createTestConfig({
      channels: { whatsapp: { dmPolicy: "disabled" } },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchWhatsAppMessage(ctx, deps);
    expect(result.text).toBe("Access denied.");
  });

  it("rejects group message when groupPolicy is disabled", async () => {
    const config = createTestConfig({
      channels: { whatsapp: { dmPolicy: "open", groupPolicy: "disabled" } },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext({
      isGroup: true,
      groupId: "group123@g.us",
      sessionKey: "whatsapp:group:group123_g.us",
    });

    const result = await dispatchWhatsAppMessage(ctx, deps);
    expect(result.text).toBe("Access denied.");
  });

  it("allows DM from allowlist when dmPolicy is allowlist", async () => {
    const config = createTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["123@s.whatsapp.net"],
        },
      },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchWhatsAppMessage(ctx, deps);
    // Should go through (not "Access denied.")
    expect(result.text).not.toBe("Access denied.");
  });

  it("rejects DM not on allowlist when dmPolicy is allowlist", async () => {
    const config = createTestConfig({
      channels: {
        whatsapp: {
          dmPolicy: "allowlist",
          allowFrom: ["999@s.whatsapp.net"],
        },
      },
    });
    const sessions = createSessionStore();
    const deps = { config, sessions };
    const ctx = makeMsgContext();

    const result = await dispatchWhatsAppMessage(ctx, deps);
    expect(result.text).toBe("Access denied.");
  });
});

describe("WhatsApp access control", () => {
  it("open dmPolicy allows any DM", () => {
    expect(
      checkWhatsAppAccess({
        jid: "anyone@s.whatsapp.net",
        isGroup: false,
        dmPolicy: "open",
      }),
    ).toBe(true);
  });

  it("disabled dmPolicy blocks all DMs", () => {
    expect(
      checkWhatsAppAccess({
        jid: "anyone@s.whatsapp.net",
        isGroup: false,
        dmPolicy: "disabled",
      }),
    ).toBe(false);
  });

  it("allowlist dmPolicy checks allowFrom array", () => {
    expect(
      checkWhatsAppAccess({
        jid: "123@s.whatsapp.net",
        isGroup: false,
        dmPolicy: "allowlist",
        allowFrom: ["123@s.whatsapp.net"],
      }),
    ).toBe(true);

    expect(
      checkWhatsAppAccess({
        jid: "456@s.whatsapp.net",
        isGroup: false,
        dmPolicy: "allowlist",
        allowFrom: ["123@s.whatsapp.net"],
      }),
    ).toBe(false);
  });

  it("groups disabled rejects all group messages", () => {
    expect(
      checkWhatsAppAccess({
        jid: "group@g.us",
        isGroup: true,
        dmPolicy: "open",
        groupPolicy: "disabled",
      }),
    ).toBe(false);
  });

  it("groups enabled with no filter allows all groups", () => {
    expect(
      checkWhatsAppAccess({
        jid: "group@g.us",
        isGroup: true,
        dmPolicy: "open",
        groupPolicy: "enabled",
      }),
    ).toBe(true);
  });

  it("groups enabled with allowFrom filters by JID", () => {
    expect(
      checkWhatsAppAccess({
        jid: "allowed-group@g.us",
        isGroup: true,
        dmPolicy: "open",
        allowFrom: ["allowed-group@g.us"],
      }),
    ).toBe(true);

    expect(
      checkWhatsAppAccess({
        jid: "other-group@g.us",
        isGroup: true,
        dmPolicy: "open",
        allowFrom: ["allowed-group@g.us"],
      }),
    ).toBe(false);
  });
});
