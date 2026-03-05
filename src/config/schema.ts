import { z } from "zod/v4";

// ── Primitives ───────────────────────────────────────────────────────────

const logLevel = z.enum(["debug", "info", "warn", "error", "silent"]);
const claudeModelId = z.enum(["opus", "sonnet", "haiku"]);
const dmPolicy = z.enum(["open", "allowlist", "disabled"]);
const groupPolicy = z.enum(["enabled", "disabled"]);

// ── LLM ──────────────────────────────────────────────────────────────────

export const llmSchema = z
  .object({
    brain: claudeModelId.default("opus"),
    subagent: claudeModelId.default("sonnet"),
    light: claudeModelId.default("haiku"),
    maxTokensBrain: z.number().int().min(256).default(16_384),
    maxTokensSubagent: z.number().int().min(256).default(16_384),
    maxTokensLight: z.number().int().min(256).default(4_096),
    maxTurns: z.number().int().min(1).default(30),
  })
  .default({
    brain: "opus",
    subagent: "sonnet",
    light: "haiku",
    maxTokensBrain: 16_384,
    maxTokensSubagent: 16_384,
    maxTokensLight: 4_096,
    maxTurns: 30,
  });

// ── Agents ───────────────────────────────────────────────────────────────

const agentHeartbeatSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().min(1).default(15),
  activeHours: z
    .object({
      start: z.number().int().min(0).max(23),
      end: z.number().int().min(0).max(23),
      timezone: z.string(),
    })
    .optional(),
});

const agentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1),
  model: claudeModelId.optional(),
  skills: z.array(z.string()).optional(),
  memorySearch: z.boolean().optional(),
  heartbeat: agentHeartbeatSchema.optional(),
  subagents: z.object({ model: claudeModelId.optional() }).optional(),
});

export const agentsSchema = z
  .object({
    default: z.string().min(1).default("default"),
    list: z
      .array(agentSchema)
      .default([{ id: "default", name: "Jinx", workspace: "~/.jinx/workspace" }]),
  })
  .default({
    default: "default",
    list: [{ id: "default", name: "Jinx", workspace: "~/.jinx/workspace" }],
  });

// ── Channels ─────────────────────────────────────────────────────────────

const baseChannelSchema = z.object({
  enabled: z.boolean().default(false),
  dmPolicy: dmPolicy.optional(),
  groupPolicy: groupPolicy.optional(),
  allowFrom: z.array(z.string()).optional(),
});

const telegramSchema = z.object({
  enabled: z.boolean().default(false),
  dmPolicy: dmPolicy.optional(),
  groupPolicy: groupPolicy.optional(),
  allowFrom: z.array(z.string()).optional(),
  botToken: z.string().optional(),
  allowedChatIds: z.array(z.number()).optional(),
  streaming: z.boolean().default(true),
  mode: z.enum(["polling", "webhook"]).default("polling"),
  webhookUrl: z.string().optional(),
  secretToken: z.string().optional(),
});

const whatsappSchema = z.object({
  enabled: z.boolean().default(false),
  dmPolicy: dmPolicy.optional(),
  groupPolicy: groupPolicy.optional(),
  allowFrom: z.array(z.string()).optional(),
  authDir: z.string().optional(),
  browserName: z.string().optional(),
});

export const channelsSchema = z
  .object({
    terminal: baseChannelSchema.default({ enabled: true }),
    telegram: telegramSchema.default({ enabled: false, streaming: true, mode: "polling" as const }),
    whatsapp: whatsappSchema.default({ enabled: false }),
  })
  .default({
    terminal: { enabled: true },
    telegram: { enabled: false, streaming: true, mode: "polling" as const },
    whatsapp: { enabled: false },
  });

// ── Skills ───────────────────────────────────────────────────────────────

export const skillsSchema = z
  .object({
    dirs: z.array(z.string()).default(["~/.jinx/skills", "./skills"]),
    exclude: z.array(z.string()).default([]),
  })
  .default({
    dirs: ["~/.jinx/skills", "./skills"],
    exclude: [],
  });

