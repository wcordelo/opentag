import { HarnessContainer, type Env } from "./container.js";
import { routeHarnessRequest } from "./router.js";

export { HarnessContainer };
export { ContainerProxy } from "@cloudflare/containers";

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    return routeHarnessRequest(
      request,
      env.HARNESS_CONTAINER,
      env.HARNESS_AUTH_TOKEN,
      {
        allowedHosts: new Set(
          (env.HARNESS_ALLOWED_REPO_HOSTS ?? "github.com")
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
        ),
        allowedOrgs: new Set(
          (env.HARNESS_ALLOWED_REPO_ORGS ?? "")
            .split(",")
            .map((value) => value.trim().toLowerCase())
            .filter(Boolean),
        ),
      },
    );
  },
};
