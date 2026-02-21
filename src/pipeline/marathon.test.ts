import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../types/channels.js";
import type { InputFileInfo } from "../types/marathon.js";
import type { MediaAttachment } from "../types/messages.js";
import type { SessionEntry, SessionStore } from "../types/sessions.js";
import type { MarathonDeps, LaunchMarathonParams } from "./marathon.js";
import { createTestConfig } from "../__test__/config.js";

// ── Mocks ───────────────────────────────────────────────────────────

vi.mock("../agents/runner.js", () => ({
  runAgent: vi.fn(),
}));

vi.mock("../delivery/deliver.js", () => ({
  deliverOutboundPayloads: vi
    .fn()
    .mockResolvedValue({ success: true, textChunks: 1, mediaItems: 0 }),
}));

vi.mock("../sessions/transcript.js", () => ({
  resolveTranscriptPath: vi.fn().mockReturnValue("/tmp/transcript.jsonl"),
}));

vi.mock("./streaming.js", () => ({
  emitStreamEvent: vi.fn(),
}));

vi.mock("../markdown/chunk.js", () => ({
  chunkText: vi.fn((text: string) => [text]),
}));

// Mock new extracted modules
vi.mock("./marathon-context.js", () => ({
  buildWorkspaceSnapshot: vi.fn().mockResolvedValue({
    fileTree: ["package.json"],
    keyFiles: [],
    progressMd: undefined,
  }),
  listFilesRecursive: vi.fn().mockResolvedValue([]),
  writeProgressFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./marathon-test-loop.js", () => ({
  runTestFixLoop: vi.fn().mockResolvedValue(undefined),
  verifyAcceptanceCriteria: vi.fn().mockResolvedValue({
    allPassed: true,
    results: [],
    passCount: 0,
    failCount: 0,
  }),
}));

// Mock checkpoint module
vi.mock("./checkpoint.js", () => ({
  createCheckpoint: vi.fn(),
  readCheckpoint: vi.fn(),
  advanceCheckpoint: vi.fn(),
  failChunk: vi.fn(),
  cancelCheckpoint: vi.fn(),
  pauseCheckpoint: vi.fn(),
  updateCheckpointStatus: vi.fn(),
  patchCheckpoint: vi.fn(),
  resetCurrentChunkRetries: vi.fn().mockResolvedValue(undefined),
  listCheckpoints: vi.fn().mockResolvedValue([]),
  resolveMarathonDir: vi.fn().mockReturnValue("/tmp/marathon"),
  resolveMarathonWorkspace: vi.fn().mockReturnValue("/tmp/tasks/marathon-test"),
}));

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(Buffer.from("zipdata")),
    unlink: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    readdir: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
    stat: vi.fn().mockResolvedValue({ size: 100 }),
    access: vi.fn().mockResolvedValue(undefined),
  },
  mkdir: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn().mockResolvedValue(Buffer.from("zipdata")),
  unlink: vi.fn().mockResolvedValue(undefined),
  writeFile: vi.fn().mockResolvedValue(undefined),
  appendFile: vi.fn().mockResolvedValue(undefined),
  readdir: vi.fn().mockResolvedValue([]),
  rm: vi.fn().mockResolvedValue(undefined),
  stat: vi.fn().mockResolvedValue({ size: 100 }),
  access: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockRunAgent = vi.fn();
const mockEmitStreamEvent = vi.fn();
const mockCreateCheckpoint = vi.fn();
const mockReadCheckpoint = vi.fn();
const mockAdvanceCheckpoint = vi.fn();
const mockFailChunk = vi.fn();
const mockPauseCheckpoint = vi.fn();
const mockCancelCheckpoint = vi.fn();
const mockUpdateCheckpointStatus = vi.fn();
const mockPatchCheckpoint = vi.fn();
const mockListCheckpoints = vi.fn();
const mockDeliverOutboundPayloads = vi.fn();
const mockListFilesRecursive = vi.fn();
const mockWriteProgressFile = vi.fn();
const mockExecFileSync = vi.fn();

// Wire mocks
beforeEach(async () => {
  vi.clearAllMocks();

  const runner = await import("../agents/runner.js");
  vi.mocked(runner.runAgent).mockImplementation(mockRunAgent);

  const streaming = await import("./streaming.js");
  vi.mocked(streaming.emitStreamEvent).mockImplementation(mockEmitStreamEvent);

  const checkpoint = await import("./checkpoint.js");
  vi.mocked(checkpoint.createCheckpoint).mockImplementation(mockCreateCheckpoint);
  vi.mocked(checkpoint.readCheckpoint).mockImplementation(mockReadCheckpoint);
  vi.mocked(checkpoint.advanceCheckpoint).mockImplementation(mockAdvanceCheckpoint);
  vi.mocked(checkpoint.failChunk).mockImplementation(mockFailChunk);
  vi.mocked(checkpoint.pauseCheckpoint).mockImplementation(mockPauseCheckpoint);
  vi.mocked(checkpoint.cancelCheckpoint).mockImplementation(mockCancelCheckpoint);
  vi.mocked(checkpoint.updateCheckpointStatus).mockImplementation(mockUpdateCheckpointStatus);
  vi.mocked(checkpoint.patchCheckpoint).mockImplementation(mockPatchCheckpoint);
  vi.mocked(checkpoint.listCheckpoints).mockImplementation(mockListCheckpoints);

  const delivery = await import("../delivery/deliver.js");
  vi.mocked(delivery.deliverOutboundPayloads).mockImplementation(mockDeliverOutboundPayloads);
  mockDeliverOutboundPayloads.mockResolvedValue({ success: true, textChunks: 1, mediaItems: 0 });

  const childProcess = await import("node:child_process");
  vi.mocked(childProcess.execFileSync).mockImplementation(mockExecFileSync);
  mockExecFileSync.mockImplementation(() => Buffer.from(""));

  // Wire marathon-context mocks
  const context = await import("./marathon-context.js");
  vi.mocked(context.listFilesRecursive).mockImplementation(mockListFilesRecursive);
  vi.mocked(context.writeProgressFile).mockImplementation(mockWriteProgressFile);
  mockListFilesRecursive.mockResolvedValue([]);
  mockWriteProgressFile.mockResolvedValue(undefined);

  const marathonRuntime = await import("./marathon.js");
  marathonRuntime.__resetMarathonRuntimeStateForTests();

  mockListCheckpoints.mockResolvedValue([]);
});

