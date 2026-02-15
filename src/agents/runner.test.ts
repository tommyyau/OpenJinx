import { describe, it, expect, vi, beforeEach } from "vitest";
import type { MemorySearchManager } from "../memory/search-manager.js";
import type { MemorySearchResult } from "../types/memory.js";
import { createTestConfig } from "../__test__/config.js";

// Mock all external dependencies
vi.mock("../providers/claude-provider.js", () => ({
  runAgentTurn: vi.fn().mockResolvedValue({
    text: "Hello!",
    messages: [],
    usage: { inputTokens: 10, outputTokens: 5 },
    durationMs: 100,
  }),
}));

vi.mock("../workspace/loader.js", () => ({
  loadWorkspaceFiles: vi.fn().mockResolvedValue([]),
}));

vi.mock("../sessions/transcript.js", () => ({
  appendTranscriptTurn: vi.fn().mockResolvedValue(undefined),
  readTranscript: vi.fn().mockResolvedValue([]),
  resolveTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
}));

vi.mock("../sessions/compaction.js", () => ({
  compactTranscript: vi
    .fn()
    .mockResolvedValue({ compacted: false, tokensBefore: 100, tokensAfter: 100 }),
  estimateTranscriptTokens: vi.fn().mockReturnValue(100),
  needsCompaction: vi.fn().mockReturnValue(false),
}));

