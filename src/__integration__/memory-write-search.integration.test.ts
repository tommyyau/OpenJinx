/**
 * Integration: Memory Write → Search boundary.
 * Tests writing daily logs and markdown files, syncing the index,
 * and searching with real MemorySearchManager (BM25 only, deterministic).
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { MemoryConfig } from "../types/config.js";
import { appendDailyLog } from "../memory/daily-logs.js";
import { MemorySearchManager } from "../memory/search-manager.js";

let tmpDir: string;
let config: MemoryConfig;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-mem-write-search-"));
  config = {
    enabled: true,
    dir: tmpDir,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    vectorWeight: 0, // Pure BM25 for deterministic tests
    maxResults: 10,
  };
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Memory Write → Search integration", () => {
  it("write daily log then search finds written content", async () => {
    await appendDailyLog(tmpDir, "Met with Sarah about TypeScript migration");

    const manager = new MemorySearchManager(config);
    await manager.sync();

    const results = await manager.search({ query: "TypeScript migration" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk).toContain("TypeScript migration");
  });

  it("multi-file ranking returns results in correct relevance order", async () => {
    // File with high relevance: dedicated quantum computing content
    await fs.writeFile(
      path.join(tmpDir, "quantum.md"),
      "# Quantum Computing\n\nQuantum computing uses qubits and superposition.\nQuantum algorithms like Shor's and Grover's revolutionize computation.\nQuantum entanglement enables quantum teleportation.\n",
      "utf-8",
    );

    // File with moderate relevance: mentions quantum once
    await fs.writeFile(
      path.join(tmpDir, "physics.md"),
      "# Physics Notes\n\nClassical mechanics describes motion of objects.\nQuantum computing was briefly mentioned in the lecture.\nThermodynamics covers heat and energy transfer.\n",
      "utf-8",
    );

    // File with no relevance: unrelated topic
    await fs.writeFile(
      path.join(tmpDir, "cooking.md"),
      "# Cooking Recipes\n\nThe best pasta requires fresh basil and tomatoes.\nSourdough bread needs a long fermentation process.\n",
      "utf-8",
    );

    const manager = new MemorySearchManager(config);
    await manager.sync();

    const results = await manager.search({ query: "quantum computing" });
    expect(results.length).toBeGreaterThanOrEqual(1);

    // The most relevant result should be from the quantum.md file
    expect(results[0].filePath).toContain("quantum.md");

    // Results should be sorted by score descending
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }

    // The cooking file should either not appear or score lower than quantum
    const cookingResults = results.filter((r) => r.filePath.includes("cooking.md"));
    if (cookingResults.length > 0) {
      expect(cookingResults[0].score).toBeLessThan(results[0].score);
    }
  });

  it("index persistence survives across manager instances", async () => {
    await fs.writeFile(
      path.join(tmpDir, "persist-test.md"),
      "# Persistence\n\nThis document tests that the index persists across manager instances.\n",
      "utf-8",
    );

    // First instance: sync to build and save index
    const manager1 = new MemorySearchManager(config);
    await manager1.sync();

    const results1 = await manager1.search({ query: "index persists" });
    expect(results1.length).toBeGreaterThan(0);

    const status1 = manager1.getStatus();
    expect(status1.totalChunks).toBeGreaterThan(0);

    // Second instance: load persisted index via init() (no sync)
    const manager2 = new MemorySearchManager(config);
    await manager2.init();

    const status2 = manager2.getStatus();
    expect(status2.totalChunks).toBe(status1.totalChunks);

    const results2 = await manager2.search({ query: "index persists" });
    expect(results2.length).toBe(results1.length);
    expect(results2[0].filePath).toBe(results1[0].filePath);
    expect(results2[0].chunk).toBe(results1[0].chunk);
  });

  it("incremental updates make both old and new files searchable", async () => {
    // Write file A and sync
    await fs.writeFile(
      path.join(tmpDir, "alpha.md"),
      "# Alpha\n\nAlpaca farming in the Andes mountains is a traditional practice.\n",
      "utf-8",
    );

    const manager = new MemorySearchManager(config);
    await manager.sync();

    const resultsA = await manager.search({ query: "alpaca farming" });
    expect(resultsA.length).toBeGreaterThan(0);
    expect(resultsA[0].filePath).toContain("alpha.md");

    // Write file B and sync again
    await fs.writeFile(
      path.join(tmpDir, "beta.md"),
      "# Beta\n\nDeep sea exploration reveals bioluminescent creatures in the ocean.\n",
      "utf-8",
    );

    await manager.sync();

    // Both files should be searchable
    const resultsB = await manager.search({ query: "bioluminescent creatures" });
    expect(resultsB.length).toBeGreaterThan(0);
    expect(resultsB[0].filePath).toContain("beta.md");

    // File A should still be searchable after the incremental sync
    const resultsA2 = await manager.search({ query: "alpaca farming" });
    expect(resultsA2.length).toBeGreaterThan(0);
    expect(resultsA2[0].filePath).toContain("alpha.md");
  });

  it("file modification re-indexes updated content", async () => {
    const filePath = path.join(tmpDir, "mutable.md");
    await fs.writeFile(
      filePath,
      "# Fruits\n\nI love eating bananas for breakfast every morning.\n",
      "utf-8",
    );

    const manager = new MemorySearchManager(config);
    await manager.sync();

    const bananaResults = await manager.search({ query: "bananas" });
    expect(bananaResults.length).toBeGreaterThan(0);

    // Overwrite the file with different content
    await fs.writeFile(
      filePath,
      "# Fruits\n\nI love eating mangoes for breakfast every morning.\n",
      "utf-8",
    );
    await manager.sync();

    // Search for new content should succeed
    const mangoResults = await manager.search({ query: "mangoes" });
    expect(mangoResults.length).toBeGreaterThan(0);
    expect(mangoResults[0].chunk).toContain("mangoes");

    // Search for old content should return no results or lower score
    const oldBananaResults = await manager.search({ query: "bananas" });
    if (oldBananaResults.length > 0) {
      // If bananas still shows up, it should score lower than mangoes did
      expect(oldBananaResults[0].score).toBeLessThan(mangoResults[0].score);
    }
  });

  it("search over empty directory returns empty results without errors", async () => {
    const manager = new MemorySearchManager(config);
    await manager.sync();

    const results = await manager.search({ query: "anything at all" });
    expect(results).toEqual([]);

    const status = manager.getStatus();
    expect(status.totalFiles).toBe(0);
    expect(status.totalChunks).toBe(0);
  });
});