// ── Helpers ─────────────────────────────────────────────────────────

function createMockSessionStore(): SessionStore {
  const map = new Map<string, SessionEntry>();
  return {
    get: vi.fn((key: string) => map.get(key)),
    set: vi.fn((key: string, entry: SessionEntry) => map.set(key, entry)),
    delete: vi.fn((key: string) => map.delete(key)),
    list: vi.fn(() => [...map.values()]),
    save: vi.fn(),
    load: vi.fn(),
  };
}

function createMockContainerManager() {
  return {
    getOrCreate: vi.fn().mockResolvedValue({
      containerId: "jinx-marathon-abc12345",
      sessionKey: "marathon:abc12345",
      status: "ready" as const,
      lifecycle: "ephemeral" as const,
      startedAt: Date.now(),
      lastExecAt: Date.now(),
    }),
    exec: vi
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 100 }),
    stop: vi.fn().mockResolvedValue(undefined),
    stopAll: vi.fn().mockResolvedValue(undefined),
    sweepIdle: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
    promote: vi.fn(),
    demote: vi.fn(),
    setRetention: vi.fn(),
    inspect: vi.fn().mockResolvedValue({
      alive: true,
      uptimeMs: 1000,
      containerId: "jinx-marathon-abc",
      lifecycle: "persistent",
    }),
    reattach: vi.fn().mockResolvedValue(true),
    cleanupOrphans: vi.fn().mockResolvedValue(undefined),
  };
}

