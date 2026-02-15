import type { ChannelId } from "./config.js";

/** Inbound message context — the unified representation of an incoming message. */
export interface MsgContext {
  /** Unique message ID (from the source channel). */
  messageId: string;
  /** Channel the message arrived on. */
  channel: ChannelId;
  /** Session key for routing. */
  sessionKey: string;
  /** The agent ID that should handle this message. */
  agentId: string;
  /** Account identifier on the channel (e.g., bot username, phone number). */
  accountId: string;
  /** Sender identifier. */
  senderId: string;
  /** Sender display name. */
  senderName: string;
  /** Text content of the message. */
  text: string;
  /** Whether this is a group chat message. */
  isGroup: boolean;
  /** Group/chat ID for group messages. */
  groupId?: string;
  /** Group display name. */
  groupName?: string;
  /** Thread/topic ID if applicable. */
  threadId?: string;
  /** Media attachments. */
  media?: MediaAttachment[];
  /** Whether the message is a command (starts with /). */
  isCommand: boolean;
  /** Parsed command name (without the leading /). */
  commandName?: string;
  /** Parsed command arguments. */
  commandArgs?: string;
  /** Timestamp of the message. */
  timestamp: number;
  /** Raw channel-specific payload for channel-specific processing. */
  raw?: unknown;
  /** Whether this is a system test message (isolated storage, no memory writes). */
  isSystemTest?: boolean;
}

export interface MediaAttachment {
  type: "image" | "audio" | "video" | "document" | "sticker";
  mimeType: string;
  /** URL or file path to the media. */
  url?: string;
  /** Raw buffer if already downloaded. */
  buffer?: Uint8Array;
  /** Original filename. */
  filename?: string;
  /** File size in bytes. */
  sizeBytes?: number;
  /** Caption / alt text. */
  caption?: string;
}

/** Outbound reply payload. */
export interface ReplyPayload {
  /** Text content to send. */
  text?: string;
  /** Media items to send. */
  media?: OutboundMedia[];
  /** Delivery target override. */
  target?: DeliveryTarget;
  /** Whether this is a reasoning/thinking message (sent before main reply). */
  isReasoning?: boolean;
}

export interface OutboundMedia {
  type: "image" | "audio" | "video" | "document";
  mimeType: string;
  url?: string;
  buffer?: Uint8Array;
  filename?: string;
  caption?: string;
}

export interface DeliveryTarget {
  channel: ChannelId;
  to: string;
  accountId?: string;
}

/** Chat events emitted during streaming. */
export type ChatEvent =
  | { type: "delta"; text: string }
  | { type: "final"; text: string; usage?: TokenUsage }
  | { type: "aborted"; reason: string }
  | { type: "thinking"; text: string }
  | { type: "tool_use"; toolName: string; input: unknown }
  | { type: "tool_result"; toolName: string; output: unknown };

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}
