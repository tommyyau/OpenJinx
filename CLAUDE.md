# CLAUDE.md

This file provides guidance to Claude Code when working with the OpenJinx codebase.

## Project Overview

OpenJinx is a local-first, multi-channel AI assistant powered by the Claude Agent SDK. The assistant's name is **Jinx**. It connects to messaging platforms (Telegram, WhatsApp, terminal) through a WebSocket gateway, with autonomous heartbeat monitoring, cron scheduling, hybrid memory search, deep work async execution, and a skills framework.

Runtime data lives at `~/.jinx/` (config, sessions, memory, WhatsApp auth, workspace files).

## Essential Commands

```bash
pnpm install              # Install dependencies
pnpm dev                  # Run via tsx (no build needed)
pnpm dev -- gateway       # Start WebSocket gateway
pnpm dev -- chat          # Interactive terminal chat
pnpm dev -- doctor        # System health check
pnpm dev -- onboard       # First-time setup wizard
pnpm build                # Production build (tsdown → dist/)
pnpm check                # Pre-commit: format check + type check + lint (REQUIRED before commits)
pnpm format               # Auto-format with oxfmt
pnpm lint                 # Lint with oxlint
pnpm lint:fix             # Auto-fix lint issues + reformat
```

## Testing

Multi-tier test architecture with Vitest:

```bash
pnpm test                 # Unit tests
pnpm test:integration     # Integration tests (subsystem boundaries)
pnpm test:e2e             # System tests (end-to-end flows)
pnpm test:all             # All three tiers sequentially
pnpm test:coverage        # Unit tests with V8 coverage report
pnpm test:watch           # Watch mode
pnpm test:live            # Live API integration tests (needs credentials)
```

Run a single test file:

```bash
npx vitest run src/path/to/file.test.ts
```

Test files are colocated: `foo.ts` → `foo.test.ts`. Integration tests: `src/__integration__/`. System tests: `src/__system__/`. Shared helpers: `src/__test__/`.

Coverage thresholds enforced: 70% lines/functions/statements, 65% branches.

Current test inventory: **155 unit test files (1,619 tests), 24 integration test files (130 tests), 19 system/live test files**. Coverage: ~90% statements, ~78% branches, ~91% functions.

High-signal integration suites:

- `src/__integration__/startup-lifecycle.integration.test.ts` (startup/shutdown hooks + webhook wiring + wake path)
- `src/__integration__/cron-service-timer.integration.test.ts` (timer/backoff behavior at service level)
- `src/__integration__/dispatch-streaming-order.integration.test.ts` (stream event ordering and lane behavior)
- `src/__integration__/dispatch-timeout-lane.integration.test.ts` (timeout recovery and lane isolation under hung turns)
- `src/__integration__/startup-cron-routing.integration.test.ts` (cron routing: direct delivery, fallback, and wake enqueueing)
- `src/__integration__/startup-composio-routing.integration.test.ts` (Composio trigger startup wiring, routing to heartbeat, and unsubscribe teardown)
- `src/__integration__/gateway-lifecycle.integration.test.ts` (WebSocket server+client handshake, auth rejection, concurrent sessions)
- `src/__integration__/whatsapp-inbound.integration.test.ts` (WhatsApp dispatch + access control simulation)
- `src/__integration__/telegram-inbound.integration.test.ts` (Telegram dispatch + access control simulation)
- `src/__integration__/pipeline-delivery.integration.test.ts` (pipeline delivery, session auto-creation, streaming events)
- `src/__integration__/session-lanes.integration.test.ts` (lane serialization and cross-session independence)
- `src/__integration__/startup-http-webhook-auth.integration.test.ts` (startup HTTP webhook auth + Telegram webhook routing via real HTTP server)
- `src/__integration__/startup-wake-retry.integration.test.ts` (wake coalescing, retry ceilings, and shutdown cancellation for pending retries)
- `src/__integration__/heartbeat-delivery-routing.integration.test.ts` (heartbeat chunked delivery routing, fallback-to-terminal, and suppression behavior)
- `src/__integration__/marathon-executor.integration.test.ts` (marathon chunk execution, checkpoint persistence, abort handling)
- `src/__integration__/marathon-checkpoint-resume.integration.test.ts` (checkpoint save/load, resume from failure, status transitions)
- `src/__integration__/marathon-container-lifecycle.integration.test.ts` (persistent container allocation, no idle eviction during marathon)
- `src/__integration__/marathon-tool-assembly.integration.test.ts` (marathon-specific tool wiring and sandbox integration)

## Tech Stack & Conventions

- **Runtime**: Node >= 22.12.0
- **Language**: TypeScript, strict mode, ESM-only (`"type": "module"`)
- **Package manager**: pnpm
- **Build**: tsdown → `dist/`
- **Lint/format**: Oxlint + Oxfmt (not ESLint/Prettier)
- **Tests**: Vitest 4 with V8 coverage, forks pool
- **CLI framework**: Commander
- **Validation**: Zod
- **LLM**: Claude Agent SDK (`@anthropic-ai/sdk`)
- **Channels**: grammY (Telegram), Baileys (WhatsApp)

### Import Rules

- Use `import type { X }` for type-only imports
- Avoid `any` types (`typescript/no-explicit-any` is enforced)

### Code Style

- Keep files under ~700 LOC; extract helpers when larger
- Before creating any utility/helper, search for existing implementations first
- Always add tests for new functionality — no exceptions