function createMockCronService() {
  return {
    add: vi.fn().mockReturnValue({ id: "watchdog-job-1", name: "marathon-watchdog" }),
    remove: vi.fn().mockReturnValue(true),
    list: vi.fn().mockReturnValue([]),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function makeDeps(overrides?: Partial<MarathonDeps>): MarathonDeps {
  return {
    config: createTestConfig(),
    sessions: createMockSessionStore(),
    containerManager: createMockContainerManager() as unknown as MarathonDeps["containerManager"],
    cronService: createMockCronService() as unknown as MarathonDeps["cronService"],
    channels: new Map(),
    ...overrides,
  };
}

function makeParams(overrides?: Partial<LaunchMarathonParams>): LaunchMarathonParams {
  return {
    prompt: "Build me a full-stack todo app",
    originSessionKey: "telegram:dm:user123",
    deliveryTarget: { channel: "telegram", to: "user123" },
    channel: "telegram",
    senderName: "Test User",
    ...overrides,
  };
}

const samplePlan = {
  goal: "Build a todo app",
  chunks: [
    {
      name: "scaffold",
      prompt: "Create project",
      estimatedMinutes: 5,
      acceptanceCriteria: [
        "file_exists: package.json",
        "command_succeeds: cd /workspace && npm run -s lint",
      ],
    },
    {
      name: "api",
      prompt: "Build API",
      estimatedMinutes: 10,
      acceptanceCriteria: [
        "file_exists: src/api.ts",
        "file_contains: src/api.ts :: export function",
      ],
    },
  ],
};

const sampleCheckpoint = {
  taskId: "marathon-abc12345",
  sessionKey: "marathon:abc12345",
  containerId: "jinx-marathon-abc12345",
  status: "executing" as const,
  plan: samplePlan,
  currentChunkIndex: 0,
  completedChunks: [],
  createdAt: Date.now(),
  updatedAt: Date.now(),
  deliverTo: { channel: "telegram" as const, to: "user123" },
  workspaceDir: "/tmp/tasks/marathon-abc12345",
  originSessionKey: "telegram:dm:user123",
  maxRetriesPerChunk: 3,
};

// ── Tests ───────────────────────────────────────────────────────────

describe("launchMarathon", () => {
  it("sends ack on origin session", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    // Make runAgent return a valid plan
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    // Return checkpoint states for execution
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    // Chunks end immediately
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });

    launchMarathon(makeParams(), deps);
    // Wait for async fire-and-forget
    await new Promise((r) => setTimeout(r, 50));

    expect(mockEmitStreamEvent).toHaveBeenCalledWith(
      "telegram:dm:user123",
      expect.objectContaining({ type: "final" }),
    );
  });

  it("creates marathon: prefixed session", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const sessions = deps.sessions;

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    const setCalls = vi.mocked(sessions.set).mock.calls;
    const marathonSession = setCalls.find(([key]) => key.startsWith("marathon:"));
    expect(marathonSession).toBeDefined();
  });

  it("runs planning turn with brain tier", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    // First runAgent call should be the planning turn with brain tier
    expect(mockRunAgent).toHaveBeenCalledWith(expect.objectContaining({ tier: "brain" }));
  });

  it("attempts one planning repair turn when the first plan is invalid", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent
      .mockResolvedValueOnce({
        text: "I will think step-by-step and then produce a plan.",
        messages: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 1000,
        model: "opus",
      })
      .mockResolvedValueOnce({
        text: JSON.stringify(samplePlan),
        messages: [],
        usage: { inputTokens: 120, outputTokens: 60 },
        durationMs: 1100,
        model: "opus",
      });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    const repairCall = mockRunAgent.mock.calls[1]?.[0];
    expect(repairCall?.prompt).toContain("previous marathon plan response was invalid");
  });

  it("fails fast when both initial and repair plans are invalid", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent
      .mockResolvedValueOnce({
        text: "invalid initial plan",
        messages: [],
        usage: { inputTokens: 100, outputTokens: 50 },
        durationMs: 1000,
        model: "opus",
      })
      .mockResolvedValueOnce({
        text: "still invalid",
        messages: [],
        usage: { inputTokens: 120, outputTokens: 60 },
        durationMs: 1100,
        model: "opus",
      });

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 80));

    expect(mockRunAgent).toHaveBeenCalledTimes(2);
    expect(mockCreateCheckpoint).not.toHaveBeenCalled();

    const planningFailureDelivery = mockDeliverOutboundPayloads.mock.calls.find(([req]) =>
      req.payload.text.includes("Marathon planning failed"),
    );
    const planningFailureFallback = mockEmitStreamEvent.mock.calls.find(
      ([, event]) => event.type === "final" && event.text.includes("Marathon planning failed"),
    );
    expect(planningFailureDelivery ?? planningFailureFallback).toBeDefined();
  });

  it("promotes container to persistent", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const cm = deps.containerManager!;

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    expect((cm as ReturnType<typeof createMockContainerManager>).promote).toHaveBeenCalled();
  });

  it("creates watchdog cron job with marathonWatchdog payload", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    const cronService = deps.cronService as ReturnType<typeof createMockCronService>;
    expect(cronService.add).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          marathonWatchdog: expect.objectContaining({
            taskId: expect.stringContaining("marathon-"),
          }),
        }),
      }),
    );
  });

  it("stores watchdogJobId in checkpoint", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    const cp = { ...sampleCheckpoint };
    mockCreateCheckpoint.mockResolvedValue(cp);
    mockPatchCheckpoint.mockResolvedValue(cp);
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    // Checkpoint should have been updated with watchdogJobId
    expect(mockPatchCheckpoint).toHaveBeenCalledWith(
      expect.stringContaining("marathon-"),
      expect.objectContaining({ watchdogJobId: expect.any(String) }),
    );
  });

  it("completion calls setRetention instead of demote", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const cm = deps.containerManager as ReturnType<typeof createMockContainerManager>;

    // Mock listFilesRecursive to return files so verifyChunkOutput sees workspace content
    mockListFilesRecursive.mockResolvedValue(["package.json"]);

    // Plan succeeds
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);

    // First readCheckpoint for watchdog setup
    mockReadCheckpoint.mockResolvedValueOnce(sampleCheckpoint);
    // Chunk loop reads: return executing, then completed after advance
    mockReadCheckpoint.mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing" });

    // Chunk execution succeeds
    mockRunAgent.mockResolvedValueOnce({
      text: "Done with scaffold. Files: /workspace/package.json",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });

    // advanceCheckpoint returns completed state (all chunks done)
    mockAdvanceCheckpoint.mockResolvedValueOnce({
      ...sampleCheckpoint,
      status: "completed",
      currentChunkIndex: 2,
      completedChunks: [
        {
          chunkName: "scaffold",
          status: "completed",
          summary: "Done",
          filesWritten: ["package.json"],
          durationMs: 500,
          completedAt: Date.now(),
          failedAttempts: 0,
        },
        {
          chunkName: "api",
          status: "completed",
          summary: "Done",
          filesWritten: ["src/api.ts"],
          durationMs: 500,
          completedAt: Date.now(),
          failedAttempts: 0,
        },
      ],
    });

    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 200));

    // Should NOT call demote
    expect(cm.demote).not.toHaveBeenCalled();
    // Should call setRetention with config value (14_400_000 = 4h)
    expect(cm.setRetention).toHaveBeenCalledWith(expect.stringContaining("marathon:"), 14_400_000);
  });

  it("maxConcurrent limit enforced (rejects launch when at capacity)", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps({
      config: createTestConfig({ marathon: { maxConcurrent: 1 } }),
    });

    // Make the planning turn succeed and chunk loop start (blocking on first chunk)
    let chunkResolve: () => void;
    const chunkPromise = new Promise<void>((r) => {
      chunkResolve = r;
    });

    let callCount = 0;
    mockRunAgent.mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        // Planning turn — returns plan
        return {
          text: JSON.stringify(samplePlan),
          messages: [],
          usage: { inputTokens: 100, outputTokens: 50 },
          durationMs: 1000,
          model: "opus",
        };
      }
      // Chunk execution — block forever
      await chunkPromise;
      return {
        text: "done",
        messages: [],
        usage: { inputTokens: 50, outputTokens: 25 },
        durationMs: 500,
        model: "sonnet",
      };
    });

    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "executing" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    // Wait for planning + loop start
    await new Promise((r) => setTimeout(r, 100));

    // Now try to start second — should get rejection
    mockEmitStreamEvent.mockClear();
    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 10));

    const ackCalls = mockEmitStreamEvent.mock.calls.filter(
      ([, event]) =>
        event.type === "final" &&
        typeof event.text === "string" &&
        event.text.includes("Cannot start marathon"),
    );
    expect(ackCalls.length).toBeGreaterThan(0);

    // Cleanup: resolve the blocked chunk
    chunkResolve!();
    await new Promise((r) => setTimeout(r, 50));
  });
});

