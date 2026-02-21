import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MediaAttachment } from "../types/messages.js";
import type { AgentTurnOptions, AgentToolDefinition } from "./types.js";

// Mock the Anthropic SDK with streaming support
const mockStream = vi.fn();
vi.mock("@anthropic-ai/sdk", () => {
  return {
    default: class MockAnthropic {
      messages = { stream: mockStream };
    },
  };
});

// Mock auth to avoid Keychain access
vi.mock("./auth.js", () => ({
  resolveAuth: () => ({ mode: "api-key" as const, key: "test-key" }),
}));

const { runAgentTurn, _internal } = await import("./claude-provider.js");

function makeResponse(
  text: string,
  stopReason = "end_turn",
  toolUse: unknown[] = [],
  cacheUsage?: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number },
) {
  return {
    content: [{ type: "text", text }, ...toolUse],
    stop_reason: stopReason,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: cacheUsage?.cache_creation_input_tokens ?? null,
      cache_read_input_tokens: cacheUsage?.cache_read_input_tokens ?? null,
    },
  };
}

/**
 * Create a mock stream object that mimics the Anthropic SDK's MessageStream.
 * Supports `on("text", handler)` and `finalMessage()`.
 */
function makeMockStream(response: ReturnType<typeof makeResponse>) {
  const textHandlers: Array<(text: string) => void> = [];

  return {
    on(event: string, handler: (text: string) => void) {
      if (event === "text") {
        textHandlers.push(handler);
      }
      return this; // chainable
    },
    async finalMessage() {
      // Simulate streaming: fire text handlers with the response text
      const textBlocks = response.content.filter(
        (b: { type: string }) => b.type === "text",
      ) as Array<{ type: "text"; text: string }>;
      for (const block of textBlocks) {
        for (const handler of textHandlers) {
          handler(block.text);
        }
      }
      return response;
    },
  };
}

describe("createClient", () => {
  it("creates client with api key", () => {
    const client = _internal.createClient({ mode: "api-key", key: "sk-test" });
    expect(client).toBeDefined();
    expect(client.messages).toBeDefined();
  });

  it("creates client with oauth token", () => {
    const client = _internal.createClient({ mode: "oauth", token: "sk-ant-oat01-test" });
    expect(client).toBeDefined();
  });
});

describe("buildToolDefinitions", () => {
  it("returns empty array for no tools", () => {
    expect(_internal.buildToolDefinitions()).toEqual([]);
    expect(_internal.buildToolDefinitions([])).toEqual([]);
  });

  it("maps tool definitions to SDK format", () => {
    const tools: AgentToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        execute: async () => "content",
      },
    ];
    const result = _internal.buildToolDefinitions(tools);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("read_file");
    expect(result[0].description).toBe("Read a file");
    expect(result[0].input_schema).toEqual(tools[0].inputSchema);
  });
});