vi.mock("../memory/flush.js", () => ({
  flushMemoryBeforeCompaction: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../skills/loader.js");
vi.mock("../skills/snapshot.js");
vi.mock("./system-prompt.js");

// ── assembleDefaultTools – session tools wiring ─────────────────────────────

describe("assembleDefaultTools", () => {
  it("includes session_status tool when sessions and sessionKey are provided", async () => {
    const { assembleDefaultTools } = await import("./runner.js");

    const sessions = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      save: vi.fn(),
      load: vi.fn(),
    };

    const config = createTestConfig();
    const tools = assembleDefaultTools(
      "/tmp/workspace",
      "/tmp/memory",
      undefined, // searchManager
      config,
      undefined, // cronService
      "test-session-key",
      sessions,
    );

    const names = tools.map((t) => t.name);
    expect(names).toContain("session_status");
  });

  it("excludes session_status tool when sessions is not provided", async () => {
    const { assembleDefaultTools } = await import("./runner.js");

    const config = createTestConfig();
    const tools = assembleDefaultTools("/tmp/workspace", "/tmp/memory", undefined, config);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("session_status");
  });

  it("does not include channel tools when no deps are wired", async () => {
    const { assembleDefaultTools } = await import("./runner.js");

    const config = createTestConfig();
    const tools = assembleDefaultTools("/tmp/workspace", "/tmp/memory", undefined, config);

    const names = tools.map((t) => t.name);
    expect(names).not.toContain("message");
    expect(names).not.toContain("sessions_send");
    expect(names).not.toContain("sessions_list");
  });

  it("includes channel tools when both sessions and channels are provided", async () => {
    const { assembleDefaultTools } = await import("./runner.js");

    const sessions = {
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      save: vi.fn(),
      load: vi.fn(),
    };

    const channels = new Map();
    const config = createTestConfig();
    const tools = assembleDefaultTools(
      "/tmp/workspace",
      "/tmp/memory",
      undefined,
      config,
      undefined,
      "test-key",
      sessions,
      channels,
    );

    const names = tools.map((t) => t.name);
    expect(names).toContain("message");
    expect(names).toContain("sessions_send");
    expect(names).toContain("sessions_list");
  });

  it("includes cron tool that works when cronService is provided", async () => {
    const { assembleDefaultTools } = await import("./runner.js");

    const fakeCron = {
      list: vi.fn().mockReturnValue([]),
    };
    const config = createTestConfig();
    const tools = assembleDefaultTools(
      "/tmp/workspace",
      "/tmp/memory",
      undefined,
      config,
      fakeCron as never,
    );

    const cronTool = tools.find((t) => t.name === "cron");
    expect(cronTool).toBeDefined();

    // With a real service, list action should work
    const result = await cronTool!.execute({ action: "list" });
    expect(result).toHaveProperty("jobs");
  });

  it("includes cron tool that returns error when cronService is not provided", async () => {
    const { assembleDefaultTools } = await import("./runner.js");

    const config = createTestConfig();
    const tools = assembleDefaultTools("/tmp/workspace", "/tmp/memory", undefined, config);

    const cronTool = tools.find((t) => t.name === "cron");
    expect(cronTool).toBeDefined();

    // Without a service, cron tool should report unavailable
    const result = (await cronTool!.execute({ action: "list" })) as {
      success: boolean;
      message: string;
    };
    expect(result.success).toBe(false);
    expect(result.message).toContain("not available");
  });
});

// ── buildRagContext ─────────────────────────────────────────────────────────

describe("buildRagContext", () => {
  it("returns empty string when no results", async () => {
    const { buildRagContext } = await import("./runner.js");

    const mockManager = { search: vi.fn().mockResolvedValue([]) } as unknown as MemorySearchManager;
    const result = await buildRagContext(mockManager, "hello");

    expect(result).toBe("");
    expect(mockManager.search).toHaveBeenCalledWith({
      query: "hello",
      maxResults: 5,
      minScore: 0.3,
    });
  });

  it("formats results with file paths and scores", async () => {
    const { buildRagContext } = await import("./runner.js");

    const results: MemorySearchResult[] = [
      {
        filePath: "preferences.md",
        chunk: "User likes TypeScript",
        startLine: 5,
        endLine: 7,
        score: 0.85,
        vectorScore: 0.9,
        textScore: 0.8,
      },
      {
        filePath: "notes.md",
        chunk: "Favorite color is blue",
        startLine: 1,
        endLine: 2,
        score: 0.42,
        vectorScore: 0.5,
        textScore: 0.3,
      },
    ];
    const mockManager = {
      search: vi.fn().mockResolvedValue(results),
    } as unknown as MemorySearchManager;
    const result = await buildRagContext(mockManager, "what do you know about me?");

    expect(result).toContain("# Relevant Memory");
    expect(result).toContain("[preferences.md:5] (score: 0.85)");
    expect(result).toContain("User likes TypeScript");
    expect(result).toContain("[notes.md:1] (score: 0.42)");
    expect(result).toContain("Favorite color is blue");
  });

  it("returns empty string on search failure", async () => {
    const { buildRagContext } = await import("./runner.js");

    const mockManager = {
      search: vi.fn().mockRejectedValue(new Error("index corrupted")),
    } as unknown as MemorySearchManager;
    const result = await buildRagContext(mockManager, "test");

    expect(result).toBe("");
  });
});

// ── loadHistory (tested indirectly via runAgent) ────────────────────────────

describe("runAgent – loadHistory behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function setupAndRunAgent(
    transcriptTurns: import("../types/sessions.js").TranscriptTurn[],
  ) {
    const { readTranscript } = await import("../sessions/transcript.js");
    const { runAgentTurn: callProvider } = await import("../providers/claude-provider.js");
    const { loadSkillEntries } = await import("../skills/loader.js");
    const { buildSkillSnapshot } = await import("../skills/snapshot.js");
    const { buildSystemPromptBlocks } = await import("./system-prompt.js");
    const { runAgent } = await import("./runner.js");

    vi.mocked(loadSkillEntries).mockResolvedValue([]);
    vi.mocked(buildSkillSnapshot).mockReturnValue({ prompt: "", count: 0, names: [], version: "" });
    vi.mocked(buildSystemPromptBlocks).mockReturnValue([
      { text: "system prompt", cacheable: true },
    ]);

    // readTranscript is called twice: once for compaction check, once for loadHistory
    vi.mocked(readTranscript).mockResolvedValue(transcriptTurns);

    const config = createTestConfig();
    await runAgent({
      prompt: "test prompt",
      sessionKey: "test-session",
      transcriptPath: "/tmp/transcript.jsonl",
      config,
      tools: [],
    });

    // Extract the history passed to the provider
    const providerCall = vi.mocked(callProvider).mock.calls[0][0];
    return providerCall.history ?? [];
  }

  it("empty transcript → provider receives empty history", async () => {
    const history = await setupAndRunAgent([]);
    expect(history).toEqual([]);
  });

  it("normal user/assistant alternation → preserved as-is", async () => {
    const history = await setupAndRunAgent([
      { role: "user", text: "hello", timestamp: 1 },
      { role: "assistant", text: "hi there", timestamp: 2 },
      { role: "user", text: "how are you?", timestamp: 3 },
    ]);

    expect(history).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
      { role: "user", content: "how are you?" },
    ]);
  });

  it("compaction turn → becomes user message with [Prior conversation summary] prefix", async () => {
    const history = await setupAndRunAgent([
      {
        role: "system",
        text: "[Conversation compacted — 10 turns]\n\nKey facts discussed.",
        timestamp: 1,
        isCompaction: true,
      },
      { role: "assistant", text: "acknowledged", timestamp: 2 },
      { role: "user", text: "continue", timestamp: 3 },
      { role: "assistant", text: "sure", timestamp: 4 },
    ]);

    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("[Prior conversation summary]");
    expect(history[0].content).toContain("Key facts discussed.");
    expect(history).toHaveLength(4);
  });

  it("leading assistant message → stripped", async () => {
    const history = await setupAndRunAgent([
      { role: "assistant", text: "stale message", timestamp: 1 },
      { role: "user", text: "hello", timestamp: 2 },
      { role: "assistant", text: "hi", timestamp: 3 },
    ]);

    expect(history[0].role).toBe("user");
    expect(history[0].content).toBe("hello");
    expect(history).toHaveLength(2);
  });

  it("consecutive same-role turns → merged with newlines", async () => {
    const history = await setupAndRunAgent([
      { role: "user", text: "first message", timestamp: 1 },
      { role: "user", text: "second message", timestamp: 2 },
      { role: "assistant", text: "response", timestamp: 3 },
    ]);

    expect(history).toHaveLength(2);
    expect(history[0].role).toBe("user");
    expect(history[0].content).toContain("first message");
    expect(history[0].content).toContain("second message");
  });

  it("more than 200 turns → only last 200 loaded", async () => {
    const turns: import("../types/sessions.js").TranscriptTurn[] = [];
    for (let i = 0; i < 210; i++) {
      turns.push({
        role: i % 2 === 0 ? "user" : "assistant",
        text: `msg-${i}`,
        timestamp: i,
      });
    }

    const history = await setupAndRunAgent(turns);

    // Should not contain the first 10 turns (only last 200)
    // Verify the first dropped turn (index 0) is absent and a kept turn is present
    // Use exact match with word boundaries to avoid "msg-0" matching "msg-100"
    const allContent = history.map((h) => h.content).join("|");
    expect(allContent.split("|")).not.toContainEqual("msg-0");
    expect(allContent.split("|")).not.toContainEqual("msg-5");
    expect(allContent).toContain("msg-209");
  });
});