describe("cancelMarathon", () => {
  it("sets checkpoint to cancelled, stops container, removes watchdog", async () => {
    const { cancelMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockReadCheckpoint.mockResolvedValue({
      ...sampleCheckpoint,
      watchdogJobId: "watchdog-1",
    });
    mockCancelCheckpoint.mockResolvedValue(undefined);

    await cancelMarathon("marathon-abc12345", deps);

    expect(mockCancelCheckpoint).toHaveBeenCalledWith("marathon-abc12345");
    const cronService = deps.cronService as ReturnType<typeof createMockCronService>;
    expect(cronService.remove).toHaveBeenCalledWith("watchdog-1");
    expect(
      (deps.containerManager as ReturnType<typeof createMockContainerManager>).stop,
    ).toHaveBeenCalled();
  });
});

describe("resumeMarathon", () => {
  it("reads checkpoint, restarts loop from currentChunkIndex", async () => {
    const { resumeMarathon } = await import("./marathon.js");
    const checkpoint = await import("./checkpoint.js");
    const deps = makeDeps();

    // Return paused checkpoint, then executing after update, then completed
    mockReadCheckpoint
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "paused", currentChunkIndex: 1 })
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing", currentChunkIndex: 1 })
      .mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    await resumeMarathon("marathon-abc12345", deps);

    expect(vi.mocked(checkpoint.resetCurrentChunkRetries)).toHaveBeenCalledWith(
      "marathon-abc12345",
    );
    expect(mockUpdateCheckpointStatus).toHaveBeenCalledWith("marathon-abc12345", "executing");
  });

  it("reattaches container if alive", async () => {
    const { resumeMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockReadCheckpoint
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "paused" })
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing" })
      .mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    await resumeMarathon("marathon-abc12345", deps);

    const cm = deps.containerManager as ReturnType<typeof createMockContainerManager>;
    expect(cm.reattach).toHaveBeenCalledWith(
      sampleCheckpoint.containerId,
      sampleCheckpoint.sessionKey,
      sampleCheckpoint.workspaceDir,
    );
  });

  it("recreates container if dead (workspace survives on host mount)", async () => {
    const { resumeMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const cm = deps.containerManager as ReturnType<typeof createMockContainerManager>;
    cm.reattach.mockResolvedValue(false); // Container is dead

    mockReadCheckpoint
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "paused" })
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "paused" }) // for container ID update
      .mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing" })
      .mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    await resumeMarathon("marathon-abc12345", deps);

    expect(cm.getOrCreate).toHaveBeenCalledWith(
      sampleCheckpoint.sessionKey,
      sampleCheckpoint.workspaceDir,
    );
    expect(cm.promote).toHaveBeenCalled();
  });
});

describe("getMarathonStatus", () => {
  it("returns all checkpoints", async () => {
    const { getMarathonStatus } = await import("./marathon.js");
    mockListCheckpoints.mockResolvedValue([sampleCheckpoint]);

    const result = await getMarathonStatus();
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe("marathon-abc12345");
  });
});

describe("marathon delivery guarantees", () => {
  it("retries failed deliveries and falls back to terminal with dead-letter logging", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const fsMod = await import("node:fs/promises");
    vi.useFakeTimers();
    const deps = makeDeps({
      channels: new Map([
        [
          "telegram",
          {
            isReady: () => true,
            send: vi.fn().mockResolvedValue(undefined),
            capabilities: { maxTextLength: 4096 },
            name: "telegram",
          } as unknown as ChannelPlugin,
        ],
      ]),
    });

    mockDeliverOutboundPayloads.mockResolvedValue({
      success: false,
      channel: "telegram",
      to: "user123",
      textChunks: 0,
      mediaItems: 0,
      error: "simulated delivery failure",
    });
    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockPatchCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    try {
      launchMarathon(makeParams(), deps);
      await vi.runAllTimersAsync();
    } finally {
      vi.useRealTimers();
    }

    expect(mockDeliverOutboundPayloads).toHaveBeenCalledTimes(3);
    expect(fsMod.default.appendFile).toHaveBeenCalled();

    const terminalFallbackCall = mockEmitStreamEvent.mock.calls.find(
      ([sessionKey]) => sessionKey === "terminal:dm:local",
    );
    expect(terminalFallbackCall).toBeDefined();
  });
});

