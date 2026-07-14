/** Exact durable lifecycle identity bound to one concrete Thread instance. */
export type TurnExecutionContext = Readonly<{
  threadKey: string;
  executionId: string;
}>;

let executionByThread = new WeakMap<object, TurnExecutionContext>();

export function bindTurnExecutionContext(
  thread: object,
  value: TurnExecutionContext,
): TurnExecutionContext {
  const exact = Object.freeze({
    threadKey: value.threadKey,
    executionId: value.executionId,
  });
  executionByThread.set(thread, exact);
  return exact;
}

export function getTurnExecutionContext(
  thread: object | undefined,
): TurnExecutionContext | undefined {
  return thread ? executionByThread.get(thread) : undefined;
}

/** Reset weak bindings (tests only). */
export function resetTurnExecutionContext(): void {
  executionByThread = new WeakMap<object, TurnExecutionContext>();
}
