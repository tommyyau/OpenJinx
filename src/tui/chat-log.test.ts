import { describe, it, expect, beforeEach } from "vitest";
import { ChatLog, type ChatMessage } from "./chat-log.js";

function makeMsg(role: ChatMessage["role"], text: string, timestamp = Date.now()): ChatMessage {
  return { role, text, timestamp };
}

describe("ChatLog", () => {
  let log: ChatLog;

  beforeEach(() => {
    log = new ChatLog();
  });

  it("add() + getAll() preserves insertion order", () => {
    log.add(makeMsg("user", "hello"));
    log.add(makeMsg("assistant", "hi there"));
    log.add(makeMsg("user", "how are you?"));

    const all = log.getAll();
    expect(all).toHaveLength(3);
    expect(all[0].text).toBe("hello");
    expect(all[1].text).toBe("hi there");
    expect(all[2].text).toBe("how are you?");
  });

  it("getAll() returns a copy, not the internal array", () => {
    log.add(makeMsg("user", "hello"));
    const all = log.getAll();
    all.push(makeMsg("system", "injected"));
    expect(log.getAll()).toHaveLength(1);
  });

  it("getRecent(n) returns last n messages", () => {
    for (let i = 0; i < 10; i++) {
      log.add(makeMsg("user", `msg-${i}`));
    }

    const recent = log.getRecent(3);
    expect(recent).toHaveLength(3);
    expect(recent[0].text).toBe("msg-7");
    expect(recent[1].text).toBe("msg-8");
    expect(recent[2].text).toBe("msg-9");
  });

  it("getRecent(n) with n > length returns all messages", () => {
    log.add(makeMsg("user", "only one"));
    const recent = log.getRecent(5);
    expect(recent).toHaveLength(1);
    expect(recent[0].text).toBe("only one");
  });

  it("clear() empties the log", () => {
    log.add(makeMsg("user", "a"));
    log.add(makeMsg("assistant", "b"));
    expect(log.length).toBe(2);

    log.clear();
    expect(log.length).toBe(0);
    expect(log.getAll()).toEqual([]);
  });

  it("length getter tracks message count", () => {
    expect(log.length).toBe(0);
    log.add(makeMsg("user", "first"));
    expect(log.length).toBe(1);
    log.add(makeMsg("assistant", "second"));
    expect(log.length).toBe(2);
  });

  it("format() applies role prefixes", () => {
    log.add(makeMsg("user", "hello"));
    log.add(makeMsg("assistant", "hi there"));
    log.add(makeMsg("system", "session started"));

    const formatted = log.format();
    expect(formatted).toContain("[You] hello");
    expect(formatted).toContain("[Jinx] hi there");
    expect(formatted).toContain("[System] session started");
  });

  it("format() separates messages with double newlines", () => {
    log.add(makeMsg("user", "a"));
    log.add(makeMsg("assistant", "b"));

    const formatted = log.format();
    expect(formatted).toBe("[You] a\n\n[Jinx] b");
  });

  it("format() returns empty string for empty log", () => {
    expect(log.format()).toBe("");
  });
});