describe("marathon hardening", () => {
  it("planning turn passes tools: [] (planner needs no tools)", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    // First runAgent call is the planning turn — should have tools: []
    const planningCall = mockRunAgent.mock.calls[0]?.[0];
    expect(planningCall).toBeDefined();
    expect(planningCall.tools).toEqual([]);
  });

  it("chunk turns get file + exec + marathon + web tools", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const cm = deps.containerManager as ReturnType<typeof createMockContainerManager>;

    // Mock exec to return file changes for verifyChunkOutput
    cm.exec.mockImplementation(async (_sk: string, cmd: string) => {
      if (cmd.includes("git diff --cached --name-only")) {
        return { exitCode: 0, stdout: "index.js\n", stderr: "", timedOut: false, durationMs: 50 };
      }
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 50 };
    });

    // Planning turn
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);

    // readCheckpoint for watchdog setup
    mockReadCheckpoint.mockResolvedValueOnce(sampleCheckpoint);
    // Chunk loop: executing, then completed after advance
    mockReadCheckpoint.mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing" });

    // Chunk execution
    mockRunAgent.mockResolvedValueOnce({
      text: "Created index.js",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });
    mockAdvanceCheckpoint.mockResolvedValueOnce({
      ...sampleCheckpoint,
      status: "completed",
      currentChunkIndex: 2,
      completedChunks: [],
    });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 200));

    // Second runAgent call is the chunk turn — check its tools
    const chunkCall = mockRunAgent.mock.calls[1]?.[0];
    expect(chunkCall).toBeDefined();
    expect(chunkCall.tools).toBeDefined();

    const toolNames = chunkCall.tools.map((t: { name: string }) => t.name);
    // Should have native file tools (scoped to workspace)
    expect(toolNames).toContain("read");
    expect(toolNames).toContain("write");
    expect(toolNames).toContain("edit");
    expect(toolNames).toContain("glob");
    expect(toolNames).toContain("grep");

    // Should have exec, marathon, and web tools
    expect(toolNames).toContain("exec");
    expect(toolNames).toContain("marathon_status");
    expect(toolNames).toContain("marathon_plan_update");
    expect(toolNames).toContain("web_search");
    expect(toolNames).toContain("web_fetch");

    // Should NOT have non-scoped tools
    expect(toolNames).not.toContain("memory_search");
    expect(toolNames).not.toContain("cron");
    expect(toolNames).not.toContain("message");
  });

  it("runs test-fix loop after successful chunk when enabled", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const testLoop = await import("./marathon-test-loop.js");
    const deps = makeDeps();

    mockListFilesRecursive.mockResolvedValue(["src/index.ts"]);
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        goal: "Build",
        chunks: [
          {
            name: "build",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      }),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue({
      ...sampleCheckpoint,
      plan: {
        goal: "Build",
        chunks: [
          {
            name: "build",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      },
    });
    mockPatchCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValueOnce(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValueOnce({
      ...sampleCheckpoint,
      status: "executing",
      plan: {
        goal: "Build",
        chunks: [
          {
            name: "build",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      },
    });
    mockRunAgent.mockResolvedValueOnce({
      text: "done",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });
    mockAdvanceCheckpoint.mockResolvedValueOnce({
      ...sampleCheckpoint,
      status: "completed",
      currentChunkIndex: 1,
      plan: {
        goal: "Build",
        chunks: [
          {
            name: "build",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      },
      completedChunks: [],
    });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 250));

    expect(vi.mocked(testLoop.runTestFixLoop)).toHaveBeenCalled();
  });

  it("chunk with no file changes triggers retry (verifyChunkOutput)", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    // Ensure listFilesRecursive returns [] — empty workspace (no files written)
    mockListFilesRecursive.mockResolvedValue([]);

    // Planning turn
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);

    // readCheckpoint: watchdog setup, then executing, then executing for retry, then completed
    mockReadCheckpoint.mockResolvedValueOnce(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing" });
    // After failChunk, checkpoint goes to paused
    mockFailChunk.mockResolvedValueOnce({ ...sampleCheckpoint, status: "paused" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    // Chunk returns text but no files actually written
    mockRunAgent.mockResolvedValueOnce({
      text: "I created the files as requested.",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 200));

    // failChunk should have been called with "no files" error
    expect(mockFailChunk).toHaveBeenCalledWith(
      expect.stringContaining("marathon-"),
      expect.stringContaining("no files in workspace"),
    );
  });

  it("authentication errors pause immediately without chunk retry accounting", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValueOnce({ ...sampleCheckpoint, status: "executing" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);
    mockRunAgent.mockRejectedValueOnce(new Error("authentication_error: 401 expired"));

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 200));

    expect(mockPauseCheckpoint).toHaveBeenCalledWith(expect.stringContaining("marathon-"));
    expect(mockFailChunk).not.toHaveBeenCalled();
  });

  it("planning prompt communicates maxChunks to the LLM", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps({
      config: createTestConfig({ marathon: { maxChunks: 12 } }),
    });

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 50));

    // Planning prompt should contain the maxChunks value
    const planningCall = mockRunAgent.mock.calls[0]?.[0];
    expect(planningCall.prompt).toContain("Hard cap: 12 chunks");
    expect(planningCall.prompt).toContain("3-8 chunks");
    expect(planningCall.prompt).not.toContain("5-20 chunks");
  });
});

describe("seedWorkspaceMedia", () => {
  it("writes buffer to workspace and returns file info", async () => {
    const { seedWorkspaceMedia } = await import("./marathon.js");
    const fsMod = await import("node:fs/promises");

    const media: MediaAttachment[] = [
      {
        type: "video",
        mimeType: "video/mp4",
        buffer: new Uint8Array([0x00, 0x01, 0x02]),
        filename: "my-video.mp4",
        sizeBytes: 3,
      },
    ];

    const result = await seedWorkspaceMedia("/tmp/workspace", media);

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      name: "my-video.mp4",
      sizeBytes: 3,
      mimeType: "video/mp4",
    });
    expect(fsMod.default.writeFile).toHaveBeenCalledWith(
      "/tmp/workspace/my-video.mp4",
      media[0].buffer,
    );
  });

  it("generates filename from type and mime when filename is missing", async () => {
    const { seedWorkspaceMedia } = await import("./marathon.js");

    const media: MediaAttachment[] = [
      {
        type: "image",
        mimeType: "image/png",
        buffer: new Uint8Array([0xff]),
      },
    ];

    const result = await seedWorkspaceMedia("/tmp/workspace", media);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("input-image.png");
  });

  it("numbers duplicate generated filenames", async () => {
    const { seedWorkspaceMedia } = await import("./marathon.js");

    const media: MediaAttachment[] = [
      { type: "image", mimeType: "image/jpeg", buffer: new Uint8Array([1]) },
      { type: "image", mimeType: "image/jpeg", buffer: new Uint8Array([2]) },
    ];

    const result = await seedWorkspaceMedia("/tmp/workspace", media);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("input-image.jpg");
    expect(result[1].name).toBe("input-image-2.jpg");
  });

  it("skips attachments without buffers", async () => {
    const { seedWorkspaceMedia } = await import("./marathon.js");

    const media: MediaAttachment[] = [
      { type: "video", mimeType: "video/mp4", url: "https://example.com/video.mp4" },
      { type: "image", mimeType: "image/png", buffer: new Uint8Array([1]) },
    ];

    const result = await seedWorkspaceMedia("/tmp/workspace", media);

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("input-image.png");
  });

  it("returns empty array for undefined/empty media", async () => {
    const { seedWorkspaceMedia } = await import("./marathon.js");

    expect(await seedWorkspaceMedia("/tmp/workspace", undefined)).toEqual([]);
    expect(await seedWorkspaceMedia("/tmp/workspace", [])).toEqual([]);
  });
});

