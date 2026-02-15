import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppSessionEvents } from "./session.js";

// Event handler registry — populated by the mock
type EventHandler = (...args: unknown[]) => void;
const eventHandlers = new Map<string, EventHandler[]>();

const mockSaveCreds = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockSendPresenceUpdate = vi.fn().mockResolvedValue(undefined);
const mockEnd = vi.fn();

// Mock QR renderer
const mockRenderQr = vi.fn().mockReturnValue("MOCK_QR_OUTPUT");

vi.mock("./render-qr.js", () => ({
  renderQrToTerminal: mockRenderQr,
}));

vi.mock("baileys", () => ({
  Browsers: { ubuntu: (name: string) => ["Ubuntu", name, "22.04"] },
  DisconnectReason: { loggedOut: 401, restartRequired: 515 },
  useMultiFileAuthState: vi.fn().mockResolvedValue({
    state: { creds: { me: { id: "447968984216:17@s.whatsapp.net" } }, keys: {} },
    saveCreds: mockSaveCreds,
  }),
  makeWASocket: vi.fn(() => ({
    ev: {
      on(event: string, handler: EventHandler) {
        const handlers = eventHandlers.get(event) ?? [];
        handlers.push(handler);
        eventHandlers.set(event, handlers);
      },
    },
    sendMessage: mockSendMessage,
    sendPresenceUpdate: mockSendPresenceUpdate,
    end: mockEnd,
  })),
}));

