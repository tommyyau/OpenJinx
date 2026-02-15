/**
 * Integration: Compaction → History reload chain.
 *
 * Tests the full compaction lifecycle with real transcript I/O and
 * real compaction logic — mocking only the LLM summarize callback
 * and the memory flush runTurn callback.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TranscriptTurn } from "../types/sessions.js";
import { flushMemoryBeforeCompaction } from "../memory/flush.js";
import {
  compactTranscript,
  estimateTranscriptTokens,
  needsCompaction,
  selectTurnsForCompaction,
} from "../sessions/compaction.js";
import { appendTranscriptTurn, readTranscript } from "../sessions/transcript.js";

/** Build a turn with ~charCount characters of text. */
function makeTurn(role: "user" | "assistant", charCount: number, index: number): TranscriptTurn {
  const text = `Turn ${index}: ${"x".repeat(Math.max(0, charCount - 10))}`;
  return { role, text, timestamp: Date.now() + index };
}

describe("compaction chain integration", () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-compact-"));
    transcriptPath = path.join(tmpDir, "sessions", "test.jsonl");
    await fs.mkdir(path.join(tmpDir, "sessions"), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("below threshold — no compaction", async () => {
    // Write 5 short turns
    for (let i = 0; i < 5; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await appendTranscriptTurn(transcriptPath, makeTurn(role as "user" | "assistant", 50, i));
    }

    const summarize = vi.fn();
    // Use a huge context window so compaction never triggers
    const result = await compactTranscript(transcriptPath, 1_000_000, summarize);

    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();

    const turns = await readTranscript(transcriptPath);
    expect(turns).toHaveLength(5);
  });

  it("above threshold — full compaction", async () => {
    // Write 20 turns with ~1000 chars each
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await appendTranscriptTurn(transcriptPath, makeTurn(role as "user" | "assistant", 1000, i));
    }

    const turnsBefore = await readTranscript(transcriptPath);
    const tokensBefore = estimateTranscriptTokens(turnsBefore);

    // Set context window so that tokensBefore exceeds 80% of it
    // needsCompaction: tokensBefore > contextWindow * 0.8
    // So contextWindow must be < tokensBefore / 0.8
    const tightContextWindow = tokensBefore; // tokensBefore > tokensBefore * 0.8 is always true
    expect(needsCompaction(tokensBefore, tightContextWindow)).toBe(true);

    const [toCompact, toKeep] = selectTurnsForCompaction(turnsBefore, 4);
    expect(toCompact).toHaveLength(16);
    expect(toKeep).toHaveLength(4);

    const summarize = vi.fn().mockResolvedValue("This is the compacted summary of 16 turns.");

    const result = await compactTranscript(transcriptPath, tightContextWindow, summarize);

    expect(result.compacted).toBe(true);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);
    expect(summarize).toHaveBeenCalledOnce();

    // Verify the summarize prompt contains turn content
    const prompt = summarize.mock.calls[0][0] as string;
    expect(prompt).toContain("[user]:");
    expect(prompt).toContain("[assistant]:");

    // Verify resulting transcript structure
    const turnsAfter = await readTranscript(transcriptPath);
    expect(turnsAfter).toHaveLength(5); // 1 compaction + 4 recent

    const compactionTurn = turnsAfter[0];
    expect(compactionTurn.role).toBe("system");
    expect(compactionTurn.isCompaction).toBe(true);
    expect(compactionTurn.text).toContain("compacted");
    expect(compactionTurn.text).toContain("This is the compacted summary of 16 turns.");

    // Recent 4 turns preserved with original content
    for (let i = 1; i < 5; i++) {
      expect(turnsAfter[i].text).toContain("Turn");
    }
  });

  it("pre-compaction flush fires before compaction", async () => {
    // Write enough turns to trigger compaction
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await appendTranscriptTurn(transcriptPath, makeTurn(role as "user" | "assistant", 1000, i));
    }

    const turns = await readTranscript(transcriptPath);
    const tokens = estimateTranscriptTokens(turns);
    const contextWindow = tokens; // tokens > tokens * 0.8 always triggers compaction

    // Verify compaction is needed
    expect(needsCompaction(tokens, contextWindow)).toBe(true);

    // Simulate the runner's compaction block:
    // 1. Flush memory first
    const runTurn = vi.fn().mockResolvedValue("flushed");
    await flushMemoryBeforeCompaction({
      sessionKey: "test-session",
      contextSummary: `${tokens} tokens used`,
      runTurn,
    });

    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn.mock.calls[0][0]).toContain("Pre-compaction memory flush");

    // 2. Then compact
    const summarize = vi.fn().mockResolvedValue("Summary after flush.");
    const result = await compactTranscript(transcriptPath, contextWindow, summarize);
    expect(result.compacted).toBe(true);
  });

  it("compacted history loads correctly with system role and isCompaction", async () => {
    // Write turns, compact, then read back
    for (let i = 0; i < 12; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await appendTranscriptTurn(transcriptPath, makeTurn(role as "user" | "assistant", 500, i));
    }

    const turns = await readTranscript(transcriptPath);
    const tokens = estimateTranscriptTokens(turns);
    const contextWindow = tokens; // tokens > tokens * 0.8 always triggers compaction

    const summarize = vi.fn().mockResolvedValue("Key facts: user discussed testing strategies.");
    await compactTranscript(transcriptPath, contextWindow, summarize);

    // Read transcript back
    const loaded = await readTranscript(transcriptPath);

    // First turn should be the compaction summary
    const summary = loaded[0];
    expect(summary.role).toBe("system");
    expect(summary.isCompaction).toBe(true);
    expect(summary.text).toContain("Key facts: user discussed testing strategies.");

    // Remaining turns should be the original recent turns
    const recent = loaded.slice(1);
    expect(recent.length).toBe(4);
    for (const turn of recent) {
      expect(turn.role === "user" || turn.role === "assistant").toBe(true);
      expect(turn.isCompaction).toBeUndefined();
    }
  });

  it("double compaction is idempotent", async () => {
    // Write turns and compact once
    for (let i = 0; i < 20; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await appendTranscriptTurn(transcriptPath, makeTurn(role as "user" | "assistant", 1000, i));
    }

    const turns = await readTranscript(transcriptPath);
    const tokens = estimateTranscriptTokens(turns);
    const contextWindow = tokens; // tokens > tokens * 0.8 always triggers compaction

    const summarize = vi.fn().mockResolvedValue("First compaction summary.");
    const first = await compactTranscript(transcriptPath, contextWindow, summarize);
    expect(first.compacted).toBe(true);

    // Second compaction — should be below threshold now
    const second = await compactTranscript(transcriptPath, contextWindow, summarize);
    expect(second.compacted).toBe(false);
    // Summarize should only have been called once (from the first compaction)
    expect(summarize).toHaveBeenCalledOnce();
  });

  it("edge case — all turns are recent, no compaction", async () => {
    // Only 3 turns in transcript
    for (let i = 0; i < 3; i++) {
      const role = i % 2 === 0 ? "user" : "assistant";
      await appendTranscriptTurn(transcriptPath, makeTurn(role as "user" | "assistant", 2000, i));
    }

    const turns = await readTranscript(transcriptPath);
    const [toCompact, toKeep] = selectTurnsForCompaction(turns, 4);
    expect(toCompact).toHaveLength(0);
    expect(toKeep).toHaveLength(3);

    // Even if tokens exceed window, can't compact when all turns are "recent"
    const summarize = vi.fn();
    const result = await compactTranscript(transcriptPath, 1, summarize);
    expect(result.compacted).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });
});
