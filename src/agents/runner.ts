import type { CronService } from "../cron/service.js";
import type { MemorySearchManager } from "../memory/search-manager.js";
import type {
  AgentResult,
  AgentToolDefinition,
  AgentTurnOptions,
  HistoryTurn,
} from "../providers/types.js";
import type { ContainerManager } from "../sandbox/container-manager.js";
import type { ChannelPlugin } from "../types/channels.js";
import type { ClaudeModelTier, JinxConfig } from "../types/config.js";
import type { MediaAttachment } from "../types/messages.js";
import type { SessionStore, TranscriptToolCall, TranscriptTurn } from "../types/sessions.js";
import { expandTilde } from "../infra/home-dir.js";
import { createLogger } from "../infra/logger.js";
import { logTurnMetric } from "../infra/metrics.js";
import { flushMemoryBeforeCompaction } from "../memory/flush.js";
import { runAgentTurn as callProvider } from "../providers/claude-provider.js";
import { getContextWindow, resolveMaxTokens, resolveModelString } from "../providers/models.js";
import {
  compactTranscript,
  estimateTranscriptTokens,
  needsCompaction,
} from "../sessions/compaction.js";
import { appendTranscriptTurn, readTranscript } from "../sessions/transcript.js";
import { loadSkillEntries } from "../skills/loader.js";
import { buildSkillSnapshot } from "../skills/snapshot.js";
import { filterFilesForSession, type SessionType } from "../workspace/filter.js";
import { loadWorkspaceFiles } from "../workspace/loader.js";
import { trimWorkspaceFiles } from "../workspace/trim.js";
import { resolveAgent, resolveModel } from "./scope.js";
import { buildSystemPromptBlocks } from "./system-prompt.js";
import { getChannelToolDefinitions } from "./tools/channel-tools.js";
import { getComposioToolDefinitions } from "./tools/composio-tools.js";
import { getCoreToolDefinitions } from "./tools/core-tools.js";
import { getCronToolDefinitions } from "./tools/cron-tools.js";
import { getExecToolDefinitions } from "./tools/exec-tools.js";
import { getMarathonToolDefinitions } from "./tools/marathon-tools.js";
import { aggregateTools } from "./tools/mcp-bridge.js";
import { getMemoryToolDefinitions } from "./tools/memory-tools.js";
import { getSessionToolDefinitions } from "./tools/session-tools.js";
import { getSpawnToolDefinitions } from "./tools/spawn-tools.js";
import { getWebFetchToolDefinitions } from "./tools/web-fetch-tools.js";
import { getWebSearchToolDefinitions } from "./tools/web-search-tools.js";

const logger = createLogger("agent");

export interface RunAgentOptions {
  prompt: string;
  sessionKey: string;
  sessionType?: SessionType;
  /** Override the model tier (defaults to "brain" for main, "subagent" for subagent sessions). */
  tier?: ClaudeModelTier;
  transcriptPath: string;
  config: JinxConfig;
  tools?: AgentToolDefinition[];
  sessions?: SessionStore;
  searchManager?: MemorySearchManager;
  cronService?: CronService;
  channels?: Map<string, ChannelPlugin>;
  containerManager?: ContainerManager;
  /** Media attachments from the inbound message (images, audio, etc.). */
  media?: MediaAttachment[];
  onDelta?: (text: string) => void;
  /** Message context — channel/sender info for situational awareness. */
  channel?: string;
  senderName?: string;
  isGroup?: boolean;
  groupName?: string;
  /** Whether this is a system test turn — skips memory tools and RAG. */
  isSystemTest?: boolean;
  /** Override the workspace directory for tool scoping (e.g., marathon task-specific workspace). */
  workspaceDir?: string;
  /** Override the identity directory (where SOUL.md etc. live). Defaults to agent.workspace. */
  identityDir?: string;
}

