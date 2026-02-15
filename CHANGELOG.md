# Changelog

## Unreleased

### Phase 2: Integration Test Suite

- Added `src/__integration__/startup-lifecycle.integration.test.ts` for startup/shutdown hook ordering, webhook registration, and wake-path validation.
- Added `src/__integration__/cron-service-timer.integration.test.ts` for service-level timer execution, stop semantics, and backoff/recovery behavior.
- Added `src/__integration__/dispatch-streaming-order.integration.test.ts` for same-session stream ordering and cross-session independence.
- Added `src/__integration__/dispatch-timeout-lane.integration.test.ts` for timeout recovery and lane isolation under hung turns.
- Added `src/__integration__/startup-cron-routing.integration.test.ts` for cron routing behavior (direct channel delivery, fallback delivery, and non-isolated wake enqueuing).
- Added `src/__integration__/startup-composio-routing.integration.test.ts` for Composio trigger startup wiring, trigger-to-heartbeat routing, API-key guard paths, and shutdown unsubscribe verification.
- Added `src/__integration__/startup-http-webhook-auth.integration.test.ts` for startup HTTP webhook auth enforcement and Telegram webhook routing through the real HTTP server boundary.
- Added `src/__integration__/startup-wake-retry.integration.test.ts` for startup wake coalescing, retry ceilings on unknown-agent wakes, and shutdown cancellation of pending wake retries.
- Added `src/__integration__/heartbeat-delivery-routing.integration.test.ts` for heartbeat delivery routing contracts: channel chunking, failure/unready fallback to terminal, and acknowledgment/visibility suppression.

### Phase 3: Branch Coverage + Live Channel Testing + Test Isolation

- Added test isolation infrastructure: `isSystemTest` flag on MsgContext, temp transcript paths, memory tool exclusion, classifier bypass.
- Added `src/__test__/live-cleanup.ts` for post-test artifact cleanup (transcripts, memory, sessions, embeddings).
- Added branch coverage tests: oversized transcripts, lane TTL eviction, lock expiration, session auto-creation, session reset error handling.
- Fixed bug in `src/pipeline/session-reset.ts`: unhandled `onSessionEnd()` error now caught and logged.
- Added `src/__integration__/gateway-lifecycle.integration.test.ts` for WebSocket server+client handshake, auth rejection/acceptance, concurrent sessions, and clean disconnect.
- Added `src/__integration__/whatsapp-inbound.integration.test.ts` for WhatsApp inbound dispatch simulation and access control.
- Added `src/__integration__/telegram-inbound.integration.test.ts` for Telegram inbound dispatch simulation and access control.
- Added `src/__integration__/pipeline-delivery.integration.test.ts` for pipeline delivery with session auto-creation.
- Added `src/__integration__/session-lanes.integration.test.ts` for lane serialization and cross-session independence.
- Added `src/__integration__/transcript-roundtrip.integration.test.ts` for transcript write/read roundtrip.
- Added `src/__integration__/memory-write-search.integration.test.ts` for memory log write and search.
- Added `src/__integration__/agent-skills.integration.test.ts` for agent skill loading and eligibility.
- Added `src/__integration__/compaction-chain.integration.test.ts` for transcript compaction chain.
- Added markdown IR tests: table rendering (3 modes), style edge cases (nesting, merging).
- Added `src/tui/chat-log.test.ts` for ChatLog data structure.
- Added live channel tests: `whatsapp-send.live.test.ts`, `telegram-send.live.test.ts`, `channel-health.live.test.ts`.
- Added live API tests: `claude-provider.live.test.ts`, `composio.live.test.ts`, `memory-embeddings.live.test.ts`.
- Raised coverage thresholds: lines/functions/statements 70%, branches 65%.
- Current: 128 unit test files (1,356 tests), 20 integration tests (102 tests), 16 system/live tests. Coverage: ~90% statements, ~78% branches.

### Documentation

- Updated testing documentation in `README.md`, `CLAUDE.md`, and `docs/testing-hardening-plan.md`.

## 0.1.0

Initial release — extracted from OpenClaw monorepo as a standalone project.

- Local-first, multi-channel AI assistant (Telegram, WhatsApp, terminal)
- Claude Agent SDK integration with OAuth and API key auth
- Hybrid memory search (semantic + keyword)
- Autonomous heartbeat monitoring
- Cron scheduling with backoff
- Deep work async task execution
- 11 bundled skills
- Composio integration (800+ external services)
- Apple Container sandbox (macOS 26+)
- Comprehensive automated test suite with coverage reporting
