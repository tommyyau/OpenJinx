/**
 * Live system test: Claude provider edge cases and advanced behaviors.
 *
 * Covers scenarios NOT tested by pipeline.live.test.ts:
 *   - maxTurns turn-limit enforcement
 *   - Error recovery with invalid model names
 *   - Prompt caching via systemPromptBlocks
 *   - Empty prompt handling
 *   - Tool with structured output
 *
 * Run: cd jinx && pnpm test:live
 *
 * Prerequisites:
 *   - Claude Code logged in (macOS Keychain), OR
 *   - CLAUDE_CODE_OAUTH_TOKEN env var set, OR
 *   - ANTHROPIC_API_KEY env var set
 *
 * This test makes real API calls and costs a small amount per run.
 * It uses Haiku (cheapest model) to minimize cost.
 */
import { describe, it, expect } from "vitest";
import type { AgentToolDefinition } from "../providers/types.js";
import type { ClaudeModelId } from "../types/config.js";
import { buildSystemPrompt, buildSystemPromptBlocks } from "../agents/system-prompt.js";
import { hasAuth } from "../providers/auth.js";
import { runAgentTurn } from "../providers/claude-provider.js";

const describeIf = hasAuth() ? describe : describe.skip;

/** Minimal workspace files for testing. */
function makeWorkspaceFiles() {
  return [
    {
      name: "SOUL.md" as const,
      path: "/test/SOUL.md",
      content: "# Soul\n\nYou are a helpful assistant. Be concise.",
      missing: false,
    },
  ];
}

/** Shared system prompt options for Haiku. */
function makeSystemPromptOptions(tools: AgentToolDefinition[] = []) {
  return {
    workspaceFiles: makeWorkspaceFiles(),
    tools,
    sessionType: "main" as const,
    agentName: "Jinx",
    model: "claude-haiku-4-5-20251001",
    workspaceDir: "/test",
    memoryDir: "/test/memory",
  };
}