/**
 * Run a complete agent turn:
 * 1. Resolve agent + model
 * 2. Compute directories
 * 3. Load + filter workspace files
 * 4. Assemble tools
 * 5. Load skills + build snapshot
 * 6. RAG pre-search (if searchManager available)
 * 7. Load conversation history from transcript
 * 8. Record user turn to transcript
 * 9. Call Claude provider (with history)
 * 10. Record assistant turn to transcript
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const { prompt, sessionKey, config, transcriptPath, onDelta } = options;
  const sessionType = options.sessionType ?? "main";

  // 1. Resolve agent and model
  const agent = resolveAgent(config, sessionKey);
  const modelTier = options.tier ?? (sessionType === "subagent" ? "subagent" : "brain");
  const modelId = resolveModel(config, modelTier, agent.model);
  const modelString = resolveModelString(modelId);

  logger.info(`Agent turn: agent=${agent.id} model=${modelId} session=${sessionKey}`);

  // 2. Compute resolved directories
  // Identity dir: where SOUL.md etc. live (always the agent's workspace)
  const identityDir = options.identityDir ?? expandTilde(agent.workspace);
  // Task dir: where file tools write (scoped per task, or defaults to identity)
  const workspaceDir = options.workspaceDir ?? identityDir;
  const memoryDir = expandTilde(config.memory.dir);

  // 3. Load and filter workspace files from IDENTITY dir (not task dir)
  const allFiles = await loadWorkspaceFiles(identityDir);
  const filtered = filterFilesForSession(allFiles, sessionType);
  const trimmed = trimWorkspaceFiles(filtered);

  // 4. Assemble tools and build system prompt
  const tools =
    options.tools ??
    assembleDefaultTools(
      workspaceDir,
      memoryDir,
      options.isSystemTest ? undefined : options.searchManager,
      config,
      options.cronService,
      sessionKey,
      options.sessions,
      options.channels,
      options.containerManager,
      options.channel,
      sessionType,
      options.isSystemTest,
      identityDir,
    );

  // 5. Load skills and build snapshot
  const skillEntries = await loadSkillEntries(config.skills.dirs);
  const excluded = new Set(config.skills.exclude);
  const filteredSkills = skillEntries.filter((s) => !excluded.has(s.name));
  const skills = buildSkillSnapshot(filteredSkills);

  const promptOptions = {
    workspaceFiles: trimmed,
    tools,
    skills,
    sessionType,
    agentName: agent.name,
    model: modelString,
    workspaceDir,
    memoryDir,
    // Show identity dir in metadata when it differs from task workspace
    identityDir: identityDir !== workspaceDir ? identityDir : undefined,
    timezone: config.timezone,
    channel: options.channel,
    senderName: options.senderName,
    isGroup: options.isGroup,
    groupName: options.groupName,
  };

  // Build structured blocks for prompt caching
  const systemBlocks = buildSystemPromptBlocks(promptOptions);

  // 6. RAG pre-search — surface relevant memory before the LLM call (skip for system tests)
  const ragContext =
    options.searchManager && !options.isSystemTest
      ? await buildRagContext(options.searchManager, prompt)
      : "";
  if (ragContext) {
    systemBlocks.push({ text: ragContext, cacheable: false });
  }

  // Flat string for backward compatibility (transcript logging, compaction, etc.)
  const systemPrompt = systemBlocks
    .map((b) => b.text)
    .filter(Boolean)
    .join("\n\n---\n\n");

  // 6.5. Pre-compaction flush + compact transcript if approaching context limit
  const contextWindow = getContextWindow(modelId);

  // Only flush if compaction is likely — check transcript size first (skip for system tests)
  const preFlushTurns = await readTranscript(transcriptPath);
  const estimatedTokens = estimateTranscriptTokens(preFlushTurns);
  if (!options.isSystemTest && needsCompaction(estimatedTokens, contextWindow)) {
    await flushMemoryBeforeCompaction({
      sessionKey,
      contextSummary: `Context at ${contextWindow} token window, ~${estimatedTokens} tokens used`,
      runTurn: async (flushPrompt) => {
        const flushResult = await callProvider({
          prompt: flushPrompt,
          systemPrompt:
            "Store important memories using your file tools before context is compacted.",
          model: resolveModel(config, "light"),
          maxTurns: 1,
          sessionId: `${sessionKey}:flush`,
        });
        return flushResult.text;
      },
    });
  }

  const compactionResult = await compactTranscript(
    transcriptPath,
    contextWindow,
    async (compactionPrompt) => {
      const compactionResult = await callProvider({
        prompt: compactionPrompt,
        systemPrompt:
          "Summarize this conversation concisely. Preserve key facts, decisions, and context needed to continue.",
        model: resolveModel(config, "light"),
        maxTurns: 1,
        sessionId: `${sessionKey}:compaction`,
      });
      return compactionResult.text;
    },
  );
  if (compactionResult.compacted) {
    logger.info(
      `Compacted transcript: ${compactionResult.tokensBefore} → ${compactionResult.tokensAfter} tokens`,
    );
  }

  // 7. Load conversation history from transcript
  const history = await loadHistory(transcriptPath);

  // 8. Record user turn in transcript (after loading history, before calling provider)
  // If media was attached, note it in the transcript text (don't store buffers)
  let transcriptText = prompt;
  if (options.media && options.media.length > 0) {
    const counts = new Map<string, number>();
    for (const m of options.media) {
      counts.set(m.type, (counts.get(m.type) ?? 0) + 1);
    }
    const parts = [...counts.entries()].map(([type, n]) => (n > 1 ? `${n} ${type}s` : `1 ${type}`));
    transcriptText += `\n[Attached: ${parts.join(", ")}]`;
  }
  const userTurn: TranscriptTurn = {
    role: "user",
    text: transcriptText,
    timestamp: Date.now(),
  };
  await appendTranscriptTurn(transcriptPath, userTurn);

  // 9. Call the provider
  const turnOptions: AgentTurnOptions = {
    prompt,
    systemPrompt,
    systemPromptBlocks: systemBlocks,
    model: modelId,
    tools,
    sessionId: sessionKey,
    history,
    maxTurns: config.llm.maxTurns,
    maxTokens: resolveMaxTokens(config, modelTier),
    media: options.media,
    onDelta,
  };

  const result = await callProvider(turnOptions);

  // 9.5. Log turn metrics (fire-and-forget)
  const turnType = sessionKey.startsWith("heartbeat:")
    ? ("heartbeat" as const)
    : sessionKey.startsWith("cron:")
      ? ("cron" as const)
      : sessionKey.startsWith("marathon:")
        ? ("marathon" as const)
        : ("chat" as const);
  logTurnMetric({
    timestamp: Date.now(),
    sessionKey,
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cacheCreationTokens: result.usage.cacheCreationTokens,
    cacheReadTokens: result.usage.cacheReadTokens,
    durationMs: result.durationMs,
    turnType,
  });

  // 10. Record assistant turn in transcript
  const assistantTurn: TranscriptTurn = {
    role: "assistant",
    text: result.text,
    timestamp: Date.now(),
    usage: result.usage,
    toolCalls: result.messages
      .flatMap((m) => m.toolCalls ?? [])
      .map((tc) => ({ toolName: tc.name, input: tc.input, output: tc.output })),
  };
  await appendTranscriptTurn(transcriptPath, assistantTurn);

  const { inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens } = result.usage;
  const cacheInfo =
    cacheCreationTokens || cacheReadTokens
      ? ` cache:+${cacheCreationTokens}w/${cacheReadTokens}r`
      : "";
  logger.info(
    `Agent turn complete: ${inputTokens}in/${outputTokens}out${cacheInfo} (${result.durationMs}ms)`,
  );

  return result;
}

/**
 * Max number of recent transcript turns to include as conversation history.
 * With auto-compaction enabled, this is a safety backstop rather than the
 * primary context limit. Compaction summarizes older turns before we hit
 * the context window, so we can afford a higher limit here.
 */
