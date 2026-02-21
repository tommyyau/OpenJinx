import type { AgentToolDefinition } from "../providers/types.js";
import type { MarathonCheckpoint } from "../types/marathon.js";
import type { DeliveryTarget } from "../types/marathon.js";
import type { LaunchMarathonParams, MarathonDeps } from "./marathon.js";
import { createLogger } from "../infra/logger.js";
import { resolveTranscriptPath } from "../sessions/transcript.js";
import {
  readCheckpoint,
  updateCheckpointStatus,
  advanceCheckpoint,
  failChunk,
  pauseCheckpoint,
} from "./checkpoint.js";
import {
  buildWorkspaceSnapshot,
  listFilesRecursive,
  writeProgressFile,
} from "./marathon-context.js";
import { sendMarathonProgressUpdate } from "./marathon-delivery.js";
import { buildChunkPrompt, buildCriteriaRetryPrompt } from "./marathon-prompts.js";
import {
  isAbortError,
  runAgentWithAbort,
  sleep,
  throwIfAborted,
  withAbort,
} from "./marathon-runtime.js";
import { runTestFixLoop, verifyAcceptanceCriteria } from "./marathon-test-loop.js";

const logger = createLogger("marathon");

function assertValidChunkDefinition(
  chunk: MarathonCheckpoint["plan"]["chunks"][number] | undefined,
  taskId: string,
  chunkIndex: number,
): asserts chunk is MarathonCheckpoint["plan"]["chunks"][number] {
  if (!chunk) {
    throw new Error(`Marathon ${taskId} has no chunk at index ${chunkIndex}`);
  }
  if (!Array.isArray(chunk.acceptanceCriteria)) {
    throw new Error(
      `Marathon ${taskId} plan invalid at chunk "${chunk.name}": acceptanceCriteria must be an array`,
    );
  }
}

export interface RunMarathonExecutionLoopParams {
  taskId: string;
  sessionKey: string;
  workspaceDir: string;
  params: LaunchMarathonParams;
  deps: MarathonDeps;
  chunkTools: AgentToolDefinition[];
  abortSignal: AbortSignal;
  chunkTimeoutMs: number;
  watchdogJobId?: string;
  onMarathonComplete: (
    taskId: string,
    sessionKey: string,
    checkpoint: MarathonCheckpoint,
    deps: MarathonDeps,
    watchdogJobId?: string,
  ) => Promise<void>;
  deliverText: (
    text: string,
    target: DeliveryTarget,
    deps: MarathonDeps,
    context?: { taskId?: string; reason?: string },
  ) => Promise<void>;
  emitTelemetry: (event: string, metadata: Record<string, unknown>) => void;
}

