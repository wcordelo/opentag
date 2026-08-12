import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { supermemoryContainerEnv } from "./container-env.js";

const SUPERMEMORY_DATA_DIR = "/var/lib/supermemory";
const SUPERMEMORY_STORAGE_SENTINEL = "/run/opentag-supermemory-r2-ready";
const SUPERMEMORY_STORAGE_MOUNT_CHECK = `mountpoint -q ${SUPERMEMORY_DATA_DIR}`;
const SUPERMEMORY_STORAGE_ACCESS_CHECK = "runuser -u supermemory";

export class SupermemoryContainer extends Sandbox<Env> {
  defaultPort = 6767;
  pingEndpoint = "localhost/ready";
  sleepAfter = "24h";
  enableInternet = true;
  envVars = supermemoryContainerEnv(this.env);

  override async fetch(request: Request): Promise<Response> {
    const response = await this.containerFetch(request, this.defaultPort);
    const pathname = new URL(request.url).pathname;
    if ((pathname === "/ready" && !response.ok) || (pathname === "/v4/search" && response.status >= 500)) {
      await this.logReadinessDiagnostic();
    }
    return response;
  }

  private async logReadinessDiagnostic(): Promise<void> {
    console.log(JSON.stringify({ event: "supermemory_readiness_diagnostic_begin" }));
    try {
      const result = await this.exec(
        "printf 'r2=%s mount=%s provider=%s env=access:%s secret:%s account:%s bucket:%s models=%s\\n' \"$(test -f /run/opentag-supermemory-r2-ready && printf ready || printf pending)\" \"$(mountpoint -q /var/lib/supermemory 2>/dev/null && printf ready || printf pending)\" \"$(test -f /run/opentag-supermemory-provider-ready && printf ready || printf pending)\" \"$(test -n \"${AWS_ACCESS_KEY_ID:-}\" && printf set || printf missing)\" \"$(test -n \"${AWS_SECRET_ACCESS_KEY:-}\" && printf set || printf missing)\" \"$(test -n \"${R2_ACCOUNT_ID:-}\" && printf set || printf missing)\" \"$(test -n \"${R2_BUCKET_NAME:-}\" && printf set || printf missing)\" \"$(find /var/cache/supermemory/models -type f 2>/dev/null | wc -l | tr -d ' ')\"; ps -eo comm=,stat= | tr '\\n' ';'; if [ -r /run/opentag-supermemory-tigrisfs.status ]; then printf ' tigrisfs_status='; tr '\\n' ' ' < /run/opentag-supermemory-tigrisfs.status; fi; if [ -r /var/lib/supermemory/api-key ]; then key=\"$(tr -d '\\r\\n' < /var/lib/supermemory/api-key)\"; status=\"$(curl -sS --connect-timeout 1 --max-time 10 -o /tmp/opentag-supermemory-search-diagnostic -w '%{http_code}' -X POST http://127.0.0.1:6768/v4/search -H \"authorization: Bearer $key\" -H 'content-type: application/json' --data '{\"q\":\"opentag readiness probe\",\"searchMode\":\"hybrid\",\"limit\":1}' 2>/dev/null || printf '000')\"; body=\"$(tr -d '\\r\\n' < /tmp/opentag-supermemory-search-diagnostic 2>/dev/null | sed -E 's/(sm_[A-Za-z0-9._-]+|sk-[A-Za-z0-9._-]+|Bearer[[:space:]]+[A-Za-z0-9._~+\\/-]+=*)/[REDACTED]/g' | cut -c1-256)\"; printf ' search=%s body=%s' \"$status\" \"$body\"; fi",
        { origin: "internal", timeout: 15_000 },
      );
      console.log(JSON.stringify({
        event: "supermemory_readiness_diagnostic",
        execSuccess: result.success,
        output: String(result.stdout ?? "").slice(0, 1_024),
      }));
    } catch {
      console.log(JSON.stringify({ event: "supermemory_readiness_diagnostic", execSuccess: false }));
    }
  }

  override async containerFetch(
    requestOrUrl: Request | string | URL,
    portOrInit?: number | RequestInit,
    portParam?: number,
  ): Promise<Response> {
    console.log(JSON.stringify({ event: "supermemory_container_fetch_begin" }));
    try {
      const response = await super.containerFetch(requestOrUrl, portOrInit, portParam);
      console.log(JSON.stringify({ event: "supermemory_container_fetch_complete", status: response.status }));
      return response;
    } catch (error) {
      console.log(JSON.stringify({ event: "supermemory_container_fetch_error" }));
      throw error;
    }
  }

  override async onStart(): Promise<void> {
    console.log(JSON.stringify({ event: "supermemory_on_start_begin" }));
    await super.onStart();
    console.log(JSON.stringify({ event: "supermemory_on_start_base_complete" }));
    console.log(JSON.stringify({
      event: "supermemory_storage_gate_delegated",
      sentinel: SUPERMEMORY_STORAGE_SENTINEL,
      mountCheck: SUPERMEMORY_STORAGE_MOUNT_CHECK,
      accessCheck: SUPERMEMORY_STORAGE_ACCESS_CHECK,
    }));
    console.log("[opentag-supermemory] container started");
  }

  override async onStop(): Promise<void> {
    await super.onStop();
    console.log("[opentag-supermemory] container stopped");
  }

  override async onActivityExpired(): Promise<void> {
    console.log("[opentag-supermemory] activity window expired; stopping container");
    await this.stop();
  }
}
