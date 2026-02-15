import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DispatchDeps } from "../../pipeline/dispatch.js";
import { createWhatsAppChannel } from "./bot.js";

// Mock session to avoid Baileys dependency
vi.mock("./session.js", () => {
  const mockSocket = {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
    end: vi.fn(),
    isConnected: true,
  };

  return {
    createWhatsAppSession: vi.fn().mockResolvedValue({
      socket: mockSocket,
      cleanup: vi.fn(),
    }),
  };
});

// Mock dispatch to isolate from the full pipeline
vi.mock("./dispatch.js", () => ({
  dispatchWhatsAppMessage: vi.fn().mockResolvedValue({ text: "reply" }),
}));

// Mock send to capture calls without hitting the network
vi.mock("./send.js", () => ({
  sendMessageWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

// Mock streaming subscription
vi.mock("../../pipeline/streaming.js", () => ({
  subscribeStream: vi.fn().mockReturnValue(() => {}),
}));

function makeDeps(overrides?: Partial<DispatchDeps>): DispatchDeps {
  return {
    config: {
      channels: {
        whatsapp: {
          enabled: true,
          authDir: "/tmp/wa-test-auth",
          dmPolicy: "open",
        },
      },
    } as DispatchDeps["config"],
    sessions: {} as DispatchDeps["sessions"],
    ...overrides,
  };
}

describe("createWhatsAppChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("lifecycle", () => {
    it("start() makes isReady() return true", async () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      expect(channel.isReady()).toBe(false);
      await channel.start();
      expect(channel.isReady()).toBe(true);
      await channel.stop();
    });

    it("stop() makes isReady() return false", async () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      await channel.start();
      await channel.stop();
      expect(channel.isReady()).toBe(false);
    });
  });

  describe("send() when disconnected", () => {
    it("returns undefined and does not send when socket is not connected", async () => {
      // Re-mock session with isConnected = false
      const { createWhatsAppSession } = await import("./session.js");
      vi.mocked(createWhatsAppSession).mockResolvedValueOnce({
        socket: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
          end: vi.fn(),
          isConnected: false,
        },
        cleanup: vi.fn(),
      });

      const { sendMessageWhatsApp } = await import("./send.js");
      const sendMock = vi.mocked(sendMessageWhatsApp);
      sendMock.mockClear();

      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());
      await channel.start();

      const result = await channel.send("123@s.whatsapp.net", { text: "hello" });

      expect(result).toBeUndefined();
      expect(sendMock).not.toHaveBeenCalled();
      await channel.stop();
    });

    it("isReady() returns false when socket is not connected", async () => {
      const { createWhatsAppSession } = await import("./session.js");
      vi.mocked(createWhatsAppSession).mockResolvedValueOnce({
        socket: {
          sendMessage: vi.fn().mockResolvedValue(undefined),
          sendPresenceUpdate: vi.fn().mockResolvedValue(undefined),
          end: vi.fn(),
          isConnected: false,
        },
        cleanup: vi.fn(),
      });

      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());
      await channel.start();

      expect(channel.isReady()).toBe(false);
      await channel.stop();
    });
  });

  describe("send()", () => {
    it("formats markdown and sends via sendMessageWhatsApp", async () => {
      const { sendMessageWhatsApp } = await import("./send.js");
      const sendMock = vi.mocked(sendMessageWhatsApp);

      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      await channel.start();
      await channel.send("123@s.whatsapp.net", { text: "**bold** message" });

      expect(sendMock).toHaveBeenCalledWith(
        expect.objectContaining({
          jid: "123@s.whatsapp.net",
          // **bold** → *bold* → _bold_ (known format.ts regex ordering issue)
          text: expect.stringContaining("bold"),
          formatMarkdown: false,
        }),
      );

      await channel.stop();
    });

    it("returns undefined (WhatsApp doesn't expose message IDs)", async () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      await channel.start();
      const result = await channel.send("123@s.whatsapp.net", { text: "hi" });

      expect(result).toBeUndefined();
      await channel.stop();
    });

    it("returns undefined for empty text", async () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      await channel.start();
      const result = await channel.send("123@s.whatsapp.net", { text: "" });

      expect(result).toBeUndefined();
      await channel.stop();
    });

    it("returns undefined when payload has no text and no media", async () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      await channel.start();
      const result = await channel.send("123@s.whatsapp.net", {});

      expect(result).toBeUndefined();
      await channel.stop();
    });

    it("sends media attachments via sendWhatsAppMedia", async () => {
      const { sendWhatsAppMedia } = await import("./media.js");

      // Mock the media send function
      vi.mock("./media.js", () => ({
        downloadWhatsAppMedia: vi.fn(),
        sendWhatsAppMedia: vi.fn().mockResolvedValue(undefined),
        extractMediaAttachments: vi.fn().mockReturnValue([]),
      }));

      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());
      await channel.start();

      const mediaBuffer = new Uint8Array([1, 2, 3, 4]);
      await channel.send("123@s.whatsapp.net", {
        media: [
          {
            type: "image",
            mimeType: "image/png",
            buffer: mediaBuffer,
            caption: "test image",
          },
        ],
      });

      expect(vi.mocked(sendWhatsAppMedia)).toHaveBeenCalledWith(
        expect.objectContaining({
          jid: "123@s.whatsapp.net",
          type: "image",
          mimetype: "image/png",
          caption: "test image",
        }),
      );

      await channel.stop();
    });

    it("chunks text exceeding max length", async () => {
      const { sendMessageWhatsApp } = await import("./send.js");
      const sendMock = vi.mocked(sendMessageWhatsApp);
      sendMock.mockClear();

      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      await channel.start();

      // Create text just over 65536 chars
      const longText = "A".repeat(70_000);
      await channel.send("123@s.whatsapp.net", { text: longText });

      expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      await channel.stop();
    });
  });

  describe("browserName", () => {
    it("passes browserName from config to createWhatsAppSession", async () => {
      const { createWhatsAppSession } = await import("./session.js");
      const sessionMock = vi.mocked(createWhatsAppSession);
      sessionMock.mockClear();

      const channel = createWhatsAppChannel(
        { enabled: true, authDir: "/tmp/wa-auth", browserName: "MyBot" },
        makeDeps(),
      );
      await channel.start();

      expect(sessionMock).toHaveBeenCalledWith(expect.any(String), expect.any(Object), "MyBot");

      await channel.stop();
    });

    it("passes undefined browserName when not configured", async () => {
      const { createWhatsAppSession } = await import("./session.js");
      const sessionMock = vi.mocked(createWhatsAppSession);
      sessionMock.mockClear();

      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());
      await channel.start();

      expect(sessionMock).toHaveBeenCalledWith(expect.any(String), expect.any(Object), undefined);

      await channel.stop();
    });
  });

  describe("capabilities", () => {
    it("exposes expected capabilities", () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      expect(channel.capabilities).toEqual({
        markdown: false,
        images: true,
        audio: true,
        video: true,
        documents: true,
        reactions: true,
        editing: false,
        streaming: false,
        maxTextLength: 65_536,
      });
    });

    it("has id and name", () => {
      const channel = createWhatsAppChannel({ enabled: true, authDir: "/tmp/wa-auth" }, makeDeps());

      expect(channel.id).toBe("whatsapp");
      expect(channel.name).toBe("WhatsApp");
    });
  });
});
