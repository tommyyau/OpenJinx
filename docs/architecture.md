# Jinx Architecture

## System Overview

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Jinx Gateway                                 │
│                                                                      │
│  ┌─────────┐  ┌───────────┐  ┌──────────┐  ┌──────────────────────┐│
│  │Terminal  │  │ Telegram  │  │ Gateway  │  │   CLI Commands       ││
│  │ Channel  │  │ Channel   │  │ WebSocket│  │ (send, gateway, etc) ││
│  └────┬─────┘  └─────┬─────┘  └────┬─────┘  └──────────┬───────────┘│
│       │               │             │                    │           │
│       └───────────────┴─────────────┴────────────────────┘           │
│                               │                                      │
│                    ┌──────────▼──────────┐                           │
│                    │   Dispatch Pipeline  │                           │
│                    │  (routing + access   │                           │
│                    │   + classification)  │                           │
│                    └───┬────────────┬────┘                           │
│                   quick│            │deep                            │
│                        │    ┌───────▼───────┐                        │
│                        │    │   Deep Work   │                        │
│                        │    │  (async bg,   │                        │
│                        │    │  fire+forget) │                        │
│                        │    └───────┬───────┘                        │
│                        │            │                                │
│                    ┌───▼────────────▼────┐                           │
│                    │    Agent Runner      │                           │
│                    │  (resolve + tools)   │                           │
│                    └──────────┬──────────┘                           │
│                               │                                      │
│    ┌──────────────────────────┼──────────────────────────┐           │
│    │                          │                          │           │
│    ▼                          ▼                          ▼           │
│ ┌──────┐              ┌──────────┐              ┌──────────┐        │
│ │Tools │              │  Claude   │              │ Memory   │        │
│ │      │              │ Provider  │              │ System   │        │
│ └──────┘              └──────────┘              └──────────┘        │
│                                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────┐       │
│  │  Heartbeat   │  │ Cron Service │  │   Session Store      │       │
│  │  Runner      │  │              │  │                      │       │
│  └──────────────┘  └──────────────┘  └──────────────────────┘       │
└──────────────────────────────────────────────────────────────────────┘
```

## Provider Stack

```
┌─────────────────────────────────────────────────┐
│              Claude (Anthropic API)              │
│                                                  │
│  Brain:    Opus    — Main agent turns            │
│  Subagent: Sonnet  — Subagent/tool tasks         │
│  Light:    Haiku   — Heartbeat, cron, summaries  │
├─────────────────────────────────────────────────┤
│  OpenAI (Embeddings API)                         │
│  text-embedding-3-small — Memory vector search   │
├─────────────────────────────────────────────────┤
│  OpenRouter → Perplexity Sonar                   │
│  perplexity/sonar-pro — Web search tool          │
├─────────────────────────────────────────────────┤
│  Composio SDK → 800+ external services           │
│  GitHub, Slack, Gmail, Linear, Notion, etc.      │
│  + Pusher triggers (real-time inbound events)    │
└─────────────────────────────────────────────────┘
```

## Channel Flow

```
Telegram message
  → TelegramMonitor (long-polling)
  → buildMsgContext()
  → checkTelegramAccess (dmPolicy, groupPolicy, allowedChatIds)
  → dispatchTelegramMessage()
    → dispatchInboundMessage() [pipeline/dispatch.ts]
      → classifyTask() [if not command and >= 20 chars]
        → "deep" → launchDeepWork() → ack + background execution
        → "quick" → normal flow (below)
      → acquireLane() [max 1 concurrent per session]
      → runAgent() [agents/runner.ts]
        → resolveAgent + resolveModel (scope.ts)
        → loadWorkspaceFiles → filterForSession → trim
        → assembleDefaultTools (core, memory, channel, cron, web)
        → loadSkillEntries → buildSkillSnapshot
        → buildRagContext (memory pre-search)
        → loadHistory (transcript → MAX_HISTORY_TURNS)
        → appendTranscriptTurn (user)
        → callProvider (claude-provider.ts)
        → appendTranscriptTurn (assistant)
      → releaseLane()
  → TelegramStreamWriter (edit-message approach)
  → sendMessageTelegram() + sendTelegramMedia() [for attachments]
