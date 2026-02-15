import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../agents/runner.js", () => ({
  runAgent: vi.fn(),
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

import type { ChatEvent, MsgContext } from "../types/messages.js";
import { createTestConfig } from "../__test__/config.js";
import { runAgent } from "../agents/runner.js";
import { dispatchInboundMessage } from "../pipeline/dispatch.js";
import { stopLaneSweep } from "../pipeline/lanes.js";
import { subscribeStream } from "../pipeline/streaming.js";
import { createSessionStore } from "../sessions/store.js";

afterAll(() => {
  stopLaneSweep();
});

beforeEach(() => {
  vi.clearAllMocks();
});

const TS = new Date("2026-02-15T12:30:00Z").getTime();

function makeContext(overrides: Partial<MsgContext>): MsgContext {
  return {
    messageId: "msg-1",
    sessionKey: "terminal:dm:user-1",
    text: "ping",
    channel: "terminal",
    accountId: "local",
    senderId: "user-1",
    senderName: "User One",
    isGroup: false,
    isCommand: false,
    agentId: "default",
    timestamp: TS,
    ...overrides,
  };
}

describe("Dispatch streaming integration", () => {
  it("serializes same-session stream events in message order", async () => {
    const sessions = createSessionStore();
    const deps = {
      config: createTestConfig(),
      sessions,
    };

    vi.mocked(runAgent).mockImplementation(async (options) => {
      const label = options.prompt.includes("first payload") ? "first" : "second";
      options.onDelta?.(`${label}-delta-1`);
      await Promise.resolve();
      options.onDelta?.(`${label}-delta-2`);
      return {
        text: `${label}-final`,
        messages: [],
        hitTurnLimit: false,
        usage: {
          inputTokens: 2,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        durationMs: 10,
        model: "test-model",
      };
    });

    const events: string[] = [];
    const unsub = subscribeStream("terminal:dm:user-1", (event: ChatEvent) => {
      if (event.type === "delta") {
        events.push(`delta:${event.text}`);
      }
      if (event.type === "final") {
        events.push(`final:${event.text}`);
      }
    });

    const ctx1 = makeContext({
      messageId: "msg-1",
      sessionKey: "terminal:dm:user-1",
      text: "first payload",
    });
    const ctx2 = makeContext({
      messageId: "msg-2",
      sessionKey: "terminal:dm:user-1",
      text: "second payload",
    });

    await Promise.all([dispatchInboundMessage(ctx1, deps), dispatchInboundMessage(ctx2, deps)]);
    unsub();

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(events).toEqual([
      "delta:first-delta-1",
      "delta:first-delta-2",
      "final:first-final",
      "delta:second-delta-1",
      "delta:second-delta-2",
      "final:second-final",
    ]);

    const session = sessions.get("terminal:dm:user-1");
    expect(session).toBeDefined();
    expect(session!.turnCount).toBe(2);
  });

  it("allows cross-session dispatch to complete independently", async () => {
    const sessions = createSessionStore();
    const deps = {
      config: createTestConfig(),
      sessions,
    };

    let releaseA: (() => void) | undefined;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });

    vi.mocked(runAgent).mockImplementation(async (options) => {
      if (options.sessionKey === "terminal:dm:user-A") {
        options.onDelta?.("A-delta");
        await gateA;
        return {
          text: "A-final",
          messages: [],
          hitTurnLimit: false,
          usage: {
            inputTokens: 1,
            outputTokens: 1,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          },
          durationMs: 10,
          model: "test-model",
        };
      }

      options.onDelta?.("B-delta");
      return {
        text: "B-final",
        messages: [],
        hitTurnLimit: false,
        usage: {
          inputTokens: 1,
          outputTokens: 1,
          cacheCreationTokens: 0,
          cacheReadTokens: 0,
        },
        durationMs: 10,
        model: "test-model",
      };
    });

    const eventsA: string[] = [];
    const eventsB: string[] = [];

    const unsubA = subscribeStream("terminal:dm:user-A", (event: ChatEvent) => {
      if (event.type === "delta") {
        eventsA.push(`delta:${event.text}`);
      }
      if (event.type === "final") {
        eventsA.push(`final:${event.text}`);
      }
    });
    const unsubB = subscribeStream("terminal:dm:user-B", (event: ChatEvent) => {
      if (event.type === "delta") {
        eventsB.push(`delta:${event.text}`);
      }
      if (event.type === "final") {
        eventsB.push(`final:${event.text}`);
      }
    });

    const pA = dispatchInboundMessage(
      makeContext({ messageId: "A-1", sessionKey: "terminal:dm:user-A", text: "alpha" }),
      deps,
    );
    await Promise.resolve();

    const pB = dispatchInboundMessage(
      makeContext({ messageId: "B-1", sessionKey: "terminal:dm:user-B", text: "beta" }),
      deps,
    );

    await pB;
    expect(eventsB).toContain("final:B-final");
    expect(eventsA).not.toContain("final:A-final");

    releaseA!();
    await pA;

    expect(eventsA).toContain("final:A-final");
    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);

    unsubA();
    unsubB();
  });
});