describe("media in marathon flow", () => {
  it("planning prompt includes INPUT FILES section when media provided", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    const media: MediaAttachment[] = [
      {
        type: "video",
        mimeType: "video/mp4",
        buffer: new Uint8Array(1024 * 1024), // 1 MB
        filename: "clip.mp4",
      },
    ];

    launchMarathon(makeParams({ media }), deps);
    await new Promise((r) => setTimeout(r, 50));

    const planningCall = mockRunAgent.mock.calls[0]?.[0];
    expect(planningCall.prompt).toContain("INPUT FILES (already in /workspace):");
    expect(planningCall.prompt).toContain("clip.mp4");
    expect(planningCall.prompt).toContain("video/mp4");
    expect(planningCall.prompt).toContain("work with these existing files");
  });

  it("checkpoint stores inputFiles for chunk prompts", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    const media: MediaAttachment[] = [
      {
        type: "video",
        mimeType: "video/mp4",
        buffer: new Uint8Array(500),
        filename: "test.mp4",
      },
    ];

    launchMarathon(makeParams({ media }), deps);
    await new Promise((r) => setTimeout(r, 50));

    // createCheckpoint should have been called with inputFiles
    expect(mockCreateCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        inputFiles: [{ name: "test.mp4", sizeBytes: 500, mimeType: "video/mp4" }],
      }),
    );
  });

  it("checkpoint stores scoped control policy for group marathon", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps({
      config: createTestConfig({
        marathon: {
          control: {
            allowFrom: ["maintainer-1"],
            allowSameGroupMembers: true,
          },
        },
      }),
    });

    mockRunAgent.mockResolvedValue({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValue({ ...sampleCheckpoint, status: "completed" });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(
      makeParams({
        originSessionKey: "telegram:group:group-123",
        deliveryTarget: { channel: "telegram", to: "group-123" },
        senderId: "owner-1",
      }),
      deps,
    );
    await new Promise((r) => setTimeout(r, 50));

    expect(mockCreateCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        controlPolicy: expect.objectContaining({
          ownerSenderId: "owner-1",
          originGroupId: "group-123",
          allowSameGroupMembers: true,
        }),
      }),
    );
  });

  it("chunk prompt includes input file section from checkpoint", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();

    // Mock listFilesRecursive to return files so verifyChunkOutput passes
    mockListFilesRecursive.mockResolvedValue(["test.mp4"]);

    // Planning turn
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(samplePlan),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);

    const checkpointWithFiles = {
      ...sampleCheckpoint,
      inputFiles: [{ name: "test.mp4", sizeBytes: 2_000_000, mimeType: "video/mp4" }],
    };

    // readCheckpoint for watchdog, then for chunk loop
    mockReadCheckpoint.mockResolvedValueOnce(checkpointWithFiles);
    mockReadCheckpoint.mockResolvedValueOnce({ ...checkpointWithFiles, status: "executing" });

    // Chunk execution succeeds
    mockRunAgent.mockResolvedValueOnce({
      text: "Compressed the video",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });
    mockAdvanceCheckpoint.mockResolvedValueOnce({
      ...checkpointWithFiles,
      status: "completed",
      currentChunkIndex: 2,
      completedChunks: [],
    });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    launchMarathon(
      makeParams({
        media: [
          {
            type: "video",
            mimeType: "video/mp4",
            buffer: new Uint8Array(2_000_000),
            filename: "test.mp4",
          },
        ],
      }),
      deps,
    );
    await new Promise((r) => setTimeout(r, 200));

    // Second runAgent call is the chunk turn
    const chunkCall = mockRunAgent.mock.calls[1]?.[0];
    expect(chunkCall).toBeDefined();
    expect(chunkCall.prompt).toContain("INPUT FILES (user-provided, already in /workspace):");
    expect(chunkCall.prompt).toContain("test.mp4");
    expect(chunkCall.prompt).toContain("video/mp4");
  });

  it("last chunk prompt includes DELIVERABLES instruction", async () => {
    const { buildChunkPrompt } = await import("./marathon-prompts.js");
    const singleChunkPlan = {
      goal: "Compress video",
      chunks: [
        {
          name: "compress",
          prompt: "Compress it",
          estimatedMinutes: 5,
          acceptanceCriteria: [
            "file_exists: package.json",
            "command_succeeds: cd /workspace && npm run -s test",
          ],
        },
      ],
    };
    const checkpoint = {
      ...sampleCheckpoint,
      plan: singleChunkPlan,
      currentChunkIndex: 0,
    };

    const prompt = buildChunkPrompt(checkpoint, singleChunkPlan.chunks[0], true, undefined);
    expect(prompt).toContain("DELIVERABLES");
    expect(prompt).toContain(".deliverables");
  });
});

