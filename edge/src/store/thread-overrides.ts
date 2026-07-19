/**
 * Sticky thread-level model/harness overrides (GOAL.md Phase A3,
 * SPEC.md §2.2 + §5 Phase A3).
 *
 * Message-level flags are parsed by `extractMessageOverrides` (slack/overrides.ts).
 * This module layers sticky-per-thread persistence on top: a flag set once in a
 * thread applies to every later turn in that thread until overwritten by a new
 * flag. Last flag wins per field.
 *
 * Reasoning effort (`-rsn`) is not a runtime option in OpenTag. The parser
 * recognizes it only to strip and visibly reject it before this resolver is
 * called; it is never persisted or presented as active.
 */
import {
  extractMessageOverrides,
  harnessModelMismatchError,
} from "../slack/overrides.js";
import type { ChannelRuntimeDefaults } from "../config/access-bundle.js";
import type { RuntimeSelectionSource } from "../permissions/contract.js";
import type { StateStore } from "./state-store-contract.js";

export type StickyThreadOverrides = {
  model?: string;
  harnessType?: string;
  updatedAt: number;
};

export type ResolvedThreadOverrides = {
  /** Prompt text with all recognized flags stripped. */
  cleanedText: string;
  /** True if this message carried at least one recognized flag. */
  hasMessageFlags: boolean;
  /** Effective model for this turn: this message's flag, else the sticky value. */
  effectiveModel?: string;
  /** Effective harness for this turn: this message's flag, else the sticky value. */
  effectiveHarnessType?: string;
  /** Parsed rejected reasoning value; production validation stops before use. */
  effectiveReasoning?: string;
  harnessSource: RuntimeSelectionSource;
  modelSource: RuntimeSelectionSource;
};

const STICKY_TTL_MS = 30 * 86_400_000; // 30 days

export function threadOverridesKey(conversationKey: string): string {
  return `thread:overrides:${conversationKey}`;
}

/**
 * Parse `rawText` for inline flags, merge them onto the thread's sticky
 * overrides (last flag wins per-field, absent fields keep the stored value),
 * persist the merge best-effort, and resolve the effective model/harness.
 *
 * Read + write against `store.kv` are best-effort: a store failure logs a
 * warning and falls back to message-only overrides rather than failing the
 * turn.
 */
export async function resolveThreadOverrides(
  store: StateStore,
  conversationKey: string,
  rawText: string,
  channelDefaults?: ChannelRuntimeDefaults,
): Promise<ResolvedThreadOverrides> {
  const messageOverride = extractMessageOverrides(rawText);
  const hasMessageFlags = Boolean(
    messageOverride.model ||
      messageOverride.harnessType ||
      messageOverride.reasoning,
  );

  let sticky: StickyThreadOverrides | undefined;
  if (conversationKey) {
    try {
      sticky = await store.kv.get<StickyThreadOverrides>(
        threadOverridesKey(conversationKey),
      );
    } catch (err) {
      console.warn(
        "[thread-overrides] kv.get failed",
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (hasMessageFlags && conversationKey) {
    const merged: StickyThreadOverrides = {
      model: messageOverride.model ?? sticky?.model,
      harnessType: messageOverride.harnessType ?? sticky?.harnessType,
      updatedAt: Date.now(),
    };
    if (!harnessModelMismatchError(merged.harnessType, merged.model)) {
      try {
        await store.kv.set(
          threadOverridesKey(conversationKey),
          merged,
          STICKY_TTL_MS,
        );
        sticky = merged;
      } catch (err) {
        console.warn(
          "[thread-overrides] kv.set failed",
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  const effectiveModel =
    messageOverride.model ?? sticky?.model ?? channelDefaults?.model;
  const effectiveHarnessType =
    messageOverride.harnessType ??
    sticky?.harnessType ??
    channelDefaults?.harnessType;
  return {
    cleanedText: messageOverride.cleanedText,
    hasMessageFlags,
    effectiveModel,
    effectiveHarnessType,
    effectiveReasoning: messageOverride.reasoning,
    harnessSource: messageOverride.harnessType
      ? "explicit"
      : sticky?.harnessType
        ? "sticky"
        : channelDefaults?.harnessType
          ? "channel"
          : "deployment",
    modelSource: messageOverride.model
      ? "explicit"
      : sticky?.model
        ? "sticky"
        : channelDefaults?.model
          ? "channel"
          : "deployment",
  };
}
