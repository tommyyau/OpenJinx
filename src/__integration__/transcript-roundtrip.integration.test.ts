/**
 * Integration: Transcript round-trip — append, read, rewrite, compaction.
 * Uses real filesystem I/O with a temp directory. No mocks except the
 * compaction summarize callback.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import type { TranscriptTurn } from "../types/sessions.js";
import { compactTranscript, estimateTranscriptTokens } from "../sessions/compaction.js";
import { appendTranscriptTurn, readTranscript, rewriteTranscript } from "../sessions/transcript.js";

let tmpDir: string;

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

function makeTurn(
  role: TranscriptTurn["role"],
  text: string,
  timestampOffset: number,
): TranscriptTurn {
  return { role, text, timestamp: 1_700_000_000_000 + timestampOffset };
}

describe("Transcript round-trip integration", () => {
  it("appends 5 turns and reads them back in order with correct content", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-transcript-"));
    const transcriptPath = path.join(tmpDir, "roundtrip.jsonl");

    const turns: TranscriptTurn[] = [
      makeTurn("user", "Hello Jinx", 0),
      makeTurn("assistant", "Hi there! How can I help?", 1000),
      makeTurn("user", "Tell me about TypeScript", 2000),
      makeTurn("assistant", "TypeScript is a typed superset of JavaScript.", 3000),
      makeTurn("system", "Session context refreshed.", 4000),
    ];

    for (const turn of turns) {
      await appendTranscriptTurn(transcriptPath, turn);
    }

    const result = await readTranscript(transcriptPath);

    expect(result).toHaveLength(5);
    for (let i = 0; i < turns.length; i++) {
      expect(result[i].role).toBe(turns[i].role);
      expect(result[i].text).toBe(turns[i].text);
      expect(result[i].timestamp).toBe(turns[i].timestamp);
    }

    // Verify ordering by timestamp
    for (let i = 1; i < result.length; i++) {
      expect(result[i].timestamp).toBeGreaterThan(result[i - 1].timestamp);
    }
  });

  it("reads from a nonexistent path and returns an empty array without throwing", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-transcript-"));
    const missingPath = path.join(tmpDir, "does-not-exist.jsonl");

    const result = await readTranscript(missingPath);

    expect(result).toEqual([]);
  });

  it("skips malformed JSONL lines and returns only valid turns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-transcript-"));
    const transcriptPath = path.join(tmpDir, "malformed.jsonl");

    const validTurn = makeTurn("user", "Valid turn", 0);
    const content = JSON.stringify(validTurn) + "\nNOT VALID JSON {{{]\n";
    await fs.writeFile(transcriptPath, content, "utf-8");

    const result = await readTranscript(transcriptPath);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].text).toBe("Valid turn");
  });

  it("rewrite atomically swaps content and leaves no .tmp files", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-transcript-"));
    const transcriptPath = path.join(tmpDir, "rewrite.jsonl");

    // Write 10 initial turns
    const originalTurns: TranscriptTurn[] = [];
    for (let i = 0; i < 10; i++) {
      const turn = makeTurn(i % 2 === 0 ? "user" : "assistant", `Turn ${i}`, i * 1000);
      originalTurns.push(turn);
      await appendTranscriptTurn(transcriptPath, turn);
    }

    // Verify 10 turns exist
    const before = await readTranscript(transcriptPath);
    expect(before).toHaveLength(10);

    // Rewrite to only 3 turns
    const newTurns = [
      makeTurn("system", "Compacted summary", 0),
      makeTurn("user", "Recent question", 9000),
      makeTurn("assistant", "Recent answer", 10_000),
    ];
    await rewriteTranscript(transcriptPath, newTurns);

    // Verify only 3 turns remain
    const after = await readTranscript(transcriptPath);
    expect(after).toHaveLength(3);
    expect(after[0].role).toBe("system");
    expect(after[0].text).toBe("Compacted summary");
    expect(after[1].text).toBe("Recent question");
    expect(after[2].text).toBe("Recent answer");

    // Verify no .tmp files remain in the directory
    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("compaction compresses transcript and preserves recent turns", async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-transcript-"));
    const transcriptPath = path.join(tmpDir, "compaction.jsonl");

    // Create 20 turns with substantial text to exceed context budget.
    // CHARS_PER_TOKEN = 4, so each 200-char turn ~ 50 tokens.
    // 20 turns * 50 tokens = ~1000 tokens, well above contextWindow of 100.
    const turns: TranscriptTurn[] = [];
    for (let i = 0; i < 20; i++) {
      const role: TranscriptTurn["role"] = i % 2 === 0 ? "user" : "assistant";
      const text = `Turn ${i}: ${"The quick brown fox jumps over the lazy dog. ".repeat(4)}`;
      const turn = makeTurn(role, text, i * 1000);
      turns.push(turn);
      await appendTranscriptTurn(transcriptPath, turn);
    }

    // Sanity check: tokens should exceed contextWindow * 0.8
    const tokensBefore = estimateTranscriptTokens(turns);
    expect(tokensBefore).toBeGreaterThan(100 * 0.8);

    // Compaction with a simple summarize callback
    const summarize = async (_prompt: string): Promise<string> => {
      return "Summary: the conversation covered various topics.";
    };

    const result = await compactTranscript(transcriptPath, 100, summarize);

    expect(result.compacted).toBe(true);
    expect(result.tokensBefore).toBe(tokensBefore);
    expect(result.tokensAfter).toBeLessThan(result.tokensBefore);

    // Re-read and verify structure: compaction turn + last 4 turns
    const afterTurns = await readTranscript(transcriptPath);
    expect(afterTurns.length).toBe(5); // 1 compaction + 4 recent

    // First turn should be the compaction summary
    expect(afterTurns[0].isCompaction).toBe(true);
    expect(afterTurns[0].role).toBe("system");
    expect(afterTurns[0].text).toContain("Summary: the conversation covered various topics.");

    // Last 4 turns should be the original last 4
    const expectedLast4 = turns.slice(-4);
    for (let i = 0; i < 4; i++) {
      expect(afterTurns[i + 1].role).toBe(expectedLast4[i].role);
      expect(afterTurns[i + 1].text).toBe(expectedLast4[i].text);
      expect(afterTurns[i + 1].timestamp).toBe(expectedLast4[i].timestamp);
    }
  });
});
