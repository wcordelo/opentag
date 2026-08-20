# Local Graphify MCP

Graphify remains a local development and architecture aid. The local stdio
server is separate from the private Cloudflare query service and must not be
used as a Slack-facing HTTP endpoint.

Install the pinned Graphify checkout from
`/Users/will/Documents/graphify` (or an equivalent local checkout) and verify
its commit before starting it:

```bash
cd /Users/will/Documents/graphify
test "$(git rev-parse HEAD)" = "00efd6e7969837ae4a9f11d8d504dcd3b20b09df"
uv tool install --editable '.[mcp]'
```

Run the MCP server over stdio for a checked-out project graph:

```bash
graphify-mcp /absolute/path/to/repository/graphify-out/graph.json
```

The MCP server exposes Graphify’s native tools, including `query_graph`,
`shortest_path`, and `get_neighbors`. It accepts local filesystem paths only
in this development process. The deployed OpenTag facade instead accepts a
server-owned `repoId` and active commit pointer, then returns OpenTag citation
records with the repository, commit, path, line range, relation, and artifact
revision.

Do not install Graphify post-commit hooks for OpenTag repositories. Rebuilds
are scheduled or manually initiated through `opentag-graphify`; generated
artifacts must not modify a developer’s dirty worktree.
