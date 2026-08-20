import { DurableObject } from "cloudflare:workers";

type RegistryEnv = Record<string, never>;
type SqlRow = Record<string, string | number | null | ArrayBuffer>;

export type GraphifyRepository = {
  repoId: string;
  teamId: string;
  projectId: string;
  cloneUrl: string;
  defaultBranch: string;
  enabled: boolean;
  revision: number;
  updatedAt: number;
};

export type GraphifyArtifact = {
  repoId: string;
  teamId: string;
  projectId: string;
  commitSha: string;
  artifactKey: string;
  manifest: Record<string, unknown>;
  updatedAt: number;
};

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const GITHUB_REPO = /^https:\/\/github\.com\/[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}\.git$/;
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

function json(request: Request): Promise<Record<string, unknown> | undefined> {
  return request.json().then((value) => (
    value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  )).catch(() => undefined);
}

function validId(value: unknown): value is string {
  return typeof value === "string" && SAFE_ID.test(value) && value !== "." && value !== "..";
}

function validBranch(value: unknown): value is string {
  return typeof value === "string" && GIT_BRANCH.test(value) &&
    value !== "." && value !== ".." &&
    !value.includes("..") && !value.includes("//") &&
    !value.includes("@{") && !value.endsWith("/");
}

function rowRepository(row: Record<string, unknown>): GraphifyRepository {
  return {
    repoId: String(row.repo_id),
    teamId: String(row.team_id),
    projectId: String(row.project_id),
    cloneUrl: String(row.clone_url),
    defaultBranch: String(row.default_branch),
    enabled: Number(row.enabled) === 1,
    revision: Number(row.revision ?? 1),
    updatedAt: Number(row.updated_at),
  };
}