// ── Memory ───────────────────────────────────────────────────────────────

export const memorySchema = z
  .object({
    enabled: z.boolean().default(true),
    dir: z.string().default("~/.jinx/memory"),
    embeddingProvider: z.literal("openai").default("openai"),
    embeddingModel: z.string().default("text-embedding-3-small"),
    vectorWeight: z.number().min(0).max(1).default(0.7),
    maxResults: z.number().int().min(1).default(10),
  })
  .default({
    enabled: true,
    dir: "~/.jinx/memory",
    embeddingProvider: "openai" as const,
    embeddingModel: "text-embedding-3-small",
    vectorWeight: 0.7,
    maxResults: 10,
  });

// ── Heartbeat ────────────────────────────────────────────────────────────

const visibilitySchema = z
  .object({
    showOk: z.boolean().default(false),
    showAlerts: z.boolean().default(true),
    useIndicator: z.boolean().default(true),
  })
  .default({ showOk: false, showAlerts: true, useIndicator: true });

export const heartbeatSchema = z
  .object({
    enabled: z.boolean().default(true),
    defaultIntervalMinutes: z.number().min(1).default(15),
    visibility: visibilitySchema,
  })
  .default({
    enabled: true,
    defaultIntervalMinutes: 15,
    visibility: { showOk: false, showAlerts: true, useIndicator: true },
  });

// ── Cron ─────────────────────────────────────────────────────────────────

export const cronSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxJobs: z.number().int().min(1).default(50),
    persistPath: z.string().default("~/.jinx/cron.json"),
  })
  .default({
    enabled: true,
    maxJobs: 50,
    persistPath: "~/.jinx/cron.json",
  });

// ── Gateway ──────────────────────────────────────────────────────────────

const hooksSchema = z
  .object({
    enabled: z.boolean().default(false),
    authToken: z.string().optional(),
  })
  .default({ enabled: false });

const httpSchema = z
  .object({
    enabled: z.boolean().default(false),
    port: z.number().int().min(1).max(65535).default(18791),
    hooks: hooksSchema,
  })
  .default({ enabled: false, port: 18791, hooks: { enabled: false } });

export const gatewaySchema = z
  .object({
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(1).max(65535).default(18790),
    authToken: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    maxPayloadBytes: z.number().int().min(1024).optional(),
    http: httpSchema,
  })
  .default({
    host: "127.0.0.1",
    port: 18790,
    http: { enabled: false, port: 18791, hooks: { enabled: false } },
  });

// ── Logging ──────────────────────────────────────────────────────────────

export const loggingSchema = z
  .object({
    level: logLevel.default("info"),
    file: z.string().optional(),
  })
  .default({ level: "info" as const });

// ── Web Search ──────────────────────────────────────────────────────

export const webSearchSchema = z
  .object({
    enabled: z.boolean().default(true),
    apiKey: z.string().optional(),
    model: z.string().default("perplexity/sonar-pro"),
    timeoutSeconds: z.number().int().min(1).default(30),
    cacheTtlMinutes: z.number().min(0).default(15),
  })
  .default({
    enabled: true,
    model: "perplexity/sonar-pro",
    timeoutSeconds: 30,
    cacheTtlMinutes: 15,
  });

// ── Composio ────────────────────────────────────────────────────────────

export const composioSchema = z
  .object({
    enabled: z.boolean().default(false),
    apiKey: z.string().optional(),
    userId: z.string().default("default"),
    timeoutSeconds: z.number().int().min(1).default(60),
  })
  .default({
    enabled: false,
    userId: "default",
    timeoutSeconds: 60,
  });

// ── Sandbox ─────────────────────────────────────────────────────────────

