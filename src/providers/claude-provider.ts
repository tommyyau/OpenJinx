import type {
  MessageParam,
  ToolResultBlockParam,
  Tool,
  TextBlockParam,
  ContentBlock,
  ImageBlockParam,
  ContentBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import Anthropic from "@anthropic-ai/sdk";
import type { SystemPromptBlock } from "../agents/system-prompt.js";
import type { MediaAttachment } from "../types/messages.js";
import type {
  AgentResult,
  AgentTurnOptions,
  AgentToolDefinition,
  AgentMessage,
  ClaudeAuth,
} from "./types.js";
import { createLogger } from "../infra/logger.js";
import { resolveAuth } from "./auth.js";
import { resolveModelString } from "./models.js";

const logger = createLogger("claude");

/** Maximum characters for a single tool result before truncation. */
const MAX_TOOL_RESULT_CHARS = 100_000;

/** Default max output tokens when not specified. */
const DEFAULT_MAX_TOKENS = 16_384;

/** Models that support adaptive thinking. */
const ADAPTIVE_THINKING_MODELS = new Set(["claude-opus-4-6", "claude-sonnet-4-6"]);

/**
 * Run a single agent turn using the Anthropic SDK with true streaming.
 * Handles multi-turn tool use loops automatically.
 * Text deltas are streamed to the caller via onDelta as they arrive.
 */
export async function runAgentTurn(options: AgentTurnOptions): Promise<AgentResult> {
  const start = Date.now();
  const auth = resolveAuth();
  const modelString = resolveModelString(options.model);
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  logger.debug(`Starting agent turn with model=${modelString}`);

  const client = createClient(auth);
  const tools = buildToolDefinitions(options.tools);

  // Build system parameter: use structured blocks for caching when available
  const systemParam: string | TextBlockParam[] = options.systemPromptBlocks
    ? buildSystemContentBlocks(options.systemPromptBlocks)
    : options.systemPrompt;

  // Build messages: history turns first, then current prompt
  const messages: MessageParam[] = [];
  if (options.history && options.history.length > 0) {
    for (const turn of options.history) {
      messages.push({ role: turn.role, content: turn.content });
    }
    logger.debug(`Loaded ${options.history.length} history turns`);
  }
  // Build current prompt with optional media (vision inputs)
  const userContent = buildUserContentWithMedia(options.prompt, options.media);
  messages.push({ role: "user", content: userContent });

  const agentMessages: AgentMessage[] = [{ role: "user", content: options.prompt }];
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCacheCreation = 0;
  let totalCacheRead = 0;
  let turns = 0;
  const maxTurns = options.maxTurns ?? 30;

  // Enable adaptive thinking for models that support it
  const thinkingParam = ADAPTIVE_THINKING_MODELS.has(modelString)
    ? { type: "adaptive" as const }
    : undefined;

  while (turns < maxTurns) {
    turns++;

    try {
      // Use streaming to get text deltas in real-time
      const stream = client.messages.stream({
        model: modelString,
        max_tokens: maxTokens,
        system: systemParam,
        messages,
        tools: tools.length > 0 ? tools : undefined,
        ...(thinkingParam ? { thinking: thinkingParam } : {}),
      });

      // Stream text deltas to the caller as they arrive
      if (options.onDelta) {
        stream.on("text", (text) => {
          options.onDelta!(text);
        });
      }

      // Wait for the complete response
      const response = await stream.finalMessage();

      totalInputTokens += response.usage.input_tokens;
      totalOutputTokens += response.usage.output_tokens;
      totalCacheCreation += response.usage.cache_creation_input_tokens ?? 0;
      totalCacheRead += response.usage.cache_read_input_tokens ?? 0;

      // Handle pause_turn: server-side tool hit iteration limit, re-send to continue
      if (response.stop_reason === "pause_turn") {
        messages.length = 0;
        // Re-send history + current turn context so server can resume
        if (options.history && options.history.length > 0) {
          for (const turn of options.history) {
            messages.push({ role: turn.role, content: turn.content });
          }
        }
        messages.push({ role: "user", content: userContent });
        messages.push({ role: "assistant", content: response.content });
        logger.debug("pause_turn: server paused, re-sending to continue");
        continue;
      }

      // Extract text and tool use blocks from the final message
      const textBlocks = response.content.filter(
        (b): b is ContentBlock & { type: "text" } => b.type === "text",
      );
      const toolUseBlocks = response.content.filter(
        (b): b is ContentBlock & { type: "tool_use"; id: string; name: string; input: unknown } =>
          b.type === "tool_use",
      );
      const responseText = textBlocks.map((b) => b.text).join("");

      // Record assistant message
      const agentMsg: AgentMessage = {
        role: "assistant",
        content: responseText,
        toolCalls: toolUseBlocks.map((b) => ({
          id: b.id,
          name: b.name,
          input: b.input,
        })),
      };
      agentMessages.push(agentMsg);

      // Add assistant message to conversation (preserve full content including thinking blocks)
      messages.push({ role: "assistant", content: response.content });

      // If no tool use or stop reason is "end_turn", we're done
      if (toolUseBlocks.length === 0 || response.stop_reason === "end_turn") {
        return {
          text: responseText,
          messages: agentMessages,
          hitTurnLimit: false,
          usage: {
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            cacheCreationTokens: totalCacheCreation,
            cacheReadTokens: totalCacheRead,
          },
          durationMs: Date.now() - start,
          model: modelString,
        };
      }

      // Execute tools and build results
      const toolResults: ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        const toolDef = options.tools?.find((t) => t.name === toolUse.name);
        if (!toolDef) {
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: Unknown tool "${toolUse.name}"`,
            is_error: true,
          });
          continue;
        }

        try {
          const output = await toolDef.execute(toolUse.input);
          const outputStr = truncateToolResult(
            typeof output === "string" ? output : JSON.stringify(output),
          );
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: outputStr,
          });

          // Record tool output on the agent message
          const call = agentMsg.toolCalls?.find((c) => c.id === toolUse.id);
          if (call) {
            call.output = output;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: "tool_result",
            tool_use_id: toolUse.id,
            content: `Error: ${errMsg}`,
            is_error: true,
          });
        }
      }

      // Add tool results to conversation
      messages.push({ role: "user", content: toolResults });
    } catch (err) {
      // Typed error handling for Anthropic API errors
      if (Anthropic.RateLimitError && err instanceof Anthropic.RateLimitError) {
        logger.warn(`Rate limited on turn ${turns}: ${err.message}`);
        throw err;
      }
      if (Anthropic.APIError && err instanceof Anthropic.APIError) {
        logger.error(`API error ${err.status} on turn ${turns}: ${err.message}`);
        throw err;
      }
      throw err;
    }
  }

  // Hit turn limit
  const lastText =
    agentMessages
      .filter((m) => m.role === "assistant")
      .map((m) => m.content)
      .pop() ?? "";

  return {
    text: lastText,
    messages: agentMessages,
    hitTurnLimit: true,
    usage: {
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      cacheCreationTokens: totalCacheCreation,
      cacheReadTokens: totalCacheRead,
    },
    durationMs: Date.now() - start,
    model: modelString,
  };
}

function createClient(auth: ClaudeAuth): Anthropic {
  if (auth.mode === "api-key") {
    return new Anthropic({ apiKey: auth.key });
  }
  // OAuth token: sent as Authorization: Bearer header (not x-api-key).
  // Requires the oauth beta header for the API to accept it.
  return new Anthropic({
    apiKey: null,
    authToken: auth.token,
    defaultHeaders: {
      "anthropic-beta": "oauth-2025-04-20",
    },
  });
}

function buildToolDefinitions(tools?: AgentToolDefinition[]): Tool[] {
  if (!tools || tools.length === 0) {
    return [];
  }
  const lastIdx = tools.length - 1;
  return tools.map((t, i) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as Tool["input_schema"],
    // Cache breakpoint on last tool — caches all tool schemas as a prefix
    ...(i === lastIdx ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/**
 * Convert SystemPromptBlocks to TextBlockParam[] for the API.
 * Places a cache_control breakpoint on the last cacheable block.
 */
function buildSystemContentBlocks(blocks: SystemPromptBlock[]): TextBlockParam[] {
  // Find the last cacheable block among non-empty blocks
  const nonEmpty = blocks.filter((b) => b.text);
  let lastCacheIdx = -1;
  for (let i = nonEmpty.length - 1; i >= 0; i--) {
    if (nonEmpty[i].cacheable) {
      lastCacheIdx = i;
      break;
    }
  }

  return nonEmpty.map((block, i) => ({
    type: "text" as const,
    text: block.text,
    ...(i === lastCacheIdx ? { cache_control: { type: "ephemeral" as const } } : {}),
  }));
}

/** Claude-supported image media types. */
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Max image size Claude accepts (20MB). */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/**
 * Build user message content with optional media attachments.
 * Images with downloaded buffers become Claude vision inputs (ImageBlockParam).
 * Non-image media gets a text description appended to the prompt.
 * Returns a plain string when no processable media is present (preserving current behavior).
 */
function buildUserContentWithMedia(
  prompt: string,
  media?: MediaAttachment[],
): string | ContentBlockParam[] {
  if (!media || media.length === 0) {
    return prompt;
  }

  const imageBlocks: ImageBlockParam[] = [];
  const descriptions: string[] = [];

  for (const attachment of media) {
    if (
      attachment.buffer &&
      SUPPORTED_IMAGE_TYPES.has(attachment.mimeType) &&
      (!attachment.sizeBytes || attachment.sizeBytes <= MAX_IMAGE_BYTES)
    ) {
      // Convert to base64 vision input
      const base64 = Buffer.from(attachment.buffer).toString("base64");
      imageBlocks.push({
        type: "image",
        source: {
          type: "base64",
          media_type: attachment.mimeType as
            | "image/jpeg"
            | "image/png"
            | "image/gif"
            | "image/webp",
          data: base64,
        },
      });
    } else if (attachment.type === "audio") {
      descriptions.push(`[Audio: ${attachment.caption || "voice message"}]`);
    } else if (attachment.type === "video") {
      descriptions.push(`[Video: ${attachment.caption || "video file"}]`);
    } else if (attachment.type === "document") {
      descriptions.push(`[Document: ${attachment.filename || "file"}]`);
    } else if (attachment.type === "sticker") {
      descriptions.push(`[Sticker: ${attachment.caption || "sticker"}]`);
    } else if (attachment.type === "image" && !attachment.buffer) {
      descriptions.push(`[Image: not downloaded]`);
    }
  }

  // If we have no image blocks, just append descriptions to the text prompt
  if (imageBlocks.length === 0) {
    const fullPrompt = descriptions.length > 0 ? `${descriptions.join(" ")}\n\n${prompt}` : prompt;
    return fullPrompt;
  }

  // Build content blocks: images first, then text
  const contentBlocks: ContentBlockParam[] = [...imageBlocks];

  const textPart = descriptions.length > 0 ? `${descriptions.join(" ")}\n\n${prompt}` : prompt;

  contentBlocks.push({ type: "text", text: textPart });

  return contentBlocks;
}

/** Truncate a tool result string if it exceeds MAX_TOOL_RESULT_CHARS. */
function truncateToolResult(output: string): string {
  if (output.length <= MAX_TOOL_RESULT_CHARS) {
    return output;
  }
  return output.slice(0, MAX_TOOL_RESULT_CHARS) + "\n[... output truncated]";
}

/** Exported for testing — allows inspecting internals. */
export const _internal = {
  createClient,
  buildToolDefinitions,
  buildSystemContentBlocks,
  buildUserContentWithMedia,
  truncateToolResult,
  MAX_TOOL_RESULT_CHARS,
  ADAPTIVE_THINKING_MODELS,
  DEFAULT_MAX_TOKENS,
};
