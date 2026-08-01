export const TENANT_ID_MAX_LENGTH = 128;
export const TENANT_ID_HEADER = "x-opentag-tenant-id";
export const OPERATOR_TENANT_ID = "__opentag_operator__";
const TENANT_ID_STORAGE_KEY = "opentag:tenant-id:v1";

export type TenantScope = {
  teamId: string;
};

type TenantFetchable = {
  fetch(input: string | Request, init?: RequestInit): Promise<Response>;
};

type TenantIdentityStorage = {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
};

type TenantNamespace<T> = {
  idFromName(name: string): T;
  get(id: T): TenantFetchable;
};

export function assertTenantId(teamId: string): string {
  if (
    typeof teamId !== "string" ||
    teamId.length === 0 ||
    teamId.length > TENANT_ID_MAX_LENGTH ||
    teamId.trim() !== teamId ||
    /[\u0000-\u001f\u007f:]/.test(teamId)
  ) {
    throw new Error("tenant_id_invalid");
  }
  return teamId;
}

export function tenantScope(teamId: string): TenantScope {
  return { teamId: assertTenantId(teamId) };
}

export function tenantStub<T>(
  namespace: TenantNamespace<T>,
  scope: TenantScope | string,
): TenantFetchable {
  const teamId = typeof scope === "string" ? assertTenantId(scope) : assertTenantId(scope.teamId);
  const stub = namespace.get(namespace.idFromName(teamId));
  return {
    fetch(input, init) {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      headers.set(TENANT_ID_HEADER, teamId);
      return stub.fetch(input, { ...init, headers });
    },
  };
}

export function operatorStub<T>(
  namespace: TenantNamespace<T>,
  objectName: string,
): TenantFetchable {
  const stub = namespace.get(namespace.idFromName(objectName));
  return {
    fetch(input, init) {
      const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
      headers.set(TENANT_ID_HEADER, OPERATOR_TENANT_ID);
      return stub.fetch(input, { ...init, headers });
    },
  };
}

export async function bindTenantIdentity(
  storage: TenantIdentityStorage,
  request: Request,
): Promise<string | undefined> {
  const header = request.headers.get(TENANT_ID_HEADER);
  if (!header) return undefined;
  let teamId: string;
  try {
    teamId = assertTenantId(header);
  } catch {
    return undefined;
  }
  const existing = await storage.get<string>(TENANT_ID_STORAGE_KEY);
  if (existing !== undefined) return existing === teamId ? teamId : undefined;
  await storage.put(TENANT_ID_STORAGE_KEY, teamId);
  return teamId;
}

export async function bodyMatchesTenant(
  request: Request,
  teamId: string,
): Promise<boolean> {
  if (!request.body) return true;
  let value: unknown;
  try {
    value = await request.clone().json();
  } catch {
    return true;
  }
  const pending: unknown[] = [value];
  let visited = 0;
  while (pending.length > 0 && visited < 2_000) {
    const current = pending.pop();
    visited += 1;
    if (!current || typeof current !== "object") continue;
    if (Array.isArray(current)) {
      pending.push(...current.slice(0, 512));
      continue;
    }
    for (const [key, child] of Object.entries(current)) {
      if (teamId !== OPERATOR_TENANT_ID && key === "teamId" && child !== teamId) return false;
      if (child && typeof child === "object") pending.push(child);
    }
  }
  return true;
}
