import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelPlugin } from "../types/channels.js";
import type { HeartbeatEvent } from "../types/heartbeat.js";
import type { ReplyPayload } from "../types/messages.js";
import { createTestConfig } from "../__test__/config.js";
import { deliverHeartbeatEvent } from "../heartbeat/delivery.js";
import { resolveVisibility } from "../heartbeat/visibility.js";
import { subscribeStream } from "../pipeline/streaming.js";
import { createSessionEntry, createSessionStore } from "../sessions/store.js";

const LONG_TEXT = `ALERT:${"X".repeat(450)}`;

function createHeartbeatEvent(overrides?: Partial<HeartbeatEvent>): HeartbeatEvent {
  return {
    type: "heartbeat",
    agentId: "agent-1",
    timestamp: Date.now(),
    hasContent: true,
    text: LONG_TEXT,
    wasOk: false,
    durationMs: 20,
    ...overrides,
  };
}

function createChannel(params?: {
  id?: ChannelPlugin["id"];
  maxTextLength?: number;
  ready?: boolean;
  sendImpl?: (to: string, payload: ReplyPayload) => Promise<string | undefined>;
}): ChannelPlugin & { sendMock: ReturnType<typeof vi.fn> } {
  const id = params?.id ?? "telegram";
  const sendMock = vi.fn(
    params?.sendImpl ??
      (async () => {
        return "msg-id";
      }),
  );

  return {
    id,
    name: `Mock ${id}`,
    capabilities: {
      markdown: true,
      images: false,
      audio: false,
      video: false,
      documents: false,
      reactions: false,
      editing: false,
      streaming: true,
      maxTextLength: params?.maxTextLength ?? 4096,
    },
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    send: sendMock,
    isReady: vi.fn(() => params?.ready ?? true),
    sendMock,
  };
}

describe("heartbeat delivery routing integration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers long heartbeat content to last active channel with chunking", async () => {
    const config = createTestConfig();
    const sessions = createSessionStore();
    sessions.set(
      "heartbeat:agent-1",
      createSessionEntry({
        sessionKey: "heartbeat:agent-1",
        agentId: "agent-1",
        channel: "telegram",
        peerId: "user-42",
      }),
    );

    const telegram = createChannel({ id: "telegram", maxTextLength: 100 });
    const terminalEvents: string[] = [];
    const unsub = subscribeStream("terminal:dm:local", (event) => {
      if (event.type === "final") {
        terminalEvents.push(event.text);
      }
    });

    deliverHeartbeatEvent(createHeartbeatEvent(), {
      sessions,
      visibility: resolveVisibility(config.heartbeat.visibility),
      getChannel: (name) => (name === "telegram" ? telegram : undefined),
    });

    await vi.waitFor(() => {
      expect(telegram.sendMock).toHaveBeenCalledTimes(5);
    });
    expect(terminalEvents).toHaveLength(0);
    expect(telegram.sendMock).toHaveBeenNthCalledWith(1, "user-42", {
      text: expect.stringContaining("ALERT:"),
    });

    unsub();
  });

  it("falls back to terminal when target channel is not ready", async () => {
    const config = createTestConfig();
    const sessions = createSessionStore();
    sessions.set(
      "heartbeat:agent-1",
      createSessionEntry({
        sessionKey: "heartbeat:agent-1",
        agentId: "agent-1",
        channel: "telegram",
        peerId: "user-99",
      }),
    );

    const telegram = createChannel({ id: "telegram", ready: false });
    const terminalEvents: string[] = [];
    const unsub = subscribeStream("terminal:dm:local", (event) => {
      if (event.type === "final") {
        terminalEvents.push(event.text);
      }
    });

    deliverHeartbeatEvent(createHeartbeatEvent(), {
      sessions,
      visibility: resolveVisibility(config.heartbeat.visibility),
      getChannel: (name) => (name === "telegram" ? telegram : undefined),
    });

    expect(telegram.sendMock).not.toHaveBeenCalled();
    expect(terminalEvents).toHaveLength(1);
    expect(terminalEvents[0]).toContain("💓");
    expect(terminalEvents[0]).toContain("ALERT:");

    unsub();
  });

  it("falls back to terminal when channel delivery fails", async () => {
    const config = createTestConfig();
    const sessions = createSessionStore();
    sessions.set(
      "heartbeat:agent-1",
      createSessionEntry({
        sessionKey: "heartbeat:agent-1",
        agentId: "agent-1",
        channel: "telegram",
        peerId: "user-fail",
      }),
    );

    const telegram = createChannel({
      id: "telegram",
      sendImpl: async () => {
        throw new Error("simulated channel failure");
      },
    });

    const terminalEvents: string[] = [];
    const unsub = subscribeStream("terminal:dm:local", (event) => {
      if (event.type === "final") {
        terminalEvents.push(event.text);
      }
    });

    deliverHeartbeatEvent(createHeartbeatEvent(), {
      sessions,
      visibility: resolveVisibility(config.heartbeat.visibility),
      getChannel: (name) => (name === "telegram" ? telegram : undefined),
    });

    await vi.waitFor(() => {
      expect(telegram.sendMock).toHaveBeenCalled();
      expect(terminalEvents).toHaveLength(1);
    });
    expect(terminalEvents[0]).toContain("ALERT:");

    unsub();
  });

  it("suppresses acknowledgment-like heartbeat text", () => {
    const config = createTestConfig();
    const sessions = createSessionStore();
    const telegram = createChannel({ id: "telegram" });
    const terminalEvents: string[] = [];
    const unsub = subscribeStream("terminal:dm:local", (event) => {
      if (event.type === "final") {
        terminalEvents.push(event.text);
      }
    });

    deliverHeartbeatEvent(
      createHeartbeatEvent({
        hasContent: true,
        wasOk: false,
        text: "All clear.",
      }),
      {
        sessions,
        visibility: resolveVisibility(config.heartbeat.visibility),
        getChannel: (name) => (name === "telegram" ? telegram : undefined),
      },
    );

    expect(telegram.sendMock).not.toHaveBeenCalled();
    expect(terminalEvents).toHaveLength(0);

    unsub();
  });

  it("suppresses ok heartbeats when showOk is disabled", () => {
    const config = createTestConfig({ heartbeat: { visibility: { showOk: false } } });
    const sessions = createSessionStore();
    const telegram = createChannel({ id: "telegram" });
    const terminalEvents: string[] = [];
    const unsub = subscribeStream("terminal:dm:local", (event) => {
      if (event.type === "final") {
        terminalEvents.push(event.text);
      }
    });

    deliverHeartbeatEvent(
      createHeartbeatEvent({
        hasContent: false,
        wasOk: true,
        text: undefined,
      }),
      {
        sessions,
        visibility: resolveVisibility(config.heartbeat.visibility),
        getChannel: (name) => (name === "telegram" ? telegram : undefined),
      },
    );

    expect(telegram.sendMock).not.toHaveBeenCalled();
    expect(terminalEvents).toHaveLength(0);

    unsub();
  });
});
