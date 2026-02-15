# PRD: Marathon Agent — Overnight Autonomous Coding

> **Status:** Draft
> **Author:** Product + AI Lead
> **Created:** 2026-02-15
> **Priority:** P0 — Primary product differentiator

---

## Vision

"Tell Jinx to build you an application. Go to sleep. Wake up to a working codebase."

Marathon Agent transforms Jinx from a conversational assistant into an autonomous
software factory. Long-running tasks (30 min to 12+ hours) execute inside persistent
Apple Container sandboxes, with checkpoint/resume, progress reporting, and multi-agent
orchestration.

---

## Problem Statement

Today's ceiling is **15 minutes** — the deep work timeout. Three constraints collide:

1. **Deep work timeout**: 15 min hard cap (`DEEP_WORK_TIMEOUT_MS`)
2. **Container idle eviction**: 15 min of no `exec` calls → container destroyed
3. **No checkpoint/resume**: If a turn fails or times out, all progress since last
   filesystem write is lost

For a task like "build me a full-stack todo app," these limits mean the agent can
scaffold but can't iterate, test, fix, and polish.

---

## Solution Overview

### New Pipeline Mode: `marathon`

The classifier gains a third category alongside `quick` and `deep`:

- **quick** (< 1 min): Simple responses, greetings, lookups
- **deep** (1-15 min): Research, code generation, multi-step tasks
- **marathon** (15 min - 12 hours): Application building, large refactors, multi-file generation with testing

### Architecture

```
User: "Build me a full-stack todo app with React, Express, SQLite."

┌──────────────────────────────────────────────────────────────┐
│ 1. Classifier → "marathon"                                   │
│    (Haiku: "multi-file app generation, testing, iteration")  │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│ 2. Planning Turn (brain tier — Opus)                         │
│    - Decomposes task into ordered chunks                     │
│    - Estimates chunk count                                   │
│    - Creates persistent container with resource allocation   │
│    - Writes initial checkpoint                               │
│    - Creates cron job for chunk execution                    │
└──────────────────────────────────────────────────────────────┘
                              ↓
┌──────────────────────────────────────────────────────────────┐
│ 3. Chunk Execution (cron job, every N minutes)               │
│    - Read checkpoint → determine current chunk               │
│    - Execute chunk as agent turn (subagent tier — Sonnet)    │
│    - Agent has full tool access inside persistent container  │
│    - Write updated checkpoint + progress                     │
│    - Send progress update to user's channel                  │
│    - Schedule next chunk (or mark DONE)                      │
└──────────────────────────────────────────────────────────────┘
                              ↓
                      (Repeats N times)
                              ↓
┌──────────────────────────────────────────────────────────────┐
│ 4. Completion                                                │
│    - Final integration test pass                             │
│    - Generate README.md with setup instructions              │
│    - Package artifacts                                       │
│    - Deliver to user with summary + file attachments         │
│    - Destroy container (or keep alive per config)            │
└──────────────────────────────────────────────────────────────┘
```

---

## Components

### 1. Persistent Container Lifecycle

**Current**: Containers evict after 15 min idle.
**New**: Marathon containers use `lifecycle: "persistent"` — no idle eviction.

Changes to `container-manager.ts`:

- Add `lifecycle` field to `ManagedContainer`: `"ephemeral"` (default, current behavior) | `"persistent"`
- `sweepIdle()` skips containers with `lifecycle: "persistent"`
- New method: `promote(sessionKey)` — marks an existing container as persistent
- New method: `demote(sessionKey)` — returns container to ephemeral (idle eviction resumes)
- Pass `--cpus` and `--memory` flags from config (`SandboxConfig` gains `cpus?: number` and `memoryGB?: number`)
- New method: `inspect(sessionKey)` — returns container stats (alive, uptime, disk)

**Resource defaults for marathon containers:**

- CPUs: 4 (configurable)
- Memory: 4GB (configurable, up from default 1GB)
- Command timeout: 10 min per exec (up from 5 min)

### 2. Checkpoint Framework

**New file**: `src/pipeline/checkpoint.ts`

