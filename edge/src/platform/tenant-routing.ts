/** Canonical Durable Object name for a tenant's platform metadata. */
export function platformTenantObjectName(tenantId: string): string {
  if (
    typeof tenantId !== "string" ||
    tenantId.length === 0 ||
    tenantId.length > 256 ||
    tenantId !== tenantId.trim() ||
    /[\u0000-\u001f\u007f]/.test(tenantId)
  ) {
    throw new Error("tenant_id_invalid");
  }
  return `tenant:${tenantId}`;
}