const MAX_HISTORY_TURNS = 200;

/**
 * Load conversation history from the transcript file.
 * Reads prior turns and converts them to the HistoryTurn format
 * expected by the provider. Only user and assistant turns are included;
 * system turns (compaction summaries) are prepended as-is.
 */
async function loadHistory(transcriptPath: string): Promise<HistoryTurn[]> {
  const turns = await readTranscript(transcriptPath);
  if (turns.length === 0) {
    return [];
  }

  // Take recent turns, respecting the limit
  const recent = turns.length > MAX_HISTORY_TURNS ? turns.slice(-MAX_HISTORY_TURNS) : turns;

  const history: HistoryTurn[] = [];
  for (const turn of recent) {
    if (turn.role === "user" || turn.role === "assistant") {
      // Enrich assistant turns with tool-use context so Claude sees prior tool interactions
      const content =
        turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0
          ? enrichWithToolContext(turn.text, turn.toolCalls)
          : turn.text;
      history.push({ role: turn.role, content });
    } else if (turn.role === "system" && turn.isCompaction) {
      // Compaction summaries go as user messages so Claude sees the context
      history.push({ role: "user", content: `[Prior conversation summary]\n\n${turn.text}` });
    }
  }

  // Anthropic requires messages to start with a user turn and alternate roles.
  // Ensure we don't start with an assistant message.
  while (history.length > 0 && history[0].role === "assistant") {
    history.shift();
  }

  // Merge consecutive same-role messages (can happen after filtering)
  const merged: HistoryTurn[] = [];
  for (const turn of history) {
    const prev = merged[merged.length - 1];
    if (prev && prev.role === turn.role) {
      prev.content += "\n\n" + turn.content;
    } else {
      merged.push({ ...turn });
    }
  }

  if (merged.length > 0) {
    logger.info(`Loaded ${merged.length} history turns from transcript`);
  }

  return merged;
}

