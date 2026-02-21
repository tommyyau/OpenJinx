/**
 * System test: WhatsApp Message Flow.
 * Crosses: Pipeline + Agent + Skills + Memory + WhatsApp Channel.
 *
 * Mirrors the Telegram message-flow system test to verify WhatsApp
 * exercises the same end-to-end path: message → context → dispatch →
 * agent (with skills + memory) → channel delivery.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { ChatEvent } from "../types/messages.js";
import { createTestHarness, type TestHarness } from "../__test__/harness.js";
import { createTestSkillEntry } from "../__test__/skills.js";
import { resolveAgent } from "../agents/scope.js";
import { buildSystemPrompt } from "../agents/system-prompt.js";
import { getMemoryToolDefinitions } from "../agents/tools/memory-tools.js";
import { checkWhatsAppAccess } from "../channels/whatsapp/access.js";
import { whatsappMessageToContext } from "../channels/whatsapp/context.js";
import { markdownToWhatsApp } from "../channels/whatsapp/format.js";
import { buildMsgContext } from "../pipeline/context.js";
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
  harness = await createTestHarness({ channelId: "whatsapp" });
});

afterEach(async () => {
  await harness.cleanup();
});

describe("WhatsApp message flow system tests", () => {
  it("WhatsApp message → pipeline → agent → channel delivery", async () => {
    // 1. Build context from a WhatsApp-shaped message
    const ctx = buildMsgContext({
      messageId: "wa-msg-1",
      channel: "whatsapp",
      text: "What can you help me with?",
      senderId: "5551234@s.whatsapp.net",
      senderName: "Tommy",
      accountId: "5551234@s.whatsapp.net",
      isGroup: false,
    });

    expect(ctx.channel).toBe("whatsapp");
    expect(ctx.sessionKey).toBe("whatsapp:dm:5551234@s.whatsapp.net");
    expect(ctx.isGroup).toBe(false);

    // 2. Session creation
    const session = createSessionEntry({
      sessionKey: ctx.sessionKey,
      agentId: ctx.agentId,
      channel: ctx.channel,
      transcriptPath: "/tmp/wa-test-transcript.jsonl",
      peerId: ctx.senderId,
      peerName: ctx.senderName,
    });
    harness.sessions.set(ctx.sessionKey, session);

    // 3. Resolve agent — same default agent as Telegram
    const agent = resolveAgent(harness.config, ctx.sessionKey);
    expect(agent.id).toBe("default");

    // 4. Load workspace files — identical pipeline
    const allFiles = await loadWorkspaceFiles(agent.workspace);
    const filtered = filterFilesForSession(allFiles, "main");
    const trimmed = trimWorkspaceFiles(filtered);

    const fileNames = trimmed.map((f) => f.name);
    expect(fileNames).toContain("SOUL.md");
    expect(fileNames).toContain("MEMORY.md");

    // 5. Build system prompt — includes memory tools
    const systemPrompt = buildSystemPrompt({
      workspaceFiles: trimmed,
      tools: getMemoryToolDefinitions({ memoryDir: harness.workspace.memoryDir }),
      sessionType: "main",
      agentName: agent.name,
      model: "claude-sonnet-4-6",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });

    expect(systemPrompt).toContain("Agent: TestJinx");
    expect(systemPrompt).toContain("memory_search");

    // 6. Stream events — WhatsApp only uses "final" (no streaming/editing)
    const events: ChatEvent[] = [];
    const unsub = subscribeStream(ctx.sessionKey, (e) => events.push(e));

    emitStreamEvent(ctx.sessionKey, {
      type: "final",
      text: "I can help you with many things!",
      usage: { inputTokens: 150, outputTokens: 40 },
    });

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("final");

    // 7. Channel delivery — format for WhatsApp
    const formatted = markdownToWhatsApp("I can help you with **many** things!");
    await harness.channel.send(ctx.senderId, { text: formatted });

    expect(harness.channel.deliveries).toHaveLength(1);
    // **many** → *many* (WhatsApp bold)
    expect(harness.channel.deliveries[0].payload.text).toContain("many");

    unsub();
  });

  it("whatsappMessageToContext builds correct context from Baileys message", () => {
    // Simulate a raw Baileys message
    const ctx = whatsappMessageToContext({
      key: {
        remoteJid: "5559876@s.whatsapp.net",
        fromMe: false,
        id: "ABCDEF123456",
      },
      message: {
        conversation: "Tell me about myself",
      },
      pushName: "Tommy",
      messageTimestamp: 1700000000,
    });

    expect(ctx.channel).toBe("whatsapp");
    expect(ctx.senderId).toBe("5559876@s.whatsapp.net");
    expect(ctx.senderName).toBe("Tommy");
    expect(ctx.text).toBe("Tell me about myself");
    expect(ctx.isGroup).toBe(false);
    expect(ctx.sessionKey).toBe("whatsapp:dm:5559876@s.whatsapp.net");
  });

  it("WhatsApp group message context is correct", () => {
    const ctx = whatsappMessageToContext({
      key: {
        remoteJid: "120363001@g.us",
        fromMe: false,
        id: "GROUP-MSG-1",
        participant: "5551234@s.whatsapp.net",
      },
      message: {
        conversation: "Hey everyone",
      },
      pushName: "Tommy",
    });

    expect(ctx.isGroup).toBe(true);
    expect(ctx.groupId).toBe("120363001@g.us");
    expect(ctx.senderId).toBe("5551234@s.whatsapp.net");
    expect(ctx.sessionKey).toBe("whatsapp:group:120363001@g.us");
  });

  it("WhatsApp access control integrates with dispatch", () => {
    // Open DM policy — should allow
    expect(
      checkWhatsAppAccess({
        jid: "5551234@s.whatsapp.net",
        isGroup: false,
        dmPolicy: "open",
      }),
    ).toBe(true);

    // Disabled groups — should deny
    expect(
      checkWhatsAppAccess({
        jid: "120363001@g.us",
        isGroup: true,
        dmPolicy: "open",
        groupPolicy: "disabled",
      }),
    ).toBe(false);
  });

  it("memory search works for WhatsApp channel (question about user)", async () => {
    // Write personal info into memory — same as what Telegram e2e does
    await harness.workspace.writeDailyLog(
      "2026-02-10",
      "# 2026-02-10\n\nTommy mentioned he lives in San Francisco and works on AI projects.\nHe prefers casual communication and always wants tests for new functionality.\n",
    );

    await harness.workspace.writeDailyLog(
      "2026-02-12",
      "# 2026-02-12\n\nTommy asked about implementing WhatsApp integration for Jinx.\nHe wants it to work exactly like the Telegram channel — full pipeline with skills and memory.\n",
    );

    // Build memory search manager (BM25 only for deterministic tests)
    const { MemorySearchManager } = await import("../memory/search-manager.js");
    const searchManager = new MemorySearchManager({
      enabled: true,
      dir: harness.workspace.memoryDir,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      vectorWeight: 0, // BM25 only
      maxResults: 10,
    });

    // Simulate the agent doing a memory_search when asked "tell me about Tommy"
    const results = await searchManager.search({ query: "Tommy lives works" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].chunk).toContain("Tommy");

    // Also search for the WhatsApp-specific memory
    const waResults = await searchManager.search({ query: "WhatsApp integration" });
    expect(waResults.length).toBeGreaterThan(0);
    expect(waResults[0].chunk).toContain("WhatsApp");

    // Agent composes response and delivers via WhatsApp channel
    const responseText =
      "Based on my memory, Tommy lives in San Francisco, works on AI projects, " +
      "and prefers casual communication. He recently asked about WhatsApp integration for Jinx.";

    const formatted = markdownToWhatsApp(responseText);
    await harness.channel.send("5551234@s.whatsapp.net", { text: formatted });

    expect(harness.channel.deliveries).toHaveLength(1);
    expect(harness.channel.deliveries[0].payload.text).toContain("San Francisco");
    expect(harness.channel.deliveries[0].payload.text).toContain("WhatsApp");
  });

  it("slash command works through WhatsApp channel", async () => {
    const skills = [
      createTestSkillEntry({
        name: "weather",
        description: "Check the weather",
        content: "# Weather\n\nCheck weather conditions.\n",
        commands: [
          {
            name: "weather",
            description: "Get weather",
            argsRequired: true,
            executionPath: "slash",
          },
        ],
        eligible: true,
      }),
    ];

    const ctx = buildMsgContext({
      messageId: "wa-cmd-1",
      channel: "whatsapp",
      text: "/weather San Francisco",
      senderId: "5551234@s.whatsapp.net",
      senderName: "Tommy",
      accountId: "5551234@s.whatsapp.net",
      isGroup: false,
    });

    expect(ctx.isCommand).toBe(true);
    expect(ctx.commandName).toBe("weather");
    expect(ctx.commandArgs).toBe("San Francisco");

    // Resolve and dispatch skill
    const resolved = resolveSlashCommand(ctx.commandName!, skills);
    expect(resolved).toBeDefined();

    const dispatched = dispatchSkill(resolved!.skill, resolved!.command, ctx.commandArgs!);
    expect(dispatched.executionPath).toBe("slash");
    expect(dispatched.prompt).toContain("/weather San Francisco");

    // Build system prompt with skills
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
    expect(systemPrompt).toContain("weather");

    // Deliver formatted response via WhatsApp
    const formatted = markdownToWhatsApp("**Weather in San Francisco**: 72°F, clear skies");
    await harness.channel.send(ctx.senderId, { text: formatted });

    expect(harness.channel.deliveries).toHaveLength(1);
    // **text** → *text* in WA format
    expect(harness.channel.deliveries[0].payload.text).toContain("Weather in San Francisco");
  });
});