// ── compaction wiring ───────────────────────────────────────────────────────

describe("runAgent – compaction wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls compactTranscript before loading history", async () => {
    const { compactTranscript } = await import("../sessions/compaction.js");
    const { loadSkillEntries } = await import("../skills/loader.js");
    const { buildSkillSnapshot } = await import("../skills/snapshot.js");
    const { buildSystemPromptBlocks } = await import("./system-prompt.js");
    const { runAgent } = await import("./runner.js");

    vi.mocked(loadSkillEntries).mockResolvedValue([]);
    vi.mocked(buildSkillSnapshot).mockReturnValue({ prompt: "", count: 0, names: [], version: "" });
    vi.mocked(buildSystemPromptBlocks).mockReturnValue([
      { text: "system prompt", cacheable: true },
    ]);
    vi.mocked(compactTranscript).mockResolvedValue({
      compacted: true,
      tokensBefore: 180_000,
      tokensAfter: 20_000,
    });

    const config = createTestConfig();

    await runAgent({
      prompt: "hello",
      sessionKey: "test-session",
      transcriptPath: "/tmp/transcript.jsonl",
      config,
      tools: [],
    });

    expect(compactTranscript).toHaveBeenCalledWith(
      "/tmp/transcript.jsonl",
      200_000, // context window for sonnet
      expect.any(Function),
    );
  });
});

