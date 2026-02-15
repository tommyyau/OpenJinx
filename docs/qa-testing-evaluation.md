# QA Testing Evaluation

Testing philosophy, strategy, and maintenance guidelines for OpenJinx.

## Testing Philosophy

### Test what matters, not what's easy

Coverage percentages are a lagging indicator. A codebase at 90% coverage can still have critical untested error paths. We prioritize:

1. **Error paths over happy paths** — The happy path usually works because developers exercise it constantly. The `catch` block that runs when the filesystem is full or the API returns 500 is where production bugs live.

2. **Integration boundaries over unit internals** — A unit test that mocks everything proves the function calls its mocks correctly. An integration test that wires real subsystems together proves they actually work.

3. **Behavioral contracts over implementation details** — Test what the function promises (its contract), not how it achieves it. If `dispatchInboundMessage` promises to create a session when none exists, test that. Don't test which internal helper it calls.

4. **Reproducibility over speed** — A flaky test is worse than no test. Use fake timers for time-dependent behavior, deterministic ports for network tests, and explicit cleanup for filesystem tests.

### The trust hierarchy

```
Live tests (real APIs, real channels)     ← Highest confidence
  Integration tests (real subsystem wiring) ← High confidence
    Unit tests (isolated module behavior)     ← Foundation
      Type checking (compile-time guarantees)   ← Baseline
```

Each tier catches different classes of bugs. Unit tests catch logic errors. Integration tests catch wiring errors. Live tests catch environment errors. All three are necessary.

## Strategy: Real Keys in Testing

### Why we test with real credentials

Mock-heavy test suites create a dangerous illusion of safety. When every external boundary is mocked, you're testing your mocks, not your system. OpenJinx takes a deliberate approach:

- **Live tests (`*.live.test.ts`)** use real API keys, real WhatsApp connections, and real Telegram bot tokens
- They run in `src/__system__/` and are excluded from the default `pnpm test` command
- They require explicit invocation via `pnpm test:live`
- They use `describeIf` patterns to skip gracefully when credentials aren't available

### Guard rails for real-key testing

1. **Credential gating** — Every live test checks for credentials before running. Missing credentials = skip, not fail.
2. **Test isolation** — The `isSystemTest` flag on `MsgContext` routes test traffic to temp directories, disables memory writes, and skips the classifier.
3. **Visible markers** — Test messages are prefixed with `[TEST]` so they're instantly identifiable in real channels.
4. **Post-test cleanup** — `src/__test__/live-cleanup.ts` scans for and removes test artifacts from transcripts, memory, sessions, and the session store.
5. **Defense in depth** — We don't trust prevention alone. Even with isolation flags, cleanup runs as a safety net.

### What live tests cover

| Test                             | What it proves                              | Credential needed                              |
| -------------------------------- | ------------------------------------------- | ---------------------------------------------- |
| `claude-provider.live.test.ts`   | Claude API auth + response parsing works    | `ANTHROPIC_API_KEY` or OAuth                   |
| `composio.live.test.ts`          | Composio SDK connects and searches tools    | `COMPOSIO_API_KEY`                             |
| `memory-embeddings.live.test.ts` | Embedding generation works end-to-end       | `ANTHROPIC_API_KEY` or OAuth                   |
| `whatsapp-send.live.test.ts`     | WhatsApp Baileys session connects and sends | `~/.jinx/whatsapp-auth/creds.json`             |
| `telegram-send.live.test.ts`     | Telegram bot sends messages                 | `TELEGRAM_BOT_TOKEN` + `TELEGRAM_TEST_CHAT_ID` |
| `channel-health.live.test.ts`    | Both channels report healthy connectivity   | Both channel credentials                       |

## Cleanup Strategy

### The belt-and-suspenders approach

Prevention and cleanup are both necessary. Prevention reduces the blast radius; cleanup catches what prevention misses.

**Prevention layer (compile-time):**

- `isSystemTest` flag on MsgContext
- Temp transcript paths (`os.tmpdir()/jinx-test/`)
- Memory tools excluded from tool assembly
- Classifier bypassed for test messages

**Cleanup layer (runtime):**

- `cleanupTestArtifacts()` runs in `afterAll()` of every live test suite
- Scans transcripts in both temp AND real directories
- Removes test-marked lines from daily memory logs
- Deletes memory files created during the test window
- Cleans session store entries matching test session keys
- Warns if the embeddings index was modified

**Orphan sweeper (global):**

- `sweepStaleTempDirs()` removes `jinx-*` temp directories older than 1 hour
- Catches artifacts from crashed test runs where `afterAll` never fired

### What a clean test run looks like

```
After test:
  transcriptsDeleted: []        ← Prevention worked
  dailyLogLinesRemoved: 0       ← No leaks into memory
  memoryFilesDeleted: []        ← Memory tools were excluded
  sessionsRemoved: []           ← Session store clean
  embeddingWarning: false       ← Index untouched
```

If cleanup finds artifacts, that's a signal that the isolation layer has a gap — file a bug.

## Coverage Goals

### Current thresholds (enforced in CI)

