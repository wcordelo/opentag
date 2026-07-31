import {
  assertPermissionSnapshotV1SlackOnly,
  type PermissionSnapshotV1,
} from "./contract.js";

let snapshotByInvocation = new WeakMap<object, PermissionSnapshotV1>();

export function bindPermissionSnapshot(
  invocation: object,
  snapshot: PermissionSnapshotV1,
): PermissionSnapshotV1 {
  assertPermissionSnapshotV1SlackOnly(snapshot);
  snapshotByInvocation.set(invocation, snapshot);
  return snapshot;
}

export function copyPermissionSnapshot(
  from: object,
  to: object,
): PermissionSnapshotV1 {
  const snapshot = requirePermissionSnapshot(from);
  assertPermissionSnapshotV1SlackOnly(snapshot);
  snapshotByInvocation.set(to, snapshot);
  return snapshot;
}

export function getPermissionSnapshot(
  invocation: object | undefined,
): PermissionSnapshotV1 | undefined {
  const snapshot = invocation ? snapshotByInvocation.get(invocation) : undefined;
  if (snapshot) assertPermissionSnapshotV1SlackOnly(snapshot);
  return snapshot;
}

export function requirePermissionSnapshot(
  invocation: object,
): PermissionSnapshotV1 {
  const snapshot = snapshotByInvocation.get(invocation);
  if (!snapshot) throw new Error("permission snapshot is unavailable for this turn");
  assertPermissionSnapshotV1SlackOnly(snapshot);
  return snapshot;
}

export function resetPermissionSnapshots(): void {
  snapshotByInvocation = new WeakMap<object, PermissionSnapshotV1>();
}
