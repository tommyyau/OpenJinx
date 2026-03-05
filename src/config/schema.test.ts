import { describe, expect, it } from "vitest";
import { jinxConfigSchema } from "./schema.js";

describe("jinxConfigSchema", () => {
  it("parses empty object with all defaults", () => {
    const result = jinxConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.llm.brain).toBe("opus");
    expect(result.data.llm.light).toBe("haiku");
    expect(result.data.llm.maxTurns).toBe(30);
    expect(result.data.channels.terminal.enabled).toBe(true);
    expect(result.data.channels.telegram.enabled).toBe(false);
    expect(result.data.heartbeat.visibility.showOk).toBe(false);
    expect(result.data.heartbeat.visibility.showAlerts).toBe(true);
    expect(result.data.gateway.port).toBe(9790);
    expect(result.data.logging.level).toBe("info");
  });

  it("accepts partial overrides", () => {
    const result = jinxConfigSchema.safeParse({
      llm: { brain: "opus" },
      gateway: { port: 9000 },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.llm.brain).toBe("opus");
    expect(result.data.llm.subagent).toBe("sonnet");
    expect(result.data.gateway.port).toBe(9000);
  });

  it("rejects invalid model id", () => {
    const result = jinxConfigSchema.safeParse({
      llm: { brain: "gpt-4" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid port", () => {
    const result = jinxConfigSchema.safeParse({
      gateway: { port: 99999 },
    });
    expect(result.success).toBe(false);
  });

  it("parses full agent config", () => {
    const result = jinxConfigSchema.safeParse({
      agents: {
        default: "main",
        list: [
          {
            id: "main",
            name: "Main Agent",
            workspace: "~/.jinx/workspace",
            model: "opus",
            heartbeat: { enabled: true, intervalMinutes: 30 },
          },
        ],
      },
    });
    expect(result.success).toBe(true);
    if (!result.success) {
      return;
    }
    expect(result.data.agents.list[0].model).toBe("opus");
    expect(result.data.agents.list[0].heartbeat?.intervalMinutes).toBe(30);
  });
});
