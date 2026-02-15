import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./home-dir.js", () => ({
  resolveHomeDir: vi.fn(() => "/tmp/fake-jinx"),
}));

vi.mock("node:fs", () => ({
  default: { existsSync: vi.fn() },
}));

vi.mock("dotenv", () => ({
  default: { config: vi.fn() },
}));

import dotenv from "dotenv";
import fs from "node:fs";
import { loadDotEnv } from "./dotenv.js";

describe("loadDotEnv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads .env file when it exists", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    loadDotEnv();

    expect(dotenv.config).toHaveBeenCalledWith({
      path: expect.stringContaining(".env"),
      override: false,
    });
  });

  it("no-ops when .env file does not exist", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);

    loadDotEnv();

    expect(dotenv.config).not.toHaveBeenCalled();
  });

  it("passes override: false to prevent overwriting existing env vars", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);

    loadDotEnv();

    expect(dotenv.config).toHaveBeenCalledWith(expect.objectContaining({ override: false }));
  });
});
