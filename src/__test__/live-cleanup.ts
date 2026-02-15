import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureHomeDir } from "../infra/home-dir.js";

export interface CleanupReport {
  transcriptsDeleted: string[];
  dailyLogLinesRemoved: number;
  memoryFilesDeleted: string[];
  sessionsRemoved: string[];
  embeddingWarning: boolean;
}

/**
 * Clean up test artifacts after a live test run.
 * Belt-and-suspenders: even with isolation (temp transcript paths, memory tool exclusion),
 * we verify and clean up in case anything leaked.
 */
export async function cleanupTestArtifacts(opts: {
  sessionKeys: string[];
  homeDir?: string;
  testStartTime?: number;
  testMarker?: string;
}): Promise<CleanupReport> {
  const homeDir = opts.homeDir ?? ensureHomeDir();
  const marker = opts.testMarker ?? "[🧪 TEST]";
  const report: CleanupReport = {
    transcriptsDeleted: [],
    dailyLogLinesRemoved: 0,
    memoryFilesDeleted: [],
    sessionsRemoved: [],
    embeddingWarning: false,
  };

  const safeKeys = opts.sessionKeys.map((k) => k.replace(/[^a-zA-Z0-9_-]/g, "_"));

  // 1. Delete temp transcripts
  const tempTestDir = path.join(os.tmpdir(), "jinx-test");
  await cleanTranscripts(tempTestDir, safeKeys, report);
  await cleanTranscripts(path.join(homeDir, "sessions"), safeKeys, report);

  // 2. Clean daily memory logs
  const memoryDir = path.join(homeDir, "memory");
  await cleanDailyLogs(memoryDir, marker, opts.sessionKeys, report);

  // 3. Scan memory files for test contamination
  if (opts.testStartTime) {
    await cleanMemoryFiles(memoryDir, marker, opts.sessionKeys, opts.testStartTime, report);
  }

  // 4. Clean session store
  await cleanSessionStore(path.join(homeDir, "sessions", "store.json"), opts.sessionKeys, report);

  // 5. Check embeddings index
  if (opts.testStartTime) {
    await checkEmbeddings(memoryDir, opts.testStartTime, report);
  }

  return report;
}

async function cleanTranscripts(
  dir: string,
  safeKeys: string[],
  report: CleanupReport,
): Promise<void> {
  try {
    const files = await fs.readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".jsonl")) {
        continue;
      }
      const baseName = file.replace(".jsonl", "");
      if (safeKeys.some((k) => baseName.includes(k))) {
        const fullPath = path.join(dir, file);
        await fs.unlink(fullPath);
        report.transcriptsDeleted.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist
  }
}

async function cleanDailyLogs(
  memoryDir: string,
  marker: string,
  sessionKeys: string[],
  report: CleanupReport,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const logPath = path.join(memoryDir, `${today}.md`);
  try {
    const content = await fs.readFile(logPath, "utf-8");
    const lines = content.split("\n");
    const cleaned = lines.filter((line) => {
      const isTestLine = line.includes(marker) || sessionKeys.some((k) => line.includes(k));
      if (isTestLine) {
        report.dailyLogLinesRemoved++;
      }
      return !isTestLine;
    });
    if (report.dailyLogLinesRemoved > 0) {
      const newContent = cleaned.join("\n");
      if (newContent.trim() === "" || newContent.trim() === `# ${today}`) {
        await fs.unlink(logPath);
      } else {
        await fs.writeFile(logPath, newContent);
      }
    }
  } catch {
    // File may not exist
  }
}

async function cleanMemoryFiles(
  memoryDir: string,
  marker: string,
  sessionKeys: string[],
  testStartTime: number,
  report: CleanupReport,
): Promise<void> {
  try {
    const files = await fs.readdir(memoryDir);
    for (const file of files) {
      if (file.endsWith(".md") && /^\d{4}-\d{2}-\d{2}/.test(file)) {
        continue;
      } // skip daily logs (handled above)
      const fullPath = path.join(memoryDir, file);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.mtimeMs < testStartTime) {
        continue;
      }
      const content = await fs.readFile(fullPath, "utf-8");
      if (content.includes(marker) || sessionKeys.some((k) => content.includes(k))) {
        await fs.unlink(fullPath);
        report.memoryFilesDeleted.push(fullPath);
      }
    }
  } catch {
    // Directory may not exist
  }
}

async function cleanSessionStore(
  storePath: string,
  sessionKeys: string[],
  report: CleanupReport,
): Promise<void> {
  try {
    const content = await fs.readFile(storePath, "utf-8");
    const store = JSON.parse(content) as Record<string, unknown>;
    let changed = false;
    for (const key of sessionKeys) {
      if (key in store) {
        delete store[key];
        report.sessionsRemoved.push(key);
        changed = true;
      }
    }
    if (changed) {
      await fs.writeFile(storePath, JSON.stringify(store, null, 2));
    }
  } catch {
    // File may not exist
  }
}

async function checkEmbeddings(
  memoryDir: string,
  testStartTime: number,
  report: CleanupReport,
): Promise<void> {
  const indexPath = path.join(memoryDir, "embeddings.json");
  try {
    const stat = await fs.stat(indexPath);
    if (stat.mtimeMs > testStartTime) {
      report.embeddingWarning = true;
    }
  } catch {
    // Index may not exist
  }
}

/**
 * Sweep stale jinx-test temp directories older than the given age.
 * Called from globalSetup to clean up orphaned test artifacts.
 */
export async function sweepStaleTempDirs(maxAgeMs = 60 * 60_000): Promise<number> {
  const tmpRoot = os.tmpdir();
  let cleaned = 0;
  try {
    const entries = await fs.readdir(tmpRoot);
    const now = Date.now();
    for (const entry of entries) {
      if (!entry.startsWith("jinx-")) {
        continue;
      }
      const fullPath = path.join(tmpRoot, entry);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(fullPath, { recursive: true, force: true });
          cleaned++;
        }
      } catch {
        // Skip entries we can't stat
      }
    }
  } catch {
    // tmpdir listing failed
  }
  return cleaned;
}
