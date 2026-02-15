import type { JinxConfig } from "../types/config.js";
import type { MsgContext, ReplyPayload } from "../types/messages.js";
import type { SessionStore } from "../types/sessions.js";
import { expandTilde } from "../infra/home-dir.js";
import { createLogger } from "../infra/logger.js";
import { onSessionEnd } from "../memory/session-hook.js";
import { resolveTranscriptPath } from "../sessions/transcript.js";
import { readRecentTurns } from "../sessions/transcript.js";
import { emitStreamEvent } from "./streaming.js";

const logger = createLogger("session-reset");

export interface SessionResetDeps {
  config: JinxConfig;
  sessions: SessionStore;
}

/**
 * Handle the /new command: end the current session and start a fresh one.
 * Creates a session summary file, appends to daily log, and resets counters.
 */
export async function handleNewSession(
  ctx: MsgContext,
  deps: SessionResetDeps,
): Promise<ReplyPayload> {
  const { config, sessions } = deps;
  const { sessionKey } = ctx;

  const session = sessions.get(sessionKey);
  if (!session) {
    logger.warn(`/new: no session found for ${sessionKey}`);
    emitStreamEvent(sessionKey, { type: "final", text: "No active session to reset." });
    return { text: "No active session to reset." };
  }

  // Read recent turns for slug + summary
  const recentTurns = await readRecentTurns(session.transcriptPath, 15);

  // Generate slug from last user message or timestamp
  const slug = generateSlug(recentTurns);

  // Generate summary from recent assistant turns
  const summary = generateSummary(recentTurns);

  // Write session summary + daily log
  const memoryDir = expandTilde(config.memory.dir);
  let filePath: string | undefined;
  try {
    filePath = await onSessionEnd({
      memoryDir,
      sessionKey,
      slug,
      summary,
    });
    logger.info(`Session ended: ${filePath}`);
  } catch (err) {
    logger.error(`Failed to write session summary: ${err}`);
  }

  // Reset session for next conversation
  const newTranscriptPath = resolveTranscriptPath(`${sessionKey}-${Date.now()}`);
  session.transcriptPath = newTranscriptPath;
  session.turnCount = 0;
  session.totalInputTokens = 0;
  session.totalOutputTokens = 0;
  session.contextTokens = 0;

  const confirmText = `Session saved. Starting fresh.`;
  emitStreamEvent(sessionKey, { type: "final", text: confirmText });

  return { text: confirmText };
}

/**
 * Generate a slug from recent transcript turns.
 * Extracts keywords from the last user message, or falls back to timestamp.
 */
function generateSlug(turns: { role: string; text: string; timestamp: number }[]): string {
  // Find last user message
  const lastUserTurn = turns.toReversed().find((t) => t.role === "user");

  if (lastUserTurn?.text) {
    const words = lastUserTurn.text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter((w) => w.length > 2)
      .slice(0, 4);

    if (words.length > 0) {
      return words.join("-");
    }
  }

  // Fallback: HHmm timestamp
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

/**
 * Generate a simple summary from recent assistant turns.
 */
function generateSummary(turns: { role: string; text: string; timestamp: number }[]): string {
  const assistantTexts = turns.filter((t) => t.role === "assistant" && t.text).map((t) => t.text);

  if (assistantTexts.length === 0) {
    return "No conversation content.";
  }

  // Take the last few responses, truncated
  const combined = assistantTexts.slice(-3).join("\n\n");
  if (combined.length > 500) {
    return combined.slice(0, 497) + "...";
  }
  return combined;
}
