# OpenJinx Product Roadmap

> **Updated:** 2026-02-15
> **Status:** Active

---

## Priority Stack

| #   | Initiative                                       | Priority                   | Status      | PRD                                                    |
| --- | ------------------------------------------------ | -------------------------- | ----------- | ------------------------------------------------------ |
| 1   | **Marathon Agent — Overnight Autonomous Coding** | P0                         | Planning    | [prd-marathon-agent.md](./prd-marathon-agent.md)       |
| 2   | **Security Hardening**                           | P1 (important, not urgent) | Ongoing     | [security-audit-report.md](./security-audit-report.md) |
| 3   | **Voice Interface**                              | P2                         | Not started | —                                                      |
| 4   | **Memory Portability**                           | P2                         | Not started | —                                                      |
| 5   | **MCP Bridge**                                   | P3 (deferred)              | Stub exists | —                                                      |

---

## 1. Marathon Agent — Overnight Autonomous Coding (P0)

**Vision**: "Tell Jinx to build an app. Go to sleep. Wake up to a working codebase."

**Key deliverables**:

- Persistent Apple Container lifecycle (no idle eviction for marathon tasks)
- Checkpoint/resume framework with JSON persistence
- Cron-based chunked execution (sequential chunks, each a full agent turn)
- Progress reporting to user's messaging channel
- User controls: status, pause, resume, cancel

**Approach**: Test-driven. Tests written first, implementation done when tests pass.

**Effort**: ~4 weeks across 3 phases (foundation → orchestration → controls)

**Details**: [docs/prd-marathon-agent.md](./prd-marathon-agent.md)

---

## 2. Security Hardening (P1)

**Status**: Audit complete. 1 vulnerable item remaining (memory write poisoning).
3 items mitigated but with residual risk.

**Open items** (from [security-audit-report.md](./security-audit-report.md)):

| Severity | Item | Description                                             |
| -------- | ---- | ------------------------------------------------------- |
| HIGH     | 4.4  | Memory write content not validated — poisoning possible |
| MEDIUM   | 3.3  | API keys stored in plaintext `.env`                     |
| MEDIUM   | 3.12 | Main session logs accumulate indefinitely               |
| MEDIUM   | 3.13 | No structured audit trail                               |
| MEDIUM   | 3.16 | Subagents inherit all parent tools                      |
| MEDIUM   | 4.1  | Injection detection is log-only, not blocking           |
| MEDIUM   | 4.2  | Anti-extraction is LLM-layer only                       |

**CI/CD**: Designed in [ci-cd-plan.md](./ci-cd-plan.md), not yet implemented.

---

## 3. Voice Interface (P2)

Telegram and WhatsApp both support voice notes. Scope:

- Voice note transcription (Whisper API or similar)
- Text-to-speech responses
- Voice-first skill triggers

Not started. Depends on identifying the right STT/TTS providers.

---

## 4. Memory Portability (P2)

Current memory: Markdown daily logs + SQLite (BM25) + OpenAI embeddings.
Already reasonably portable.

**Potential enhancements**:

- Token-aware context budgeting (replace hardcoded `MAX_HISTORY_TURNS=40`)
- Cross-channel memory sync
- Export/import in standard format
- Memory write validation (overlaps with security item 4.4)

---

## 5. MCP Bridge (P3 — Deferred)

Stub exists at `src/agents/tools/mcp-bridge.ts`. Returns `[]`.

**Rationale for deferral**: Composio already provides 800+ cloud SaaS integrations
with managed auth, trigger subscriptions, and production-ready tooling (724 LOC, 8 tools).
MCP's value-add is local tool servers and community MCP server ecosystem — not needed
for current use cases.

**Revisit when**: Community MCP servers offer capabilities Composio doesn't
(e.g., IDE integration, local database tools).

---

## Cleanup Backlog

Minor dead config fields (will get picked up in future security/QA passes):

- `logging.file` — schema has it, logger ignores it
- `embeddingProvider` — hardcoded to OpenAI