export const sandboxSchema = z
  .object({
    enabled: z.boolean().default(true),
    timeoutMs: z.number().int().min(1000).default(300_000),
    idleTimeoutMs: z.number().int().min(60_000).default(900_000),
    maxOutputBytes: z.number().int().min(1024).default(102_400),
    image: z.string().default("node:22-slim"),
    blockedPatterns: z.array(z.string()).default([]),
    allowedMounts: z.array(z.string()).default([]),
    workspaceWritable: z.boolean().default(true),
  })
  .default({
    enabled: true,
    timeoutMs: 300_000,
    idleTimeoutMs: 900_000,
    maxOutputBytes: 102_400,
    image: "node:22-slim",
    blockedPatterns: [],
    allowedMounts: [],
    workspaceWritable: true,
  });

// ── Marathon ────────────────────────────────────────────────────────────

const marathonContainerSchema = z
  .object({
    cpus: z.number().int().min(1).default(4),
    memoryGB: z.number().min(1).default(4),
    commandTimeoutMs: z.number().int().min(1000).default(600_000),
  })
  .default({ cpus: 4, memoryGB: 4, commandTimeoutMs: 600_000 });

const marathonProgressSchema = z
  .object({
    notifyEveryNChunks: z.number().int().min(1).default(1),
    includeFileSummary: z.boolean().default(true),
  })
  .default({ notifyEveryNChunks: 1, includeFileSummary: true });

const marathonContextSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxTreeFiles: z.number().int().min(10).default(200),
    maxFileBytes: z.number().int().min(1024).default(8192),
    maxTotalChars: z.number().int().min(1000).default(30_000),
  })
  .default({ enabled: true, maxTreeFiles: 200, maxFileBytes: 8192, maxTotalChars: 30_000 });

const marathonTestFixSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxIterations: z.number().int().min(0).default(3),
    testTimeoutMs: z.number().int().min(5000).default(120_000),
    maxTestOutputChars: z.number().int().min(500).default(8_000),
  })
  .default({ enabled: true, maxIterations: 3, testTimeoutMs: 120_000, maxTestOutputChars: 8_000 });

const marathonControlSchema = z
  .object({
    allowFrom: z.array(z.string()).default([]),
    allowSameGroupMembers: z.boolean().default(false),
  })
  .default({ allowFrom: [], allowSameGroupMembers: false });

export const marathonSchema = z
  .object({
    enabled: z.boolean().default(true),
    maxConcurrent: z.number().int().min(1).default(1),
    chunkIntervalMs: z.number().int().min(0).default(5000),
    maxChunks: z.number().int().min(1).default(50),
    maxDurationHours: z.number().min(0.1).default(12),
    maxRetriesPerChunk: z.number().int().min(0).default(3),
    completionRetentionMs: z.number().int().min(0).default(14_400_000),
    container: marathonContainerSchema,
    progress: marathonProgressSchema,
    context: marathonContextSchema,
    testFix: marathonTestFixSchema,
    control: marathonControlSchema,
  })
  .default({
    enabled: true,
    maxConcurrent: 1,
    chunkIntervalMs: 5000,
    maxChunks: 50,
    maxDurationHours: 12,
    maxRetriesPerChunk: 3,
    completionRetentionMs: 14_400_000,
    container: { cpus: 4, memoryGB: 4, commandTimeoutMs: 600_000 },
    progress: { notifyEveryNChunks: 1, includeFileSummary: true },
    context: { enabled: true, maxTreeFiles: 200, maxFileBytes: 8192, maxTotalChars: 30_000 },
    testFix: { enabled: true, maxIterations: 3, testTimeoutMs: 120_000, maxTestOutputChars: 8_000 },
    control: { allowFrom: [], allowSameGroupMembers: false },
  });

// ── Root ─────────────────────────────────────────────────────────────────

export const jinxConfigSchema = z.object({
  timezone: z.string().optional(),
  llm: llmSchema,
  agents: agentsSchema,
  channels: channelsSchema,
  skills: skillsSchema,
  memory: memorySchema,
  heartbeat: heartbeatSchema,
  cron: cronSchema,
  gateway: gatewaySchema,
  logging: loggingSchema,
  webSearch: webSearchSchema,
  composio: composioSchema,
  sandbox: sandboxSchema,
  marathon: marathonSchema,
});

export type JinxConfigInput = z.input<typeof jinxConfigSchema>;
