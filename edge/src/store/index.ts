/**
 * Durable Object + SQLite `StateStore` for `@copilotkit/channels` on Cloudflare.
 *
 * Layers (bottom → top):
 *   sql.ts                       — narrow SqlExecutor seam (portable/testable)
 *   schema.ts                    — DDL + migrations
 *   sql-state-engine.ts          — synchronous SQLite impl of the StateStore ops
 *   conversation-state-do.ts     — the Durable Object hosting the engine (RPC)
 *   partition.ts                 — key → DO instance routing
 *   durable-object-state-store.ts— the StateStore the bot consumes (RPC forwarder)
 */
export {
  ConversationStateDO,
  RenderObligationEngine,
  reconstructMarkdown,
} from "./conversation-state-do.js";
export type {
  RenderObligationRow,
  SessionEventsRpc,
} from "./conversation-state-do.js";
export {
  DurableObjectStateStore,
  createDurableObjectStore,
} from "./durable-object-state-store.js";
export type { DurableObjectStoreOptions } from "./durable-object-state-store.js";
export { singleGlobal, byConversationKey } from "./partition.js";
export type { Partitioner } from "./partition.js";
export { SqlStateEngine } from "./sql-state-engine.js";
export type { EngineDeps } from "./sql-state-engine.js";
export { migrate, SCHEMA_VERSION } from "./schema.js";
export type { StateStore } from "./state-store-contract.js";
export type { SqlExecutor, SqlCursor, SqlValue, TransactionRunner } from "./sql.js";
