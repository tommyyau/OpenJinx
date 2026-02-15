import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChannelPlugin } from "../types/channels.js";
import type { SessionEntry, SessionStore } from "../types/sessions.js";
import { createTestConfig } from "../__test__/config.js";

const mockRunAgent = vi.fn();
vi.mock("../agents/runner.js", () => ({
  runAgent: (...args: unknown[]) => mockRunAgent(...args),
}));

const mockDeliverOutboundPayloads = vi.fn();
vi.mock("../delivery/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => mockDeliverOutboundPayloads(...args),
}));

vi.mock("../sessions/transcript.js", () => ({
  resolveTranscriptPath: vi.fn().mockReturnValue("/tmp/deepwork-transcript.jsonl"),
}));

const mockEmitStreamEvent = vi.fn();
vi.mock("./streaming.js", () => ({
  emitStreamEvent: (...args: unknown[]) => mockEmitStreamEvent(...args),
}));

const mockReadFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  default: { readFile: (...args: unknown[]) => mockReadFile(...args) },
}));

const { launchDeepWork } = await import("./deep-work.js");

function createMockSessionStore(): SessionStore {
  const map = new Map<string, SessionEntry>();
  return {
    get: vi.fn((key: string) => map.get(key)),
    set: vi.fn((key: string, entry: SessionEntry) => map.set(key, entry)),
    delete: vi.fn((key: string) => map.delete(key)),
    list: vi.fn(() => [...map.values()]),
    save: vi.fn(),
    load: vi.fn(),
  };
}

function createMockChannel(ready = true): ChannelPlugin {
  return {
    id: "whatsapp",
    name: "WhatsApp",
    capabilities: { maxTextLength: 4096 },
    isReady: () => ready,
    send: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  } as unknown as ChannelPlugin;
}

const defaultParams = {
  prompt: "[WhatsApp Tommy] Compare Redis vs Memcached for session caching",
  originSessionKey: "whatsapp:dm:user1",
  deliveryTarget: { channel: "whatsapp" as const, to: "user1" },
  channel: "whatsapp" as const,
  senderName: "Tommy",
};

describe("launchDeepWork", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRunAgent.mockResolvedValue({
      text: "Here is the comparison...",
      messages: [],
      hitTurnLimit: false,
      usage: { inputTokens: 500, outputTokens: 200, cacheCreationTokens: 0, cacheReadTokens: 0 },
      durationMs: 5000,
      model: "sonnet",
    });
    mockDeliverOutboundPayloads.mockResolvedValue({
      channel: "whatsapp",
      to: "user1",
      textChunks: 1,
      mediaItems: 0,
      success: true,
    });
  });

  it("emits ack on the origin session key", async () => {
    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    // Ack is synchronous — should be emitted immediately
    expect(mockEmitStreamEvent).toHaveBeenCalledWith("whatsapp:dm:user1", {
      type: "final",
      text: "Working on this — I'll get back to you when it's done.",
    });
  });

  it("creates a session with deepwork: prefix and parentSessionKey", async () => {
    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    // Wait for async work to complete
    await vi.waitFor(() => {
      expect(sessions.set).toHaveBeenCalled();
    });

    const setCall = vi.mocked(sessions.set).mock.calls[0];
    const sessionKey = setCall[0];
    const entry = setCall[1];

    expect(sessionKey).toMatch(/^deepwork:[a-f0-9]{8}$/);
    expect(entry.parentSessionKey).toBe("whatsapp:dm:user1");
    expect(entry.channel).toBe("whatsapp");
  });

  it("calls runAgent with tier brain and sessionType main", async () => {
    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    await vi.waitFor(() => {
      expect(mockRunAgent).toHaveBeenCalled();
    });

    expect(mockRunAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        tier: "brain",
        sessionType: "main",
      }),
    );

    // Prompt should start with the original text and include delivery note
    const call0 = mockRunAgent.mock.calls[0][0];
    expect(call0.prompt).toContain(defaultParams.prompt);
    expect(call0.prompt).toContain("async deep-work task");

    // Session key should have deepwork: prefix
    const call = mockRunAgent.mock.calls[0][0];
    expect(call.sessionKey).toMatch(/^deepwork:/);
  });

  it("delivers result via deliverOutboundPayloads on completion", async () => {
    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    await vi.waitFor(() => {
      expect(mockDeliverOutboundPayloads).toHaveBeenCalled();
    });

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ text: "Here is the comparison..." }),
        target: { channel: "whatsapp", to: "user1" },
      }),
    );
  });

  it("delivers error message when runAgent throws", async () => {
    mockRunAgent.mockRejectedValueOnce(new Error("Deep work timed out after 900s"));

    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    await vi.waitFor(() => {
      expect(mockDeliverOutboundPayloads).toHaveBeenCalled();
    });

    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    expect(call.payload.text).toContain("Deep work timed out after 900s");
  });

  it("falls back to terminal when channel is not ready", async () => {
    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel(false); // not ready

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    await vi.waitFor(() => {
      // Should have emitted to terminal as fallback (ack + terminal fallback)
      expect(mockEmitStreamEvent).toHaveBeenCalledTimes(2);
    });

    const terminalCall = mockEmitStreamEvent.mock.calls[1];
    expect(terminalCall[0]).toBe("terminal:dm:local");
    expect(terminalCall[1]).toEqual({
      type: "final",
      text: "Here is the comparison...",
    });
  });

  it("extracts written files as media attachments with correct MIME types", async () => {
    mockReadFile.mockResolvedValue(Buffer.from("# Report content"));

    mockRunAgent.mockResolvedValueOnce({
      text: "I wrote a file for you.",
      messages: [
        {
          role: "assistant",
          content: "done",
          toolCalls: [
            { id: "tc1", name: "write", input: { path: "/tmp/report.md" }, output: "written" },
          ],
        },
      ],
      hitTurnLimit: false,
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      durationMs: 1000,
      model: "sonnet",
    });

    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    await vi.waitFor(() => {
      expect(mockDeliverOutboundPayloads).toHaveBeenCalled();
    });

    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    expect(call.payload.media).toBeDefined();
    expect(call.payload.media).toHaveLength(1);
    expect(call.payload.media[0].filename).toBe("report.md");
    expect(call.payload.media[0].mimeType).toBe("text/markdown");
  });

  it("handles file read failure gracefully during extraction", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));

    mockRunAgent.mockResolvedValueOnce({
      text: "I tried to write a file.",
      messages: [
        {
          role: "assistant",
          content: "done",
          toolCalls: [
            { id: "tc1", name: "write", input: { path: "/tmp/missing.txt" }, output: "written" },
          ],
        },
      ],
      hitTurnLimit: false,
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
      durationMs: 1000,
      model: "sonnet",
    });

    const config = createTestConfig();
    const sessions = createMockSessionStore();
    const channel = createMockChannel();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map([["whatsapp", channel]]),
    });

    await vi.waitFor(() => {
      expect(mockDeliverOutboundPayloads).toHaveBeenCalled();
    });

    const call = mockDeliverOutboundPayloads.mock.calls[0][0];
    // No media since file read failed
    expect(call.payload.media).toBeUndefined();
  });

  it("falls back to terminal when channel map is empty", async () => {
    const config = createTestConfig();
    const sessions = createMockSessionStore();

    launchDeepWork(defaultParams, {
      config,
      sessions,
      channels: new Map(),
    });

    await vi.waitFor(() => {
      expect(mockEmitStreamEvent).toHaveBeenCalledTimes(2);
    });

    const terminalCall = mockEmitStreamEvent.mock.calls[1];
    expect(terminalCall[0]).toBe("terminal:dm:local");
  });
});