export class GraphifyRegistryDO extends DurableObject<RegistryEnv> {
  constructor(ctx: DurableObjectState, env: RegistryEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      const sql = ctx.storage.sql;
      sql.exec(`CREATE TABLE IF NOT EXISTS repositories (
        repo_id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        project_id TEXT NOT NULL,
        clone_url TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1,
        updated_at INTEGER NOT NULL
      )`);
      const columns = new Set(sql.exec<{ name: string }>(
        "PRAGMA table_info(repositories)",
      ).toArray().map((row) => row.name));
      if (!columns.has("revision")) {
        sql.exec("ALTER TABLE repositories ADD COLUMN revision INTEGER NOT NULL DEFAULT 1");
      }
      sql.exec(`CREATE TABLE IF NOT EXISTS artifacts (
        repo_id TEXT PRIMARY KEY,
        commit_sha TEXT NOT NULL,
        artifact_key TEXT NOT NULL,
        manifest_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`);
    });
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (request.method === "GET" && url.pathname === "/repositories") {
      const enabledOnly = url.searchParams.get("enabled") === "true";
      const rows = sql.exec<SqlRow>(
        enabledOnly
          ? "SELECT * FROM repositories WHERE enabled = 1 ORDER BY repo_id"
          : "SELECT * FROM repositories ORDER BY repo_id",
      ).toArray();
      return Response.json(rows.map(rowRepository));
    }
    if (request.method === "POST" && url.pathname === "/repositories") {
      const body = await json(request);
      if (!body || !validId(body.repoId) || !validId(body.teamId) || !validId(body.projectId) ||
        typeof body.cloneUrl !== "string" || !GITHUB_REPO.test(body.cloneUrl) ||
        !validBranch(body.defaultBranch) ||
        typeof body.enabled !== "boolean") {
        return Response.json({ error: "repository_invalid" }, { status: 400 });
      }
      const now = Date.now();
      const previous = sql.exec<SqlRow>(
        "SELECT team_id, project_id, clone_url, default_branch, enabled, revision FROM repositories WHERE repo_id = ?",
        body.repoId,
      ).toArray()[0];
      const registrationChanged = Boolean(previous && (
        String(previous.team_id) !== body.teamId ||
        String(previous.project_id) !== body.projectId ||
        String(previous.clone_url) !== body.cloneUrl ||
        String(previous.default_branch) !== body.defaultBranch ||
        Number(previous.enabled) !== (body.enabled ? 1 : 0)
      ));
      const revision = previous
        ? Number(previous.revision ?? 1) + (registrationChanged ? 1 : 0)
        : 1;
      sql.exec(
        `INSERT INTO repositories(repo_id, team_id, project_id, clone_url, default_branch, enabled, revision, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET team_id=excluded.team_id, project_id=excluded.project_id,
           clone_url=excluded.clone_url, default_branch=excluded.default_branch, enabled=excluded.enabled,
           revision=excluded.revision, updated_at=excluded.updated_at`,
        body.repoId, body.teamId, body.projectId, body.cloneUrl, body.defaultBranch, body.enabled ? 1 : 0, revision, now,
      );
      if (registrationChanged) {
        // The old graph is immutable and remains in R2 for audit/rollback, but
        // it must not stay active under a changed repository definition. The
        // next manual or scheduled rebuild must publish a fresh pointer.
        sql.exec("DELETE FROM artifacts WHERE repo_id = ?", body.repoId);
      }
      return Response.json({ ok: true, repoId: body.repoId });
    }
    if (request.method === "GET" && url.pathname === "/repository") {
      const repoId = url.searchParams.get("repoId");
      if (!validId(repoId)) return Response.json({ error: "repo_id_invalid" }, { status: 400 });
      const row = sql.exec<SqlRow>("SELECT * FROM repositories WHERE repo_id = ?", repoId).toArray()[0];
      return row ? Response.json(rowRepository(row)) : Response.json({ error: "not_found" }, { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/artifact") {
      const repoId = url.searchParams.get("repoId");
      if (!validId(repoId)) return Response.json({ error: "repo_id_invalid" }, { status: 400 });
      const row = sql.exec<SqlRow>(
        `SELECT a.*, r.team_id, r.project_id FROM artifacts a JOIN repositories r ON r.repo_id = a.repo_id WHERE a.repo_id = ?`,
        repoId,
      ).toArray()[0];
      if (!row) return Response.json({ error: "not_found" }, { status: 404 });
      let manifest: Record<string, unknown>;
      try {
        const parsed = JSON.parse(String(row.manifest_json));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("manifest");
        manifest = parsed as Record<string, unknown>;
      } catch {
        return Response.json({ error: "manifest_invalid" }, { status: 500 });
      }
      return Response.json({
        repoId: String(row.repo_id),
        teamId: String(row.team_id),
        projectId: String(row.project_id),
        commitSha: String(row.commit_sha),
        artifactKey: String(row.artifact_key),
        manifest,
        updatedAt: Number(row.updated_at),
      } satisfies GraphifyArtifact);
    }
    if (request.method === "POST" && url.pathname === "/activate") {
      const body = await json(request);
      const expected = body?.expectedPreviousCommitSha;
      const repoId = body?.repoId;
      const commitSha = body?.commitSha;
      const artifactKey = body?.artifactKey;
      const manifest = body?.manifest;
      const expectedRepositoryRevision = body?.expectedRepositoryRevision;
      const expectedRevisionNumber = typeof expectedRepositoryRevision === "number"
        ? expectedRepositoryRevision
        : Number.NaN;
      if (!validId(repoId) || typeof commitSha !== "string" || !COMMIT.test(commitSha) ||
        typeof artifactKey !== "string" || artifactKey !== `code-graphs/${repoId}/${commitSha}` ||
        !manifest || typeof manifest !== "object" || Array.isArray(manifest) ||
        !(expected === null || expected === undefined || (typeof expected === "string" && COMMIT.test(expected))) ||
        !Number.isSafeInteger(expectedRevisionNumber) || expectedRevisionNumber < 1) {
        return Response.json({ error: "activation_invalid" }, { status: 400 });
      }
      const repo = sql.exec<SqlRow>("SELECT * FROM repositories WHERE repo_id = ?", repoId).toArray()[0];
      if (!repo) return Response.json({ error: "repository_not_found" }, { status: 404 });
      const currentRepositoryRevision = Number(repo.revision ?? 1);
      if (currentRepositoryRevision !== expectedRevisionNumber) {
        return Response.json({
          error: "stale_repository",
          currentRevision: currentRepositoryRevision,
        }, { status: 409 });
      }
      const current = sql.exec<SqlRow>("SELECT commit_sha FROM artifacts WHERE repo_id = ?", repoId).toArray()[0];
      const currentCommit = current ? String(current.commit_sha) : null;
      const expectedCommit = expected === undefined ? null : expected as string | null;
      if (currentCommit !== expectedCommit) {
        return Response.json({ error: "stale_activation", currentCommit }, { status: 409 });
      }
      sql.exec(
        `INSERT INTO artifacts(repo_id, commit_sha, artifact_key, manifest_json, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET commit_sha=excluded.commit_sha, artifact_key=excluded.artifact_key,
           manifest_json=excluded.manifest_json, updated_at=excluded.updated_at`,
        repoId, commitSha, artifactKey, JSON.stringify(manifest), Date.now(),
      );
      return Response.json({ ok: true, repoId, commitSha, artifactKey });
    }
    return new Response("Not found", { status: 404 });
  }
}
