import crypto from "node:crypto";
import type { CronService } from "../cron/service.js";
import type { MemorySearchManager } from "../memory/search-manager.js";
import type { AgentToolDefinition } from "../providers/types.js";
import type { ContainerManager } from "../sandbox/container-manager.js";
import type { ChannelPlugin } from "../types/channels.js";
import type { JinxConfig } from "../types/config.js";
import type { DeliveryTarget } from "../types/marathon.js";
import type { MarathonCheckpoint } from "../types/marathon.js";
import type { SessionStore } from "../types/sessions.js";
import { createLogger } from "../infra/logger.js";
import { logProductTelemetry } from "../infra/product-telemetry.js";
import {
  readCheckpoint,
  cancelCheckpoint,
  updateCheckpointStatus,
  patchCheckpoint,
  resetCurrentChunkRetries,
  listCheckpoints,
} from "./checkpoint.js";
import { packageDeliverables } from "./marathon-artifacts.js";
import { buildMarathonCompletionText } from "./marathon-completion.js";
import { deliverMarathonPayload } from "./marathon-delivery.js";
import { runMarathonExecutionLoop } from "./marathon-executor.js";
import { bootstrapMarathonExecution } from "./marathon-launch.js";
import { buildMarathonChunkTools } from "./marathon-tools.js";
import { emitStreamEvent } from "./streaming.js";

const logger = createLogger("marathon");

/** Per-chunk timeout — 1 hour for large autonomous tasks. */
const CHUNK_TIMEOUT_MS = 60 * 60_000;

/** Planning turn timeout — 5 min (planning is lighter than execution). */
const PLANNING_TIMEOUT_MS = 15 * 60_000;

/** Track active marathon executor loops. */
const activeExecutors = new Map<string, { abortController: AbortController }>();
/** Track marathons currently in planning (reserved concurrency slots). */
const planningExecutors = new Set<string>();

export interface MarathonDeps {
  config: JinxConfig;
  sessions: SessionStore;
  cronService?: CronService;
  channels?: Map<string, ChannelPlugin>;
  containerManager?: ContainerManager;
  searchManager?: MemorySearchManager;
}

export interface LaunchMarathonParams {
  /** The enveloped prompt from the user. */
  prompt: string;
  /** Session key of the originating conversation. */
  originSessionKey: string;
  /** Where to deliver progress and results. */
  deliveryTarget: DeliveryTarget;
  /** Channel the message came from. */
  channel: string;
  /** Sender display name. */
  senderName: string;
  /** Sender ID (used for group authorization). */
  senderId?: string;
  /** Group ID when launched from a group session. */
  groupId?: string;
  /** Media attachments from the inbound message. */
  media?: import("../types/messages.js").MediaAttachment[];
}

/** Check how many marathons are currently executing. */
function activeMarathonCount(): number {
  return activeExecutors.size + planningExecutors.size;
}

/**
 * Launch a marathon task. Fire-and-forget — sends ack, then runs the executor loop.
 */
export function launchMarathon(params: LaunchMarathonParams, deps: MarathonDeps): void {
  const { config } = deps;

  // Enforce concurrency limit
  if (activeMarathonCount() >= config.marathon.maxConcurrent) {
    emitStreamEvent(params.originSessionKey, {
      type: "final",
      text: `Cannot start marathon: already at maximum concurrent tasks (${config.marathon.maxConcurrent}). Use /marathon status to check active tasks.`,
    });
    return;
  }

  const shortId = crypto.randomUUID().slice(0, 8);
  const taskId = `marathon-${shortId}`;
  const sessionKey = `marathon:${shortId}`;
  planningExecutors.add(taskId);

  emitMarathonTelemetry("marathon_launch_requested", {
    taskId,
    sessionKey,
    channel: params.deliveryTarget.channel,
    hasMedia: Boolean(params.media && params.media.length > 0),
  });

  // Emit ack on the origin session
  emitStreamEvent(params.originSessionKey, {
    type: "final",
    text: `Starting marathon task \`${taskId}\`. I'll plan the work, then execute it chunk by chunk. You'll receive progress updates and the final result when complete.`,
  });

  // Fire-and-forget
  executeMarathon(taskId, sessionKey, shortId, params, deps)
    .catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`Marathon failed (task=${taskId}): ${msg}`);
      emitMarathonTelemetry("marathon_launch_failed", {
        taskId,
        sessionKey,
        error: msg,
      });
    })
    .finally(() => {
      planningExecutors.delete(taskId);
    });
}