describe("autoDetectDeliverables", () => {
  it("finds deliverable files by extension, excluding inputs and noise", async () => {
    const { autoDetectDeliverables } = await import("./marathon.js");
    const fsMod = await import("node:fs/promises");

    // Simulate workspace with mixed files via listFilesRecursive mock
    mockListFilesRecursive.mockResolvedValue([
      "input.mp4",
      "output-compressed.mp4",
      "package.json",
      "process-video.js",
      "README.md",
      "CHUNK1_COMPLETE.md",
    ]);

    const mockStat = vi.mocked(fsMod.default.stat);
    mockStat.mockImplementation(async (p: unknown) => {
      const filePath = String(p);
      if (filePath.includes("output-compressed.mp4")) {
        return { size: 2_500_000 } as never;
      }
      if (filePath.includes("process-video.js")) {
        return { size: 1500 } as never;
      }
      if (filePath.includes("README.md")) {
        return { size: 800 } as never;
      }
      return { size: 100 } as never;
    });

    const inputFiles: InputFileInfo[] = [
      { name: "input.mp4", sizeBytes: 5_000_000, mimeType: "video/mp4" },
    ];

    const result = await autoDetectDeliverables("/workspace", inputFiles);

    // Should find output-compressed.mp4 (deliverable extension, not an input)
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("output-compressed.mp4");
  });

  it("returns empty array when no deliverable extensions found", async () => {
    const { autoDetectDeliverables } = await import("./marathon.js");
    const fsMod = await import("node:fs/promises");

    mockListFilesRecursive.mockResolvedValue(["index.js", "utils.ts", "README.md"]);

    vi.mocked(fsMod.default.stat).mockResolvedValue({ size: 500 } as never);

    const result = await autoDetectDeliverables("/workspace");
    expect(result).toEqual([]);
  });

  it("sorts deliverables by size (largest first) and caps at 5", async () => {
    const { autoDetectDeliverables } = await import("./marathon.js");
    const fsMod = await import("node:fs/promises");

    const fileNames = Array.from({ length: 7 }, (_, i) => `image-${i}.png`);
    mockListFilesRecursive.mockResolvedValue(fileNames);

    vi.mocked(fsMod.default.stat).mockImplementation(async (p: unknown) => {
      const filePath = String(p);
      const match = filePath.match(/image-(\d)/);
      const idx = match ? Number.parseInt(match[1]) : 0;
      return { size: (idx + 1) * 1000 } as never;
    });

    const result = await autoDetectDeliverables("/workspace");

    // Should cap at 5 files
    expect(result).toHaveLength(5);
    // Largest first (image-6 = 7000, image-5 = 6000, ...)
    expect(result[0]).toContain("image-6.png");
    expect(result[1]).toContain("image-5.png");
  });

  it("skips noise patterns like package.json and CHUNK files", async () => {
    const { autoDetectDeliverables } = await import("./marathon.js");
    const fsMod = await import("node:fs/promises");

    mockListFilesRecursive.mockResolvedValue([
      "package.json",
      "CHUNK2_COMPLETE.md",
      "SETUP_COMPLETE.md",
      ".deliverables",
      "result.pdf",
    ]);

    vi.mocked(fsMod.default.stat).mockResolvedValue({ size: 5000 } as never);

    const result = await autoDetectDeliverables("/workspace");

    expect(result).toHaveLength(1);
    expect(result[0]).toContain("result.pdf");
  });
});

describe("isManifestDeliverablePath", () => {
  it("rejects non-deliverable manifest entries like README/PROGRESS", async () => {
    const { isManifestDeliverablePath } = await import("./marathon.js");

    expect(isManifestDeliverablePath("README.md")).toBe(false);
    expect(isManifestDeliverablePath("PROGRESS.md")).toBe(false);
    expect(isManifestDeliverablePath(".deliverables")).toBe(false);
  });

  it("accepts regular artifact-like entries", async () => {
    const { isManifestDeliverablePath } = await import("./marathon.js");

    expect(isManifestDeliverablePath("dist/index.html")).toBe(true);
    expect(isManifestDeliverablePath("output/report.pdf")).toBe(true);
  });
});

describe("selectProgressArtifacts", () => {
  it("shows likely outputs and suppresses noisy markdown references", async () => {
    const { selectProgressArtifacts } = await import("./marathon.js");

    const selected = selectProgressArtifacts([
      "README.md",
      "PROGRESS.md",
      "src/index.ts",
      "dist/index.html",
      "out/final.mp4",
      "package.json",
    ]);

    expect(selected).toEqual(["dist/index.html", "out/final.mp4"]);
  });
});

