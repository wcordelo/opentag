# `opentag-graphify`

Private Graphify facade with two Container roles:

- `GraphQueryContainer` mounts `opentag-code-graphs` read-only through pinned
  Sandbox SDK R2 binding egress and serves only the three bounded code
  operations;
- `GraphBuilderContainer` clones registry-approved GitHub repositories at exact
  commits, verifies the checkout, builds Graphify artifacts, and returns
  checksummed files to the Worker for R2 publication.

`GraphifyRegistryDO` stores tracked repository scope and the active immutable
artifact pointer. Activation uses compare-and-swap against both the previous
commit and the repository-registration revision, so a stale build cannot
replace the active revision after a scope or source change. Hourly rebuilds
and explicit admin rebuilds are supported; post-commit hooks are deliberately
not configured.

The Graphify source pin is
`00efd6e7969837ae4a9f11d8d504dcd3b20b09df`. Required secrets/vars are in
`wrangler.toml`. The query Container receives no bucket-scoped credential; its
Worker mounts the `ARTIFACTS` binding read-only. The builder receives no R2
credentials. The bot uses the `GRAPHIFY` service binding, while local
architecture work continues to use Graphify's stdio MCP.
`GRAPHIFY_ALLOWED_REPO_ORGS` is a required server-owned comma-separated
allowlist; the checked-in production placeholder is `wcordelo` and must be
reviewed when tracked repositories change. `GRAPHIFY_REPOSITORY_CATALOG` is a
server-owned JSON object mapping each tracked `repoId` to its GitHub clone URL
and default branch. The admin registration route accepts only that `repoId`;
it rejects caller-supplied URL and filesystem fields. The catalog must be
non-empty before a knowledge-service deployment is allowed.
If a catalog entry is removed or changed, the facade stops serving the old
registration until it is explicitly re-registered and rebuilt; scheduled builds
also require the current catalog source.

```bash
npm ci
npm run typecheck
# deployment requires explicit approval:
npm run deploy
```