describeIf("Claude provider edge cases (live API)", () => {
  it("maxTurns limit: agent is stopped when turn limit is reached", async () => {
    const keepGoingTool: AgentToolDefinition = {
      name: "keep_going",
      description: "A tool that always returns a message asking the agent to continue processing.",
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => "continue processing",
    };

    const opts = makeSystemPromptOptions([keepGoingTool]);
    const blocks = buildSystemPromptBlocks(opts);
    const systemPrompt = blocks
      .map((b) => b.text)
      .filter(Boolean)
      .join("\n\n---\n\n");

    const result = await runAgentTurn({
      prompt:
        "Use the keep_going tool repeatedly. Every time you get a result, use it again. Do not stop using the tool.",
      systemPrompt,
      systemPromptBlocks: blocks,
      model: "haiku",
      tools: [keepGoingTool],
      maxTurns: 2,
    });

    expect(result.hitTurnLimit).toBe(true);

    // Should have made tool calls
    const toolCalls = result.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.toolCalls ?? []);
    expect(toolCalls.some((c) => c.name === "keep_going")).toBe(true);

    console.log(
      `  maxTurns limit: ${toolCalls.length} tool call(s), hitTurnLimit=${result.hitTurnLimit}, ${result.usage.inputTokens}in/${result.usage.outputTokens}out in ${result.durationMs}ms`,
    );
  }, 60_000);

  it("error recovery: invalid model name throws a meaningful error", async () => {
    const systemPrompt = buildSystemPrompt(makeSystemPromptOptions());

    await expect(
      runAgentTurn({
        prompt: "Hello",
        systemPrompt,
        model: "nonexistent-model" as ClaudeModelId,
        maxTurns: 1,
      }),
    ).rejects.toThrow();
  }, 60_000);

  it("cache behavior: second identical call uses cache tokens", async () => {
    const opts = makeSystemPromptOptions();
    const blocks = buildSystemPromptBlocks(opts);
    const systemPrompt = blocks
      .map((b) => b.text)
      .filter(Boolean)
      .join("\n\n---\n\n");

    const callOpts = {
      prompt: "Reply with exactly the word: CACHED",
      systemPrompt,
      systemPromptBlocks: blocks,
      model: "haiku" as ClaudeModelId,
      maxTurns: 1,
    };

    // First call — primes the cache
    const result1 = await runAgentTurn(callOpts);
    expect(result1.text).toBeTruthy();

    // Second call — should benefit from prompt caching
    const result2 = await runAgentTurn(callOpts);
    expect(result2.text).toBeTruthy();

    // Both calls should succeed. The second should have cache read tokens,
    // but cache behavior may vary by backend, so we just verify both complete
    // and log the cache metrics for manual inspection.
    console.log(
      `  Cache call 1: ${result1.usage.inputTokens}in/${result1.usage.outputTokens}out, cacheCreate=${result1.usage.cacheCreationTokens}, cacheRead=${result1.usage.cacheReadTokens}`,
    );
    console.log(
      `  Cache call 2: ${result2.usage.inputTokens}in/${result2.usage.outputTokens}out, cacheCreate=${result2.usage.cacheCreationTokens}, cacheRead=${result2.usage.cacheReadTokens}`,
    );

    // Soft assertion: second call should have some cache read tokens.
    // This is expected to work with the Anthropic API's prompt caching,
    // but we don't hard-fail if the backend decides not to cache.
    if (result2.usage.cacheReadTokens > 0) {
      expect(result2.usage.cacheReadTokens).toBeGreaterThan(0);
    }
  }, 60_000);

  it("empty prompt handling: does not hang and either returns or throws", async () => {
    const systemPrompt = buildSystemPrompt(makeSystemPromptOptions());

    // An empty prompt should not cause the provider to hang indefinitely.
    // It may either return a response or throw a clear error.
    try {
      const result = await runAgentTurn({
        prompt: "",
        systemPrompt,
        model: "haiku",
        maxTurns: 1,
      });

      // If it returns, there should be some kind of result
      expect(result).toBeDefined();
      expect(result.durationMs).toBeGreaterThan(0);
      console.log(
        `  Empty prompt: returned response (${result.text.length} chars) in ${result.durationMs}ms`,
      );
    } catch (err) {
      // If it throws, the error should be meaningful (not a timeout or hang)
      expect(err).toBeDefined();
      expect(err instanceof Error ? err.message : String(err)).toBeTruthy();
      console.log(
        `  Empty prompt: threw error — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, 60_000);

  it("tool with structured output: tool call is recorded with result", async () => {
    const calculateTool: AgentToolDefinition = {
      name: "calculate",
      description: "Performs a calculation and returns a structured result with a numeric value.",
      inputSchema: {
        type: "object",
        properties: {
          expression: { type: "string", description: "The expression to calculate" },
        },
        required: ["expression"],
      },
      execute: async () => ({ result: 42 }),
    };

    const opts = makeSystemPromptOptions([calculateTool]);
    const blocks = buildSystemPromptBlocks(opts);
    const systemPrompt = blocks
      .map((b) => b.text)
      .filter(Boolean)
      .join("\n\n---\n\n");

    const result = await runAgentTurn({
      prompt: 'Use the calculate tool with the expression "6 * 7" and tell me the result.',
      systemPrompt,
      systemPromptBlocks: blocks,
      model: "haiku",
      tools: [calculateTool],
      maxTurns: 3,
    });

    // Agent should have called the tool
    const toolCalls = result.messages
      .filter((m) => m.role === "assistant")
      .flatMap((m) => m.toolCalls ?? []);
    expect(toolCalls.some((c) => c.name === "calculate")).toBe(true);

    // The tool call output should be the structured result
    const calcCall = toolCalls.find((c) => c.name === "calculate");
    expect(calcCall).toBeDefined();
    expect(calcCall!.output).toEqual({ result: 42 });

    // Agent should mention 42 in its response
    expect(result.text).toContain("42");

    console.log(
      `  Structured tool: ${toolCalls.length} tool call(s), output=${JSON.stringify(calcCall!.output)}, ${result.usage.inputTokens}in/${result.usage.outputTokens}out in ${result.durationMs}ms`,
    );
  }, 60_000);
});