```

## Memory Flow

```
Write path:
  memory_write tool → fs.writeFile to memoryDir
                    → MemorySearchManager.refreshIndex()
                    → chunkFile() → BM25 index + vector embed

Search path (RAG):
  User prompt → buildRagContext()
             → MemorySearchManager.search()
               → BM25 search (term frequency)
               → Vector search (cosine similarity via OpenAI embeddings)
               → Hybrid merge (vectorWeight=0.7)
             → Format as "# Relevant Memory" section
             → Append to system prompt
```

## Heartbeat Flow

```
HeartbeatRunner.tick()
  → Check: enabled? running? nextDueMs? activeHours?
  → preFlightCheck: pending events? actionable HEARTBEAT.md?
  → runAgent(tier: "light") [Haiku]
  → Classify: HEARTBEAT_OK? empty? duplicate?
  → emitHeartbeatEvent()
  → onHeartbeatEvent listener (startup.ts)
    → shouldDeliver(visibility)?
    → isAcknowledgment()?
    → emitStreamEvent to terminal session
  → scheduleNext()
```

## Deep Work Flow

```
Inbound message (any channel)
  → dispatchInboundMessage() [pipeline/dispatch.ts]
    → Skip if command or < 20 chars
    → classifyTask(text, haiku) [pipeline/classifier.ts]
      → Single Haiku turn, ~200ms
      → extractJson() handles markdown-fenced responses
      → On error/malformed → fallback to "quick"
    → If "quick" → normal lane dispatch (unchanged)
    → If "deep":
      → emitStreamEvent(originSessionKey, ack)
        → Channel subscriber picks up ack immediately
      → launchDeepWork() [pipeline/deep-work.ts] (fire-and-forget)
        → Creates isolated session: deepwork:{8-char-uuid}
        → runAgent(tier: "brain", 15min timeout)
          → Full tool set: container, web search, memory, cron
          → Delivery note appended to prompt:
            "Include FULL content inline, don't just write to files"
        → extractWrittenFiles()
          → Scans AgentResult.messages for write tool calls
          → Reads each file from disk → OutboundMedia[]
        → deliverOutboundPayloads()
          → Text chunked + delivered to originating channel
          → Written files sent as document attachments
          → Fallback: terminal if channel unavailable
      → Return empty (user unblocked)

Session lifecycle:
  → deepwork: sessions are ephemeral
  → SessionReaper sweeps after 24h (same as cron: sessions)
  → Transcript persisted at ~/.jinx/sessions/deepwork_{uuid}.jsonl
```

## Composio Tool Flow

```
Agent needs to interact with external service (GitHub, Linear, etc.)
  → composio_search(query, toolkit)
    → withTimeout(client.tools.getRawComposioTools(), timeoutMs)
    → Client-side scoring + ranking
    → Returns slugs for matching tools
  → composio_check_connection(toolkit)
    → withTimeout(client.connectedAccounts.list(), timeoutMs)
    → Returns connected: true/false
  → If not connected:
    → composio_connect(toolkit)
      → withTimeout(client.authConfigs.list/create(), timeoutMs)
      → withTimeout(client.connectedAccounts.initiate(), timeoutMs)
      → Returns OAuth URL for user to visit
  → composio_execute(slug, arguments)
    → withTimeout(client.tools.execute(), timeoutMs)
    → Returns result data
    → On timeout: agent-friendly error with retry suggestion
    → On auth error: suggests composio_connect
```

## Composio Trigger Flow

```
Composio Cloud (Pusher)
         │
   outbound WebSocket (SDK manages connection)
         │
   triggers.subscribe(callback) [started at boot]
         │
   Callback fires when trigger event arrives
         │
   eventQueue.enqueue("[Trigger: LINEAR_ISSUE_CREATED] ...")
         │
   requestHeartbeatNow(agentId, "composio-trigger")
         │
   Heartbeat wakes → prependSystemEvents() → agent sees the event
```

Agent-side trigger management:

```
composio_trigger_create(slug, config)
  → withTimeout(client.triggers.create(), timeoutMs)
  → Returns triggerId

composio_trigger_list()
  → withTimeout(client.triggers.listActive(), timeoutMs)
  → Returns active triggers

composio_trigger_delete(triggerId)
  → withTimeout(client.triggers.delete(), timeoutMs)
