import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestConfig } from "../__test__/config.js";
import { buildMarathonChunkTools } from "./marathon-tools.js";

vi.mock("../agents/tools/core-tools.js", () => ({
  getCoreToolDefinitions: vi.fn(() => [{ name: "core-file" }]),
}));

vi.mock("../agents/tools/exec-tools.js", () => ({
  getExecToolDefinitions: vi.fn(() => [{ name: "exec-shell" }]),
}));

vi.mock("../agents/tools/marathon-tools.js", () => ({
  getMarathonToolDefinitions: vi.fn(() => [{ name: "marathon-control" }]),
}));

vi.mock("../agents/tools/web-search-tools.js", () => ({
  getWebSearchToolDefinitions: vi.fn(() => [{ name: "web-search" }]),
}));

vi.mock("../agents/tools/web-fetch-tools.js", () => ({
  getWebFetchToolDefinitions: vi.fn(() => [{ name: "web-fetch" }]),
}));

describe("buildMarathonChunkTools", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("assembles core + exec + marathon + web tools when enabled", () => {
    const config = createTestConfig();
    const containerManager = {};

    const tools = buildMarathonChunkTools({
      config,
      containerManager: containerManager as never,
      taskId: "marathon-1",
      sessionKey: "marathon:1",
      workspaceDir: "/tmp/ws",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "core-file",
      "exec-shell",
      "marathon-control",
      "web-search",
      "web-fetch",
    ]);
  });

  it("skips exec tools when sandbox is disabled", () => {
    const config = createTestConfig({ sandbox: { enabled: false } });

    const tools = buildMarathonChunkTools({
      config,
      containerManager: {} as never,
      taskId: "marathon-1",
      sessionKey: "marathon:1",
      workspaceDir: "/tmp/ws",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "core-file",
      "marathon-control",
      "web-search",
      "web-fetch",
    ]);
  });

  it("skips web search tools when webSearch is disabled", () => {
    const config = createTestConfig({ webSearch: { enabled: false } });

    const tools = buildMarathonChunkTools({
      config,
      containerManager: {} as never,
      taskId: "marathon-1",
      sessionKey: "marathon:1",
      workspaceDir: "/tmp/ws",
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "core-file",
      "exec-shell",
      "marathon-control",
      "web-fetch",
    ]);
  });
});