describe("runAgentTurn", () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  const baseOptions: AgentTurnOptions = {
    prompt: "Hello",
    systemPrompt: "Be helpful.",
    model: "sonnet",
  };

  it("returns text response for simple turn", async () => {
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("Hello! How can I help?")));

    const result = await runAgentTurn(baseOptions);

    expect(result.text).toBe("Hello! How can I help?");
    expect(result.hitTurnLimit).toBe(false);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.usage.inputTokens).toBe(100);
    expect(result.usage.outputTokens).toBe(50);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.messages).toHaveLength(2); // user + assistant
  });

  it("calls onDelta with streamed text", async () => {
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("delta text")));
    const onDelta = vi.fn();

    await runAgentTurn({ ...baseOptions, onDelta });

    expect(onDelta).toHaveBeenCalledWith("delta text");
  });

  it("handles tool use loop", async () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "read_file",
      input: { path: "/test.txt" },
    };

    // First response: tool use
    mockStream.mockReturnValueOnce(
      makeMockStream(makeResponse("Let me read that.", "tool_use", [toolUseBlock])),
    );
    // Second response: final answer
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("The file contains: hello")));

    const tools: AgentToolDefinition[] = [
      {
        name: "read_file",
        description: "Read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
        execute: async (_input: unknown) => "hello world",
      },
    ];

    const result = await runAgentTurn({ ...baseOptions, tools });

    expect(result.text).toBe("The file contains: hello");
    expect(mockStream).toHaveBeenCalledTimes(2);
    expect(result.messages).toHaveLength(3); // user + assistant(tool) + assistant(final)
  });

  it("handles unknown tool gracefully", async () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "unknown_tool",
      input: {},
    };

    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("", "tool_use", [toolUseBlock])));
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("Sorry, I couldn't do that.")));

    const result = await runAgentTurn(baseOptions);
    expect(result.text).toBe("Sorry, I couldn't do that.");
  });

  it("handles tool execution errors", async () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "fail_tool",
      input: {},
    };

    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("", "tool_use", [toolUseBlock])));
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("The tool failed.")));

    const tools: AgentToolDefinition[] = [
      {
        name: "fail_tool",
        description: "Always fails",
        inputSchema: {},
        execute: async () => {
          throw new Error("disk full");
        },
      },
    ];

    const result = await runAgentTurn({ ...baseOptions, tools });
    expect(result.text).toBe("The tool failed.");
  });

  it("respects maxTurns limit", async () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "loop_tool",
      input: {},
    };

    // Always returns tool use, never end_turn
    mockStream.mockReturnValue(
      makeMockStream(makeResponse("thinking...", "tool_use", [toolUseBlock])),
    );

    const tools: AgentToolDefinition[] = [
      {
        name: "loop_tool",
        description: "Loops",
        inputSchema: {},
        execute: async () => "ok",
      },
    ];

    const result = await runAgentTurn({ ...baseOptions, tools, maxTurns: 3 });

    expect(result.hitTurnLimit).toBe(true);
    expect(mockStream).toHaveBeenCalledTimes(3);
  });

  it("accumulates tokens across turns", async () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "simple",
      input: {},
    };

    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("", "tool_use", [toolUseBlock])));
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("done")));

    const tools: AgentToolDefinition[] = [
      {
        name: "simple",
        description: "Simple",
        inputSchema: {},
        execute: async () => "ok",
      },
    ];

    const result = await runAgentTurn({ ...baseOptions, tools });

    expect(result.usage.inputTokens).toBe(200); // 100 * 2 turns
    expect(result.usage.outputTokens).toBe(100); // 50 * 2 turns
  });

  it("sends error to caller when API throws", async () => {
    mockStream.mockImplementationOnce(() => {
      return {
        on() {
          return this;
        },
        finalMessage() {
          return Promise.reject(new Error("rate limited"));
        },
      };
    });

    await expect(runAgentTurn(baseOptions)).rejects.toThrow("rate limited");
  });

  it("resolves correct model strings", async () => {
    mockStream.mockReturnValue(makeMockStream(makeResponse("ok")));

    const opusResult = await runAgentTurn({ ...baseOptions, model: "opus" });
    expect(opusResult.model).toBe("claude-opus-4-6");

    const haikuResult = await runAgentTurn({ ...baseOptions, model: "haiku" });
    expect(haikuResult.model).toBe("claude-haiku-4-5-20251001");
  });

  it("returns zero cache metrics when API returns null", async () => {
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("ok")));
    const result = await runAgentTurn(baseOptions);

    expect(result.usage.cacheCreationTokens).toBe(0);
    expect(result.usage.cacheReadTokens).toBe(0);
  });

  it("captures cache creation and read metrics from API response", async () => {
    mockStream.mockReturnValueOnce(
      makeMockStream(
        makeResponse("ok", "end_turn", [], {
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
        }),
      ),
    );
    const result = await runAgentTurn(baseOptions);

    expect(result.usage.cacheCreationTokens).toBe(5000);
    expect(result.usage.cacheReadTokens).toBe(0);
  });

  it("accumulates cache metrics across tool-use loop iterations", async () => {
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "simple",
      input: {},
    };

    // First call: cache write (cold)
    mockStream.mockReturnValueOnce(
      makeMockStream(
        makeResponse("", "tool_use", [toolUseBlock], {
          cache_creation_input_tokens: 5000,
          cache_read_input_tokens: 0,
        }),
      ),
    );
    // Second call: cache hit (warm)
    mockStream.mockReturnValueOnce(
      makeMockStream(
        makeResponse("done", "end_turn", [], {
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 5000,
        }),
      ),
    );

    const tools: AgentToolDefinition[] = [
      {
        name: "simple",
        description: "Simple",
        inputSchema: {},
        execute: async () => "ok",
      },
    ];

    const result = await runAgentTurn({ ...baseOptions, tools });

    expect(result.usage.cacheCreationTokens).toBe(5000);
    expect(result.usage.cacheReadTokens).toBe(5000);
  });

  it("passes system prompt blocks as TextBlockParam array to API", async () => {
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("ok")));

    await runAgentTurn({
      ...baseOptions,
      systemPromptBlocks: [
        { text: "Static instruction", cacheable: true },
        { text: "Dynamic timestamp", cacheable: false },
      ],
    });

    const callArgs = mockStream.mock.calls[0][0];
    // Should be an array of TextBlockParam, not a string
    expect(Array.isArray(callArgs.system)).toBe(true);
    expect(callArgs.system).toHaveLength(2);
    expect(callArgs.system[0].type).toBe("text");
    expect(callArgs.system[0].text).toBe("Static instruction");
    // First block (last cacheable) should have cache_control
    expect(callArgs.system[0].cache_control).toEqual({ type: "ephemeral" });
    // Second block (dynamic) should NOT have cache_control
    expect(callArgs.system[1].cache_control).toBeUndefined();
  });

  it("falls back to plain string system prompt when no blocks provided", async () => {
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("ok")));

    await runAgentTurn(baseOptions);

    const callArgs = mockStream.mock.calls[0][0];
    expect(callArgs.system).toBe("Be helpful.");
  });
});

