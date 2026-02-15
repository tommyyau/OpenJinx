import { afterEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../../types/messages.js";

vi.mock("../../infra/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock("./context.js", () => ({
  telegramUpdateToContext: vi.fn().mockReturnValue({
    messageId: "123",
    sessionKey: "telegram:dm:456",
    text: "hello",
    channel: "telegram",
    accountId: "789",
    senderId: "456",
    senderName: "Test User",
    isGroup: false,
    isCommand: false,
    agentId: "default",
    timestamp: Date.now(),
  }),
}));

const { registerTelegramHandlers } = await import("./handlers.js");
const { telegramUpdateToContext } = await import("./context.js");

function createMockBot() {
  const handlers: Array<(update: unknown) => void | Promise<void>> = [];
  return {
    bot: {
      onMessage(handler: (update: unknown) => void | Promise<void>) {
        handlers.push(handler);
      },
    },
    getHandler: () => handlers[0],
    handlers,
  };
}

function validUpdate() {
  return {
    update_id: 1,
    message: {
      message_id: 100,
      from: { id: 456, first_name: "Test", last_name: "User", username: "testuser" },
      chat: { id: 456, type: "private" },
      text: "hello",
      date: Math.floor(Date.now() / 1000),
    },
  };
}

describe("registerTelegramHandlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers a handler via bot.onMessage", () => {
    const { bot, handlers } = createMockBot();
    const onMessage = vi.fn<(ctx: MsgContext) => Promise<void>>();

    registerTelegramHandlers(bot, onMessage);

    expect(handlers).toHaveLength(1);
    expect(typeof handlers[0]).toBe("function");
  });

  it("forwards valid text messages to onMessage callback", async () => {
    const { bot, getHandler } = createMockBot();
    const onMessage = vi.fn<(ctx: MsgContext) => Promise<void>>().mockResolvedValue(undefined);

    registerTelegramHandlers(bot, onMessage);
    await getHandler()!(validUpdate());

    expect(telegramUpdateToContext).toHaveBeenCalledWith(validUpdate());
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0]![0]).toHaveProperty("messageId", "123");
  });

  it("ignores updates where message has no text", async () => {
    const { bot, getHandler } = createMockBot();
    const onMessage = vi.fn<(ctx: MsgContext) => Promise<void>>();

    registerTelegramHandlers(bot, onMessage);

    const update = {
      update_id: 2,
      message: {
        message_id: 101,
        from: { id: 456, first_name: "Test" },
        chat: { id: 456, type: "private" },
        date: Math.floor(Date.now() / 1000),
        // no text field
      },
    };

    await getHandler()!(update);

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("ignores updates with no message field", async () => {
    const { bot, getHandler } = createMockBot();
    const onMessage = vi.fn<(ctx: MsgContext) => Promise<void>>();

    registerTelegramHandlers(bot, onMessage);
    await getHandler()!({ update_id: 1 });

    expect(onMessage).not.toHaveBeenCalled();
  });

  it("catches errors from onMessage without propagating", async () => {
    const { bot, getHandler } = createMockBot();
    const onMessage = vi
      .fn<(ctx: MsgContext) => Promise<void>>()
      .mockRejectedValue(new Error("handler exploded"));

    registerTelegramHandlers(bot, onMessage);

    // Should not throw
    await expect(getHandler()!(validUpdate())).resolves.toBeUndefined();
  });

  it("ignores caption-only messages (no text field)", async () => {
    const { bot, getHandler } = createMockBot();
    const onMessage = vi.fn<(ctx: MsgContext) => Promise<void>>();

    registerTelegramHandlers(bot, onMessage);

    const update = {
      update_id: 3,
      message: {
        message_id: 102,
        from: { id: 456, first_name: "Test" },
        chat: { id: 456, type: "private" },
        caption: "A photo caption",
        date: Math.floor(Date.now() / 1000),
        // text is absent — only caption
      },
    };

    await getHandler()!(update);

    expect(onMessage).not.toHaveBeenCalled();
  });
});
