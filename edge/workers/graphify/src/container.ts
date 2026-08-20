import { Container } from "@cloudflare/containers";
import { Sandbox } from "@cloudflare/sandbox";
import type { Env } from "./env.js";
import { graphBuilderContainerEnv, graphQueryContainerEnv } from "./container-env.js";

/** Read-only graph query role. The R2 token should be provisioned read-only. */
export class GraphQueryContainer extends Sandbox<Env> {
  defaultPort = 8080;
  sleepAfter = "24h";
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ["*.r2.cloudflarestorage.com"];
  envVars = graphQueryContainerEnv(this.env);
  pingEndpoint = "localhost/health";
  private artifactsMounted = false;

  override async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, this.defaultPort);
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    if (!this.artifactsMounted) {
      await this.mountBucket("ARTIFACTS", "/mnt/graphs", { readOnly: true });
      this.artifactsMounted = true;
    }
    console.log("[opentag-graphify] query container started");
  }

  override async onStop(): Promise<void> {
    this.artifactsMounted = false;
    await super.onStop();
    console.log("[opentag-graphify] query container stopped");
  }

  override async onActivityExpired(): Promise<void> {
    console.log("[opentag-graphify] query activity expired; stopping container");
    await this.stop();
  }
}

/** Builder role. Its egress is restricted to GitHub for the registry-approved clone. */
export class GraphBuilderContainer extends Container<Env> {
  defaultPort = 8080;
  sleepAfter = "24h";
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = ["github.com", "*.github.com", "*.githubusercontent.com"];
  envVars = graphBuilderContainerEnv(this.env);
  entrypoint = ["python3", "/app/graphify-builder.py"];

  override async fetch(request: Request): Promise<Response> {
    const pathname = new URL(request.url).pathname;
    console.log("[opentag-graphify] builder fetch started", {
      method: request.method,
      pathname,
    });
    try {
      const response = await super.fetch(request);
      console.log("[opentag-graphify] builder fetch completed", {
        pathname,
        status: response.status,
      });
      return response;
    } catch (error) {
      console.error("[opentag-graphify] builder fetch failed", {
        pathname,
        errorType: error instanceof Error ? error.constructor.name : "unknown",
        errorMessage: safeContainerErrorMessage(error, [
          this.env.GRAPHIFY_CONTAINER_AUTH_TOKEN,
          this.env.GITHUB_TOKEN,
        ]),
      });
      throw error;
    }
  }

  override onStart(): void {
    console.log("[opentag-graphify] builder container started");
  }

  override async onActivityExpired(): Promise<void> {
    console.log("[opentag-graphify] builder activity expired; stopping container");
    await this.stop();
  }
}

function safeContainerErrorMessage(error: unknown, secrets: readonly (string | undefined)[] = []): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret) message = message.split(secret).join("[redacted]");
  }
  return message
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/(?:authorization|token|secret|password)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .slice(0, 240);
}
