import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const TS = new Date("2026-02-15T13:00:00Z").getTime();

function makeContext(overrides: Partial<MsgContext>): MsgContext {
  return {
    messageId: "msg-1",
    sessionKey: "terminal:dm:user-timeout",
    text: "hello",
    channel: "terminal",
    accountId: "local",
    senderId: "user-timeout",
    senderName: "Timeout User",
    isGroup: false,
    isCommand: false,
    agentId: "default",
    timestamp: TS,
    ...overrides,
  };
}

describe("Dispatch timeout lane integration", () => {
  it("times out first same-session turn, then drains queued turn with final event", async () => {
    const sessions = createSessionStore();
    const deps = {
      config: createTestConfig(),
      sessions,
    };

    let callCount = 0;
    vi.mocked(runAgent).mockImplementation(async (options) => {
      callCount++;
      if (callCount === 1) {
        return await new Promise(() => {
          // Simulate hung provider turn to exercise withTimeout path.
        });
      }
      options.onDelta?.("after-timeout-delta");
      return {
        text: "after-timeout-final",
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

    const eventTypes: string[] = [];
    const unsub = subscribeStream("terminal:dm:user-timeout", (event: ChatEvent) => {
      if (event.type === "aborted") {
        eventTypes.push(`aborted:${event.reason}`);
      }
      if (event.type === "final") {
        eventTypes.push(`final:${event.text}`);
      }
    });

    const p1 = dispatchInboundMessage(
      makeContext({ messageId: "msg-timeout-1", text: "first hangs" }),
      deps,
    );
    const p2 = dispatchInboundMessage(
      makeContext({ messageId: "msg-timeout-2", text: "second should run after timeout" }),
      deps,
    );

    // Dispatch timeout is 5 minutes in production.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    await Promise.all([p1, p2]);
    unsub();

    expect(vi.mocked(runAgent)).toHaveBeenCalledTimes(2);
    expect(eventTypes[0]).toContain("aborted:Agent turn timed out after 300s");
    expect(eventTypes[1]).toBe("final:after-timeout-final");

    const session = sessions.get("terminal:dm:user-timeout");
    expect(session).toBeDefined();
    // Only successful turns increment token/session counters.
    expect(session!.turnCount).toBe(1);
  });

  it("does not let one timed-out session block another session lane", async () => {
    const sessions = createSessionStore();
    const deps = {
      config: createTestConfig(),
      sessions,
    };

    vi.mocked(runAgent).mockImplementation(async (options) => {
      if (options.sessionKey === "terminal:dm:user-A") {
        return await new Promise(() => {
          // Force timeout for user A.
        });
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
      if (event.type === "aborted") {
        eventsA.push("aborted");
      }
      if (event.type === "final") {
        eventsA.push("final");
      }
    });
    const unsubB = subscribeStream("terminal:dm:user-B", (event: ChatEvent) => {
      if (event.type === "final") {
        eventsB.push(`final:${event.text}`);
      }
    });

    const pA = dispatchInboundMessage(
      makeContext({ messageId: "msg-A", sessionKey: "terminal:dm:user-A", senderId: "user-A" }),
      deps,
    );
    const pB = dispatchInboundMessage(
      makeContext({ messageId: "msg-B", sessionKey: "terminal:dm:user-B", senderId: "user-B" }),
      deps,
    );

    await pB;
    expect(eventsB).toEqual(["final:B-final"]);
    expect(eventsA).toEqual([]);

    await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
    await pA;

    expect(eventsA).toEqual(["aborted"]);

    unsubA();
    unsubB();
  });
});
