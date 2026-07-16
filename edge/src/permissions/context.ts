import type { PermissionSnapshotV1 } from "./contract.js";

let snapshotByInvocation = new WeakMap<object, PermissionSnapshotV1>();

export function bindPermissionSnapshot(
  invocation: object,
  snapshot: PermissionSnapshotV1,
): PermissionSnapshotV1 {
  snapshotByInvocation.set(invocation, snapshot);
  return snapshot;
}

export function copyPermissionSnapshot(
  from: object,
  to: object,
): PermissionSnapshotV1 {
  const snapshot = requirePermissionSnapshot(from);
  snapshotByInvocation.set(to, snapshot);
  return snapshot;
}

export function getPermissionSnapshot(
  invocation: object | undefined,
): PermissionSnapshotV1 | undefined {
  return invocation ? snapshotByInvocation.get(invocation) : undefined;
}

export function requirePermissionSnapshot(
  invocation: object,
): PermissionSnapshotV1 {
  const snapshot = snapshotByInvocation.get(invocation);
  if (!snapshot) throw new Error("permission snapshot is unavailable for this turn");
  return snapshot;
}

export function resetPermissionSnapshots(): void {
  snapshotByInvocation = new WeakMap<object, PermissionSnapshotV1>();
}
