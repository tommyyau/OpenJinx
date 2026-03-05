/** Root Jinx configuration. */
export interface JinxConfig {
  /** IANA timezone (e.g. "Europe/London"). Auto-detected from system when omitted. */
  timezone?: string;
  llm: LlmConfig;
  agents: AgentsConfig;
  channels: ChannelsConfig;
  skills: SkillsConfig;
  memory: MemoryConfig;
  heartbeat: HeartbeatGlobalConfig;
  cron: CronGlobalConfig;
  gateway: GatewayConfig;
  logging: LoggingConfig;
  webSearch: WebSearchConfig;
  composio: ComposioConfig;
  sandbox: SandboxConfig;
  marathon: MarathonConfig;
}

// ── LLM ──────────────────────────────────────────────────────────────────

export type ClaudeModelTier = "brain" | "subagent" | "light";

export type ClaudeModelId = "opus" | "sonnet" | "haiku";

export interface LlmConfig {
  /** Model for main agent turns. */
  brain: ClaudeModelId;
  /** Model for subagent / tool tasks. */
  subagent: ClaudeModelId;
  /** Model for lightweight tasks (slug generation, summaries). */
  light: ClaudeModelId;
  /** Max output tokens for brain-tier turns. */
  maxTokensBrain: number;
  /** Max output tokens for subagent-tier turns. */
  maxTokensSubagent: number;
  /** Max output tokens for light-tier turns. */
  maxTokensLight: number;
  /** Max agentic turns per invocation. */
  maxTurns: number;
}

// ── Agents ───────────────────────────────────────────────────────────────

export interface AgentConfig {
  id: string;
  name: string;
  workspace: string;
  model?: ClaudeModelId;
  skills?: string[];
  memorySearch?: boolean;
  heartbeat?: AgentHeartbeatConfig;
  subagents?: { model?: ClaudeModelId };
}

export interface AgentHeartbeatConfig {
  enabled: boolean;
  intervalMinutes: number;
  activeHours?: { start: number; end: number; timezone: string };
}

export interface AgentsConfig {
  default: string;
  list: AgentConfig[];
}

// ── Channels ─────────────────────────────────────────────────────────────

export type ChannelId = "terminal" | "telegram" | "whatsapp";

export type DmPolicy = "open" | "allowlist" | "disabled";
export type GroupPolicy = "enabled" | "disabled";

export interface ChannelConfig {
  enabled: boolean;
  dmPolicy?: DmPolicy;
  groupPolicy?: GroupPolicy;
  allowFrom?: string[];
}

export interface TelegramChannelConfig extends ChannelConfig {
  botToken?: string;
  allowedChatIds?: number[];
  streaming?: boolean;
  /** Receive mode: "polling" (default) or "webhook". */
  mode?: "polling" | "webhook";
  /** Public URL for webhook mode (e.g. "https://example.com/telegram/webhook"). */
  webhookUrl?: string;
  /** Secret token for verifying webhook requests. */
  secretToken?: string;
}

export interface WhatsAppChannelConfig extends ChannelConfig {
  authDir?: string;
  /** Browser name shown in WhatsApp's Linked Devices list. */
  browserName?: string;
}

export interface ChannelsConfig {
  terminal: ChannelConfig;
  telegram: TelegramChannelConfig;
  whatsapp: WhatsAppChannelConfig;
}

// ── Skills ───────────────────────────────────────────────────────────────

export interface SkillsConfig {
  /** Directories to scan for SKILL.md files. */
  dirs: string[];
  /** Skills to exclude by name. */
  exclude: string[];
}

// ── Memory ───────────────────────────────────────────────────────────────

export interface MemoryConfig {
  enabled: boolean;
  /** Path to the memory workspace directory. */
  dir: string;
  /** Embedding provider ("openai" currently). */
  embeddingProvider: "openai";
  /** Embedding model. */
  embeddingModel: string;
  /** Hybrid search weight: 0 = pure BM25, 1 = pure vector. */
  vectorWeight: number;
  /** Max chunks to return from search. */
  maxResults: number;
}

// ── Heartbeat ────────────────────────────────────────────────────────────

export interface HeartbeatGlobalConfig {
  enabled: boolean;
  defaultIntervalMinutes: number;
  visibility: HeartbeatVisibilityConfig;
}

export interface HeartbeatVisibilityConfig {
  showOk: boolean;
  showAlerts: boolean;
  useIndicator: boolean;
}

// ── Cron ─────────────────────────────────────────────────────────────────

export interface CronGlobalConfig {
  enabled: boolean;
  maxJobs: number;
  persistPath: string;
}

// ── Gateway ──────────────────────────────────────────────────────────────

