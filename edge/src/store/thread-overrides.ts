/**
 * Sticky thread-level model/harness overrides (GOAL.md Phase A3,
 * SPEC.md §2.2 + §5 Phase A3).
 *
 * Message-level flags are parsed by `extractMessageOverrides` (slack/overrides.ts).
 * This module layers sticky-per-thread persistence on top: a flag set once in a
 * thread applies to every later turn in that thread until overwritten by a new
 * flag. Last flag wins per-field — a message that only sets `-rsn high` doesn't
 * clobber a previously-sticky `--opus`.
 *
 * Reasoning effort (`-rsn`) is deliberately NOT sticky — it is a per-turn knob
 * (matches centaur: StickyThreadOverrides there is Pick<..., 'harnessType' |
 * 'model' | 'provider'>, excluding reasoning).
 */
import { extractMessageOverrides } from "../slack/overrides.js";
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
  /** Reasoning effort for this turn only (never sticky). */
  effectiveReasoning?: string;
};

const STICKY_TTL_MS = 30 * 86_400_000; // 30 days

export function threadOverridesKey(conversationKey: string): string {
  return `thread:overrides:${conversationKey}`;
}

/**
 * Parse `rawText` for inline flags, merge them onto the thread's sticky
 * overrides (last flag wins per-field, absent fields keep the stored value),
 * persist the merge best-effort, and resolve the effective model/harness/
 * reasoning for this turn.
 *
 * Read + write against `store.kv` are best-effort: a store failure logs a
 * warning and falls back to message-only overrides rather than failing the
 * turn.
 */
export async function resolveThreadOverrides(
  store: StateStore,
  conversationKey: string,
  rawText: string,
  options?: { persist?: boolean },
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

  if (hasMessageFlags && conversationKey && options?.persist !== false) {
    const merged: StickyThreadOverrides = {
      model: messageOverride.model ?? sticky?.model,
      harnessType: messageOverride.harnessType ?? sticky?.harnessType,
      updatedAt: Date.now(),
    };
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

  return {
    cleanedText: messageOverride.cleanedText,
    hasMessageFlags,
    effectiveModel: messageOverride.model ?? sticky?.model,
    effectiveHarnessType: messageOverride.harnessType ?? sticky?.harnessType,
    effectiveReasoning: messageOverride.reasoning,
  };
}
