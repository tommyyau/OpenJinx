import fs from "node:fs/promises";
import type { AgentToolDefinition } from "../providers/types.js";
import type { DeliveryTarget } from "../types/marathon.js";
import type { LaunchMarathonParams, MarathonDeps } from "./marathon.js";
import { runAgent } from "../agents/runner.js";
import { createLogger } from "../infra/logger.js";
import { SECURE_DIR_MODE } from "../infra/security.js";
import { withTimeout } from "../infra/timeout.js";
import { createSessionEntry } from "../sessions/store.js";
import { resolveTranscriptPath } from "../sessions/transcript.js";
import {
  createCheckpoint,
  patchCheckpoint,
  resolveMarathonWorkspace,
  updateCheckpointStatus,
} from "./checkpoint.js";
import { buildControlPolicy } from "./marathon-control.js";
import { seedWorkspaceMedia } from "./marathon-media.js";
import {
  buildPlanningPrompt,
  buildPlanningRepairPrompt,
  parsePlanFromResult,
} from "./marathon-prompts.js";
import { buildMarathonChunkTools } from "./marathon-tools.js";

const logger = createLogger("marathon");

export interface BootstrapMarathonExecutionParams {
  taskId: string;
  sessionKey: string;
  shortId: string;
  launchParams: LaunchMarathonParams;
  deps: MarathonDeps;
  planningTimeoutMs: number;
  emitTelemetry: (event: string, metadata: Record<string, unknown>) => void;
  deliverText: (
    text: string,
    target: DeliveryTarget,
    deps: MarathonDeps,
    context?: { taskId?: string; reason?: string },
  ) => Promise<void>;
}

export interface MarathonBootstrapResult {
  workspaceDir: string;
  chunkTools: AgentToolDefinition[];
  watchdogJobId?: string;
}