```typescript
interface MarathonCheckpoint {
  taskId: string;
  sessionKey: string;
  containerId: string;
  status: "planning" | "executing" | "paused" | "completed" | "failed";
  plan: ChunkPlan;
  currentChunkIndex: number;
  completedChunks: ChunkResult[];
  failedAttempts: number;
  maxRetries: number; // default: 3 per chunk
  createdAt: number;
  updatedAt: number;
  deliverTo: DeliveryTarget; // where to send progress + final result
}

interface ChunkPlan {
  description: string; // high-level task description
  chunks: ChunkDefinition[];
  estimatedTotalMinutes: number;
}

interface ChunkDefinition {
  name: string; // e.g. "scaffold", "backend-api", "frontend"
  prompt: string; // full prompt for the agent turn
  dependsOn: string[]; // chunk names that must complete first
  estimatedMinutes: number;
}

interface ChunkResult {
  chunkName: string;
  status: "completed" | "failed" | "skipped";
  summary: string; // agent's summary of what it did
  filesWritten: string[]; // paths written in this chunk
  durationMs: number;
  completedAt: number;
}
```

**Storage**: `~/.jinx/marathon/{taskId}.json`

**Operations**:

- `createCheckpoint(task, plan, deliverTo)` → writes initial checkpoint
- `readCheckpoint(taskId)` → reads current state
- `advanceCheckpoint(taskId, result)` → marks chunk complete, advances index
- `failCheckpoint(taskId, error)` → increments failedAttempts, pauses if max retries hit
- `listCheckpoints()` → all active/paused marathon tasks
- `cancelCheckpoint(taskId)` → marks cancelled, triggers container cleanup

### 3. Marathon Executor

**New file**: `src/pipeline/marathon.ts`

Orchestrates the full marathon lifecycle:

1. **`launchMarathon(params)`**: Entry point from dispatch
   - Creates persistent container
   - Runs planning turn (Opus) to decompose task into chunks
   - Writes initial checkpoint
   - Creates cron job with `mode: "marathon-chunk"`
   - Sends ack to user: "Starting marathon task: {description}. {N} chunks planned, estimated {M} minutes."

2. **`executeChunk(taskId)`**: Called by cron executor
   - Read checkpoint
   - If `status !== "executing"`, skip (paused/completed/failed)
   - Get current chunk from plan
   - Run agent turn with chunk prompt + context from previous chunks
   - Agent has access to persistent container (install deps, run tests, etc.)
   - On success: advance checkpoint, send progress update
   - On failure: increment retries, retry or pause
   - On final chunk complete: run integration pass, deliver result

3. **`resumeMarathon(taskId)`**: Resume a paused marathon
   - Reads checkpoint, validates container still alive
   - If container dead, recreates from workspace files (they survived on host mount)
   - Restarts cron job

### 4. Cron Integration

Extend `CronPayload` with marathon mode:

```typescript
interface CronPayload {
  prompt: string;
  mode?: "standard" | "marathon-chunk";
  marathonTaskId?: string; // for marathon-chunk mode
}
```

When `mode === "marathon-chunk"`:

- Executor calls `executeChunk(marathonTaskId)` instead of generic `runTurn()`
- Chunk execution interval: configurable, default 2 minutes between chunks
  (not 15 — chunks should start as soon as the previous one finishes)

### 5. Progress Reporting

After each chunk:

- Send to user's channel: `"[Marathon: {taskName}] Chunk {N}/{total} complete: {summary}"`
- Include timing: `"({duration}s, {elapsed} elapsed, ~{remaining} remaining)"`

On failure:

- Send: `"[Marathon: {taskName}] Chunk {N} failed (attempt {K}/{max}): {error}"`

On completion:

- Send full summary + file attachments (like deep work delivery)

### 6. Agent Tools for Marathon Context

New tools available during marathon chunks:

