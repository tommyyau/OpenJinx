import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type { TranscriptTurn } from "../types/sessions.js";
import { LIMITS } from "../infra/security.js";
import {
  appendTranscriptTurn,
  readTranscript,
  readRecentTurns,
  countTurns,
  rewriteTranscript,
} from "./transcript.js";

let tmpDir: string;
let transcriptPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-transcript-"));
  transcriptPath = path.join(tmpDir, "test.jsonl");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

const makeTurn = (role: "user" | "assistant", text: string): TranscriptTurn => ({
  role,
  text,
  timestamp: Date.now(),
});

describe("transcript operations", () => {
  it("appends and reads turns", async () => {
    await appendTranscriptTurn(transcriptPath, makeTurn("user", "hello"));
    await appendTranscriptTurn(transcriptPath, makeTurn("assistant", "hi there"));

    const turns = await readTranscript(transcriptPath);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("hello");
    expect(turns[1].text).toBe("hi there");
  });

  it("reads empty transcript for missing file", async () => {
    const turns = await readTranscript("/nonexistent/path.jsonl");
    expect(turns).toHaveLength(0);
  });

  it("reads recent turns", async () => {
    for (let i = 0; i < 10; i++) {
      await appendTranscriptTurn(transcriptPath, makeTurn("user", `msg-${i}`));
    }

    const recent = await readRecentTurns(transcriptPath, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].text).toBe("msg-7");
    expect(recent[2].text).toBe("msg-9");
  });

  it("counts turns", async () => {
    await appendTranscriptTurn(transcriptPath, makeTurn("user", "a"));
    await appendTranscriptTurn(transcriptPath, makeTurn("assistant", "b"));
    await appendTranscriptTurn(transcriptPath, makeTurn("user", "c"));

    expect(await countTurns(transcriptPath)).toBe(3);
  });

  it("returns 0 for missing file count", async () => {
    expect(await countTurns("/nonexistent.jsonl")).toBe(0);
  });
});

describe("transcript file security", () => {
  it("creates transcript files with secure permissions (0o600)", async () => {
    await appendTranscriptTurn(transcriptPath, makeTurn("user", "hello"));
    const stat = await fs.stat(transcriptPath);
    // mode includes file type bits, mask with 0o777 to get just permission bits
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("rewriteTranscript uses unpredictable temp file names", async () => {
    // Write initial content
    await appendTranscriptTurn(transcriptPath, makeTurn("user", "original"));

    // Rewrite and verify no .tmp file remains
    await rewriteTranscript(transcriptPath, [makeTurn("user", "rewritten")]);

    // List directory — no temp files should remain
    const files = await fs.readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("rewriteTranscript creates files with secure permissions", async () => {
    await rewriteTranscript(transcriptPath, [makeTurn("user", "secure")]);
    const stat = await fs.stat(transcriptPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });
});

describe("rewriteTranscript", () => {
  it("replaces transcript contents atomically", async () => {
    // Write 5 turns via append
    for (let i = 0; i < 5; i++) {
      await appendTranscriptTurn(transcriptPath, makeTurn("user", `original-${i}`));
    }
    const before = await readTranscript(transcriptPath);
    expect(before).toHaveLength(5);

    // Rewrite with only 2 turns
    const newTurns = [makeTurn("user", "compacted-summary"), makeTurn("assistant", "reply")];
    await rewriteTranscript(transcriptPath, newTurns);

    const after = await readTranscript(transcriptPath);
    expect(after).toHaveLength(2);
    expect(after[0].text).toBe("compacted-summary");
    expect(after[1].text).toBe("reply");
  });

  it("creates parent directory if needed", async () => {
    const nestedPath = path.join(tmpDir, "nested", "dir", "transcript.jsonl");
    await rewriteTranscript(nestedPath, [makeTurn("user", "hello")]);

    const turns = await readTranscript(nestedPath);
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe("hello");
  });
});

describe("readTranscript edge cases", () => {
  it("returns empty array when file exceeds MAX_TRANSCRIPT_FILE_BYTES", async () => {
    // Write a file that exceeds the size limit
    const bigContent = "x".repeat(LIMITS.MAX_TRANSCRIPT_FILE_BYTES + 1);
    await fs.writeFile(transcriptPath, bigContent);

    const turns = await readTranscript(transcriptPath);
    expect(turns).toHaveLength(0);
  });

  it("returns empty array on non-ENOENT read error (e.g. path is a directory)", async () => {
    // Create a directory where the file would be — reading it should fail with EISDIR
    const dirAsFile = path.join(tmpDir, "fake-transcript.jsonl");
    await fs.mkdir(dirAsFile, { recursive: true });

    const turns = await readTranscript(dirAsFile);
    expect(turns).toHaveLength(0);
  });

  it("skips malformed JSON lines and returns valid ones", async () => {
    const validTurn = JSON.stringify(makeTurn("user", "valid"));
    const content = `${validTurn}\n{INVALID_JSON\n${JSON.stringify(makeTurn("assistant", "also valid"))}\n`;
    await fs.writeFile(transcriptPath, content);

    const turns = await readTranscript(transcriptPath);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe("valid");
    expect(turns[1].text).toBe("also valid");
  });
});
