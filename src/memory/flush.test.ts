import { describe, it, expect, vi } from "vitest";
import { flushMemoryBeforeCompaction } from "./flush.js";

describe("flushMemoryBeforeCompaction", () => {
  it("calls runTurn with MEMORY_FLUSH_PROMPT when callback provided", async () => {
    const runTurn = vi.fn().mockResolvedValue("done");

    await flushMemoryBeforeCompaction({
      sessionKey: "test-session",
      contextSummary: "some context",
      runTurn,
    });

    expect(runTurn).toHaveBeenCalledOnce();
    expect(runTurn.mock.calls[0][0]).toContain("Pre-compaction memory flush");
  });

  it("skips silently when runTurn is undefined", async () => {
    await expect(
      flushMemoryBeforeCompaction({
        sessionKey: "test-session",
        contextSummary: "some context",
      }),
    ).resolves.toBeUndefined();
  });

  it("propagates error when runTurn throws", async () => {
    const runTurn = vi.fn().mockRejectedValue(new Error("LLM down"));

    await expect(
      flushMemoryBeforeCompaction({
        sessionKey: "test-session",
        contextSummary: "some context",
        runTurn,
      }),
    ).rejects.toThrow("LLM down");
  });
});