export interface GatewayConfig {
  host: string;
  port: number;
  /** Optional auth token for WebSocket connections. */
  authToken?: string;
  /** Optional list of allowed origins for WebSocket connections. */
  allowedOrigins?: string[];
  /** Optional max payload size in bytes. */
  maxPayloadBytes?: number;
  /** HTTP server config for webhooks and health checks. */
  http?: HttpConfig;
}

export interface HttpConfig {
  enabled: boolean;
  /** HTTP port (separate from WS port). */
  port: number;
  /** Webhook hooks config. */
  hooks?: HooksConfig;
}

export interface HooksConfig {
  enabled: boolean;
  /** Bearer token for webhook authentication. */
  authToken?: string;
}

// ── Web Search ───────────────────────────────────────────────────────────

export interface WebSearchConfig {
  enabled: boolean;
  /** OpenRouter API key (falls back to OPENROUTER_API_KEY env var). */
  apiKey?: string;
  /** Perplexity model to use. Default: "perplexity/sonar-pro". */
  model?: string;
  /** Request timeout in seconds. */
  timeoutSeconds?: number;
  /** In-memory cache TTL in minutes. */
  cacheTtlMinutes?: number;
}

// ── Composio ─────────────────────────────────────────────────────────────

export interface ComposioConfig {
  enabled: boolean;
  /** Composio API key (falls back to COMPOSIO_API_KEY env var). */
  apiKey?: string;
  /** User ID for Composio scoping. Default: "default". */
  userId: string;
  /** Request timeout in seconds. */
  timeoutSeconds: number;
}

// ── Sandbox ─────────────────────────────────────────────────────────────

export interface SandboxConfig {
  enabled: boolean;
  /** Default command timeout in milliseconds. */
  timeoutMs: number;
  /** Idle timeout before destroying a persistent container (ms). */
  idleTimeoutMs: number;
  /** Max output bytes per stream (stdout/stderr). */
  maxOutputBytes: number;
  /** Container image to use. */
  image: string;
  /** Additional glob patterns to block from mounting. */
  blockedPatterns: string[];
  /** Extra host directories to mount read-only. */
  allowedMounts: string[];
  /** Whether the workspace is mounted read-write (vs read-only). */
  workspaceWritable: boolean;
}

// ── Marathon ─────────────────────────────────────────────────────────────

export interface MarathonConfig {
  enabled: boolean;
  /** Maximum concurrent marathon tasks. */
  maxConcurrent: number;
  /** Pause between chunks in milliseconds. */
  chunkIntervalMs: number;
  /** Maximum number of chunks per marathon. */
  maxChunks: number;
  /** Maximum total duration in hours. */
  maxDurationHours: number;
  /** Maximum retries per chunk before pausing. */
  maxRetriesPerChunk: number;
  /** How long to keep the container alive after completion (ms). Default: 24h. */
  completionRetentionMs: number;
  /** Container resource overrides for marathon tasks. */
  container: MarathonContainerConfig;
  /** Progress notification settings. */
  progress: MarathonProgressConfig;
  /** Workspace context enrichment settings. */
  context: MarathonContextConfig;
  /** Test-fix loop settings. */
  testFix: MarathonTestFixConfig;
  /** Marathon control authorization policy. */
  control: MarathonControlConfig;
}

export interface MarathonContainerConfig {
  /** CPU count for marathon containers. */
  cpus: number;
  /** Memory in GB for marathon containers. */
  memoryGB: number;
  /** Command timeout for marathon container operations (ms). */
  commandTimeoutMs: number;
}

export interface MarathonProgressConfig {
  /** Send progress notification every N completed chunks. */
  notifyEveryNChunks: number;
  /** Include file summary in progress notifications. */
  includeFileSummary: boolean;
}

export interface MarathonContextConfig {
  /** Whether to enrich chunk prompts with workspace snapshots. */
  enabled: boolean;
  /** Maximum number of files to include in the file tree. */
  maxTreeFiles: number;
  /** Maximum bytes per key file read. */
  maxFileBytes: number;
  /** Maximum total characters for the entire workspace snapshot. */
  maxTotalChars: number;
}

export interface MarathonTestFixConfig {
  /** Whether to run test-fix loops after each chunk. */
  enabled: boolean;
  /** Maximum fix iterations before giving up. */
  maxIterations: number;
  /** Timeout for each test command execution (ms). */
  testTimeoutMs: number;
  /** Maximum characters of test output to include in fix prompt. */
  maxTestOutputChars: number;
}

export interface MarathonControlConfig {
  /** Additional controller sender IDs granted at task creation time. */
  allowFrom: string[];
  /**
   * If true, any member in the origin group can control marathons created in that group.
   * If false, only explicit allowlist/owner can control.
   */
  allowSameGroupMembers: boolean;
}

// ── Logging ──────────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LoggingConfig {
  level: LogLevel;
  file?: string;
}
