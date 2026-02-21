import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
/**
 * System test: Workspace Lifecycle.
 * Crosses: Workspace + Agent + Sessions.
 *
 * Verifies bootstrap, file loading, filtering, trimming, and prompt assembly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildSystemPrompt } from "../agents/system-prompt.js";
import { ensureWorkspace } from "../workspace/bootstrap.js";
import { filterFilesForSession } from "../workspace/filter.js";
import { loadWorkspaceFiles, WORKSPACE_FILES } from "../workspace/loader.js";
import { trimWorkspaceFiles, trimFileContent } from "../workspace/trim.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-ws-lifecycle-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Workspace lifecycle system tests", () => {
  it("bootstrap creates all template files (idempotent)", async () => {
    // First run: creates files
    await ensureWorkspace(tmpDir);

    const entries = await fs.readdir(tmpDir);
    for (const name of WORKSPACE_FILES) {
      expect(entries).toContain(name);
    }

    // Verify files have content
    for (const name of WORKSPACE_FILES) {
      const content = await fs.readFile(path.join(tmpDir, name), "utf-8");
      expect(content.length).toBeGreaterThan(0);
    }

    // Modify a file
    const customContent = "# Custom Soul\n\nCustom personality.\n";
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), customContent, "utf-8");

    // Second run: does not overwrite existing files
    await ensureWorkspace(tmpDir);

    const soulContent = await fs.readFile(path.join(tmpDir, "SOUL.md"), "utf-8");
    expect(soulContent).toBe(customContent);
  });

  it("files flow through load → filter → trim → prompt assembly", async () => {
    // Write workspace files with known content
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), "# Soul\n\nBe helpful and kind.\n", "utf-8");
    await fs.writeFile(
      path.join(tmpDir, "AGENTS.md"),
      "# Agents\n\n- default: Main agent\n",
      "utf-8",
    );
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "# Identity\n\nName: Jinx\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "USER.md"), "# User\n\nPrefers TypeScript.\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "TOOLS.md"), "# Tools\n\nAvailable tools.\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# Heartbeat\n\nCheck items.\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "BOOTSTRAP.md"), "# Bootstrap\n\nStartup.\n", "utf-8");
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "# Memory\n\nUser likes dark mode.\n",
      "utf-8",
    );

    // 1. Load all files
    const allFiles = await loadWorkspaceFiles(tmpDir);
    expect(allFiles).toHaveLength(WORKSPACE_FILES.length);
    expect(allFiles.every((f) => !f.missing)).toBe(true);

    // 2. Filter for each session type
    const mainFiles = filterFilesForSession(allFiles, "main");
    expect(mainFiles).toHaveLength(8); // all files

    const subagentFiles = filterFilesForSession(allFiles, "subagent");
    expect(subagentFiles).toHaveLength(4); // SOUL.md, AGENTS.md, TOOLS.md, MEMORY.md

    const groupFiles = filterFilesForSession(allFiles, "group");
    expect(groupFiles).toHaveLength(6); // no HEARTBEAT.md, BOOTSTRAP.md

    // 3. Trim (all our content is short, so no actual trimming)
    const trimmed = trimWorkspaceFiles(mainFiles);
    expect(trimmed).toHaveLength(mainFiles.length);

    // 4. Build prompt
    const prompt = buildSystemPrompt({
      workspaceFiles: trimmed,
      tools: [],
      sessionType: "main",
      agentName: "Jinx",
      model: "claude-sonnet-4-6",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });

    expect(prompt).toContain("Be helpful and kind");
    expect(prompt).toContain("Prefers TypeScript");
    expect(prompt).toContain("dark mode");
    expect(prompt).toContain("Agent: Jinx");
    expect(prompt).toContain("HEARTBEAT_OK");
  });

  it("MEMORY.md audience control: present in main, present in group", async () => {
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), "# Soul\n\nBe helpful.\n", "utf-8");
    await fs.writeFile(
      path.join(tmpDir, "MEMORY.md"),
      "# Memory\n\nSensitive user data.\n",
      "utf-8",
    );
    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), "# Agents\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "IDENTITY.md"), "# Identity\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "USER.md"), "# User\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "TOOLS.md"), "# Tools\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "HEARTBEAT.md"), "# Heartbeat\n", "utf-8");
    await fs.writeFile(path.join(tmpDir, "BOOTSTRAP.md"), "# Bootstrap\n", "utf-8");

    const allFiles = await loadWorkspaceFiles(tmpDir);

    // Main session: MEMORY.md present
    const mainFiles = filterFilesForSession(allFiles, "main");
    const mainPrompt = buildSystemPrompt({
      workspaceFiles: mainFiles,
      tools: [],
      sessionType: "main",
      agentName: "Jinx",
      model: "test",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });
    expect(mainPrompt).toContain("MEMORY.md");
    expect(mainPrompt).toContain("Sensitive user data");

    // Group session: MEMORY.md present per PRD spec
    const groupFiles = filterFilesForSession(allFiles, "group");
    const groupPrompt = buildSystemPrompt({
      workspaceFiles: groupFiles,
      tools: [],
      sessionType: "group",
      agentName: "Jinx",
      model: "test",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });
    expect(groupPrompt).toContain("MEMORY.md");

    // Subagent session: MEMORY.md present (minimal set)
    const subFiles = filterFilesForSession(allFiles, "subagent");
    const subPrompt = buildSystemPrompt({
      workspaceFiles: subFiles,
      tools: [],
      sessionType: "subagent",
      agentName: "Jinx",
      model: "test",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });
    expect(subPrompt).toContain("MEMORY.md");
  });

  it("trim handles very long files with head/tail strategy", () => {
    // Create content that exceeds the 20K char limit
    const longContent = "A".repeat(30_000);
    const trimmed = trimFileContent(longContent);

    expect(trimmed.length).toBeLessThanOrEqual(20_000);
    expect(trimmed).toContain("truncated");
    // Head portion
    expect(trimmed.startsWith("A")).toBe(true);
    // Tail portion
    expect(trimmed.endsWith("A")).toBe(true);
  });

  it("missing workspace files are loaded with missing=true", async () => {
    // Only write SOUL.md, leave everything else missing
    await fs.writeFile(path.join(tmpDir, "SOUL.md"), "# Soul\n\nPresent.\n", "utf-8");

    const files = await loadWorkspaceFiles(tmpDir);

    const soulFile = files.find((f) => f.name === "SOUL.md")!;
    expect(soulFile.missing).toBe(false);
    expect(soulFile.content).toContain("Present.");

    const memoryFile = files.find((f) => f.name === "MEMORY.md")!;
    expect(memoryFile.missing).toBe(true);
    expect(memoryFile.content).toBe("");

    // Missing files are excluded from system prompt
    const prompt = buildSystemPrompt({
      workspaceFiles: files,
      tools: [],
      sessionType: "main",
      agentName: "Jinx",
      model: "test",
      workspaceDir: "/test/workspace",
      memoryDir: "/test/memory",
    });
    expect(prompt).toContain("SOUL.md");
    expect(prompt).not.toContain("MEMORY.md"); // missing file excluded
  });
});
