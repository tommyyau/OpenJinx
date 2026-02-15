import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./loader.js", () => ({
  loadRawConfig: vi.fn(),
}));

import { loadRawConfig } from "./loader.js";
import { validateConfig, loadAndValidateConfig, parsePartialConfig } from "./validation.js";

describe("validateConfig", () => {
  it("returns ok with defaults merged for valid minimal input", () => {
    const result = validateConfig({});
    expect(result.ok).toBe(true);
    expect(result.config).toBeDefined();
    expect(result.config!.llm.brain).toBe("opus");
    expect(result.config!.channels.terminal.enabled).toBe(true);
  });

  it("returns errors for invalid input", () => {
    const result = validateConfig({ llm: { brain: "gpt-4" } });
    expect(result.ok).toBe(false);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBeGreaterThan(0);
    expect(result.errors!.some((e) => e.includes("brain"))).toBe(true);
  });
});

describe("loadAndValidateConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns JinxConfig for valid file", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({});
    const config = await loadAndValidateConfig("/tmp/config.yaml");
    expect(config.llm.brain).toBe("opus");
    expect(loadRawConfig).toHaveBeenCalledWith("/tmp/config.yaml");
  });

  it("throws with error details for invalid file", async () => {
    vi.mocked(loadRawConfig).mockResolvedValue({ llm: { brain: "invalid-model" } });
    await expect(loadAndValidateConfig()).rejects.toThrow("Invalid config");
  });
});

describe("parsePartialConfig", () => {
  it("merges partial input with Zod defaults", () => {
    const config = parsePartialConfig({ llm: { brain: "haiku" } });
    expect(config.llm.brain).toBe("haiku");
    expect(config.llm.subagent).toBe("sonnet");
    expect(config.channels.terminal.enabled).toBe(true);
  });

  it("preserves whatsapp browserName field", () => {
    const config = parsePartialConfig({
      channels: { whatsapp: { enabled: true, browserName: "MyBot" } },
    });
    expect(config.channels.whatsapp.browserName).toBe("MyBot");
    expect(config.channels.whatsapp.enabled).toBe(true);
  });
});
