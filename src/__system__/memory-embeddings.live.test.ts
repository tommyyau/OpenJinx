/**
 * Live integration test: Memory embeddings with real OpenAI API.
 *
 * Verifies:
 *   - OpenAI embedding generation (dimensions, types)
 *   - Cosine similarity ordering for semantic relatedness
 *   - Hybrid search with real embeddings (vector + BM25 scores)
 *   - Edge cases (empty input, invalid API key)
 *
 * Run: OPENAI_API_KEY=sk-... npx vitest run src/__system__/memory-embeddings.live.test.ts
 *
 * Prerequisites:
 *   - OPENAI_API_KEY env var set with a valid OpenAI API key
 *
 * This test makes real API calls and costs a small amount per run.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { MemoryConfig } from "../types/config.js";
import { createOpenAIEmbeddingProvider, type EmbeddingProvider } from "../memory/embeddings.js";
import { MemorySearchManager } from "../memory/search-manager.js";

const describeIf = process.env.OPENAI_API_KEY ? describe : describe.skip;

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

describeIf("Memory embeddings (live OpenAI API)", () => {
  let provider: EmbeddingProvider;
  let tmpDir: string;

  beforeAll(async () => {
    provider = createOpenAIEmbeddingProvider({
      apiKey: process.env.OPENAI_API_KEY!,
    });
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-embeddings-live-"));
  });

  afterAll(async () => {
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("generates embeddings with correct dimensions", async () => {
    const texts = [
      "The quick brown fox jumps over the lazy dog",
      "Machine learning transforms how we process data",
      "A stitch in time saves nine",
    ];

    const embeddings = await provider.embed(texts);

    expect(embeddings).toHaveLength(3);
    expect(provider.model).toBe("text-embedding-3-small");
    expect(provider.dimensions).toBe(1536);

    for (const embedding of embeddings) {
      expect(Array.isArray(embedding)).toBe(true);
      expect(embedding).toHaveLength(1536);
      for (const value of embedding) {
        expect(typeof value).toBe("number");
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  }, 60_000);

  it("similarity ordering reflects semantic relatedness", async () => {
    const texts = ["TypeScript programming", "JavaScript coding", "Italian cooking"];

    const embeddings = await provider.embed(texts);

    const simTsJs = cosineSimilarity(embeddings[0], embeddings[1]);
    const simTsCooking = cosineSimilarity(embeddings[0], embeddings[2]);

    // TypeScript and JavaScript should be much more similar than TypeScript and cooking
    expect(simTsJs).toBeGreaterThan(simTsCooking);

    // Sanity: all similarities should be in valid range
    expect(simTsJs).toBeGreaterThan(0);
    expect(simTsJs).toBeLessThanOrEqual(1);
    expect(simTsCooking).toBeGreaterThan(0);
    expect(simTsCooking).toBeLessThanOrEqual(1);

    console.log(`  TS↔JS similarity: ${simTsJs.toFixed(4)}`);
    console.log(`  TS↔Cooking similarity: ${simTsCooking.toFixed(4)}`);
    console.log(`  Difference: ${(simTsJs - simTsCooking).toFixed(4)}`);
  }, 60_000);

  it("hybrid search returns results with both vector and text scores", async () => {
    const memoryDir = path.join(tmpDir, "hybrid-memory");
    await fs.mkdir(memoryDir, { recursive: true });

    // Write daily logs with distinct topics
    await fs.writeFile(
      path.join(memoryDir, "2026-02-10.md"),
      [
        "# 2026-02-10",
        "",
        "Worked on TypeScript compiler optimization today.",
        "Improved type inference for generic functions.",
        "Reduced compilation time by 15% on large projects.",
      ].join("\n"),
      "utf-8",
    );

    await fs.writeFile(
      path.join(memoryDir, "2026-02-11.md"),
      [
        "# 2026-02-11",
        "",
        "Tried a new Italian pasta recipe for dinner.",
        "Used homemade tomato sauce with fresh basil.",
        "The family loved the carbonara variation.",
      ].join("\n"),
      "utf-8",
    );

    await fs.writeFile(
      path.join(memoryDir, "2026-02-12.md"),
      [
        "# 2026-02-12",
        "",
        "Debugged a tricky JavaScript async race condition.",
        "The issue was in the Promise.all error handling.",
        "Added proper retry logic with exponential backoff.",
      ].join("\n"),
      "utf-8",
    );

    const config: MemoryConfig = {
      enabled: true,
      dir: memoryDir,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorWeight: 0.7,
      maxResults: 10,
    };

    const manager = new MemorySearchManager(config, provider);
    await manager.sync();

    const results = await manager.search({ query: "TypeScript compiler performance" });

    expect(results.length).toBeGreaterThan(0);

    // The TypeScript-related entry should rank first
    expect(results[0].filePath).toContain("2026-02-10");
    expect(results[0].chunk).toContain("TypeScript");

    // Both score components should be populated
    for (const result of results) {
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(typeof result.vectorScore).toBe("number");
      expect(typeof result.textScore).toBe("number");
      // With vectorWeight=0.7, at least some results should have non-zero vector scores
      // (the query embedding matched against chunk embeddings)
    }

    // At least the top result should have a meaningful vector score
    expect(results[0].vectorScore).toBeGreaterThan(0);
    expect(results[0].textScore).toBeGreaterThanOrEqual(0);

    console.log(`  Top result: ${results[0].filePath}`);
    console.log(
      `  Score: ${results[0].score.toFixed(4)} (vector: ${results[0].vectorScore.toFixed(4)}, text: ${results[0].textScore.toFixed(4)})`,
    );
    console.log(`  Total results: ${results.length}`);
  }, 60_000);

  it("returns empty array for empty input without API call", async () => {
    const result = await provider.embed([]);
    expect(result).toEqual([]);
  });

  it("throws descriptive error for invalid API key", async () => {
    const badProvider = createOpenAIEmbeddingProvider({
      apiKey: "sk-invalid-key-for-testing",
    });

    await expect(badProvider.embed(["test text"])).rejects.toThrow(/OpenAI embeddings API error/);
  }, 60_000);
});