async function executeMarathon(
  taskId: string,
  sessionKey: string,
  shortId: string,
  params: LaunchMarathonParams,
  deps: MarathonDeps,
): Promise<void> {
  emitMarathonTelemetry("marathon_execution_started", { taskId, sessionKey });
  const bootstrapped = await bootstrapMarathonExecution({
    taskId,
    sessionKey,
    shortId,
    launchParams: params,
    deps,
    planningTimeoutMs: PLANNING_TIMEOUT_MS,
    emitTelemetry: emitMarathonTelemetry,
    deliverText,
  });
  if (!bootstrapped) {
    return;
  }
  const { workspaceDir, chunkTools, watchdogJobId } = bootstrapped;

  // Planning slot is no longer needed once execution loop starts.
  planningExecutors.delete(taskId);

  // 8. Run chunk loop
  await runChunkLoop(taskId, sessionKey, workspaceDir, params, deps, chunkTools, watchdogJobId);
}

async function runChunkLoop(
  taskId: string,
  sessionKey: string,
  workspaceDir: string,
  params: LaunchMarathonParams,
  deps: MarathonDeps,
  chunkTools: AgentToolDefinition[],
  watchdogJobId?: string,
): Promise<void> {
  if (activeExecutors.has(taskId)) {
    throw new Error(`Marathon ${taskId} already has an active executor loop`);
  }
  const abortController = new AbortController();
  activeExecutors.set(taskId, { abortController });
  emitMarathonTelemetry("marathon_loop_started", { taskId, sessionKey });

  try {
    await runMarathonExecutionLoop({
      taskId,
      sessionKey,
      workspaceDir,
      params,
      deps,
      chunkTools,
      abortSignal: abortController.signal,
      chunkTimeoutMs: CHUNK_TIMEOUT_MS,
      watchdogJobId,
      onMarathonComplete,
      deliverText,
      emitTelemetry: emitMarathonTelemetry,
    });
  } finally {
    activeExecutors.delete(taskId);
    emitMarathonTelemetry("marathon_loop_stopped", { taskId, sessionKey });
  }
}

// ── Marathon Completion ─────────────────────────────────────────────

async function onMarathonComplete(
  taskId: string,
  sessionKey: string,
  checkpoint: MarathonCheckpoint,
  deps: MarathonDeps,
  watchdogJobId?: string,
): Promise<void> {
  logger.info(`Marathon completed: task=${taskId}`);
  emitMarathonTelemetry("marathon_completed", {
    taskId,
    sessionKey,
    completedChunks: checkpoint.completedChunks.length,
  });

  // Remove watchdog cron job
  if (watchdogJobId && deps.cronService) {
    deps.cronService.remove(watchdogJobId);
  }

  // Try deliverables manifest first, then auto-detect, then fall back to full workspace ZIP
  const deliverableMedia = await packageDeliverables(
    checkpoint.workspaceDir,
    taskId,
    checkpoint.inputFiles,
  );

  const deliveredNames = deliverableMedia
    .map((item) => item.filename)
    .filter((name): name is string => Boolean(name))
    .slice(0, 5);
  const text = buildMarathonCompletionText({
    taskId,
    completedChunks: checkpoint.completedChunks,
    deliveredNames,
  });

  await deliverMarathonPayload({
    text,
    media: deliverableMedia,
    target: checkpoint.deliverTo,
    deps,
    emitTelemetry: emitMarathonTelemetry,
    context: {
      taskId,
      reason: "completion",
    },
  });

  // Keep container alive for post-completion inspection
  if (deps.containerManager) {
    deps.containerManager.setRetention(sessionKey, deps.config.marathon.completionRetentionMs);
  }
}

// ── Resume / Cancel / Status ────────────────────────────────────────

