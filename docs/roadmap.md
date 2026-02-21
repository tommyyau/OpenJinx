# OpenJinx Product Roadmap

> **Updated:** 2026-02-19
> **Status:** Active
> **Planning rule:** Marathon remains the active top priority until complete.

---

## Priority Stack

| #   | Initiative                                          | Priority           | Status      | PRD / Source                                           |
| --- | --------------------------------------------------- | ------------------ | ----------- | ------------------------------------------------------ |
| 1   | **Marathon Agent — Overnight Autonomous Coding**    | P0                 | In progress | [prd-marathon-agent.md](./prd-marathon-agent.md)       |
| 2   | **Knowledge Ingestion + Multimodal Intelligence**   | P0 (post-Marathon) | Planned     | This roadmap section                                   |
| 3   | **Delegated Actions + Personal Operator Workflows** | P0 (post-Marathon) | Planned     | This roadmap section                                   |
| 4   | **Trust, Governance, and Safety Guardrails**        | P1 (post-Marathon) | Planned     | [security-audit-report.md](./security-audit-report.md) |
| 5   | **Reliability + Operator Control Plane**            | P1 (post-Marathon) | Planned     | [prd-marathon-agent.md](./prd-marathon-agent.md)       |
| 6   | **Onboarding V2 (Guided + Deterministic Setup)**    | P1 (post-Marathon) | Planned     | [prd-onboarding-v2.md](./prd-onboarding-v2.md)         |
| 7   | **Voice Interface**                                 | P2 (post-Marathon) | Not started | —                                                      |
| 8   | **Memory Portability + Data Governance**            | P2 (post-Marathon) | Not started | [prd-token-budgeting.md](./prd-token-budgeting.md)     |
| 9   | **MCP Bridge**                                      | P3 (deferred)      | Stub exists | —                                                      |

---

## 1. Marathon Agent — Overnight Autonomous Coding (P0)

**Vision**: "Tell Jinx to build an app. Go to sleep. Wake up to a working codebase."

**Status**: In implementation now. This remains the top priority until completed.

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

## 2. Knowledge Ingestion + Multimodal Intelligence (P0 Post-Marathon)

**Product outcome**: Jinx can ingest external knowledge (attachments + cloud docs), understand it, classify it, and answer with higher precision than generic semantic search.

**Why this is next**:

- "Know more about me" requires ongoing ingestion, not just chat memory.
- "Paste images/PDFs and use them immediately" requires first-class multimodal/document handling.
- "Quick query quality" improves when retrieval combines metadata/entity filtering with vector recall.

**Current baseline to build on**:

- Channel media exists for Telegram/WhatsApp ingestion paths.
- Vision input exists for supported image buffers.
- Memory retrieval already supports BM25 + vector hybrid.
- Composio integration exists and can be leveraged for Drive-adjacent connectors.

**Scope**:

- Add a unified ingestion pipeline for channel attachments and external sources.
- Prioritize Google Drive as first external document source (initially via Composio connector path).
- Support document parsing for PDF first, then DOCX and plain text.
- Add OCR path for image-only PDFs and standalone images.
- Add document classification + entity extraction before indexing.
- Add retrieval planner that uses metadata/entity filtering (SQL) before vector search fallback.

**Data model additions**:

- `documents` table: source, external id, mime, owner scope, timestamps, checksum, parse status.
- `document_chunks` table: chunk text, line/page spans, token estimate, embedding reference, chunk metadata.
- `document_entities` table: entity type, normalized value, confidence, source chunk/page.
- `document_links` table: relationship edges (person-project, customer-invoice, repo-prd, etc.).

**Retrieval strategy for fast/high-precision queries**:

- Step 1: intent parse and constraints extraction (entities, dates, source filters).
- Step 2: SQL filter over metadata/entities to narrow candidate docs.
- Step 3: hybrid retrieval (BM25 + vector) over candidate chunks.
- Step 4: rerank + grounded response with source references.

**Milestones**:

- **K1: Ingestion foundation (2-3 weeks)**
- Build ingestion job model + queue + status tracking.
- Implement PDF parser + OCR fallback for image-only pages.
- Implement Google Drive connector (read/list/sync subset) via existing integration framework.
- Ship manual "ingest this file/url" command path for deterministic testing.
- **K2: Retrieval intelligence (2-3 weeks)**
- Add metadata/entity extraction pipeline.
- Add SQL-first retrieval planner with vector fallback.
- Add query-time provenance in answers (file/page/chunk references).
- **K3: Quality + scale hardening (2 weeks)**
- Dedup strategy by checksum/version.
- Re-index policy for changed docs.
- Ingestion error handling/retry policy and operator diagnostics.

**Success criteria**:

- > =95% ingest success on supported PDF files under size limit.
- > =80% reduction in irrelevant retrieval chunks on entity-constrained queries.
- P95 retrieval latency under agreed target for "quick query" path.
- Clear observability: every document has status, errors, and last sync timestamp.

---

## 3. Delegated Actions + Personal Operator Workflows (P0 Post-Marathon)

**Product outcome**: Jinx can reliably "do work for the user" across connected systems, not just propose steps.

**Scope**:

- Introduce explicit task objects for delegated work (goal, constraints, approvals, status).
- Add approval checkpoints for high-risk/irreversible actions.
- Add action plans with verification steps before marking done.
- Use existing connector/tool ecosystem for execution (starting with high-value toolkits).
- Add scheduled/recurrent delegated jobs where useful.

**Execution model**:

- Plan -> approval gate -> execute -> verify -> summarize -> log.
- Every delegated task has structured status transitions and auditable events.
- Reusable runbook patterns for common flows (document triage, issue filing, status reporting, follow-up tasks).