export async function bootstrapMarathonExecution({
  taskId,
  sessionKey,
  shortId,
  launchParams,
  deps,
  planningTimeoutMs,
  emitTelemetry,
  deliverText,
}: BootstrapMarathonExecutionParams): Promise<MarathonBootstrapResult | undefined> {
  const { config, sessions, containerManager } = deps;
  const marathonConfig = config.marathon;

  const workspaceDir = resolveMarathonWorkspace(shortId);
  await fs.mkdir(workspaceDir, { recursive: true, mode: SECURE_DIR_MODE });

  const inputFiles = await seedWorkspaceMedia(workspaceDir, launchParams.media);

  const transcriptPath = resolveTranscriptPath(sessionKey);
  const session = createSessionEntry({
    sessionKey,
    agentId: "default",
    channel: launchParams.deliveryTarget.channel,
    transcriptPath,
    parentSessionKey: launchParams.originSessionKey,
  });
  sessions.set(sessionKey, session);

  let containerId = "";
  if (containerManager) {
    const containerSession = await containerManager.getOrCreate(sessionKey, workspaceDir);
    containerManager.promote(sessionKey);
    containerId = containerSession.containerId;
  }

  logger.info(`Marathon planning: task=${taskId}`);
  emitTelemetry("marathon_planning_started", { taskId, sessionKey });
  const planResult = await withTimeout(
    runAgent({
      prompt: buildPlanningPrompt(launchParams.prompt, marathonConfig.maxChunks, inputFiles),
      sessionKey,
      sessionType: "main",
      tier: "brain",
      transcriptPath,
      config,
      sessions,
      tools: [],
      channel: launchParams.channel,
      senderName: launchParams.senderName,
      workspaceDir,
    }),
    planningTimeoutMs,
    `Marathon planning timed out after ${planningTimeoutMs / 1000}s`,
  );

  let plan = parsePlanFromResult(planResult.text);
  if (!plan || plan.chunks.length === 0) {
    emitTelemetry("marathon_plan_repair_started", {
      taskId,
      sessionKey,
      reason: "invalid-initial-plan",
    });

    try {
      const repairedResult = await withTimeout(
        runAgent({
          prompt: buildPlanningRepairPrompt(
            launchParams.prompt,
            marathonConfig.maxChunks,
            planResult.text,
            inputFiles,
          ),
          sessionKey,
          sessionType: "main",
          tier: "brain",
          transcriptPath,
          config,
          sessions,
          tools: [],
          channel: launchParams.channel,
          senderName: launchParams.senderName,
          workspaceDir,
        }),
        planningTimeoutMs,
        `Marathon plan repair timed out after ${planningTimeoutMs / 1000}s`,
      );
      plan = parsePlanFromResult(repairedResult.text);
      if (plan && plan.chunks.length > 0) {
        emitTelemetry("marathon_plan_repair_succeeded", {
          taskId,
          sessionKey,
          chunkCount: plan.chunks.length,
        });
      } else {
        emitTelemetry("marathon_plan_repair_failed", {
          taskId,
          sessionKey,
          reason: "invalid-repair-plan",
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emitTelemetry("marathon_plan_repair_failed", {
        taskId,
        sessionKey,
        reason: "repair-turn-error",
        error: msg,
      });
      logger.warn(`Marathon plan repair failed for task=${taskId}: ${msg}`);
    }
  }

  if (!plan || plan.chunks.length === 0) {
    emitTelemetry("marathon_planning_failed", {
      taskId,
      sessionKey,
      reason: "empty_plan",
    });
    await deliverText(
      `Marathon planning failed: could not produce a valid chunk plan after automatic repair.\n\n` +
        `Try re-running with a more concrete request (deliverables, tech stack, constraints).\n\n` +
        `Raw planner response (truncated):\n\n${planResult.text.slice(0, 500)}`,
      launchParams.deliveryTarget,
      deps,
      { taskId, reason: "planning-failed" },
    );
    return undefined;
  }

  if (plan.chunks.length > marathonConfig.maxChunks) {
    plan.chunks = plan.chunks.slice(0, marathonConfig.maxChunks);
  }
  emitTelemetry("marathon_plan_ready", {
    taskId,
    sessionKey,
    chunkCount: plan.chunks.length,
  });

  await createCheckpoint({
    taskId,
    sessionKey,
    containerId,
    plan,
    deliverTo: launchParams.deliveryTarget,
    workspaceDir,
    originSessionKey: launchParams.originSessionKey,
    originSenderId: launchParams.senderId,
    controlPolicy: buildControlPolicy(launchParams, config),
    maxRetriesPerChunk: marathonConfig.maxRetriesPerChunk,
    inputFiles: inputFiles.length > 0 ? inputFiles : undefined,
  });

  let watchdogJobId: string | undefined;
  if (deps.cronService) {
    try {
      const watchdogJob = deps.cronService.add({
        name: `marathon-watchdog:${taskId}`,
        schedule: { type: "every", intervalMs: 5 * 60_000 },
        payload: {
          prompt: "watchdog",
          isolated: true,
          marathonWatchdog: { taskId },
        },
        target: { agentId: "default" },
      });
      watchdogJobId = watchdogJob.id;
      await patchCheckpoint(taskId, { watchdogJobId });
    } catch (err) {
      logger.warn(`Failed to create watchdog cron: ${err}`);
    }
  }

  await updateCheckpointStatus(taskId, "executing");
  emitTelemetry("marathon_execution_resumed", {
    taskId,
    sessionKey,
    source: "launch",
  });

  const planSummary = plan.chunks
    .map((chunk, i) => `${i + 1}. **${chunk.name}** (~${chunk.estimatedMinutes}min)`)
    .join("\n");
  await deliverText(
    `Marathon plan for \`${taskId}\`:\n\n${planSummary}\n\nStarting execution...`,
    launchParams.deliveryTarget,
    deps,
    { taskId, reason: "plan-summary" },
  );

  const chunkTools = buildMarathonChunkTools({
    config,
    containerManager,
    taskId,
    sessionKey,
    workspaceDir,
  });

  return {
    workspaceDir,
    chunkTools,
    watchdogJobId,
  };
}
