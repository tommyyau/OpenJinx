import fs from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../config/loader.js", () => ({
  resolveConfigPath: vi.fn(() => "/tmp/.jinx/config.yaml"),
}));

vi.mock("../../config/validation.js", () => ({
  loadAndValidateConfig: vi.fn().mockResolvedValue({
    channels: {
      terminal: { enabled: true },
      telegram: { enabled: false, streaming: true, mode: "polling" },
      whatsapp: { enabled: false },
    },
    composio: { enabled: false, userId: "default", timeoutSeconds: 60 },
  }),
}));

vi.mock("../../infra/home-dir.js", () => ({
  resolveHomeDir: vi.fn(() => "/tmp/.jinx"),
}));

vi.mock("../../providers/auth.js", () => ({
  hasAuth: vi.fn(() => true),
  resolveAuth: vi.fn(() => ({ mode: "api-key", key: "sk-ant-test" })),
}));

vi.mock("../../infra/fetch-retry.js", () => ({
  fetchWithRetry: vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
}));

describe("doctorCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("runs all tiers and reports results", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    // Tier 1: Structure
    expect(output).toContain("Structure:");
    expect(output).toContain("Home directory");
    expect(output).toContain("Config file");
    expect(output).toContain("Workspace");
    expect(output).toContain("Node.js");

    // Tier 2: API Keys
    expect(output).toContain("API Keys (live validation):");
    expect(output).toContain("Claude auth");

    // Tier 3: Channels & Security
    expect(output).toContain("Channels & Security:");

    expect(output).toContain("All checks passed");
    expect(process.exitCode).toBe(0);
  });

  it("reports failures when structure checks fail", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    expect(output).toContain("[FAIL]");
    expect(output).toContain("Some checks failed");
    expect(process.exitCode).toBe(1);
  });

  it("reports SKIP for disabled channels", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    expect(output).toContain("[SKIP] Telegram: not enabled");
    expect(output).toContain("[SKIP] WhatsApp: not enabled");
  });

  it("reports SKIP for missing optional API keys", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    // Clear env vars for optional keys
    const origOpenAi = process.env.OPENAI_API_KEY;
    const origOpenRouter = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    expect(output).toContain("[SKIP] OpenAI embeddings: key not set (BM25 only)");
    expect(output).toContain("[SKIP] OpenRouter web search: key not set");
    expect(output).toContain("[SKIP] Composio: not enabled");

    // Restore env
    if (origOpenAi) {
      process.env.OPENAI_API_KEY = origOpenAi;
    }
    if (origOpenRouter) {
      process.env.OPENROUTER_API_KEY = origOpenRouter;
    }
  });

  it("reports Claude auth 401 when API returns unauthorized", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const { fetchWithRetry } = await import("../../infra/fetch-retry.js");
    vi.mocked(fetchWithRetry).mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    } as Response);

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    expect(output).toContain("[FAIL] Claude auth");
    expect(output).toContain("401 Unauthorized");
    expect(process.exitCode).toBe(1);
  });

  it("reports WhatsApp credentials with allowFrom when configured", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const { loadAndValidateConfig } = await import("../../config/validation.js");
    vi.mocked(loadAndValidateConfig).mockResolvedValue({
      channels: {
        terminal: { enabled: true },
        telegram: { enabled: false, streaming: true, mode: "polling" },
        whatsapp: {
          enabled: true,
          allowFrom: ["1234567890"],
        },
      },
      composio: { enabled: false, userId: "default", timeoutSeconds: 60 },
    } as never);

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    expect(output).toContain("[OK] WhatsApp");
    expect(output).toContain("credentials present, locked to");
  });

  it("reports Claude auth failure when hasAuth returns false", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(true);

    const { hasAuth } = await import("../../providers/auth.js");
    vi.mocked(hasAuth).mockReturnValue(false);

    const { doctorCommand } = await import("./doctor.js");

    process.exitCode = undefined;
    await doctorCommand.parseAsync([], { from: "user" });

    const logCalls = vi.mocked(console.log).mock.calls.flat();
    const output = logCalls.join("\n");

    expect(output).toContain("[FAIL] Claude auth: No auth found");
    expect(process.exitCode).toBe(1);
  });
});
