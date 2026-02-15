import type { DispatchDeps } from "../../pipeline/dispatch.js";
import type { ChannelPlugin } from "../../types/channels.js";
import type { WhatsAppChannelConfig } from "../../types/config.js";
import type { ChatEvent, ReplyPayload } from "../../types/messages.js";
import type { WhatsAppMessage } from "./context.js";
import type { WhatsAppSocket } from "./session.js";
import { expandTilde } from "../../infra/home-dir.js";
import { createLogger } from "../../infra/logger.js";
import { subscribeStream } from "../../pipeline/streaming.js";
import { whatsappMessageToContext, extractMediaAttachments } from "./context.js";
import { dispatchWhatsAppMessage } from "./dispatch.js";
import { markdownToWhatsApp } from "./format.js";
import { downloadWhatsAppMedia, sendWhatsAppMedia } from "./media.js";
import { sendMessageWhatsApp } from "./send.js";
import { createWhatsAppSession } from "./session.js";

const logger = createLogger("whatsapp:bot");

const WA_MAX_TEXT_LENGTH = 65_536;
const TYPING_REFRESH_MS = 10_000;

/**
 * Create a WhatsApp channel plugin that connects via Baileys and dispatches
 * messages through the Jinx pipeline.
 */
export function createWhatsAppChannel(
  whatsappConfig: WhatsAppChannelConfig,
  deps: DispatchDeps,
): ChannelPlugin {
  const authDir = expandTilde(whatsappConfig.authDir ?? "~/.jinx/whatsapp-auth");

  let socket: WhatsAppSocket | undefined;
  let sessionCleanup: (() => void) | undefined;
  let started = false;

  /** Core send logic shared by stream callbacks and channel.send(). */
  async function sendText(jid: string, text: string): Promise<void> {
    if (!socket) {
      logger.warn(`Cannot send to ${jid}: socket not initialized`);
      return;
    }
    if (!socket.isConnected) {
      logger.warn(`Cannot send to ${jid}: socket not connected`);
      return;
    }
    const formatted = markdownToWhatsApp(text);
    const chunks = chunkText(formatted, WA_MAX_TEXT_LENGTH);
    for (const chunk of chunks) {
      await sendMessageWhatsApp({ socket, jid, text: chunk, formatMarkdown: false });
    }
  }

  async function handleMessage(msg: WhatsAppMessage): Promise<void> {
    const text = msg.message?.conversation ?? msg.message?.extendedTextMessage?.text;
    const media = extractMediaAttachments(msg);

    // Require either text or media to proceed
    if (!text && media.length === 0) {
      return;
    }

    // Download media buffers if present
    if (media.length > 0) {
      try {
        const buffer = await downloadWhatsAppMedia({ message: msg });
        media[0].buffer = buffer;
      } catch (err) {
        logger.warn(`Media download failed, continuing without media: ${err}`);
      }
    }

    const ctx = whatsappMessageToContext(msg);
    // Populate downloaded buffers into context media
    if (ctx.media && media.length > 0) {
      for (let i = 0; i < ctx.media.length; i++) {
        if (media[i]?.buffer) {
          ctx.media[i].buffer = media[i].buffer;
        }
      }
    }
    const jid = ctx.isGroup ? ctx.groupId! : ctx.senderId;

    logger.info(`Message from ${ctx.senderName} in ${jid}`);

    // Subscribe to stream events — no streaming (WA can't edit messages),
    // only act on "final" to send the response
    const unsub = subscribeStream(ctx.sessionKey, (event: ChatEvent) => {
      if (event.type === "final") {
        if (event.text) {
          sendText(jid, event.text).catch((err) => logger.error("Send failed", err));
        }
        unsub();
      } else if (event.type === "aborted") {
        unsub();
      }
    });

    // Show typing indicator while agent is thinking
    let typingTimer: ReturnType<typeof setInterval> | undefined;
    if (socket) {
      socket
        .sendPresenceUpdate("composing", jid)
        .catch((e) => logger.debug("Presence update failed", e));
      typingTimer = setInterval(() => {
        socket
          ?.sendPresenceUpdate("composing", jid)
          .catch((e) => logger.debug("Presence update failed", e));
      }, TYPING_REFRESH_MS);
    }

    try {
      await dispatchWhatsAppMessage(ctx, deps);
    } catch (err) {
      logger.error("Dispatch failed", err);
    } finally {
      if (typingTimer) {
        clearInterval(typingTimer);
      }
      socket
        ?.sendPresenceUpdate("available", jid)
        .catch((e) => logger.debug("Presence update failed", e));
    }
  }

  return {
    id: "whatsapp",
    name: "WhatsApp",
    capabilities: {
      markdown: false,
      images: true,
      audio: true,
      video: true,
      documents: true,
      reactions: true,
      editing: false,
      streaming: false,
      maxTextLength: WA_MAX_TEXT_LENGTH,
    },

    async start() {
      // Create a single Baileys session. Baileys handles its own
      // internal reconnection — we don't need a monitor creating
      // new sessions repeatedly.
      const result = await createWhatsAppSession(
        authDir,
        {
          onMessage: handleMessage,
          onConnectionUpdate: (update) => {
            if (update.connection === "open") {
              logger.info("WhatsApp socket connected — channel fully ready");
            }
            if (update.isLoggedOut) {
              logger.warn("WhatsApp session logged out — restart gateway and re-scan QR");
            }
          },
        },
        whatsappConfig.browserName,
      );

      socket = result.socket;
      sessionCleanup = result.cleanup;
      started = true;

      logger.info(
        `WhatsApp channel started (connected=${socket.isConnected}) — ${socket.isConnected ? "ready" : "waiting for connection..."}`,
      );
    },

    async stop() {
      started = false;

      if (sessionCleanup) {
        sessionCleanup();
        sessionCleanup = undefined;
      }
      socket = undefined;

      logger.info("WhatsApp channel stopped");
    },

    async send(to: string, payload: ReplyPayload): Promise<string | undefined> {
      if (!socket) {
        logger.warn(`Cannot send to ${to}: socket not initialized`);
        return undefined;
      }
      if (!socket.isConnected) {
        logger.warn(`Cannot send to ${to}: socket not connected`);
        return undefined;
      }

      if (!payload.text && !payload.media?.length) {
        return undefined;
      }

      if (payload.text) {
        await sendText(to, payload.text);
      }

      // Send media attachments
      if (payload.media) {
        for (const item of payload.media) {
          if (item.buffer) {
            await sendWhatsAppMedia({
              socket,
              jid: to,
              buffer: Buffer.from(item.buffer),
              type: item.type,
              mimetype: item.mimeType,
              filename: item.filename,
              caption: item.caption,
            });
          }
        }
      }

      return undefined;
    },

    isReady() {
      return started && !!socket?.isConnected;
    },
  };
}

/** Split text into chunks of at most `maxLen` characters. */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  return chunks;
}
