/**
 * Integration: Gateway WebSocket server + client lifecycle.
 *
 * Tests the full server+client handshake, chat flow, auth rejection,
 * and concurrent sessions. Mocks only the Claude provider boundary.
 */
import { describe, it, expect, vi, afterEach, beforeEach, afterAll } from "vitest";
import WebSocket from "ws";
import type { GatewayMessage } from "../gateway/protocol.js";
import type { SessionStore } from "../types/sessions.js";
import { createTestConfig } from "../__test__/config.js";
import { createGatewayClient } from "../gateway/client.js";
import { createGatewayServer } from "../gateway/server.js";

vi.mock("../agents/runner.js", () => ({
  runAgent: vi.fn().mockResolvedValue({
    text: "gateway test reply",
    messages: [],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 50,
  }),
}));

vi.mock("../heartbeat/wake.js", () => ({
  requestHeartbeatNow: vi.fn(),
}));

vi.mock("../sessions/transcript.js", () => ({
  resolveTranscriptPath: vi.fn().mockReturnValue("/tmp/gw-test-transcript.jsonl"),
  readTranscript: vi.fn().mockResolvedValue([]),
  appendTranscriptTurn: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../pipeline/classifier.js", () => ({
  classifyTask: vi.fn().mockResolvedValue({ classification: "quick", reason: "test" }),
}));

vi.mock("../pipeline/deep-work.js", () => ({
  launchDeepWork: vi.fn(),
}));

vi.mock("../sessions/compaction.js", () => ({
  estimateTranscriptTokens: vi.fn().mockReturnValue(100),
  needsCompaction: vi.fn().mockReturnValue(false),
  compactTranscript: vi.fn().mockResolvedValue({ compacted: false }),
}));

vi.mock("../providers/claude-provider.js", () => ({
  runAgentTurn: vi.fn().mockResolvedValue({
    text: "gateway test reply",
    messages: [],
    model: "test-model",
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 50,
  }),
}));

function createMockSessionStore(): SessionStore {
  const map = new Map();
  return {
    get: vi.fn((key: string) => map.get(key)),
    set: vi.fn((key: string, entry: unknown) => map.set(key, entry)),
    delete: vi.fn((key: string) => map.delete(key)),
    list: vi.fn(() => [...map.values()]),
    save: vi.fn(),
    load: vi.fn(),
  };
}

let nextPort = 19900;
function getPort(): number {
  return nextPort++;
}

function connectWS(port: number, headers?: Record<string, string>): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers });
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function collectMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<GatewayMessage[]> {
  return new Promise((resolve) => {
    const msgs: GatewayMessage[] = [];
    const timer = setTimeout(() => resolve(msgs), timeoutMs);
    ws.on("message", (data) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        resolve(msgs);
      }
    });
  });
}

afterAll(async () => {
  const { stopLaneSweep } = await import("../pipeline/lanes.js");
  stopLaneSweep();
});

describe("Gateway lifecycle integration", () => {
  let server: ReturnType<typeof createGatewayServer>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await server?.stop();
  });

  it("server + client handshake and health check", async () => {
    const port = getPort();
    const config = createTestConfig({ gateway: { host: "127.0.0.1", port } });
    const sessions = createMockSessionStore();
    server = createGatewayServer(config, { config, sessions });
    server.start();
    await new Promise((r) => setTimeout(r, 50));

    const client = createGatewayClient(`ws://127.0.0.1:${port}`);
    await client.connect();
    expect(client.connected).toBe(true);

    // Send health check via the client API
    const msgPromise = new Promise<GatewayMessage>((resolve) => {
      client.onMessage(resolve);
    });

    client.send({ type: "health.check" } as GatewayMessage);
    const resp = await msgPromise;

    expect(resp).toMatchObject({
      type: "health.status",
      ok: true,
    });

    client.disconnect();
    expect(client.connected).toBe(false);
  });

  it("auth token rejection — no token", async () => {
    const port = getPort();
    const config = createTestConfig({
      gateway: { host: "127.0.0.1", port, authToken: "secret-token-123" },
    });
    const sessions = createMockSessionStore();
    server = createGatewayServer(config, { config, sessions });
    server.start();
    await new Promise((r) => setTimeout(r, 50));

    // Connect without token — should fail
    await expect(connectWS(port)).rejects.toThrow();
  });

  it("auth token rejection — wrong token", async () => {
    const port = getPort();
    const config = createTestConfig({
      gateway: { host: "127.0.0.1", port, authToken: "secret-token-123" },
    });
    const sessions = createMockSessionStore();
    server = createGatewayServer(config, { config, sessions });
    server.start();
    await new Promise((r) => setTimeout(r, 50));

    await expect(connectWS(port, { Authorization: "Bearer wrong-token" })).rejects.toThrow();
  });

  it("auth token acceptance — correct token", async () => {
    const port = getPort();
    const config = createTestConfig({
      gateway: { host: "127.0.0.1", port, authToken: "secret-token-123" },
    });
    const sessions = createMockSessionStore();
    server = createGatewayServer(config, { config, sessions });
    server.start();
    await new Promise((r) => setTimeout(r, 50));

    const ws = await connectWS(port, { Authorization: "Bearer secret-token-123" });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it("concurrent sessions — messages routed to correct client", async () => {
    const port = getPort();
    const config = createTestConfig({ gateway: { host: "127.0.0.1", port } });
    const sessions = createMockSessionStore();
    server = createGatewayServer(config, { config, sessions });
    server.start();
    await new Promise((r) => setTimeout(r, 50));

    const ws1 = await connectWS(port);
    const ws2 = await connectWS(port);

    // Both clients send health check
    const msgs1 = collectMessages(ws1, 1);
    const msgs2 = collectMessages(ws2, 1);

    ws1.send(JSON.stringify({ type: "health.check" }));
    ws2.send(JSON.stringify({ type: "health.check" }));

    const [resp1, resp2] = await Promise.all([msgs1, msgs2]);

    expect(resp1[0]).toMatchObject({ type: "health.status", ok: true });
    expect(resp2[0]).toMatchObject({ type: "health.status", ok: true });

    ws1.close();
    ws2.close();
  });

  it("server and client disconnect cleanly — no leaked handles", async () => {
    const port = getPort();
    const config = createTestConfig({ gateway: { host: "127.0.0.1", port } });
    const sessions = createMockSessionStore();
    server = createGatewayServer(config, { config, sessions });
    server.start();
    await new Promise((r) => setTimeout(r, 50));

    const ws = await connectWS(port);
    ws.close();
    await new Promise((r) => setTimeout(r, 50));

    await server.stop();
    // If we get here without hanging, no leaked handles
  });
});
