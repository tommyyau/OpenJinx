import type { ClaudeModelId } from "../types/config.js";
import { createLogger } from "../infra/logger.js";
import { runAgentTurn } from "../providers/claude-provider.js";

const logger = createLogger("classifier");

/** Minimum message length to consider for LLM classification. */
const MIN_CLASSIFY_LENGTH = 20;

export interface ClassificationResult {
  classification: "quick" | "deep" | "marathon";
  reason: string;
}

const CLASSIFIER_PROMPT = `Classify this user message as "quick", "deep", or "marathon".

"quick": Simple greetings, short questions, casual chat, status checks, single-step requests, commands.
"deep": Multi-step research, comparative analysis, tasks requiring web search + synthesis, code generation with execution, requests for thoroughness or comprehensive answers, anything needing 5+ minutes of focused work.
"marathon": Large-scale project requests that require building a complete application, multi-file codebase, or multi-hour autonomous work. Examples: "build me a full-stack app", "create a REST API with tests and deployment", "build a complete website with authentication". Must involve creating something substantial from scratch.

Respond with ONLY a JSON object: {"classification":"quick"|"deep"|"marathon","reason":"brief reason"}`;

/**
 * Classify whether a message needs deep work or can be handled quickly.
 * Short messages and commands always return "quick" without an LLM call.
 * On any error, falls back to "quick" to never block normal dispatch.
 */
export async function classifyTask(
  text: string,
  model: ClaudeModelId,
): Promise<ClassificationResult> {
  // Short messages and commands bypass the LLM entirely
  if (text.length < MIN_CLASSIFY_LENGTH) {
    return { classification: "quick", reason: "short message" };
  }

  try {
    const result = await runAgentTurn({
      prompt: text,
      systemPrompt: CLASSIFIER_PROMPT,
      model,
      maxTurns: 1,
      maxTokens: 256,
      sessionId: "classifier",
    });

    const parsed = extractJson(result.text);
    if (!parsed) {
      logger.warn(`Classifier returned unparseable response: ${result.text.slice(0, 200)}`);
      return { classification: "quick", reason: "unparseable classifier response" };
    }

    if (
      parsed.classification !== "quick" &&
      parsed.classification !== "deep" &&
      parsed.classification !== "marathon"
    ) {
      logger.warn(`Classifier returned invalid classification: ${result.text.slice(0, 200)}`);
      return { classification: "quick", reason: "invalid classifier response" };
    }

    logger.info(`Classified as "${parsed.classification}": ${parsed.reason}`);
    return parsed;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`Classifier failed, defaulting to quick: ${msg}`);
    return { classification: "quick", reason: "classifier error" };
  }
}

/**
 * Extract a JSON object from text that may contain markdown fences or preamble.
 * Handles: raw JSON, ```json fenced, or JSON embedded in prose.
 */
function extractJson(text: string): ClassificationResult | undefined {
  // Try raw parse first
  try {
    return JSON.parse(text) as ClassificationResult;
  } catch {
    // Fall through to extraction
  }

  // Try to extract JSON from markdown fences or surrounding text
  const match = text.match(/\{[^}]*"classification"\s*:\s*"[^"]*"[^}]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]) as ClassificationResult;
    } catch {
      // Fall through
    }
  }

  return undefined;
}
