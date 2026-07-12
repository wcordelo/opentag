# State Layer Audit — Phase 7

Audit of `lib/research/migrations/001_initial.sql` and `lib/research/adapters/storage-do.ts`
against the tables/methods required by OpenTag 2.0 (agent containers, handoffs, execution
logs, GitHub artifacts). Produced as part of Task 7.1; the gaps identified here are the ones
closed by Tasks 7.2–7.4 (now implemented).

## 1. Missing tables (now added in `002_agent_pipeline.sql`)

| Table | Purpose | Status |
|---|---|---|
| `agent_containers` | Tracks PM/Impl/Verify container lifecycle: `container_id`, `session_id`, `flavor`, `status`, `preview_url`, `started_at`, `killed_at`. Backs `ContainerManager` (Phase 4). | Added |
| `agent_handoffs` | Records inter-agent handoffs: `from_session_id` → `to_session_id`, `round`, `compressed_tokens`, `validated`, `created_at`. Backs the context-hardening handoff loop (Phase 6). | Added |
| `agent_execution_logs` | Per-tool-call execution trace inside a container: `session_id`, `container_id`, `step`, `tool_name`, `request`/`response` (JSON as TEXT), `duration_ms`, `created_at`. Distinct from `research_log`, which only tracks the research fiber, not agent-container tool calls. | Added |
| `github_artifacts` | PR/commit/branch artifacts produced by the impl agent per session. | Added |

None of these four tables existed in `001_initial.sql`. All four are now defined in
`lib/research/migrations/002_agent_pipeline.sql` with `CREATE TABLE IF NOT EXISTS` plus a
`session_id` index (and an additional `container_id` index on `agent_execution_logs`, since
containers query their own trace independent of session).

## 2. Missing `StorageAdapter` methods (now added)

None of the following existed on the `StorageAdapter` interface or on
`DurableObjectStorageAdapter` prior to this change:

| Method | Notes |
|---|---|
| `createAgentContainer(record)` | Insert into `agent_containers`. |
| `getAgentContainer(containerId)` | Point lookup by primary key. |
| `updateAgentContainerStatus(containerId, status, fields?)` | Simple `UPDATE` (no OCC version check needed — container status is single-writer per container, unlike `session_state`). |
| `appendHandoff(record)` | Insert into `agent_handoffs`. |
| `getHandoffs(sessionId)` | Returns handoffs where the session is either the source or the target, ordered by round. |
| `appendExecutionLog(entry)` | Insert into `agent_execution_logs`. |
| `getExecutionLogs(sessionId, limit?)` | Ordered by `created_at`, capped by `limit` (default 100), mirroring `getLogs` on `research_log`. |
| `appendGithubArtifact(record)` | Insert into `github_artifacts`. No read method requested by 2.0 phases so far; artifacts are read via direct SQL/dashboard tooling if needed. |

Implemented in:
- `lib/research/adapters/storage-do.ts` (parameterized `this.sql.exec(...)`, snake_case columns mapped to camelCase records).
- `lib/research/adapters/storage-memory.ts` (in-memory `Map`/array-backed, for unit tests).
- `lib/research/adapters/storage-postgres.ts` (stubs that `throw new Error("not implemented on Railway")` — the Railway/Postgres track does not run the agent-container pipeline; only the Cloudflare DO track does).

## 3. Bug fixed while auditing: snake_case → camelCase mapping

`DurableObjectStorageAdapter.getTask` / `getTasksByThread` previously cast raw SQL rows
(`task_id`, `thread_key`, `created_at`, `deadline_at`, `event_ts`, `event_id`, `metadata` as a
JSON string) directly to `TaskRecord` without mapping fields or parsing `metadata`. This meant
`task.taskId`, `task.threadKey`, etc. were `undefined` at runtime despite type-checking, and
`metadata` was a raw string instead of a parsed object. Fixed by adding `mapTaskRow()` which
translates every column and `JSON.parse`s `metadata`.

The same class of bug existed on `getPendingDeliveries` (`delivery_obligations` rows have
`thread_key` and a JSON-string `payload`, not `threadKey`/parsed `payload`). Fixed with a
parallel `mapDeliveryRow()` helper. `appendDeliveryObligation`/`appendTask`/etc. (write paths)
were already correct since they explicitly name columns and JSON-stringify.

## 4. Existing tables/methods reused unchanged

Everything from `001_initial.sql` is reused as-is by 2.0 — no schema changes were required for:

- `session_state` — `getSession` / `createSession` / `updateSession` (OCC).
- `research_log` — `appendLog` / `updateLogStatus` / `getLastLog` / `getLogs`.
- `verified_facts`, `fact_edges` — `upsertFact` / `getFacts` / `addFactEdge`.
- `outbox` — `appendOutbox` / `getPendingOutbox` / `markOutboxSent`.
- `processed_requests`, `processed_slack_events` — idempotency guards.
- `tasks` — `createTask` / `getTask` / `updateTaskStatus` / `getTasksByThread` (mapping bug fixed, see §3; no schema change).
- `delivery_obligations` — `appendDeliveryObligation` / `getPendingDeliveries` / `markDeliveryDelivered` (mapping bug fixed, see §3; no schema change).
- `alarm_queue` — `enqueueAlarm` / `getDueAlarms` / `deleteAlarm`.
- `blob_storage` — `storeBlobRef` / `getBlobRef`.
- `verification_cache` — `getVerificationCache` / `setVerificationCache`.
- `schema_migrations` — migration bookkeeping (Postgres track only; the Cloudflare DO track has its own idempotent `runMigrations()` in `edge/workers/orchestrator/src/schema.ts`, which already applies an equivalent `MIGRATION_002` inline — `002_agent_pipeline.sql` is the canonical/audit copy shared by the Postgres and generic-SQLite tracks).

## 5. Types added

`lib/research/types.ts` gained `AgentFlavor`, `AgentContainerStatus`,
`AgentContainerRecord`, `AgentHandoffRecord`, `AgentExecutionLogEntry`, and
`GithubArtifactRecord`, matching the columns above.

## 6. Sign-off

This audit and the schema/methods it specifies are implemented as of this change
(Tasks 7.1–7.4 combined). No further schema gaps are known for the agent-container
pipeline at this time; future phases (compression stats, escalation records) may need
additional columns/tables, to be audited separately when those phases start.
