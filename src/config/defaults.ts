import type { JinxConfig } from "../types/config.js";

/** Default configuration values (matches Zod schema defaults). */
export const DEFAULT_CONFIG: JinxConfig = {
  llm: {
    brain: "opus",
    subagent: "sonnet",
    light: "haiku",
    maxTokensBrain: 16_384,
    maxTokensSubagent: 16_384,
    maxTokensLight: 4_096,
    maxTurns: 30,
  },
  agents: {
    default: "default",
    list: [
      {
        id: "default",
        name: "Jinx",
        workspace: "~/.jinx/workspace",
      },
    ],
  },
  channels: {
    terminal: { enabled: true },
    telegram: { enabled: false, streaming: true, mode: "polling" as const },
    whatsapp: { enabled: false },
  },
  skills: {
    dirs: ["~/.jinx/skills", "./skills"],
    exclude: [],
  },
  memory: {
    enabled: true,
    dir: "~/.jinx/memory",
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    vectorWeight: 0.7,
    maxResults: 10,
  },
  heartbeat: {
    enabled: true,
    defaultIntervalMinutes: 15,
    visibility: {
      showOk: false,
      showAlerts: true,
      useIndicator: true,
    },
  },
  cron: {
    enabled: true,
    maxJobs: 50,
    persistPath: "~/.jinx/cron.json",
  },
  gateway: {
    host: "127.0.0.1",
    port: 18790,
    http: {
      enabled: false,
      port: 18791,
      hooks: { enabled: false },
    },
  },
  logging: {
    level: "info",
  },
  webSearch: {
    enabled: true,
    model: "perplexity/sonar-pro",
    timeoutSeconds: 30,
    cacheTtlMinutes: 15,
  },
  composio: {
    enabled: false,
    userId: "default",
    timeoutSeconds: 60,
  },
  sandbox: {
    enabled: true,
    timeoutMs: 300_000,
    idleTimeoutMs: 900_000,
    maxOutputBytes: 524_288,
    image: "node:22-slim",
    blockedPatterns: [],
    allowedMounts: [],
    workspaceWritable: true,
  },
  marathon: {
    enabled: true,
    maxConcurrent: 1,
    chunkIntervalMs: 5000,
    maxChunks: 50,
    maxDurationHours: 12,
    maxRetriesPerChunk: 3,
    completionRetentionMs: 14_400_000,
    container: {
      cpus: 4,
      memoryGB: 4,
      commandTimeoutMs: 600_000,
    },
    progress: {
      notifyEveryNChunks: 1,
      includeFileSummary: true,
    },
    context: {
      enabled: true,
      maxTreeFiles: 200,
      maxFileBytes: 8192,
      maxTotalChars: 30_000,
    },
    testFix: {
      enabled: true,
      maxIterations: 3,
      testTimeoutMs: 120_000,
      maxTestOutputChars: 8_000,
    },
    control: {
      allowFrom: [],
      allowSameGroupMembers: false,
    },
  },
};
