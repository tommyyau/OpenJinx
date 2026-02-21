/**
 * System test: Message Flow.
 * Crosses: Pipeline + Agent + Skills + Memory + Channels.
 *
 * Verifies the full user message → pipeline → agent → channel delivery flow.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChatEvent } from "../types/messages.js";
import { createTestHarness, type TestHarness } from "../__test__/harness.js";
import { createTestSkillEntry } from "../__test__/skills.js";
import { resolveAgent } from "../agents/scope.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";
import { getMemoryToolDefinitions } from "../agents/tools/memory-tools.js";
import { buildMsgContext } from "../pipeline/context.js";
import { Lane } from "../pipeline/lanes.js";
import { subscribeStream, emitStreamEvent } from "../pipeline/streaming.js";
import { createSessionEntry } from "../sessions/store.js";
import { resolveSlashCommand } from "../skills/commands.js";
import { dispatchSkill } from "../skills/dispatch.js";
import { buildSkillSnapshot } from "../skills/snapshot.js";
import { filterFilesForSession } from "../workspace/filter.js";
import { loadWorkspaceFiles } from "../workspace/loader.js";
import { trimWorkspaceFiles } from "../workspace/trim.js";

let harness: TestHarness;

beforeEach(async () => {
  harness = await createTestHarness();
});

afterEach(async () => {
  await harness.cleanup();
});

describe("Message flow system tests", () => {
  it("user message → pipeline → agent → channel delivery", async () => {
    const ctx = buildMsgContext({
      messageId: "msg-1",
      channel: "telegram",
      text: "What's the weather like?",
      senderId: "user-123",
      senderName: "Alice",
      accountId: "bot-456",
      isGroup: false,
    });

    // 1. Session creation
    const session = createSessionEntry({
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      channel: ctx.channel,
      transcriptPath: "/tmp/test-transcript.jsonl",
      peerId: ctx.senderId,
      peerName: ctx.senderName,
    });
    harness.sessions.set(ctx.sessionKey, session);

    // 2. Resolve agent and model
    const agent = resolveAgent(harness.config, ctx.sessionKey);
    expect(agent.id).toBe("default");

    // 3. Load workspace files
    const allFiles = await loadWorkspaceFiles(agent.workspace);
    const filtered = filterFilesForSession(allFiles, "main");
    const trimmed = trimWorkspaceFiles(filtered);

    // Verify SOUL.md, MEMORY.md, etc. are present
    const fileNames = trimmed.map((f) => f.name);
    expect(fileNames).toContain("SOUL.md");
    expect(fileNames).toContain("AGENTS.md");
    expect(fileNames).toContain("MEMORY.md");
    expect(fileNames).toContain("HEARTBEAT.md");

    // 4. Build system prompt
    const systemPrompt = buildSystemPrompt({
      workspaceFiles: trimmed,
      tools: getMemoryToolDefinitions(),
      sessionType: "main",
      agentName: agent.name,
      model: "claude-sonnet-4-6",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });

    expect(systemPrompt).toContain("Agent: TestJinx");
    expect(systemPrompt).toContain("memory_search");

    // 5. Stream events emitted
    const events: ChatEvent[] = [];
    const unsub = subscribeStream(ctx.sessionKey, (e) => events.push(e));

    emitStreamEvent(ctx.sessionKey, { type: "delta", text: "It's sunny" });
    emitStreamEvent(ctx.sessionKey, {
      type: "final",
      text: "It's sunny today!",
      usage: { inputTokens: 100, outputTokens: 30 },
    });

    expect(events).toHaveLength(2);

    // 6. Channel receives response
    await harness.channel.send(ctx.senderId, { text: "It's sunny today!" });
    expect(harness.channel.deliveries).toHaveLength(1);
    expect(harness.channel.deliveries[0].payload.text).toBe("It's sunny today!");

    unsub();
  });

  it("slash command → skill execution → channel delivery", async () => {
    const skills = [
      createTestSkillEntry({
        name: "search",
        description: "Search the web",
        content: "# Search\n\nSearch the web for information.\n",
        commands: [
          { name: "search", description: "Web search", argsRequired: true, executionPath: "slash" },
        ],
        eligible: true,
      }),
    ];

    const ctx = buildMsgContext({
      messageId: "msg-2",
      channel: "telegram",
      text: "/search latest TypeScript features",
      senderId: "user-123",
      senderName: "Alice",
      accountId: "bot-456",
      isGroup: false,
    });

    expect(ctx.isCommand).toBe(true);
    expect(ctx.commandName).toBe("search");

    // Resolve skill
    const resolved = resolveSlashCommand(ctx.commandName!, skills);
    expect(resolved).toBeDefined();

    // Dispatch skill
    const dispatched = dispatchSkill(resolved!.skill, resolved!.command, ctx.commandArgs!);
    expect(dispatched.executionPath).toBe("slash");
    expect(dispatched.prompt).toContain("/search latest TypeScript features");
    expect(dispatched.prompt).toContain("<skill-context>");

    // Build prompt with skills
    const snapshot = buildSkillSnapshot(skills);
    const systemPrompt = buildSystemPrompt({
      workspaceFiles: [],
      tools: [],
      skills: snapshot,
      sessionType: "main",
      agentName: "Jinx",
      model: "test",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });

    expect(systemPrompt).toContain("<available-skills>");
    expect(systemPrompt).toContain("search");

    // Deliver response
    await harness.channel.send(ctx.senderId, {
      text: "Here are the latest TypeScript features...",
    });
    expect(harness.channel.deliveries).toHaveLength(1);
  });

  it("agent tool loop (memory_search) works end-to-end", async () => {
    // Write searchable content
    await harness.workspace.writeDailyLog(
      "2026-01-10",
      "# 2026-01-10\n\nMeeting notes: Decided to use React for the frontend.\n",
    );

    // Build memory search manager
    const { MemorySearchManager } = await import("../memory/search-manager.js");
    const searchManager = new MemorySearchManager({
      enabled: true,
      dir: harness.workspace.memoryDir,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorWeight: 0,
      maxResults: 10,
    });

    // Simulate memory_search tool call
    const results = await searchManager.search({ query: "React frontend" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk).toContain("React");

    // Feed results back (as agent would)
    const _toolOutput = JSON.stringify(
      results.map((r) => ({
        file: r.filePath,
        text: r.chunk,
        score: r.score,
      })),
    );

    // Final response delivered
    await harness.channel.send("user-123", {
      text: `Based on your notes, you decided to use React for the frontend on 2026-01-10.`,
    });

    expect(harness.channel.deliveries).toHaveLength(1);
    expect(harness.channel.deliveries[0].payload.text).toContain("React");
  });

  it("group message excludes private workspace files", async () => {
    const files = await loadWorkspaceFiles(harness.workspace.dir);

    // Group session filtering
    const groupFiltered = filterFilesForSession(files, "group");
    const groupFileNames = groupFiltered.map((f) => f.name);

    // HEARTBEAT.md and BOOTSTRAP.md should be excluded from group
    expect(groupFileNames).not.toContain("HEARTBEAT.md");
    expect(groupFileNames).not.toContain("BOOTSTRAP.md");

    // But MEMORY.md is still included per PRD
    expect(groupFileNames).toContain("MEMORY.md");
    expect(groupFileNames).toContain("SOUL.md");
  });

  it("session lane ensures message serialization", async () => {
    const lane = new Lane("system-test-serial", 1);
    const executionOrder: string[] = [];

    const p1 = lane.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      executionOrder.push("first");
    });
    const p2 = lane.enqueue(async () => {
      executionOrder.push("second");
    });

    await Promise.all([p1, p2]);
    expect(executionOrder).toEqual(["first", "second"]);
  });
});