// ── flush wiring ────────────────────────────────────────────────────────

describe("runAgent – pre-compaction flush wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls flushMemoryBeforeCompaction before compactTranscript when approaching limit", async () => {
    const { flushMemoryBeforeCompaction } = await import("../memory/flush.js");
    const { compactTranscript, needsCompaction } = await import("../sessions/compaction.js");
    const { loadSkillEntries } = await import("../skills/loader.js");
    const { buildSkillSnapshot } = await import("../skills/snapshot.js");
    const { buildSystemPromptBlocks } = await import("./system-prompt.js");
    const { runAgent } = await import("./runner.js");

    vi.mocked(loadSkillEntries).mockResolvedValue([]);
    vi.mocked(buildSkillSnapshot).mockReturnValue({ prompt: "", count: 0, names: [], version: "" });
    vi.mocked(buildSystemPromptBlocks).mockReturnValue([
      { text: "system prompt", cacheable: true },
    ]);

    // Simulate approaching context limit
    vi.mocked(needsCompaction).mockReturnValue(true);

    const callOrder: string[] = [];
    vi.mocked(flushMemoryBeforeCompaction).mockImplementation(async () => {
      callOrder.push("flush");
    });
    vi.mocked(compactTranscript).mockImplementation(async () => {
      callOrder.push("compact");
      return { compacted: true, tokensBefore: 180_000, tokensAfter: 20_000 };
    });

    const config = createTestConfig();

    await runAgent({
      prompt: "hello",
      sessionKey: "test-session",
      transcriptPath: "/tmp/transcript.jsonl",
      config,
      tools: [],
    });

    expect(flushMemoryBeforeCompaction).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "test-session",
        contextSummary: expect.stringContaining("200000"),
      }),
    );
    expect(callOrder).toEqual(["flush", "compact"]);
  });

  it("skips flush when transcript is well under context limit", async () => {
    const { flushMemoryBeforeCompaction } = await import("../memory/flush.js");
    const { needsCompaction } = await import("../sessions/compaction.js");
    const { loadSkillEntries } = await import("../skills/loader.js");
    const { buildSkillSnapshot } = await import("../skills/snapshot.js");
    const { buildSystemPromptBlocks } = await import("./system-prompt.js");
    const { runAgent } = await import("./runner.js");

    vi.mocked(loadSkillEntries).mockResolvedValue([]);
    vi.mocked(buildSkillSnapshot).mockReturnValue({ prompt: "", count: 0, names: [], version: "" });
    vi.mocked(buildSystemPromptBlocks).mockReturnValue([
      { text: "system prompt", cacheable: true },
    ]);

    // Not near context limit
    vi.mocked(needsCompaction).mockReturnValue(false);

    const config = createTestConfig();

    await runAgent({
      prompt: "hello",
      sessionKey: "test-session",
      transcriptPath: "/tmp/transcript.jsonl",
      config,
      tools: [],
    });

    expect(flushMemoryBeforeCompaction).not.toHaveBeenCalled();
  });
});