/** Max chars of tool I/O to include in history enrichment per call. */
const MAX_TOOL_CONTEXT_CHARS = 500;

/**
 * Enrich an assistant message with a summary of tool calls it made.
 * This gives Claude visibility into its prior tool-use patterns in history
 * without requiring structured tool_use/tool_result blocks (which the
 * Anthropic API only supports for the current turn).
 */
function enrichWithToolContext(text: string, toolCalls: TranscriptToolCall[]): string {
  const summaries = toolCalls.map((tc) => {
    const inputStr = typeof tc.input === "string" ? tc.input : JSON.stringify(tc.input);
    const outputStr = typeof tc.output === "string" ? tc.output : JSON.stringify(tc.output ?? "");
    const truncInput =
      inputStr.length > MAX_TOOL_CONTEXT_CHARS
        ? inputStr.slice(0, MAX_TOOL_CONTEXT_CHARS) + "..."
        : inputStr;
    const truncOutput =
      outputStr.length > MAX_TOOL_CONTEXT_CHARS
        ? outputStr.slice(0, MAX_TOOL_CONTEXT_CHARS) + "..."
        : outputStr;
    return `- ${tc.toolName}(${truncInput}) → ${truncOutput}`;
  });
  return `${text}\n\n[Tools used: ${toolCalls.length}]\n${summaries.join("\n")}`;
}

/**
 * Assemble the default tool set for an agent turn.
 * Core tools are scoped to the agent workspace directory and the memory directory.
 */
