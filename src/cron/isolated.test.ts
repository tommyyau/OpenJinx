import { describe, it, expect, vi } from "vitest";
import { runCronIsolatedAgentTurn } from "./isolated.js";

describe("runCronIsolatedAgentTurn", () => {
  it("calls runAgentTurn with correct params and returns result", async () => {
    const runAgentTurn = vi.fn().mockResolvedValue("cron output");

    const result = await runCronIsolatedAgentTurn({
      prompt: "check something",
      agentId: "default",
      sessionKey: "cron:default:123",
      runAgentTurn,
    });

    expect(result).toBe("cron output");
    expect(runAgentTurn).toHaveBeenCalledWith({
      prompt: "check something",
      agentId: "default",
      sessionKey: "cron:default:123",
    });
  });

  it("uses provided sessionKey when given", async () => {
    const runAgentTurn = vi.fn().mockResolvedValue("ok");

    await runCronIsolatedAgentTurn({
      prompt: "test",
      agentId: "default",
      sessionKey: "custom-key",
      runAgentTurn,
    });

    expect(runAgentTurn).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey: "custom-key" }),
    );
  });

  it("generates cron:{agentId}:{timestamp} session key when not provided", async () => {
    const runAgentTurn = vi.fn().mockResolvedValue("ok");

    await runCronIsolatedAgentTurn({
      prompt: "test",
      agentId: "myagent",
      runAgentTurn,
    });

    const call = runAgentTurn.mock.calls[0][0];
    expect(call.sessionKey).toMatch(/^cron:myagent:\d+$/);
  });

  it("propagates errors from runAgentTurn", async () => {
    const runAgentTurn = vi.fn().mockRejectedValue(new Error("agent crash"));

    await expect(
      runCronIsolatedAgentTurn({
        prompt: "test",
        agentId: "default",
        runAgentTurn,
      }),
    ).rejects.toThrow("agent crash");
  });
});