export async function runMarathonExecutionLoop({
  taskId,
  sessionKey,
  workspaceDir,
  params,
  deps,
  chunkTools,
  abortSignal,
  chunkTimeoutMs,
  watchdogJobId,
  onMarathonComplete,
  deliverText,
  emitTelemetry,
}: RunMarathonExecutionLoopParams): Promise<void> {
  const { config, sessions, containerManager } = deps;
  const marathonConfig = config.marathon;
  const startTime = Date.now();

  while (true) {
    if (abortSignal.aborted) {
      emitTelemetry("marathon_loop_aborted", { taskId, sessionKey });
      break;
    }

    const checkpoint = await readCheckpoint(taskId);
    if (!checkpoint || checkpoint.status !== "executing") {
      break;
    }

    const elapsed = (Date.now() - startTime) / (1000 * 60 * 60);
    if (elapsed > marathonConfig.maxDurationHours) {
      await updateCheckpointStatus(taskId, "failed");
      await deliverText(
        `Marathon \`${taskId}\` exceeded max duration (${marathonConfig.maxDurationHours}h). Pausing.`,
        checkpoint.deliverTo,
        deps,
        { taskId, reason: "duration-exceeded" },
      );
      emitTelemetry("marathon_failed", {
        taskId,
        sessionKey,
        reason: "duration-exceeded",
        maxDurationHours: marathonConfig.maxDurationHours,
      });
      break;
    }

    if (checkpoint.currentChunkIndex >= checkpoint.plan.chunks.length) {
      break;
    }

    if (checkpoint.currentChunkIndex >= marathonConfig.maxChunks) {
      await updateCheckpointStatus(taskId, "failed");
      await deliverText(
        `Marathon \`${taskId}\` exceeded max chunks (${marathonConfig.maxChunks}).`,
        checkpoint.deliverTo,
        deps,
        { taskId, reason: "max-chunks-exceeded" },
      );
      emitTelemetry("marathon_failed", {
        taskId,
        sessionKey,
        reason: "max-chunks-exceeded",
        maxChunks: marathonConfig.maxChunks,
      });
      break;
    }

    const chunk = checkpoint.plan.chunks[checkpoint.currentChunkIndex];
    const chunkIndex = checkpoint.currentChunkIndex;
    assertValidChunkDefinition(chunk, taskId, chunkIndex);
    const acceptanceCriteria = chunk.acceptanceCriteria;
    logger.info(
      `Marathon chunk ${chunkIndex + 1}/${checkpoint.plan.chunks.length}: ${chunk.name} (task=${taskId})`,
    );
    emitTelemetry("marathon_chunk_started", {
      taskId,
      sessionKey,
      chunkIndex,
      chunkName: chunk.name,
    });

    const snapshot =
      chunkIndex > 0
        ? await buildWorkspaceSnapshot(workspaceDir, marathonConfig.context)
        : undefined;

    const isLastChunk = chunkIndex === checkpoint.plan.chunks.length - 1;
    const chunkPrompt = buildChunkPrompt(checkpoint, chunk, isLastChunk, snapshot);
    const chunkStartMs = Date.now();

    const chunkSessionKey = `${sessionKey}:chunk-${chunkIndex}`;
    const chunkTranscriptPath = resolveTranscriptPath(chunkSessionKey);

    try {
      const session = sessions.get(sessionKey);
      if (session) {
        session.lastActiveAt = Date.now();
      }

      const result = await runAgentWithAbort(
        {
          prompt: chunkPrompt,
          sessionKey: chunkSessionKey,
          sessionType: "main",
          tier: "subagent",
          transcriptPath: chunkTranscriptPath,
          config,
          sessions,
          tools: chunkTools,
          channel: params.channel,
          senderName: params.senderName,
          workspaceDir,
        },
        abortSignal,
        chunkTimeoutMs,
        `Marathon chunk "${chunk.name}" timed out after ${chunkTimeoutMs / 1000}s`,
        `Marathon ${taskId} cancelled during chunk "${chunk.name}"`,
      );
      throwIfAborted(
        abortSignal,
        `Marathon ${taskId} cancelled while processing chunk "${chunk.name}"`,
      );

      const filesWritten = await listFilesRecursive(workspaceDir);
      if (filesWritten.length === 0) {
        throw new Error(
          `Chunk "${chunk.name}" completed but produced no files in workspace. Retrying.`,
        );
      }

      let testStatus;
      if (marathonConfig.testFix.enabled && containerManager) {
        testStatus = await withAbort(
          runTestFixLoop({
            chunkName: chunk.name,
            sessionKey,
            workspaceDir,
            containerManager,
            config,
            testFixConfig: marathonConfig.testFix,
            sessions,
            chunkTools,
            channel: params.channel,
            senderName: params.senderName,
          }),
          abortSignal,
          `Marathon ${taskId} cancelled during test-fix loop for "${chunk.name}"`,
        );
        throwIfAborted(
          abortSignal,
          `Marathon ${taskId} cancelled during test-fix loop for "${chunk.name}"`,
        );

        if (testStatus && !testStatus.testsPassed) {
          throw new Error(
            `Chunk "${chunk.name}" failed test-fix loop after ${testStatus.fixIterations} attempts.`,
          );
        }
      }

      let criteriaResult;
      const maxCriteriaRetries = marathonConfig.testFix.maxIterations;

      if (acceptanceCriteria.length > 0) {
        criteriaResult = await verifyAcceptanceCriteria({
          criteria: acceptanceCriteria,
          workspaceDir,
          containerManager,
          sessionKey,
        });

        for (
          let attempt = 1;
          !criteriaResult.allPassed && attempt <= maxCriteriaRetries;
          attempt++
        ) {
          logger.info(
            `Criteria check: ${criteriaResult.passCount}/${criteriaResult.results.length} passed for "${chunk.name}", retry ${attempt}/${maxCriteriaRetries}`,
          );
          emitTelemetry("marathon_chunk_criteria_retry", {
            taskId,
            sessionKey,
            chunkIndex,
            chunkName: chunk.name,
            retryAttempt: attempt,
            maxRetries: maxCriteriaRetries,
            passCount: criteriaResult.passCount,
            failCount: criteriaResult.failCount,
          });

          const retrySnapshot = await buildWorkspaceSnapshot(workspaceDir, marathonConfig.context);
          const retryPrompt = buildCriteriaRetryPrompt(
            chunk.name,
            chunk.prompt,
            criteriaResult.results.filter((r) => r.passed).map((r) => r.criterion),
            criteriaResult.results
              .filter((r) => !r.passed)
              .map((r) => ({ criterion: r.criterion, detail: r.detail })),
            attempt,
            maxCriteriaRetries,
            retrySnapshot,
          );

          const retrySessionKey = `${sessionKey}:chunk-${chunkIndex}:retry-${attempt}`;
          const retryTranscriptPath = resolveTranscriptPath(retrySessionKey);

          await runAgentWithAbort(
            {
              prompt: retryPrompt,
              sessionKey: retrySessionKey,
              sessionType: "main",
              tier: "subagent",
              transcriptPath: retryTranscriptPath,
              config,
              sessions,
              tools: chunkTools,
              channel: params.channel,
              senderName: params.senderName,
              workspaceDir,
            },
            abortSignal,
            chunkTimeoutMs,
            `Criteria retry ${attempt} for "${chunk.name}" timed out`,
            `Marathon ${taskId} cancelled during criteria retry ${attempt} for "${chunk.name}"`,
          );
          throwIfAborted(
            abortSignal,
            `Marathon ${taskId} cancelled during criteria verification for "${chunk.name}"`,
          );

          criteriaResult = await verifyAcceptanceCriteria({
            criteria: acceptanceCriteria,
            workspaceDir,
            containerManager,
            sessionKey,
          });
        }

        if (criteriaResult.allPassed) {
          logger.info(`All ${criteriaResult.passCount} criteria passed for "${chunk.name}"`);
        } else {
          logger.warn(
            `Criteria incomplete for "${chunk.name}": ${criteriaResult.passCount}/${criteriaResult.results.length} passed after ${maxCriteriaRetries} retries`,
          );
        }
      }

      const chunkResult = {
        chunkName: chunk.name,
        status: "completed" as const,
        summary: result.text.slice(0, 500),
        filesWritten,
        durationMs: Date.now() - chunkStartMs,
        completedAt: Date.now(),
        failedAttempts: 0,
        testStatus: testStatus ?? undefined,
        criteriaResult: criteriaResult ?? undefined,
      };

      await writeProgressFile(workspaceDir, checkpoint, chunkResult);

      const updated = await advanceCheckpoint(taskId, chunkResult);
      emitTelemetry("marathon_chunk_completed", {
        taskId,
        sessionKey,
        chunkIndex,
        chunkName: chunk.name,
        durationMs: chunkResult.durationMs,
        filesWritten: filesWritten.length,
      });

      if ((chunkIndex + 1) % marathonConfig.progress.notifyEveryNChunks === 0) {
        await sendMarathonProgressUpdate(updated, deps, emitTelemetry);
      }

      if (updated.status === "completed") {
        await onMarathonComplete(taskId, sessionKey, updated, deps, watchdogJobId);
        return;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isAbortError(err, abortSignal)) {
        logger.info(`Marathon aborted: task=${taskId}`);
        emitTelemetry("marathon_loop_aborted", { taskId, sessionKey });
        break;
      }

      logger.error(`Chunk failed: ${chunk.name} (task=${taskId}): ${errMsg}`);
      emitTelemetry("marathon_chunk_failed", {
        taskId,
        sessionKey,
        chunkIndex,
        chunkName: chunk.name,
        error: errMsg,
      });

      if (errMsg.includes("authentication_error") || errMsg.includes("401")) {
        await pauseCheckpoint(taskId);
        emitTelemetry("marathon_paused", {
          taskId,
          sessionKey,
          reason: "authentication_error",
        });
        await deliverText(
          `Marathon \`${taskId}\` paused: authentication error. Your Claude token has expired.\n\n` +
            `**Fix:** Add \`ANTHROPIC_API_KEY=sk-ant-...\` to \`~/.jinx/.env\` for a non-expiring credential.\n` +
            `Create an API key at https://console.anthropic.com/settings/keys\n\n` +
            `Then resume: \`/marathon resume ${taskId}\``,
          checkpoint.deliverTo,
          deps,
          { taskId, reason: "auth-pause" },
        );
        break;
      }

      const updated = await failChunk(taskId, errMsg);
      if (updated.status === "paused") {
        emitTelemetry("marathon_paused", {
          taskId,
          sessionKey,
          reason: "chunk-retries-exhausted",
          chunkName: chunk.name,
        });
        await deliverText(
          `Marathon \`${taskId}\` paused: chunk "${chunk.name}" failed after ${updated.maxRetriesPerChunk} attempts.\nLast error: ${errMsg}\n\nUse \`/marathon resume ${taskId}\` to retry.`,
          updated.deliverTo,
          deps,
          { taskId, reason: "retry-exhausted-pause" },
        );
        break;
      }
    }

    if (marathonConfig.chunkIntervalMs > 0) {
      await sleep(marathonConfig.chunkIntervalMs, abortSignal);
    }
  }
}