export function assembleDefaultTools(
  workspaceDir: string,
  memoryDir: string,
  searchManager?: MemorySearchManager,
  config?: JinxConfig,
  cronService?: CronService,
  sessionKey?: string,
  sessions?: SessionStore,
  channels?: Map<string, ChannelPlugin>,
  containerManager?: ContainerManager,
  /** Originating channel name (e.g. "whatsapp", "telegram") for cron delivery targeting. */
  originChannel?: string,
  /** Session type for tiered file protection. */
  sessionType?: string,
  /** Whether to exclude memory tools (system test isolation). */
  isSystemTest?: boolean,
  /** Identity directory (where SOUL.md etc. live). Included in allowedDirs when provided. */
  identityDir?: string,
): AgentToolDefinition[] {
  const allowedDirs = [
    ...new Set([workspaceDir, ...(identityDir ? [identityDir] : []), memoryDir]),
  ];

  const core = getCoreToolDefinitions({ allowedDirs, sessionType });
  const memory = isSystemTest ? [] : getMemoryToolDefinitions({ memoryDir, searchManager });
  const channel = getChannelToolDefinitions(
    sessions && channels
      ? {
          sessions,
          send: async (channelName, to, text) => {
            const ch = channels.get(channelName);
            if (!ch || !ch.isReady()) {
              return false;
            }
            try {
              await ch.send(to, { text });
              return true;
            } catch (err) {
              logger.warn(`Channel send failed: channel=${channelName} to=${to}`, err);
              return false;
            }
          },
        }
      : undefined,
  );
  const cron = getCronToolDefinitions(
    cronService
      ? { service: cronService, sessionKey, sessions, channel: originChannel }
      : undefined,
  );

  const session =
    sessionKey && sessions
      ? getSessionToolDefinitions({ sessionKey, sessions, timezone: config?.timezone })
      : [];

  const webSearch = config?.webSearch;
  const web =
    webSearch?.enabled !== false
      ? getWebSearchToolDefinitions({
          apiKey: webSearch?.apiKey,
          model: webSearch?.model,
          timeoutSeconds: webSearch?.timeoutSeconds,
          cacheTtlMinutes: webSearch?.cacheTtlMinutes,
        })
      : [];

  const webFetch = getWebFetchToolDefinitions({
    cacheTtlMinutes: webSearch?.cacheTtlMinutes,
  });

  const exec =
    config?.sandbox?.enabled !== false && containerManager && sessionKey
      ? getExecToolDefinitions({
          workspaceDir,
          sandboxConfig: config!.sandbox,
          sessionKey,
          containerManager,
        })
      : [];

  const spawn =
    sessionKey && sessions && config
      ? getSpawnToolDefinitions({
          parentSessionKey: sessionKey,
          config,
          sessions,
          searchManager,
          cronService,
          channels,
          containerManager,
        })
      : [];

  const composio = config?.composio?.enabled
    ? getComposioToolDefinitions({
        apiKey: config.composio.apiKey,
        userId: config.composio.userId,
        timeoutSeconds: config.composio.timeoutSeconds,
      })
    : [];

  // Marathon tools — available when running inside a marathon chunk session
  const marathonTaskId = sessionKey?.startsWith("marathon:")
    ? sessionKey.replace("marathon:", "marathon-")
    : undefined;
  const marathon = marathonTaskId ? getMarathonToolDefinitions({ taskId: marathonTaskId }) : [];

  return aggregateTools(
    core,
    memory,
    channel,
    cron,
    [],
    [...web, ...webFetch, ...exec, ...marathon],
    [...session, ...spawn],
    composio,
  );
}

/**
 * Pre-search memory using the user's prompt and format results as a
 * system prompt section. Returns empty string if no relevant results.
 */
export async function buildRagContext(
  searchManager: MemorySearchManager,
  query: string,
): Promise<string> {
  try {
    const results = await searchManager.search({ query, maxResults: 5, minScore: 0.3 });
    if (results.length === 0) {
      return "";
    }

    const chunks = results
      .map((r) => `[${r.filePath}:${r.startLine}] (score: ${r.score.toFixed(2)})\n${r.chunk}`)
      .join("\n\n---\n\n");

    return `\n\n---\n\n# Relevant Memory\n\nNote: Memory content was written in prior sessions. Verify if critical.\n\nRetrieved from memory based on the user's message:\n\n${chunks}`;
  } catch (err) {
    logger.warn(`RAG pre-search failed, continuing without context: ${err}`);
    return "";
  }
}