describe("createWhatsAppSession", () => {
  let createWhatsAppSession: typeof import("./session.js").createWhatsAppSession;
  let makeWASocketMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    eventHandlers.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    const mod = await import("./session.js");
    createWhatsAppSession = mod.createWhatsAppSession;
    const baileys = await import("baileys");
    makeWASocketMock = vi.mocked(baileys.makeWASocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeEvents(overrides?: Partial<WhatsAppSessionEvents>): WhatsAppSessionEvents {
    return {
      onMessage: vi.fn(),
      onConnectionUpdate: vi.fn(),
      ...overrides,
    };
  }

  function fireEvent(name: string, ...args: unknown[]) {
    const handlers = eventHandlers.get(name) ?? [];
    for (const h of handlers) {
      h(...args);
    }
  }

  it("wires creds.update to saveCreds", async () => {
    const events = makeEvents();
    await createWhatsAppSession("/tmp/auth", events);

    expect(eventHandlers.has("creds.update")).toBe(true);

    // Fire creds update
    fireEvent("creds.update");
    expect(mockSaveCreds).toHaveBeenCalled();
  });

  it("filters out fromMe messages", async () => {
    const onMessage = vi.fn();
    await createWhatsAppSession("/tmp/auth", makeEvents({ onMessage }));

    fireEvent("messages.upsert", {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", fromMe: true, id: "m1" },
          message: { conversation: "hi" },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("forwards non-fromMe notify messages", async () => {
    const onMessage = vi.fn();
    await createWhatsAppSession("/tmp/auth", makeEvents({ onMessage }));

    const msg = {
      key: { remoteJid: "123@s.whatsapp.net", fromMe: false, id: "m2" },
      message: { conversation: "hello" },
    };

    fireEvent("messages.upsert", { type: "notify", messages: [msg] });

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("allows fromMe messages in self-chat (Message Yourself)", async () => {
    const onMessage = vi.fn();
    await createWhatsAppSession("/tmp/auth", makeEvents({ onMessage }));

    const msg = {
      key: { remoteJid: "447968984216@s.whatsapp.net", fromMe: true, id: "m-self" },
      message: { conversation: "hello jinx" },
    };

    fireEvent("messages.upsert", { type: "notify", messages: [msg] });

    expect(onMessage).toHaveBeenCalledWith(msg);
  });

  it("filters out history sync messages (type !== notify)", async () => {
    const onMessage = vi.fn();
    await createWhatsAppSession("/tmp/auth", makeEvents({ onMessage }));

    fireEvent("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { remoteJid: "123@s.whatsapp.net", fromMe: false, id: "m3" },
          message: { conversation: "history" },
        },
      ],
    });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("tracks isConnected state on connection open", async () => {
    const events = makeEvents();
    const { socket } = await createWhatsAppSession("/tmp/auth", events);

    expect(socket.isConnected).toBe(false);

    fireEvent("connection.update", { connection: "open" });
    expect(socket.isConnected).toBe(true);
  });

  it("tracks isConnected state on connection close", async () => {
    const events = makeEvents();
    const { socket } = await createWhatsAppSession("/tmp/auth", events);

    fireEvent("connection.update", { connection: "open" });
    expect(socket.isConnected).toBe(true);

    fireEvent("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 428 } } },
    });
    expect(socket.isConnected).toBe(false);
  });

  it("detects loggedOut from disconnect reason", async () => {
    const onConnectionUpdate = vi.fn();
    await createWhatsAppSession("/tmp/auth", makeEvents({ onConnectionUpdate }));

    fireEvent("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    expect(onConnectionUpdate).toHaveBeenCalledWith(expect.objectContaining({ isLoggedOut: true }));
  });

  it("end() disconnects the socket", async () => {
    const events = makeEvents();
    const { socket } = await createWhatsAppSession("/tmp/auth", events);

    fireEvent("connection.update", { connection: "open" });
    expect(socket.isConnected).toBe(true);

    socket.end();
    expect(socket.isConnected).toBe(false);
    expect(mockEnd).toHaveBeenCalled();
  });

  it("sendMessage delegates to Baileys socket", async () => {
    const events = makeEvents();
    const { socket } = await createWhatsAppSession("/tmp/auth", events);

    await socket.sendMessage("123@s.whatsapp.net", { text: "hi" });
    expect(mockSendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", { text: "hi" });
  });

  it("sendPresenceUpdate delegates to Baileys socket", async () => {
    const events = makeEvents();
    const { socket } = await createWhatsAppSession("/tmp/auth", events);

    await socket.sendPresenceUpdate("composing", "123@s.whatsapp.net");
    expect(mockSendPresenceUpdate).toHaveBeenCalledWith("composing", "123@s.whatsapp.net");
  });

  it("cleanup() calls end()", async () => {
    const events = makeEvents();
    const { cleanup } = await createWhatsAppSession("/tmp/auth", events);

    cleanup();
    expect(mockEnd).toHaveBeenCalled();
  });

  it("auto-reconnects on non-logout disconnect", async () => {
    const events = makeEvents();
    await createWhatsAppSession("/tmp/auth", events);

    const initialCallCount = makeWASocketMock.mock.calls.length;

    // Disconnect with 515 (restart required) — should trigger reconnect
    fireEvent("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(3000);

    expect(makeWASocketMock.mock.calls.length).toBe(initialCallCount + 1);
  });

  it("does not reconnect on logout disconnect", async () => {
    const events = makeEvents();
    await createWhatsAppSession("/tmp/auth", events);

    const initialCallCount = makeWASocketMock.mock.calls.length;

    // Disconnect with 401 (logged out) — should NOT reconnect
    fireEvent("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 401 } } },
    });

    // Advance past reconnect delay
    await vi.advanceTimersByTimeAsync(5000);

    expect(makeWASocketMock.mock.calls.length).toBe(initialCallCount);
  });

  it("does not reconnect after end() is called", async () => {
    const events = makeEvents();
    const { socket } = await createWhatsAppSession("/tmp/auth", events);

    const initialCallCount = makeWASocketMock.mock.calls.length;

    socket.end();

    // Simulate a close event that might come during shutdown
    fireEvent("connection.update", {
      connection: "close",
      lastDisconnect: { error: { output: { statusCode: 515 } } },
    });

    await vi.advanceTimersByTimeAsync(5000);

    expect(makeWASocketMock.mock.calls.length).toBe(initialCallCount);
  });

  it("passes browserName to Browsers.ubuntu()", async () => {
    const events = makeEvents();
    await createWhatsAppSession("/tmp/auth", events, "MyBot");

    const baileys = await import("baileys");
    const socketCalls = vi.mocked(baileys.makeWASocket).mock.calls;
    const lastCall = socketCalls[socketCalls.length - 1];
    const options = lastCall[0] as { browser?: unknown };

    // Browsers.ubuntu("MyBot") returns ["Ubuntu", "MyBot", "22.04"]
    expect(options.browser).toEqual(["Ubuntu", "MyBot", "22.04"]);
  });

  it("defaults browserName to Jinx when not provided", async () => {
    const events = makeEvents();
    await createWhatsAppSession("/tmp/auth", events);

    const baileys = await import("baileys");
    const socketCalls = vi.mocked(baileys.makeWASocket).mock.calls;
    const lastCall = socketCalls[socketCalls.length - 1];
    const options = lastCall[0] as { browser?: unknown };

    expect(options.browser).toEqual(["Ubuntu", "Jinx", "22.04"]);
  });

  it("renders QR code to terminal when received", async () => {
    const onConnectionUpdate = vi.fn();
    await createWhatsAppSession("/tmp/auth", makeEvents({ onConnectionUpdate }));

    fireEvent("connection.update", { qr: "QR_DATA_STRING" });

    expect(mockRenderQr).toHaveBeenCalledWith("QR_DATA_STRING");
    expect(onConnectionUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ qr: "QR_DATA_STRING" }),
    );
  });
});