## Architecture

### Source Layout (`src/`)

| Directory    | Purpose                                                                   |
| ------------ | ------------------------------------------------------------------------- |
| `agents/`    | Agent runtime — system prompt, runner, tools, subagent registry           |
| `channels/`  | Channel adapters — `telegram/` (grammY), `whatsapp/` (Baileys)            |
| `cli/`       | CLI commands (chat, gateway, onboard, doctor, send, skills, etc.)         |
| `composio/`  | Composio integration — trigger subscriptions                              |
| `config/`    | Config loading (YAML/JSON5), Zod schema validation, defaults              |
| `cron/`      | Cron scheduler — jobs, timer, executor, backoff, store                    |
| `delivery/`  | Outbound message delivery — targeting, chunking                           |
| `events/`    | System event queue — formatting, consumption                              |
| `gateway/`   | WebSocket gateway — server, client, protocol, startup                     |
| `heartbeat/` | Autonomous heartbeat — runner, visibility, dedup, active hours, preflight |
| `infra/`     | Shared utilities — logging, env detection, home dir, time formatting      |
| `markdown/`  | Markdown processing — chunking, fence detection, IR, rendering            |
| `memory/`    | Memory system — daily logs, hybrid search, embeddings, index manager      |
| `pipeline/`  | Message pipeline — dispatch, lanes, streaming, classifier, deep work      |
| `providers/` | LLM provider — Claude SDK, auth (OAuth/API key/Keychain), models          |
| `sandbox/`   | Code execution — Apple Container manager, mount security                  |
| `sessions/`  | Session management — store, locks, transcripts, compaction, reaper        |
| `skills/`    | Skills framework — loader, parser, eligibility, dispatch, env overrides   |
| `tui/`       | Terminal UI — chat log, status bar, stream assembler                      |
| `types/`     | TypeScript type definitions                                               |
| `workspace/` | Workspace — bootstrap, loader, filter, trim, task-dir, templates          |

### Key Data Flow

1. **Inbound message** → Channel adapter (terminal/Telegram/WhatsApp) receives message
2. **Pipeline** (`pipeline/dispatch.ts`) resolves session, acquires lane lock (max 1 concurrent per session)
3. **Classifier** (`pipeline/classifier.ts`) routes quick vs deep work
4. **Agent runtime** (`agents/runner.ts`) loads workspace files, builds system prompt, calls Claude Agent SDK
5. **Tools** execute during the agent turn (memory, cron, exec, web search, etc.)
6. **Delivery** (`delivery/deliver.ts`) sends response back through the originating channel
7. **Heartbeat** (`heartbeat/runner.ts`) runs autonomously on a timer
8. **Cron** (`cron/service.ts`) fires scheduled jobs as isolated agent turns

### Key Architectural Patterns

- **Session lanes** (`pipeline/lanes.ts`): max 1 concurrent agent turn per session key
- **Streaming**: `emitStreamEvent`/`subscribeStream` pub-sub per session key (`pipeline/streaming.ts`)
- **Claude provider**: uses `stream: false` — full response per turn
- **Conversation history**: runner loads transcript via `readTranscript()`, passes as `history` to provider. MAX_HISTORY_TURNS=40
- **Config**: `~/.jinx/config.yaml`, Zod-validated, merged with defaults
- **Workspace isolation**: Identity files (SOUL.md, etc.) in `~/.jinx/workspace/`, task outputs scoped to `~/.jinx/tasks/{type}-{id}/`

### Intentional Stubs

Two features return `[]` by design (future work):

- **MCP Bridge** (`agents/tools/mcp-bridge.ts`) — placeholder for MCP tool forwarding
- **Channel cross-messaging tools** — placeholder for cross-channel message routing

## CI/CD and GitHub

Before pushing to GitHub or creating a public repository, read `docs/ci-cd-plan.md` and follow the pre-push checklist. It covers: secret scanning, GitHub Actions workflow setup, branch protection rules, and which test tiers to gate on.

## Security

Security audit report: `docs/security-audit-report.md` — validates all 35 items from the OpenClaw vulnerability register against Jinx. Scorecard: 28 resolved, 7 partially mitigated, 0 vulnerable. The source vulnerability register: `docs/security-checks.md`.

Key security files:

- `src/infra/security.ts` — Path validation, SSRF protection, env filtering, injection detection, secret redaction, content wrapping
- `src/sandbox/mount-security.ts` — Blocked mount patterns for containers (.ssh, .env, .aws, credentials, etc.)
- `src/agents/tools/core-tools.ts` — File access confinement (allowedDirs), identity file write protection, injection audit on writes
- `src/agents/system-prompt.ts` — Anti-extraction directives, safety guidelines, untrusted content handling

## Lessons Learned

See `docs/lessons-learned.md` for detailed post-incident notes covering:

- WhatsApp multi-agent loop prevention
- Telegram streaming race conditions
- Test mock patterns and gotchas
- launchd service management pitfalls

## Skills

Skills live in `skills/<name>/SKILL.md` with flat YAML frontmatter. The loader (`src/skills/loader.ts`) scans directories and the parser (`src/skills/parser.ts`) reads key:value pairs. Supported fields: `name`, `display_name`, `description`, `required_bins`, `required_env`, `os`, `tags`.

The parser is a simple line-by-line splitter — not a full YAML parser. It only supports flat string fields.