**Milestones**:

- **A1: Delegated task v1 (2 weeks)**
- Task schema, lifecycle, and persistence.
- Approval API + chat UX for approve/reject/edit.
- Basic verification hooks (expected side effect checks).
- **A2: Connector-first operator flows (2-3 weeks)**
- First-class Google Drive + one work-management integration workflow.
- Trigger-based follow-up actions.
- **A3: Repeatable automations (2 weeks)**
- Recurring delegated jobs with safeguards.
- Failure routing and retry policy tuned for unattended runs.

**Success criteria**:

- > =90% of delegated tasks complete without manual intervention for supported flow templates.
- 100% of high-risk actions require and record explicit approval.
- Clear user trust signal: full action timeline available per task.

---

## 4. Trust, Governance, and Safety Guardrails (P1 Post-Marathon)

**Goal**: Make ingestion + delegated execution safe by default.

**Current security posture** (from [security-audit-report.md](./security-audit-report.md)): **0 vulnerable, 7 partially mitigated, 28 resolved** across 35 OpenClaw items. All Category 4 (prompt injection) items now mitigated or partially mitigated — injection detection wired in production, identity files protected, memory tools read-only, SSRF validated, untrusted content wrapped.

**Remaining operational hardening items** (all MEDIUM, accepted risk for now):

| Item | Description                              | Current State                                         |
| ---- | ---------------------------------------- | ----------------------------------------------------- |
| 3.3  | Plaintext `.env`                         | Blocked from mounts + agent file access               |
| 3.12 | Main session log accumulation            | Cron/subagent sessions reaped, transcripts capped     |
| 3.13 | No structured audit trail                | Basic logging + secret redaction exists                |
| 3.16 | Subagents inherit all parent tools       | Identity file protection added                        |

**Guardrail deliverables for post-Marathon**:

- Capability profiles for subagents and delegated task workers (least privilege by default).
- Structured audit trails for ingestion, retrieval decisions, approvals, and external actions.
- Configurable retention and redaction policies for logs/transcripts/artifacts.
- Optional keychain integration for credential storage.

**CI/CD**: Designed in [ci-cd-plan.md](./ci-cd-plan.md), pending implementation.

---

## 5. Reliability + Operator Control Plane (P1 Post-Marathon)

**Goal**: Keep long-running ingestion + delegation + marathon execution observable and recoverable.

**Deliverables**:

- Hardened marathon controls (`status`, `pause`, `resume`, `cancel`, `logs`)
- Strict execution locks and idempotency for chunk runners
- Restart-safe recovery semantics (checkpoint + scheduler + container state reconciliation)
- Budget and runtime guardrails (max time, retry policy, fail-fast boundaries)
- Operator diagnostics for "what is running, what failed, what retried, and why"
- Unified job observability across marathon tasks, ingestion tasks, and delegated tasks

---

## 6. Onboarding V2 (P1 Post-Marathon)

**Goal**: Make first-run setup deterministic, opinionated, and secure-by-default.

**Why this matters**:

- Current onboarding surfaces can drift (`onboard` bootstrap vs `/setup` guided flow).
- New users need key prerequisites up front, not discovered mid-setup.
- Setup should end in a clear readiness signal (`jinx doctor`) with remediation.

**Planned deliverables**:

- Canonical onboarding contract across CLI, docs, and skills.
- Clear separation of roles:
  - `jinx onboard` = bootstrap scaffolding
  - `/setup` = guided opinionated configuration
  - `jinx doctor` = readiness gate
- `jinx doctor --onboarding` blocker mode with concrete remediation output (implemented 2026-02-16).
- Explicit API key checklist (required vs optional) before setup steps.
- Secure channel defaults in guided flow (`allowlist` DM, groups disabled by default).
- Regression tests + doc consistency checks to prevent drift.

**PRD**: [docs/prd-onboarding-v2.md](./prd-onboarding-v2.md)

---

## 7. Voice Interface (P2 Post-Marathon)

Telegram and WhatsApp both support voice notes. Scope:

- Voice note transcription (Whisper API or similar)
- Text-to-speech responses
- Voice-first skill triggers

Status: Not started. Depends on selecting STT/TTS providers and cost envelope.

---

## 8. Memory Portability + Data Governance (P2 Post-Marathon)

Current memory: Markdown daily logs + SQLite (BM25) + OpenAI embeddings.
Already reasonably portable.

**Planned enhancements**:

- Token-aware context budgeting and compaction policy
- Cross-channel memory sync
- Export/import in standard format
- Per-user or per-agent memory namespacing options
- Memory write validation (overlaps with security item 4.4)

---

## 9. MCP Bridge (P3 — Deferred)

Stub exists at `src/agents/tools/mcp-bridge.ts`. Returns `[]`.

**Rationale for deferral**: Composio already provides 800+ cloud SaaS integrations
with managed auth, trigger subscriptions, and production-ready tooling (724 LOC, 8 tools).
MCP's value-add is local tool servers and community MCP server ecosystem — not needed
for current use cases.

**Revisit when**: Community MCP servers offer capabilities Composio doesn't
(e.g., IDE integration, local database tools).

---

## Post-Marathon Sequencing

1. Finish Marathon and stabilize.
2. Build K1 + K2 (ingestion + retrieval intelligence).
3. Build A1 (delegated task lifecycle + approvals).
4. Ship trust guardrails needed for K/A rollout.
5. Scale with reliability/operator controls.
6. Ship Onboarding V2 as the operator growth layer after core execution capabilities are stable.

---

## Cleanup Backlog

Minor dead config fields (will get picked up in future security/QA passes):

- `logging.file` — schema has it, logger ignores it
- `embeddingProvider` — hardcoded to OpenAI
