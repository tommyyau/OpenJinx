/**
 * Integration: Skills loading → Snapshot → System Prompt boundary.
 * Tests real SKILL.md file loading, snapshot building, and system prompt inclusion.
 * No mocking of skills modules — uses actual filesystem and real parsing.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeTestSkillMd } from "../__test__/skills.js";
import { buildSystemPromptBlocks } from "../agents/system-prompt.js";
import { loadSkillEntries } from "../skills/loader.js";
import { buildSkillSnapshot } from "../skills/snapshot.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jinx-skills-int-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("Skills → Snapshot → System Prompt integration", () => {
  it("loads real SKILL.md files from disk", async () => {
    await writeTestSkillMd(
      tmpDir,
      "weather",
      { name: "weather", display_name: "Weather Lookup", description: "Check current weather" },
      "# Weather\n\nLook up the weather for a given location.",
    );
    await writeTestSkillMd(
      tmpDir,
      "translate",
      {
        name: "translate",
        display_name: "Translator",
        description: "Translate text between languages",
      },
      "# Translate\n\nTranslate text from one language to another.",
    );

    const entries = await loadSkillEntries([tmpDir]);

    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.name).toSorted();
    expect(names).toEqual(["translate", "weather"]);

    const weather = entries.find((e) => e.name === "weather")!;
    expect(weather.displayName).toBe("Weather Lookup");
    expect(weather.description).toBe("Check current weather");
    expect(weather.eligible).toBe(true);
    expect(weather.path).toBe(path.join(tmpDir, "weather", "SKILL.md"));

    const translate = entries.find((e) => e.name === "translate")!;
    expect(translate.displayName).toBe("Translator");
    expect(translate.description).toBe("Translate text between languages");
    expect(translate.eligible).toBe(true);
  });

  it("builds snapshot from loaded skills with XML prompt", async () => {
    await writeTestSkillMd(
      tmpDir,
      "search",
      { name: "search", display_name: "Web Search", description: "Search the web for information" },
      "# Search\n\nPerform web searches.",
    );
    await writeTestSkillMd(
      tmpDir,
      "calculator",
      { name: "calculator", display_name: "Calculator", description: "Perform math calculations" },
      "# Calculator\n\nEvaluate mathematical expressions.",
    );

    const entries = await loadSkillEntries([tmpDir]);
    const snapshot = buildSkillSnapshot(entries);

    expect(snapshot.count).toBe(2);
    expect(snapshot.names.toSorted()).toEqual(["calculator", "search"]);
    expect(snapshot.prompt).toContain("<available-skills>");
    expect(snapshot.prompt).toContain("</available-skills>");
    expect(snapshot.prompt).toContain('name="search"');
    expect(snapshot.prompt).toContain('name="calculator"');
    expect(snapshot.prompt).toContain("Search the web for information");
    expect(snapshot.prompt).toContain("Perform math calculations");
    expect(snapshot.version).toBeTruthy();
    expect(snapshot.version.length).toBe(8);
  });

  it("system prompt includes skills from snapshot", async () => {
    await writeTestSkillMd(
      tmpDir,
      "notes",
      { name: "notes", display_name: "Note Taker", description: "Manage personal notes" },
      "# Notes\n\nCreate and organize notes.",
    );

    const entries = await loadSkillEntries([tmpDir]);
    const snapshot = buildSkillSnapshot(entries);

    const blocks = buildSystemPromptBlocks({
      workspaceFiles: [],
      tools: [],
      skills: snapshot,
      sessionType: "main",
      agentName: "Jinx",
      model: "claude-sonnet-4-6",
      workspaceDir: tmpDir,
      memoryDir: path.join(tmpDir, "memory"),
    });

    const fullText = blocks.map((b) => b.text).join("\n");
    expect(fullText).toContain("notes");
    expect(fullText).toContain("Manage personal notes");
    expect(fullText).toContain("<available-skills>");

    // The skills block should be cacheable
    const skillsBlock = blocks.find((b) => b.text.includes("<available-skills>"));
    expect(skillsBlock).toBeDefined();
    expect(skillsBlock!.cacheable).toBe(true);
  });

  it("exclusion filtering removes skills by name", async () => {
    await writeTestSkillMd(
      tmpDir,
      "alpha",
      { name: "alpha", display_name: "Alpha", description: "Alpha skill" },
      "# Alpha",
    );
    await writeTestSkillMd(
      tmpDir,
      "beta",
      { name: "beta", display_name: "Beta", description: "Beta skill" },
      "# Beta",
    );
    await writeTestSkillMd(
      tmpDir,
      "gamma",
      { name: "gamma", display_name: "Gamma", description: "Gamma skill" },
      "# Gamma",
    );

    const entries = await loadSkillEntries([tmpDir]);
    expect(entries).toHaveLength(3);

    // Simulate runner-style exclusion filtering
    const excluded = new Set(["beta"]);
    const filtered = entries.filter((s) => !excluded.has(s.name));
    expect(filtered).toHaveLength(2);

    const snapshot = buildSkillSnapshot(filtered);
    expect(snapshot.count).toBe(2);
    expect(snapshot.names.toSorted()).toEqual(["alpha", "gamma"]);
    expect(snapshot.names).not.toContain("beta");
    expect(snapshot.prompt).not.toContain('name="beta"');
    expect(snapshot.prompt).toContain('name="alpha"');
    expect(snapshot.prompt).toContain('name="gamma"');
  });

  it("ineligible skills with missing binaries are filtered from snapshot", async () => {
    await writeTestSkillMd(
      tmpDir,
      "broken-skill",
      {
        name: "broken-skill",
        display_name: "Broken Skill",
        description: "Requires a binary that does not exist",
        required_bins: "nonexistent_binary_xyz",
      },
      "# Broken\n\nThis skill requires a missing binary.",
    );

    const entries = await loadSkillEntries([tmpDir]);
    expect(entries).toHaveLength(1);

    const entry = entries[0];
    expect(entry.name).toBe("broken-skill");
    expect(entry.eligible).toBe(false);

    // buildSkillSnapshot filters out ineligible entries
    const snapshot = buildSkillSnapshot(entries);
    expect(snapshot.count).toBe(0);
    expect(snapshot.names).toEqual([]);
    expect(snapshot.prompt).toBe("");
    expect(snapshot.version).toBe("");
  });
});