```

## Cron Flow

```
CronService
  → CronTimer.tick() [every ≤60s]
  → Find due jobs (nextRunAt ≤ now)
  → executeJobCore(job, runTurn)
    → If isolated: runAgent(tier: "light") → stream to terminal
    → If not isolated: eventQueue.enqueue() → next heartbeat
  → Update: lastRunAt, nextRunAt, failCount
  → One-shot (at): disable after success
  → Backoff: exponential on failure, disable after 3
```

## Boot Sequence

```
1. loadDotEnv()              — Load ~/.jinx/.env
2. loadAndValidateConfig()   — Parse + validate ~/.jinx/config.yaml
3. setLogLevel()             — Wire config.logging.level
4. ensureWorkspace()         — Create ~/.jinx/workspace/ structure
4a. ensureTasksRoot()        — Create ~/.jinx/tasks/ (task output root)
5. mkdir memoryDir           — Create ~/.jinx/memory/
6. MemorySearchManager       — BM25 + optional vector search
7. createContainerManager()  — Apple Container sandbox (if ready)
8. createSessionStore()      — Load persisted sessions
9. HeartbeatRunner           — Register agents, start timer
10. onHeartbeatEvent         — Subscribe delivery to channels
11. CronService              — Load persisted jobs, start timer
12. startTriggerSubscriber() — Composio Pusher triggers (if enabled)
13. createGatewayServer()    — WebSocket on 127.0.0.1:18790
14. createTelegramChannel()  — Long-polling or webhook (if configured)
15. createWhatsAppChannel()  — Baileys (if configured)
16. SessionReaper            — Sweeps cron: and deepwork: sessions
17. startSkillRefresh()      — Hot-reload skill watcher
18. Memory wiring validation — Log status
```

## Directory Layout

```
~/.jinx/
├── .env                   # API keys
├── config.yaml            # Jinx configuration (Zod-validated)
├── workspace/             # Agent identity files (persistent)
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── MEMORY.md
│   ├── TOOLS.md
│   ├── AGENTS.md
│   ├── HEARTBEAT.md
│   └── BOOTSTRAP.md
├── tasks/                 # Scoped task outputs (per-session, cleanable)
│   ├── chat-telegram-dm-12345/
│   ├── deepwork-a1b2c3d4/
│   └── marathon-e5f6g7h8/
├── marathon/              # Checkpoint JSON files
├── sessions/              # JSONL transcripts
├── memory/                # Daily logs + embedding index
└── skills/                # Custom skill definitions
```

## What's Live vs. Stubbed

| Component         | Status      | Notes                                                           |
| ----------------- | ----------- | --------------------------------------------------------------- |
| Terminal channel  | Live        | TUI with streaming                                              |
| Telegram channel  | Live        | Long-polling + edit-message streaming + media delivery          |
| WhatsApp channel  | Live        | Baileys adapter with media send/receive                         |
| Claude provider   | Live        | Opus/Sonnet/Haiku via OAuth or API key                          |
| Memory (BM25)     | Live        | File chunking + term search                                     |
| Memory (vector)   | Live        | OpenAI embeddings (needs OPENAI_API_KEY)                        |
| Heartbeat runner  | Live        | Pre-flight, dedup, visibility                                   |
| Cron service      | Live        | Persistence, backoff, expression parser                         |
| Cron tools        | Live        | create/list/update/delete via agent                             |
| Web search        | Live        | Perplexity Sonar via OpenRouter                                 |
| Skills system     | Live        | SKILL.md loader + snapshot                                      |
| Gateway WebSocket | Live        | Typed protocol                                                  |
| Deep work         | Live        | Haiku classifier + async Opus executor + file attachments       |
| Sandbox           | Live        | Apple Container (macOS 26+), idle cleanup, timeouts             |
| Composio          | Live        | 800+ external integrations with timeout + trigger subscriptions |
| Marathon agent    | In progress | Checkpoint/resume, chunked execution, container lifecycle       |
| Token budgeting   | Not started | Fixed MAX_HISTORY_TURNS=40                                      |
| Subagent runtime  | Not started | Tier exists, no orchestration                                   |
| Channel tools     | Stubbed     | Schema defined, no wiring                                       |