| Metric     | Threshold | Current | Target |
| ---------- | --------- | ------- | ------ |
| Lines      | 70%       | ~90%    | 85%+   |
| Statements | 70%       | ~90%    | 85%+   |
| Branches   | 65%       | ~78%    | 75%+   |
| Functions  | 70%       | ~91%    | 85%+   |

### Branch coverage is the real metric

Line coverage is easy to game — one test through the happy path covers most lines. Branch coverage requires testing both sides of every `if`. The jump from 40% to 78% branch coverage represents real risk reduction.

### Coverage exclusions

Some files are excluded from coverage enforcement because they require external connections that can't be mocked in unit tests:

- `src/gateway/**` — WebSocket server (tested in integration tier)
- `src/channels/telegram/bot.ts`, `session.ts`, etc. — Channel adapters requiring live connections
- `src/cli/**` — CLI commands (integration-tested via `pnpm dev doctor`)
- `src/tui/**` — Terminal UI (interactive, tested via ChatLog unit tests)
- `src/__test__/**` — Test helpers (not production code)

Each exclusion should be revisited periodically. The goal is to shrink this list, not grow it.

## Test Maintenance Guidelines

### When to add tests

- **Every new feature** gets tests. No exceptions.
- **Every bug fix** gets a regression test that fails without the fix and passes with it.
- **Every error path** you add should be tested. If you write `catch (err)`, test what happens when it throws.

### When to remove tests

- **Stale mocks** — If a test mocks a function that no longer exists or has a different signature, delete and rewrite it.
- **Redundant coverage** — If two tests verify the exact same behavior with the exact same inputs, keep the more readable one.
- **Implementation-coupled tests** — If a test breaks every time you refactor internals (without changing behavior), it's testing the wrong thing.

### When to update tests

- **Behavior changes** — If the contract changes (new return type, new error, different ordering), update the test to match.
- **New branches** — If you add an `else` clause, add a test for it.
- **Flaky tests** — If a test fails intermittently, it's either time-dependent (use fake timers), order-dependent (ensure cleanup), or race-condition-prone (add explicit waits). Fix the root cause; don't retry.

### Test naming convention

```typescript
it("dispatches a valid DM through the pipeline", ...)     // What it tests
it("rejects DM when dmPolicy is disabled", ...)            // Error/rejection path
it("auto-creates session when none pre-exists", ...)       // Edge case
it("lane idle beyond TTL — evicted by sweep", ...)         // Timer behavior
```

The test name should read as a sentence. Someone scanning test output should understand what broke without reading the test body.

### Mock discipline

- **Mock at boundaries, not internals** — Mock the Claude API, not the internal function that calls it.
- **Keep mocks minimal** — Only mock what's necessary to isolate the behavior under test.
- **Verify mock paths** — `vi.mock()` paths are relative to the test file, not the source module. A wrong path silently falls through to the real module.
- **Clean up between tests** — `vi.clearAllMocks()` in `beforeEach()`. Module-level state (singletons, timers) needs explicit teardown.

## Test Architecture Reference

### Directory structure

```
src/
  __test__/              # Shared test infrastructure
    config.ts            # createTestConfig() factory
    mock-sdk.ts          # Mock Claude SDK
    mock-channel.ts      # Mock channel adapters
    live-cleanup.ts      # Post-test artifact cleanup
  __integration__/       # Integration tests (20 files, 102 tests)
    startup-*.ts         # Startup/shutdown lifecycle wiring
    dispatch-*.ts        # Pipeline dispatch behavior
    gateway-*.ts         # WebSocket gateway lifecycle
    whatsapp-*.ts        # WhatsApp inbound simulation
    telegram-*.ts        # Telegram inbound simulation
    pipeline-*.ts        # Pipeline delivery contracts
    session-*.ts         # Session lane behavior
    memory-*.ts          # Memory system integration
    agent-*.ts           # Agent skill loading
    compaction-*.ts      # Transcript compaction
    transcript-*.ts      # Transcript roundtrip
    heartbeat-*.ts       # Heartbeat delivery routing
    cron-*.ts            # Cron timer behavior
  __system__/            # System/live tests (16 files)
    *.system.test.ts     # End-to-end flows with mocked externals
    *.live.test.ts       # Real API/channel tests (credential-gated)
  [module]/
    foo.ts               # Source module
    foo.test.ts          # Colocated unit test
```

### Running specific tiers

```bash
pnpm test                 # Unit only (128 files, ~5s)
pnpm test:integration     # Integration only (20 files, ~2s)
pnpm test:e2e             # System tests
pnpm test:live            # Live tests (needs credentials)
pnpm test:all             # All tiers sequentially
pnpm test:coverage        # Unit + V8 coverage report
```

### Current inventory (2026-02-15)

| Category          | Files    | Tests       |
| ----------------- | -------- | ----------- |
| Unit tests        | 128      | 1,356       |
| Integration tests | 20       | 102         |
| System/live tests | 16       | ~50         |
| Test helpers      | 9        | —           |
| **Total**         | **~166** | **~1,500+** |