describe("deliverable packaging three-tier strategy", () => {
  it("tier 1: uses .deliverables manifest when present and valid", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const fsMod = await import("node:fs/promises");

    // Manifest exists with valid path
    const mockReadFile = vi.mocked(fsMod.default.readFile);
    mockReadFile.mockImplementation(async (p: unknown, _enc?: unknown) => {
      const filePath = String(p);
      if (filePath.endsWith(".deliverables")) {
        return '["/workspace/output.mp4"]' as never;
      }
      // Return buffer for the actual file read
      return Buffer.from("video-data") as never;
    });

    // access check passes
    const mockAccess = vi.fn().mockResolvedValue(undefined);
    fsMod.default.access = mockAccess;

    // listFilesRecursive returns file for verifyChunkOutput
    mockListFilesRecursive.mockResolvedValue(["output.mp4"]);

    // Planning turn
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify({
        goal: "Test",
        chunks: [
          {
            name: "do-it",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      }),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });
    mockCreateCheckpoint.mockResolvedValue(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValueOnce(sampleCheckpoint);
    mockReadCheckpoint.mockResolvedValueOnce({
      ...sampleCheckpoint,
      status: "executing",
      plan: {
        goal: "Test",
        chunks: [
          {
            name: "do-it",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      },
    });

    // Chunk execution
    mockRunAgent.mockResolvedValueOnce({
      text: "Done",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });
    mockAdvanceCheckpoint.mockResolvedValueOnce({
      ...sampleCheckpoint,
      status: "completed",
      currentChunkIndex: 1,
      plan: {
        goal: "Test",
        chunks: [
          {
            name: "do-it",
            prompt: "Do it",
            estimatedMinutes: 5,
            acceptanceCriteria: [
              "file_exists: package.json",
              "command_succeeds: cd /workspace && npm run -s test",
            ],
          },
        ],
      },
      completedChunks: [
        {
          chunkName: "do-it",
          status: "completed",
          summary: "Done",
          filesWritten: ["output.mp4"],
          durationMs: 500,
          completedAt: Date.now(),
          failedAttempts: 0,
        },
      ],
    });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    // Wire up a mock channel to capture delivered media
    const mockChannel = {
      isReady: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      name: "telegram",
    };
    deps.channels = new Map([["telegram", mockChannel as unknown as ChannelPlugin]]);

    launchMarathon(makeParams(), deps);
    await new Promise((r) => setTimeout(r, 300));

    // deliverOutboundPayloads should have been called with media
    const deliverCalls = mockDeliverOutboundPayloads.mock.calls;
    const completionCall = deliverCalls.find(
      ([arg]) => arg.payload?.media && arg.payload.media.length > 0,
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![0].payload.media).toHaveLength(1);
    expect(completionCall![0].payload.media[0].filename).toMatch(/-artifacts\.zip$/);
  });

  it("tier 2: auto-detects deliverables when no manifest exists", async () => {
    const { launchMarathon } = await import("./marathon.js");
    const deps = makeDeps();
    const fsMod = await import("node:fs/promises");

    // No .deliverables manifest (readFile throws for manifest)
    const mockReadFile = vi.mocked(fsMod.default.readFile);
    mockReadFile.mockImplementation(async (p: unknown, _enc?: unknown) => {
      const filePath = String(p);
      if (filePath.endsWith(".deliverables")) {
        throw new Error("ENOENT");
      }
      // Return buffer for the detected deliverable
      return Buffer.from("compressed-video-data") as never;
    });

    // listFilesRecursive returns files including a deliverable output
    mockListFilesRecursive.mockResolvedValue([
      "original-input.mp4",
      "output-compressed.mp4",
      "process.js",
      "package.json",
    ]);

    vi.mocked(fsMod.default.stat).mockImplementation(async (p: unknown) => {
      const filePath = String(p);
      if (filePath.includes("output-compressed.mp4")) {
        return { size: 2_000_000 } as never;
      }
      return { size: 500 } as never;
    });

    // Planning turn
    const singleChunk = {
      goal: "Compress",
      chunks: [
        {
          name: "compress",
          prompt: "Do it",
          estimatedMinutes: 5,
          acceptanceCriteria: [
            "file_exists: package.json",
            "command_succeeds: cd /workspace && npm run -s test",
          ],
        },
      ],
    };
    mockRunAgent.mockResolvedValueOnce({
      text: JSON.stringify(singleChunk),
      messages: [],
      usage: { inputTokens: 100, outputTokens: 50 },
      durationMs: 1000,
      model: "opus",
    });

    const cpWithInput = {
      ...sampleCheckpoint,
      plan: singleChunk,
      inputFiles: [{ name: "original-input.mp4", sizeBytes: 5_000_000, mimeType: "video/mp4" }],
    };
    mockCreateCheckpoint.mockResolvedValue(cpWithInput);
    mockReadCheckpoint.mockResolvedValueOnce(cpWithInput);
    mockReadCheckpoint.mockResolvedValueOnce({ ...cpWithInput, status: "executing" });

    // Chunk execution
    mockRunAgent.mockResolvedValueOnce({
      text: "Compressed",
      messages: [],
      usage: { inputTokens: 50, outputTokens: 25 },
      durationMs: 500,
      model: "sonnet",
    });
    mockAdvanceCheckpoint.mockResolvedValueOnce({
      ...cpWithInput,
      status: "completed",
      currentChunkIndex: 1,
      completedChunks: [
        {
          chunkName: "compress",
          status: "completed",
          summary: "Done",
          filesWritten: ["output-compressed.mp4"],
          durationMs: 500,
          completedAt: Date.now(),
          failedAttempts: 0,
        },
      ],
    });
    mockUpdateCheckpointStatus.mockResolvedValue(undefined);

    const mockChannel = {
      isReady: () => true,
      send: vi.fn().mockResolvedValue(undefined),
      name: "telegram",
    };
    deps.channels = new Map([["telegram", mockChannel as unknown as ChannelPlugin]]);

    launchMarathon(
      makeParams({
        media: [
          {
            type: "video",
            mimeType: "video/mp4",
            buffer: new Uint8Array(5_000_000),
            filename: "original-input.mp4",
          },
        ],
      }),
      deps,
    );
    await new Promise((r) => setTimeout(r, 300));

    // deliverOutboundPayloads should be called with auto-detected media
    const deliverCalls = mockDeliverOutboundPayloads.mock.calls;
    const completionCall = deliverCalls.find(
      ([arg]) => arg.payload?.media && arg.payload.media.length > 0,
    );
    expect(completionCall).toBeDefined();
    expect(completionCall![0].payload.media).toHaveLength(1);
    expect(completionCall![0].payload.media[0].filename).toMatch(/-artifacts\.zip$/);
  });
});