/** Resume a paused or stalled marathon from its last checkpoint. */
export async function resumeMarathon(taskId: string, deps: MarathonDeps): Promise<void> {
  if (activeExecutors.has(taskId)) {
    throw new Error(`Marathon ${taskId} is already running`);
  }

  const checkpoint = await readCheckpoint(taskId);
  if (!checkpoint) {
    throw new Error(`Marathon not found: ${taskId}`);
  }

  if (checkpoint.status !== "paused" && checkpoint.status !== "executing") {
    throw new Error(`Marathon ${taskId} is ${checkpoint.status}, cannot resume`);
  }

  // Reattach container if needed
  if (deps.containerManager && checkpoint.containerId) {
    const alive = await deps.containerManager.reattach(
      checkpoint.containerId,
      checkpoint.sessionKey,
      checkpoint.workspaceDir,
    );
    if (!alive) {
      logger.info(`Container dead, recreating for marathon ${taskId}`);
      const containerSession = await deps.containerManager.getOrCreate(
        checkpoint.sessionKey,
        checkpoint.workspaceDir,
      );
      deps.containerManager.promote(checkpoint.sessionKey);
      await patchCheckpoint(taskId, { containerId: containerSession.containerId });
    }
  }

  // Reset per-chunk failedAttempts so the resumed chunk gets a fresh retry budget.
  if (checkpoint.status === "paused") {
    await resetCurrentChunkRetries(taskId);
  }
  await updateCheckpointStatus(taskId, "executing");
  emitMarathonTelemetry("marathon_execution_resumed", {
    taskId,
    sessionKey: checkpoint.sessionKey,
    source: checkpoint.status,
  });

  // Assemble scoped tools for resumed chunk agents
  const chunkTools = buildMarathonChunkTools({
    config: deps.config,
    containerManager: deps.containerManager,
    taskId,
    sessionKey: checkpoint.sessionKey,
    workspaceDir: checkpoint.workspaceDir,
  });

  // Resume the chunk loop
  runChunkLoop(
    taskId,
    checkpoint.sessionKey,
    checkpoint.workspaceDir,
    {
      prompt: "",
      originSessionKey: checkpoint.originSessionKey,
      deliveryTarget: checkpoint.deliverTo,
      channel: checkpoint.deliverTo.channel,
      senderName: "system",
    },
    deps,
    chunkTools,
    checkpoint.watchdogJobId,
  ).catch((err) => {
    logger.error(`Resume marathon failed (task=${taskId}): ${err}`);
    const msg = err instanceof Error ? err.message : String(err);
    emitMarathonTelemetry("marathon_resume_failed", {
      taskId,
      sessionKey: checkpoint.sessionKey,
      error: msg,
    });
  });
}

/** Cancel a marathon task. */
export async function cancelMarathon(taskId: string, deps: MarathonDeps): Promise<void> {
  const checkpoint = await readCheckpoint(taskId);
  if (!checkpoint) {
    throw new Error(`Marathon not found: ${taskId}`);
  }

  planningExecutors.delete(taskId);
  await cancelCheckpoint(taskId);
  emitMarathonTelemetry("marathon_cancelled", {
    taskId,
    sessionKey: checkpoint.sessionKey,
  });

  const executor = activeExecutors.get(taskId);
  if (executor) {
    executor.abortController.abort();
  }

  if (checkpoint.watchdogJobId && deps.cronService) {
    deps.cronService.remove(checkpoint.watchdogJobId);
  }

  if (deps.containerManager) {
    await deps.containerManager.stop(checkpoint.sessionKey);
  }

  logger.info(`Marathon cancelled: task=${taskId}`);
}

/** Get all marathon checkpoints (for status queries). */
export async function getMarathonStatus(): Promise<MarathonCheckpoint[]> {
  return listCheckpoints();
}

/** Check if an executor loop is alive for the given task. */
export function isExecutorAlive(taskId: string): boolean {
  return activeExecutors.has(taskId);
}

/** @internal Test-only helper to clear in-memory marathon runtime state. */
export function __resetMarathonRuntimeStateForTests(): void {
  for (const executor of activeExecutors.values()) {
    executor.abortController.abort();
  }
  activeExecutors.clear();
  planningExecutors.clear();
}

async function deliverText(
  text: string,
  target: DeliveryTarget,
  deps: MarathonDeps,
  context?: { taskId?: string; reason?: string },
): Promise<void> {
  await deliverMarathonPayload({
    text,
    media: [],
    target,
    deps,
    emitTelemetry: emitMarathonTelemetry,
    context,
  });
}

// ── Utilities ───────────────────────────────────────────────────────

// Re-export for backward compatibility
export { parsePlanFromResult } from "./marathon-prompts.js";
export { formatFileSize } from "./marathon-prompts.js";
export { seedWorkspaceMedia } from "./marathon-media.js";
export {
  autoDetectDeliverables,
  isManifestDeliverablePath,
  selectProgressArtifacts,
} from "./marathon-artifacts.js";

function emitMarathonTelemetry(event: string, metadata: Record<string, unknown>): void {
  logProductTelemetry({
    area: "marathon",
    event,
    ...metadata,
  });
}