describe("buildToolDefinitions — cache_control", () => {
  it("adds cache_control on last tool only", () => {
    const tools: AgentToolDefinition[] = [
      { name: "tool_a", description: "A", inputSchema: {}, execute: async () => ({}) },
      { name: "tool_b", description: "B", inputSchema: {}, execute: async () => ({}) },
      { name: "tool_c", description: "C", inputSchema: {}, execute: async () => ({}) },
    ];
    const result = _internal.buildToolDefinitions(tools);

    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeUndefined();
    expect(result[2].cache_control).toEqual({ type: "ephemeral" });
  });

  it("adds cache_control when there is only one tool", () => {
    const tools: AgentToolDefinition[] = [
      { name: "only", description: "Only tool", inputSchema: {}, execute: async () => ({}) },
    ];
    const result = _internal.buildToolDefinitions(tools);

    expect(result[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("returns empty array with no cache_control for no tools", () => {
    const result = _internal.buildToolDefinitions([]);
    expect(result).toEqual([]);
  });
});

describe("truncateToolResult", () => {
  it("returns short output unchanged", () => {
    expect(_internal.truncateToolResult("hello")).toBe("hello");
  });

  it("truncates output exceeding MAX_TOOL_RESULT_CHARS", () => {
    const limit = _internal.MAX_TOOL_RESULT_CHARS;
    const huge = "x".repeat(limit + 500);
    const result = _internal.truncateToolResult(huge);

    expect(result.length).toBe(limit + "\n[... output truncated]".length);
    expect(result).toContain("[... output truncated]");
    expect(result.startsWith("x".repeat(100))).toBe(true);
  });

  it("does not truncate output at exactly the limit", () => {
    const limit = _internal.MAX_TOOL_RESULT_CHARS;
    const exact = "x".repeat(limit);
    expect(_internal.truncateToolResult(exact)).toBe(exact);
  });
});

describe("runAgentTurn — tool result truncation", () => {
  beforeEach(() => {
    mockStream.mockReset();
  });

  const baseOptions: AgentTurnOptions = {
    prompt: "Hello",
    systemPrompt: "Be helpful.",
    model: "sonnet",
  };

  it("truncates tool output exceeding MAX_TOOL_RESULT_CHARS", async () => {
    const limit = _internal.MAX_TOOL_RESULT_CHARS;
    const toolUseBlock = {
      type: "tool_use",
      id: "toolu_01",
      name: "big_tool",
      input: {},
    };

    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("", "tool_use", [toolUseBlock])));
    mockStream.mockReturnValueOnce(makeMockStream(makeResponse("done")));

    const tools: AgentToolDefinition[] = [
      {
        name: "big_tool",
        description: "Returns huge output",
        inputSchema: {},
        execute: async () => "x".repeat(limit + 1000),
      },
    ];

    const result = await runAgentTurn({ ...baseOptions, tools });
    expect(result.text).toBe("done");

    // Verify the tool result sent to the API was truncated
    const secondCallArgs = mockStream.mock.calls[1][0];
    const toolResultMsg = secondCallArgs.messages.find(
      (m: { role: string }) => m.role === "user" && Array.isArray(m.content),
    );
    const toolResult = toolResultMsg?.content?.[0];
    expect(toolResult?.content?.length).toBeLessThan(limit + 1000);
    expect(toolResult?.content).toContain("[... output truncated]");
  });
});

describe("buildUserContentWithMedia", () => {
  it("returns plain string when no media is present", () => {
    const result = _internal.buildUserContentWithMedia("Hello world");
    expect(result).toBe("Hello world");
  });

  it("returns plain string for empty media array", () => {
    const result = _internal.buildUserContentWithMedia("Hello world", []);
    expect(result).toBe("Hello world");
  });

  it("builds ImageBlockParam content for image media with buffer", () => {
    const media: MediaAttachment[] = [
      {
        type: "image",
        mimeType: "image/jpeg",
        buffer: new Uint8Array([0xff, 0xd8, 0xff]),
      },
    ];
    const result = _internal.buildUserContentWithMedia("Describe this image", media);

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{ type: string; source?: unknown; text?: string }>;
    expect(blocks).toHaveLength(2); // 1 image + 1 text
    expect(blocks[0].type).toBe("image");
    expect(blocks[0].source).toEqual({
      type: "base64",
      media_type: "image/jpeg",
      data: Buffer.from([0xff, 0xd8, 0xff]).toString("base64"),
    });
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toBe("Describe this image");
  });

  it("appends text description for non-image media (audio)", () => {
    const media: MediaAttachment[] = [
      {
        type: "audio",
        mimeType: "audio/ogg",
        caption: "voice note",
      },
    ];
    const result = _internal.buildUserContentWithMedia("What did they say?", media);

    // No image blocks → returns a string with description prepended
    expect(typeof result).toBe("string");
    expect(result).toContain("[Audio: voice note]");
    expect(result).toContain("What did they say?");
  });

  it("handles mixed image and non-image media", () => {
    const media: MediaAttachment[] = [
      {
        type: "image",
        mimeType: "image/png",
        buffer: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      },
      {
        type: "audio",
        mimeType: "audio/mpeg",
      },
    ];
    const result = _internal.buildUserContentWithMedia("Check this", media);

    expect(Array.isArray(result)).toBe(true);
    const blocks = result as Array<{ type: string; text?: string }>;
    // 1 image + 1 text (with audio description)
    expect(blocks).toHaveLength(2);
    expect(blocks[0].type).toBe("image");
    expect(blocks[1].type).toBe("text");
    expect(blocks[1].text).toContain("[Audio: voice message]");
  });

  it("skips image without buffer and adds description instead", () => {
    const media: MediaAttachment[] = [
      {
        type: "image",
        mimeType: "image/jpeg",
        // no buffer — download failed
      },
    ];
    const result = _internal.buildUserContentWithMedia("What's in this?", media);

    expect(typeof result).toBe("string");
    expect(result).toContain("[Image: not downloaded]");
  });
});

describe("buildSystemContentBlocks", () => {
  it("places cache_control on the last cacheable block", () => {
    const result = _internal.buildSystemContentBlocks([
      { text: "Workspace files", cacheable: true },
      { text: "Tools list", cacheable: true },
      { text: "Safety", cacheable: true },
      { text: "Runtime metadata", cacheable: false },
    ]);

    expect(result).toHaveLength(4);
    // Blocks 0 and 1 — cacheable but not the last cacheable
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeUndefined();
    // Block 2 — last cacheable
    expect(result[2].cache_control).toEqual({ type: "ephemeral" });
    // Block 3 — dynamic, no cache_control
    expect(result[3].cache_control).toBeUndefined();
  });

  it("handles all-dynamic blocks (no cache_control)", () => {
    const result = _internal.buildSystemContentBlocks([
      { text: "Dynamic A", cacheable: false },
      { text: "Dynamic B", cacheable: false },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].cache_control).toBeUndefined();
    expect(result[1].cache_control).toBeUndefined();
  });

  it("filters out empty text blocks", () => {
    const result = _internal.buildSystemContentBlocks([
      { text: "Keep this", cacheable: true },
      { text: "", cacheable: true },
      { text: "And this", cacheable: false },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0].text).toBe("Keep this");
    expect(result[0].cache_control).toEqual({ type: "ephemeral" });
    expect(result[1].text).toBe("And this");
  });

  it("sets type to text on all blocks", () => {
    const result = _internal.buildSystemContentBlocks([{ text: "Hello", cacheable: true }]);

    expect(result[0].type).toBe("text");
  });
});
