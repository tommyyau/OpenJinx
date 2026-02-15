import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../types/messages.js";
import type { SessionStore } from "../types/sessions.js";
import { createTestConfig } from "../__test__/config.js";
import { createSessionEntry } from "../sessions/store.js";
import { handleNewSession } from "./session-reset.js";

function makeMsgContext(overrides?: Partial<MsgContext>): MsgContext {
  return {
    messageId: "msg-1",
    channel: "terminal",
    sessionKey: "test-session",
    agentId: "default",
    accountId: "user",
    senderId: "user-1",
    senderName: "Tester",
    text: "/new",
    isGroup: false,
    isCommand: true,
    commandName: "new",
    timestamp: Date.now(),
    ...overrides,
  };
}

describe("handleNewSession", () => {
  let tmpDir: string;
  let memoryDir: string;
  let transcriptPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-session-reset-"));
    memoryDir = path.join(tmpDir, "memory");
    transcriptPath = path.join(tmpDir, "transcript.jsonl");

    // Write a small transcript
    const turns = [
      { role: "user", text: "Tell me about TypeScript", timestamp: Date.now() - 3000 },
      {
        role: "assistant",
        text: "TypeScript is a typed superset of JavaScript.",
        timestamp: Date.now() - 2000,
      },
      { role: "user", text: "How do generics work?", timestamp: Date.now() - 1000 },
      {
        role: "assistant",
        text: "Generics allow you to write reusable typed functions.",
        timestamp: Date.now(),
      },
    ];
    await fs.writeFile(transcriptPath, turns.map((t) => JSON.stringify(t)).join("\n") + "\n");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates a session summary file in memory dir", async () => {
    const config = createTestConfig({ memory: { dir: memoryDir } });
    const session = createSessionEntry({
      sessionKey: "test-session",
      agentId: "default",
      channel: "terminal",
      transcriptPath,
    });
    session.turnCount = 4;

    const sessions: SessionStore = {
      get: vi.fn(() => session),
      set: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => [session]),
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
    };

    const ctx = makeMsgContext();
    const result = await handleNewSession(ctx, { config, sessions });

    expect(result.text).toContain("Session saved");

    // Check that memory files were created
    const files = await fs.readdir(memoryDir);
    // Should have a session summary file (YYYY-MM-DD-slug.md) and a daily log (YYYY-MM-DD.md)
    expect(files.length).toBeGreaterThanOrEqual(2);

    const summaryFile = files.find((f) => f.includes("generics"));
    expect(summaryFile).toBeDefined();
  });

  it("resets session counters", async () => {
    const config = createTestConfig({ memory: { dir: memoryDir } });
    const session = createSessionEntry({
      sessionKey: "test-session",
      agentId: "default",
      channel: "terminal",
      transcriptPath,
    });
    session.turnCount = 10;
    session.totalInputTokens = 5000;
    session.totalOutputTokens = 3000;

    const sessions: SessionStore = {
      get: vi.fn(() => session),
      set: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => [session]),
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
    };

    await handleNewSession(makeMsgContext(), { config, sessions });

    expect(session.turnCount).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
  });

  it("returns confirmation when no session exists", async () => {
    const config = createTestConfig({ memory: { dir: memoryDir } });

    const sessions: SessionStore = {
      get: vi.fn(() => undefined),
      set: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => []),
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
    };

    const result = await handleNewSession(makeMsgContext(), { config, sessions });

    expect(result.text).toContain("No active session");
  });

  it("handles onSessionEnd failure gracefully — session still resets", async () => {
    // Use an invalid memory dir that will cause onSessionEnd to fail
    const config = createTestConfig({ memory: { dir: "/nonexistent/readonly/dir" } });
    const session = createSessionEntry({
      sessionKey: "test-session",
      agentId: "default",
      channel: "terminal",
      transcriptPath,
    });
    session.turnCount = 5;
    session.totalInputTokens = 1000;
    session.totalOutputTokens = 500;

    const sessions: SessionStore = {
      get: vi.fn(() => session),
      set: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => [session]),
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
    };

    // Should NOT throw even though onSessionEnd will fail
    const result = await handleNewSession(makeMsgContext(), { config, sessions });

    // Session should still be confirmed and reset
    expect(result.text).toContain("Session saved");
    expect(session.turnCount).toBe(0);
    expect(session.totalInputTokens).toBe(0);
    expect(session.totalOutputTokens).toBe(0);
  });

  it("generates slug from last user message", async () => {
    const config = createTestConfig({ memory: { dir: memoryDir } });
    const session = createSessionEntry({
      sessionKey: "test-session",
      agentId: "default",
      channel: "terminal",
      transcriptPath,
    });

    const sessions: SessionStore = {
      get: vi.fn(() => session),
      set: vi.fn(),
      delete: vi.fn(() => true),
      list: vi.fn(() => [session]),
      save: vi.fn(async () => {}),
      load: vi.fn(async () => {}),
    };

    await handleNewSession(makeMsgContext(), { config, sessions });

    const files = await fs.readdir(memoryDir);
    // The slug should contain "generics" from "How do generics work?"
    const summaryFile = files.find((f) => f.includes("generics"));
    expect(summaryFile).toBeDefined();
  });
});
