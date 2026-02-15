/**
 * Live system test: Composio tool integrations with real Composio API.
 *
 * Covers read-only scenarios to avoid side effects:
 *   - composio_search: find tools by query
 *   - composio_connections: list authenticated connections
 *   - composio_check_connection: check a specific toolkit's connection status
 *   - Error handling: empty query returns error gracefully
 *
 * Run: COMPOSIO_API_KEY=... npx vitest run src/__system__/composio.live.test.ts
 *
 * Prerequisites:
 *   - COMPOSIO_API_KEY env var set with a valid Composio API key
 *
 * This test makes real API calls against the Composio service.
 */
import { describe, it, expect, afterAll } from "vitest";
import type { AgentToolDefinition } from "../providers/types.js";
import { getComposioToolDefinitions, resetComposioClient } from "../agents/tools/composio-tools.js";

const describeIf = process.env.COMPOSIO_API_KEY ? describe : describe.skip;

function getTools(): AgentToolDefinition[] {
  return getComposioToolDefinitions({
    apiKey: process.env.COMPOSIO_API_KEY!,
    userId: "test",
    timeoutSeconds: 30,
  });
}

function findTool(name: string): AgentToolDefinition {
  const tool = getTools().find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Tool ${name} not found`);
  }
  return tool;
}

describeIf("Composio tools (live API)", () => {
  afterAll(() => {
    resetComposioClient();
  });

  it("composio_search: finds tools matching a query", async () => {
    const tool = findTool("composio_search");
    const result = (await tool.execute({ query: "list repositories" })) as {
      query: string;
      resultCount: number;
      tools: Array<{
        slug: string;
        name: string;
        description: string;
        toolkit: string;
      }>;
    };

    expect(result.resultCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.tools)).toBe(true);

    if (result.tools.length > 0) {
      const first = result.tools[0];
      expect(typeof first.slug).toBe("string");
      expect(first.slug.length).toBeGreaterThan(0);
      expect(typeof first.name).toBe("string");
      expect(typeof first.description).toBe("string");
      expect(typeof first.toolkit).toBe("string");
    }

    console.log(`  composio_search: ${result.resultCount} result(s) for "list repositories"`);
    if (result.tools.length > 0) {
      console.log(`  Top result: ${result.tools[0].slug} (${result.tools[0].toolkit})`);
    }
  }, 60_000);

  it("composio_connections: lists authenticated connections", async () => {
    const tool = findTool("composio_connections");
    const result = (await tool.execute({})) as {
      connectionCount: number;
      connections: Array<{
        id: string;
        toolkit: string;
        status: string;
        createdAt: string;
      }>;
    };

    expect(typeof result.connectionCount).toBe("number");
    expect(result.connectionCount).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(result.connections)).toBe(true);
    expect(result.connections).toHaveLength(result.connectionCount);

    if (result.connections.length > 0) {
      const first = result.connections[0];
      expect(typeof first.id).toBe("string");
      expect(typeof first.toolkit).toBe("string");
      expect(typeof first.status).toBe("string");
    }

    console.log(`  composio_connections: ${result.connectionCount} connection(s)`);
    for (const conn of result.connections) {
      console.log(`    - ${conn.toolkit}: ${conn.status}`);
    }
  }, 60_000);

  it("composio_check_connection: returns connection status for a toolkit", async () => {
    const tool = findTool("composio_check_connection");
    const result = (await tool.execute({ toolkit: "github" })) as {
      toolkit: string;
      connected: boolean;
      status: string;
      accountId: string | null;
    };

    expect(result.toolkit).toBe("github");
    expect(typeof result.connected).toBe("boolean");
    expect(typeof result.status).toBe("string");
    expect(result.status.length).toBeGreaterThan(0);

    console.log(
      `  composio_check_connection(github): connected=${result.connected}, status=${result.status}`,
    );
  }, 60_000);

  it("error handling: empty query returns error response without throwing", async () => {
    const tool = findTool("composio_search");
    const result = (await tool.execute({ query: "" })) as {
      error?: string;
      resultCount?: number;
      tools?: unknown[];
    };

    // The implementation returns { error: "Search query cannot be empty." }
    // for empty queries — verify it does not throw and returns a structured response.
    expect(result).toBeDefined();

    if (result.error) {
      expect(typeof result.error).toBe("string");
      expect(result.error.length).toBeGreaterThan(0);
      console.log(`  Empty query error: ${result.error}`);
    } else {
      // If the API accepts empty queries, it should still return a valid shape
      expect(typeof result.resultCount).toBe("number");
      expect(Array.isArray(result.tools)).toBe(true);
      console.log(`  Empty query returned ${result.resultCount} result(s) (no error)`);
    }
  }, 60_000);
});
