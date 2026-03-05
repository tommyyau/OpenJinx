import type { SystemPromptBlock } from "../agents/system-prompt.js";
import type { ClaudeModelId } from "../types/config.js";
import type { MediaAttachment } from "../types/messages.js";

/** Token usage for a single agent turn. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** Result of a single agent turn via Claude Agent SDK. */
export interface AgentResult {
  /** The final text response from the agent. */
  text: string;
  /** Messages from the SDK conversation. */
  messages: AgentMessage[];
  /** Whether the agent exhausted its turn limit. */
  hitTurnLimit: boolean;
  /** Token usage for this turn. */
  usage: TurnUsage;
  /** Duration of the turn in ms. */
  durationMs: number;
  /** Model that was actually used. */
  model: string;
}

/** A single message in the agent conversation. */
export interface AgentMessage {
  role: "user" | "assistant" | "system";
  content: string;
  toolCalls?: AgentToolCall[];
}

export interface AgentToolCall {
  id: string;
  name: string;
  input: unknown;
  output?: unknown;
}

/** A prior conversation turn for multi-turn context. */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}

/** Options for running an agent turn. */
export interface AgentTurnOptions {
  prompt: string;
  systemPrompt: string;
  /** Structured system prompt blocks with cacheability hints. When provided, used instead of systemPrompt for the API call. */
  systemPromptBlocks?: SystemPromptBlock[];
  model: ClaudeModelId;
  tools?: AgentToolDefinition[];
  sessionId?: string;
  /** Prior conversation turns to prepend before the current prompt. */
  history?: HistoryTurn[];
  maxTurns?: number;
  /** Max output tokens for this turn. */
  maxTokens?: number;
  /** Media attachments from the user message (images become vision inputs). */
  media?: MediaAttachment[];
  /** Callback for streaming partial messages. */
  onDelta?: (text: string) => void;
}

/** A tool definition to pass to the Claude Agent SDK. */
export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => Promise<unknown>;
}

/** Auth credentials resolved for the SDK. */
export type ClaudeAuth = { mode: "oauth"; token: string } | { mode: "api-key"; key: string };
