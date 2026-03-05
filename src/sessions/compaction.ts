import type { TranscriptTurn } from "../types/sessions.js";
import { CHARS_PER_TOKEN } from "../memory/chunker.js";
import { readTranscript, rewriteTranscript } from "./transcript.js";

/** Threshold ratio of context window to trigger compaction. */
const COMPACTION_THRESHOLD = 0.8;

/**
 * Check if a session needs compaction based on context token usage.
 */
export function needsCompaction(contextTokens: number, contextWindow: number): boolean {
  return contextTokens > contextWindow * COMPACTION_THRESHOLD;
}

/**
 * Estimate token count for a single transcript turn.
 */
export function estimateTurnTokens(turn: TranscriptTurn): number {
  let chars = turn.text.length;
  if (turn.toolCalls && turn.toolCalls.length > 0) {
    chars += JSON.stringify(turn.toolCalls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Estimate total token count across all turns.
 */
export function estimateTranscriptTokens(turns: TranscriptTurn[]): number {
  let total = 0;
  for (const turn of turns) {
    total += estimateTurnTokens(turn);
  }
  return total;
}

/**
 * Build a compaction summary turn from a list of turns.
 * This creates a "system" turn that summarizes the conversation history.
 */
export function buildCompactionTurn(turns: TranscriptTurn[], summary: string): TranscriptTurn {
  return {
    role: "system",
    text: `[Conversation compacted — ${turns.length} turns summarized]\n\n${summary}`,
    timestamp: Date.now(),
    isCompaction: true,
  };
}

/**
 * Select turns to compact. Keeps the most recent turns and compacts older ones.
 * Returns [turnsToCompact, turnsToKeep].
 */
export function selectTurnsForCompaction(
  turns: TranscriptTurn[],
  keepRecent = 4,
): [TranscriptTurn[], TranscriptTurn[]] {
  if (turns.length <= keepRecent) {
    return [[], turns];
  }
  const toCompact = turns.slice(0, -keepRecent);
  const toKeep = turns.slice(-keepRecent);
  return [toCompact, toKeep];
}

/**
 * Build a prompt to ask the LLM to summarize turns for compaction.
 */
export function buildCompactionPrompt(turns: TranscriptTurn[]): string {
  const turnTexts = turns
    .map((t) => {
      let entry = `[${t.role}]: ${t.text}`;
      if (t.toolCalls && t.toolCalls.length > 0) {
        const tools = t.toolCalls.map((tc) => tc.toolName).join(", ");
        entry += `\n[Tools used: ${tools}]`;
      }
      return entry;
    })
    .join("\n\n");
  return `Summarize the following conversation history into a concise summary. Preserve key facts, decisions, tool usage patterns, and context that would be important for continuing the conversation. Keep the summary under 2000 characters.\n\n${turnTexts}`;
}

export interface CompactionResult {
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
}

/**
 * Compact a transcript if it exceeds the context window threshold.
 * Summarizes older turns via the provided `summarize` callback and
 * rewrites the transcript with a compaction turn + recent turns.
 */
export async function compactTranscript(
  transcriptPath: string,
  contextWindow: number,
  summarize: (prompt: string) => Promise<string>,
): Promise<CompactionResult> {
  const turns = await readTranscript(transcriptPath);
  const tokensBefore = estimateTranscriptTokens(turns);

  if (!needsCompaction(tokensBefore, contextWindow)) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const [toCompact, toKeep] = selectTurnsForCompaction(turns, 4);
  if (toCompact.length === 0) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const prompt = buildCompactionPrompt(toCompact);
  const summary = await summarize(prompt);
  const compactionTurn = buildCompactionTurn(toCompact, summary);

  const newTurns = [compactionTurn, ...toKeep];
  await rewriteTranscript(transcriptPath, newTurns);

  const tokensAfter = estimateTranscriptTokens(newTurns);
  return { compacted: true, tokensBefore, tokensAfter };
}
