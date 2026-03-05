import { vi } from "vitest";
import type { AgentResult } from "../providers/types.js";

export interface MockSdkCall {
  prompt: string;
  systemPrompt: string;
  model: string;
  tools?: unknown[];
  timestamp: number;
  maxTurns: number;
}

export interface MockSdkResponse {
  text: string;
  toolCalls?: { name: string; input: unknown; output: unknown }[];
}

/**
 * Mock Claude SDK that intercepts `_internal.callSdk` in the provider.
 * Use `setNextResponse()` or `setResponseSequence()` to configure behavior,
 * then inspect `calls` to verify what was sent.
 */
export function createMockClaudeSdk() {
  const calls: MockSdkCall[] = [];
  let responseQueue: MockSdkResponse[] = [];
  let defaultResponse: MockSdkResponse = { text: "" };

  function setNextResponse(text: string, toolCalls?: MockSdkResponse["toolCalls"]) {
    responseQueue = [{ text, toolCalls }];
  }

  function setResponseSequence(responses: MockSdkResponse[]) {
    responseQueue = [...responses];
  }

  function getCallsForModel(model: string): MockSdkCall[] {
    return calls.filter((c) => c.model === model);
  }

  function reset() {
    calls.length = 0;
    responseQueue = [];
    defaultResponse = { text: "" };
  }

  /** The mock callSdk implementation. */
  async function mockCallSdk(
    options: {
      prompt: string;
      systemPrompt: string;
      model: string;
      maxTurns: number;
      tools?: unknown[];
    },
    onDelta?: (text: string) => void,
  ): Promise<Omit<AgentResult, "durationMs" | "model">> {
    calls.push({
      prompt: options.prompt,
      systemPrompt: options.systemPrompt,
      model: options.model,
      tools: options.tools,
      timestamp: Date.now(),
      maxTurns: options.maxTurns,
    });

    const response = responseQueue.length > 0 ? responseQueue.shift()! : defaultResponse;

    // Simulate streaming deltas
    if (onDelta && response.text) {
      onDelta(response.text);
    }

    const messages = [
      {
        role: "assistant" as const,
        content: response.text,
        toolCalls: response.toolCalls?.map((tc) => ({
          id: `tool-${Date.now()}`,
          ...tc,
        })),
      },
    ];

    return {
      text: response.text,
      messages,
      hitTurnLimit: false,
      usage: { inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    };
  }

  /** Install the mock via vi.mock. Call from beforeEach. */
  function install() {
    const mockModule = {
      runAgentTurn: vi.fn(
        async (options: {
          prompt: string;
          systemPrompt: string;
          model: string;
          maxTurns?: number;
          maxTokens?: number;
          tools?: unknown[];
          onDelta?: (text: string) => void;
        }) => {
          const result = await mockCallSdk(
            {
              prompt: options.prompt,
              systemPrompt: options.systemPrompt,
              model: options.model,
              maxTurns: options.maxTurns ?? 30,
              tools: options.tools,
            },
            options.onDelta,
          );
          return {
            ...result,
            durationMs: 100,
            model: options.model,
          };
        },
      ),
      _internal: {
        callSdk: vi.fn(mockCallSdk),
        buildSdkOptions: vi.fn((auth: unknown, model: string, opts: unknown) => ({
          prompt: (opts as { prompt: string }).prompt,
          systemPrompt: (opts as { systemPrompt: string }).systemPrompt,
          model,
          maxTurns: 30,
          auth,
          tools: (opts as { tools?: unknown[] }).tools,
        })),
      },
    };

    return mockModule;
  }

  return {
    calls,
    setNextResponse,
    setResponseSequence,
    getCallsForModel,
    reset,
    install,
    mockCallSdk,
  };
}

export type MockClaudeSdk = ReturnType<typeof createMockClaudeSdk>;