- **`marathon_status`**: Read current checkpoint (what chunks are done, what's next)
- **`marathon_plan_update`**: Revise the remaining plan (add/remove/reorder chunks)
  if the agent discovers the plan needs adjustment mid-execution

Existing tools that matter:

- `exec`: Runs commands in the persistent container
- `write` / `read_file`: Workspace files persist across chunks via host mount
- `memory_search`: Access to user's memory for preferences, patterns
- `web_search` / `web_fetch`: Research during execution

### 7. User Controls

Via chat commands during a marathon:

- `/marathon status` — Show all active marathon tasks with progress
- `/marathon pause {taskId}` — Pause execution (cron job stops, container stays alive)
- `/marathon resume {taskId}` — Resume paused marathon
- `/marathon cancel {taskId}` — Cancel and clean up (destroys container)
- `/marathon logs {taskId}` — Show chunk-by-chunk execution log

---

## Key Design Decisions

### Why Cron-Based Chunks (Not One Long Turn)?

1. **Resilience**: Each chunk is an independent agent turn. If the process crashes,
   the checkpoint survives and chunks resume on restart.
2. **Observability**: Progress updates after each chunk. User sees what's happening.
3. **Course correction**: Agent can revise the plan mid-execution based on discoveries.
4. **Resource efficiency**: Each chunk gets a fresh context window. No risk of
   blowing the token limit on a 6-hour task.
5. **Interruptibility**: User can pause/cancel between chunks.

### Why Not Parallel Subagents (Yet)?

Phase 1 is sequential chunks. Parallel subagents are Phase 2 because:

- Sequential is simpler to debug and test
- Most app-building tasks have natural dependencies (backend before frontend)
- Parallel introduces merge conflicts and coordination complexity
- Get the checkpoint/resume right first, then parallelize

### Workspace Mount = Persistence

Files written to `/workspace` inside the container persist on the host mount.
Even if the container dies, the workspace survives. This means:

- Container restart doesn't lose code
- `git init` + commits inside the container provide version history
- Final artifacts are already on host disk for delivery

### Container Resource Sizing

Default for marathon: 4 CPUs, 4GB RAM. Apple Containers use VM-per-container
isolation, so each container has real resource overhead. For a single marathon
task this is fine. If running multiple concurrent marathons, resource monitoring
becomes important (future work).

---

## Test Strategy — Spec-Driven Development

Tests are written FIRST. Implementation is not done until all tests pass.

### Unit Tests

**`src/pipeline/checkpoint.test.ts`** — Checkpoint CRUD:

```
- creates checkpoint with valid plan
- reads checkpoint returns current state
- advanceCheckpoint moves to next chunk
- advanceCheckpoint on final chunk sets status to "completed"
- failCheckpoint increments failedAttempts
- failCheckpoint pauses after maxRetries exceeded
- cancelCheckpoint sets status to "cancelled"
- listCheckpoints returns only active/paused tasks
- checkpoint survives JSON round-trip (serialize/deserialize)
- rejects advance on completed/cancelled checkpoint
```

**`src/pipeline/marathon.test.ts`** — Marathon orchestration:

```
- launchMarathon creates persistent container
- launchMarathon runs planning turn and writes checkpoint
- launchMarathon creates cron job with marathon-chunk mode
- launchMarathon sends ack message to user channel
- executeChunk reads checkpoint and runs agent turn
- executeChunk advances checkpoint on success
- executeChunk sends progress update after each chunk
- executeChunk retries on failure up to maxRetries
- executeChunk pauses marathon after max retries exceeded
- executeChunk skips if marathon is paused/completed/cancelled
- executeChunk delivers final result on last chunk completion
- resumeMarathon restarts cron job from current checkpoint
- resumeMarathon recreates container if dead (workspace survives)
- cancelMarathon stops cron job and destroys container
```

**`src/pipeline/classifier.test.ts`** — Extended classifier:

```
- classifies "build me a full-stack app" as marathon
- classifies "create a REST API with tests" as marathon
- classifies multi-file generation requests as marathon
- classifies "refactor the entire module" as marathon
- still classifies "what time is it" as quick
- still classifies "write a function that..." as deep
```

**`src/sandbox/container-manager.test.ts`** — Extended lifecycle:

```
- persistent containers are not evicted by sweepIdle
- promote() changes lifecycle from ephemeral to persistent
- demote() changes lifecycle from persistent to ephemeral
- inspect() returns container stats
- getOrCreate passes --cpus and --memory when configured
- marathon containers use configured resource limits
```

### Integration Tests

**`src/__integration__/marathon-checkpoint-resume.integration.test.ts`**:

```
- full marathon lifecycle: plan → chunk1 → chunk2 → complete → deliver
- checkpoint persists across simulated process restart
- failed chunk retries and eventually pauses marathon
- paused marathon resumes from correct chunk
- cancelled marathon cleans up container and cron job
- concurrent chunk execution is prevented (lane lock)
- progress updates delivered to correct channel
```

**`src/__integration__/marathon-container-lifecycle.integration.test.ts`**:

```
- persistent container survives beyond idle timeout
- workspace files persist after container restart
- container inspect returns valid stats
- resource limits (cpus/memory) passed to container runtime
- marathon cleanup destroys container on completion
```

**`src/__integration__/marathon-cron-integration.integration.test.ts`**:

```
- cron job with marathon-chunk mode calls executeChunk
- chunk interval respected between executions
- cron job auto-disables when marathon completes
- cron job pauses when marathon pauses
```

### System Tests

**`src/__system__/marathon-build-app.system.test.ts`**:

```
- end-to-end: launch marathon → plan → execute chunks → deliver result
  (uses mock LLM, real container, real filesystem)
- workspace contains expected file structure after completion
- delivery includes correct file attachments
- progress messages sent in correct order
- total execution time within expected bounds
```

---

## Configuration

```yaml
marathon:
  enabled: true
  maxConcurrent: 1 # max simultaneous marathon tasks
  chunkIntervalMs: 120_000 # 2 min between chunks (scheduling buffer)
  maxChunks: 50 # safety cap on chunk count
  maxDurationHours: 12 # safety cap on total duration
  maxRetriesPerChunk: 3 # retry failed chunks before pausing
  container:
    cpus: 4 # CPUs allocated to marathon containers
    memoryGB: 4 # GB RAM allocated to marathon containers
    commandTimeoutMs: 600_000 # 10 min per exec command
  progress:
    notifyEveryNChunks: 1 # send progress after every chunk
    includeFileSummary: true # list files written in progress update
```

---

## Implementation Phases

### Phase 1: Foundation (Week 1-2)

- [ ] Checkpoint framework (`checkpoint.ts` + tests)
- [ ] Container lifecycle extensions (persistent, promote/demote, resource flags)
- [ ] Classifier extension (marathon category)
- [ ] Marathon config schema

### Phase 2: Core Orchestration (Week 2-3)

- [ ] Marathon executor (`marathon.ts` + tests)
- [ ] Cron integration (marathon-chunk mode)
- [ ] Progress reporting
- [ ] Integration tests

### Phase 3: User Controls + Polish (Week 3-4)

- [ ] Chat commands (/marathon status, pause, resume, cancel, logs)
- [ ] System tests with real containers
- [ ] Workspace git init for version history inside container
- [ ] Error recovery edge cases

### Phase 4: Multi-Agent (Future)

- [ ] Async subagent spawning (`sessions_spawn_async`)
- [ ] Parallel chunk execution for independent tasks
- [ ] Supervisor agent role with worker coordination
- [ ] Cross-subagent artifact sharing

---

## Success Criteria

1. User sends "build me a todo app with React + Express + SQLite"
2. Jinx acknowledges, creates plan, starts marathon
3. User receives progress updates every few minutes
4. User can check status, pause, resume at any time
5. After N chunks (30-90 min), Jinx delivers:
   - Working application code in workspace
   - README with setup instructions
   - Test results summary
   - File attachment of key artifacts
6. Workspace files survive container restart
7. Process crash + restart resumes from last checkpoint
8. All tests pass before the feature ships

---

## Non-Goals (Phase 1)

- Multi-provider support (Claude only)
- Parallel subagent execution (sequential first)
- Container-to-container networking
- GPU access for ML tasks
- Automatic GitHub push (user controls deployment)
- Visual UI for marathon monitoring (chat commands only)

---

## Dependencies

- Apple Container CLI (`container` command) — macOS 26+
- Existing: CronService, ContainerManager, deep work pipeline, delivery system
- No new external dependencies required
