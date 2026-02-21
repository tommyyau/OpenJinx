/**
 * System test: Memory Utilization Pipeline.
 * Crosses: Memory search → RAG pre-search → System prompt → Agent runner.
 *
 * Verifies that stored memory reaches the agent through both automatic RAG
 * pre-search and proactive tool directives in the system prompt.
 *
 * Uses BM25-only search (vectorWeight: 0) for determinism — no embedding API calls.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryConfig } from "../types/config.js";
import { createTestHarness, type TestHarness } from "../__test__/harness.js";
import { buildRagContext } from "../agents/runner.js";
import { buildSystemPrompt, type SystemPromptOptions } from "../agents/system-prompt.js";
import { MemorySearchManager } from "../memory/search-manager.js";

let harness: TestHarness;
let memoryConfig: MemoryConfig;

beforeEach(async () => {
  harness = await createTestHarness();
  memoryConfig = {
    enabled: true,
    dir: harness.workspace.memoryDir,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    vectorWeight: 0, // Pure BM25 for determinism
    maxResults: 10,
  };
});

afterEach(async () => {
  await harness.cleanup();
});

describe("Memory utilization pipeline", () => {
  it("RAG surfaces stored facts into system prompt context", async () => {
    // 1. Write a keyword-dense fact so BM25 scores exceed minScore threshold (0.3)
    await harness.workspace.writeDailyLog(
      "2026-02-10",
      [
        "# 2026-02-10",
        "",
        "Tommy's favorite programming language is TypeScript.",
        "Tommy uses TypeScript for all projects.",
        "TypeScript is Tommy's primary language for everything.",
        "Tommy recommends TypeScript to everyone.",
      ].join("\n"),
    );

    // 2. Create search manager (BM25-only) and sync
    const searchManager = new MemorySearchManager(memoryConfig);
    await searchManager.sync();

    // 3. Verify precondition: search finds the fact
    const searchResults = await searchManager.search({
      query: "favorite programming language",
    });
    expect(searchResults.length).toBeGreaterThan(0);
    expect(searchResults.some((r) => r.chunk.includes("TypeScript"))).toBe(true);

    // 4. buildRagContext produces a "# Relevant Memory" section
    // Use a query with exact keywords for reliable BM25 matching
    const ragContext = await buildRagContext(
      searchManager,
      "Tommy favorite programming language TypeScript",
    );
    expect(ragContext).toContain("# Relevant Memory");
    expect(ragContext).toContain("TypeScript");
  });

  it("RAG context is empty when no relevant memory exists", async () => {
    // Create an empty search manager (only default workspace files)
    const searchManager = new MemorySearchManager(memoryConfig);
    await searchManager.sync();

    // Query about something not in memory
    const ragContext = await buildRagContext(
      searchManager,
      "what is the capital of jupiter's third moon?",
    );
    expect(ragContext).toBe("");
  });

  it("system prompt includes Memory Recall directive for main sessions with memory tools", () => {
    const memorySearchTool = {
      name: "memory_search",
      description:
        "Mandatory recall step: search memory (semantic + keyword) before answering questions about prior work, decisions, dates, people, preferences, or todos. Returns relevant chunks with file path and line references.",
      inputSchema: {},
      execute: async () => ({}),
    };
    const memoryGetTool = {
      name: "memory_get",
      description:
        "Read a specific memory file or section. Use after memory_search to pull only the needed lines and keep context small.",
      inputSchema: {},
      execute: async () => ({}),
    };

    const options: SystemPromptOptions = {
      workspaceFiles: [],
      tools: [memorySearchTool, memoryGetTool],
      sessionType: "main",
      agentName: "Jinx",
      model: "claude-sonnet-4-6",
      workspaceDir: harness.workspace.dir,
      memoryDir: harness.workspace.memoryDir,
    };

    const prompt = buildSystemPrompt(options);

    // Memory Recall section present
    expect(prompt).toContain("# Memory Recall");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("prior work");

    // Tool description has mandatory language
    expect(prompt).toContain("Mandatory recall step");
  });
});
