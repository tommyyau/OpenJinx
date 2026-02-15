import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../infra/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./format.js", () => ({
  markdownToWhatsApp: vi.fn((text: string) => `formatted:${text}`),
}));

const { sendMessageWhatsApp } = await import("./send.js");
const { markdownToWhatsApp } = await import("./format.js");

function createMockSocket() {
  return {
    sendMessage: vi
      .fn<(jid: string, content: { text: string }) => Promise<unknown>>()
      .mockResolvedValue({}),
  };
}

describe("sendMessageWhatsApp", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends formatted text by default", async () => {
    const socket = createMockSocket();

    await sendMessageWhatsApp({
      socket: socket as never,
      jid: "123@s.whatsapp.net",
      text: "hello world",
    });

    expect(markdownToWhatsApp).toHaveBeenCalledWith("hello world");
    expect(socket.sendMessage).toHaveBeenCalledWith("123@s.whatsapp.net", {
      text: "formatted:hello world",
    });
  });

  it("sends raw text when formatMarkdown is false", async () => {
    const socket = createMockSocket();

    await sendMessageWhatsApp({
      socket: socket as never,
      jid: "456@s.whatsapp.net",
      text: "**raw markdown**",
      formatMarkdown: false,
    });

    expect(socket.sendMessage).toHaveBeenCalledWith("456@s.whatsapp.net", {
      text: "**raw markdown**",
    });
  });

  it("propagates socket errors", async () => {
    const socket = createMockSocket();
    const err = new Error("connection lost");
    socket.sendMessage.mockRejectedValue(err);

    await expect(
      sendMessageWhatsApp({
        socket: socket as never,
        jid: "789@s.whatsapp.net",
        text: "hello",
      }),
    ).rejects.toThrow("connection lost");
  });
});
