#!/usr/bin/env python3
"""Authenticated exact-commit Graphify builder with bounded artifact reads."""
from __future__ import annotations

import hashlib
import hmac
import json
import gzip
import os
import re
import shutil
import subprocess
import tarfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

MAX_BODY = 2_000_000
COMMIT_RE = re.compile(r"^[0-9a-f]{40}$")
REPO_RE = re.compile(r"^https://github\.com/[A-Za-z0-9_.-]{1,100}/[A-Za-z0-9_.-]{1,100}\.git$")
JOB_RE = re.compile(r"^[a-f0-9-]{36}$")
ARTIFACTS = {"graph.json", "report.md", "source.tar.gz", "manifest.json"}
BUILD_LOCK = threading.Lock()
MAX_SOURCE_FILES = 100_000
MAX_SOURCE_BYTES = 256 * 1024 * 1024
MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024


def log_event(message: str, **fields: object) -> None:
    """Emit bounded, secret-free lifecycle diagnostics for the Container tail."""
    print(json.dumps({"component": "graphify-builder", "message": message, **fields}, separators=(",", ":")), flush=True)


def auth_ok(value: str | None) -> bool:
    expected = os.environ.get("GRAPHIFY_CONTAINER_AUTH_TOKEN", "")
    return bool(value and expected and hmac.compare_digest(value, expected))


def repo_org_allowed(repo_url: str) -> bool:
    match = re.fullmatch(r"https://github\.com/([^/]+)/[^/]+\.git", repo_url)
    configured = {
        item.strip().casefold()
        for item in os.environ.get("GRAPHIFY_ALLOWED_REPO_ORGS", "").split(",")
        if item.strip()
    }
    return bool(match and configured and match.group(1).casefold() in configured)


def valid_artifact_key(value: object) -> bool:
    if not isinstance(value, str):
        return False
    parts = value.split("/")
    return (
        len(parts) == 3
        and bool(re.fullmatch(r"code-graphs/[A-Za-z0-9_.-]{1,128}/[0-9a-f]{40}", value))
        and parts[1] not in (".", "..")
    )


def send_json(handler: BaseHTTPRequestHandler, value: dict[str, Any], status: int = 200) -> None:
    data = json.dumps(value, separators=(",", ":")).encode()
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(data)))
    handler.end_headers()
    handler.wfile.write(data)


def read_json(handler: BaseHTTPRequestHandler) -> dict[str, Any] | None:
    try:
        length = int(handler.headers.get("content-length", "0"))
        if length < 0 or length > MAX_BODY:
            return None
        value = json.loads(handler.rfile.read(length))
    except (ValueError, json.JSONDecodeError):
        return None
    return value if isinstance(value, dict) else None


def sha256(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def archive_source(repo: Path, destination: Path) -> tuple[int, int]:
    """Write a bounded, deterministic, non-duplicating source snapshot."""
    file_count = 0
    total_bytes = 0
    # Git checkout mtimes and gzip's default header timestamp vary between
    # builds. Normalize archive metadata so the same exact commit produces the
    # same bytes and can safely reuse its immutable R2 artifact.
    with destination.open("wb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for item in sorted(repo.rglob("*")):
                    relative = item.relative_to(repo)
                    if ".git" in relative.parts or not (item.is_file() or item.is_symlink()):
                        continue
                    size = 0 if item.is_symlink() else item.stat().st_size
                    if size > MAX_SOURCE_FILE_BYTES or total_bytes + size > MAX_SOURCE_BYTES:
                        raise RuntimeError("source snapshot exceeds size limit")
                    file_count += 1
                    if file_count > MAX_SOURCE_FILES:
                        raise RuntimeError("source snapshot exceeds file limit")
                    info = archive.gettarinfo(item, arcname=str(Path("source") / relative))
                    info.mtime = 0
                    info.uid = 0
                    info.gid = 0
                    info.uname = ""
                    info.gname = ""
                    if info.isreg():
                        with item.open("rb") as source:
                            archive.addfile(info, source)
                    else:
                        archive.addfile(info)
                    total_bytes += size
    return file_count, total_bytes


def run(command: list[str], cwd: Path, env: dict[str, str]) -> None:
    # Do not retain unbounded tool output in a pipe. The caller only needs a
    # success/failure result and request logs must not contain clone details.
    subprocess.run(command, cwd=cwd, env=env, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=1_800)


class Handler(BaseHTTPRequestHandler):
    server_version = "opentag-graphify-builder/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        if not auth_ok(self.headers.get("x-graphify-container-token")):
            send_json(self, {"error": "unauthorized"}, 401)
            return
        match = re.fullmatch(r"/v1/build/([^/]+)/([^/]+)", self.path)
        if not match or not JOB_RE.fullmatch(match.group(1)) or match.group(2) not in ARTIFACTS:
            send_json(self, {"error": "not_found"}, 404)
            return
        path = Path("/tmp/graphify-builds") / match.group(1) / match.group(2)
        if not path.is_file():
            send_json(self, {"error": "not_found"}, 404)
            return
        size = path.stat().st_size
        if size > 1_000_000_000:
            send_json(self, {"error": "artifact_too_large"}, 413)
            return
        self.send_response(200)
        self.send_header("content-type", "application/octet-stream")
        self.send_header("content-length", str(size))
        self.end_headers()
        with path.open("rb") as stream:
            shutil.copyfileobj(stream, self.wfile)

    def do_POST(self) -> None:  # noqa: N802
        if not auth_ok(self.headers.get("x-graphify-container-token")):
            send_json(self, {"error": "unauthorized"}, 401)
            return
        if self.path != "/v1/build":
            send_json(self, {"error": "not_found"}, 404)
            return
        payload = read_json(self)
        if payload is None:
            send_json(self, {"error": "invalid_json"}, 400)
            return
        repo_url = payload.get("repoUrl")
        commit_sha = payload.get("commitSha")
        artifact_key = payload.get("artifactKey")
        if not isinstance(repo_url, str) or not REPO_RE.fullmatch(repo_url):
            send_json(self, {"error": "repository_not_allowed"}, 400)
            return
        if not repo_org_allowed(repo_url):
            send_json(self, {"error": "repository_not_allowlisted"}, 403)
            return
        if not isinstance(commit_sha, str) or not COMMIT_RE.fullmatch(commit_sha):
            send_json(self, {"error": "commit_invalid"}, 400)
            return
        if not valid_artifact_key(artifact_key):
            send_json(self, {"error": "artifact_invalid"}, 400)
            return
        if not BUILD_LOCK.acquire(blocking=False):
            send_json(self, {"error": "builder_busy"}, 429)
            return
        job_id = str(uuid.uuid4())
        root = Path("/tmp/graphify-builds") / job_id
        repo = root / "repo"
        output = root / "out"
        repo_id = artifact_key.split("/")[1]
        stage = "start"
        log_event("build_started", repoId=repo_id, commitSha=commit_sha)
        try:
            root.mkdir(parents=True, exist_ok=False)
            environment = os.environ.copy()
            environment.pop("GRAPHIFY_CONTAINER_AUTH_TOKEN", None)
            github_token = environment.get("GITHUB_TOKEN", "")
            if github_token:
                # Git reads the credential from an ephemeral environment config,
                # never from the clone URL or a logged argv value.
                environment["GIT_CONFIG_COUNT"] = "1"
                environment["GIT_CONFIG_KEY_0"] = "http.extraheader"
                environment["GIT_CONFIG_VALUE_0"] = f"AUTHORIZATION: bearer {github_token}"
            stage = "clone"
            run(["git", "clone", "--no-checkout", "--filter=blob:none", repo_url, str(repo)], root, environment)
            log_event("clone_complete", repoId=repo_id, commitSha=commit_sha)
            stage = "checkout"
            run(["git", "fetch", "--depth=1", "origin", commit_sha], repo, environment)
            run(["git", "checkout", "--detach", commit_sha], repo, environment)
            verified = subprocess.check_output(
                ["git", "rev-parse", "HEAD"],
                cwd=repo,
                text=True,
                stderr=subprocess.DEVNULL,
                env=environment,
            ).strip()
            if verified != commit_sha:
                raise RuntimeError("checked out commit does not match requested commit")
            log_event("checkout_complete", repoId=repo_id, commitSha=commit_sha)
            environment.pop("GITHUB_TOKEN", None)
            environment.pop("GIT_CONFIG_VALUE_0", None)
            environment.pop("GIT_CONFIG_KEY_0", None)
            environment.pop("GIT_CONFIG_COUNT", None)
            stage = "extract"
            run(["graphify", "extract", str(repo), "--code-only", "--no-cluster", "--out", str(output)], root, environment)
            graph = output / "graphify-out" / "graph.json"
            if not graph.is_file():
                raise RuntimeError("Graphify did not produce graph.json")
            log_event("extract_complete", repoId=repo_id, commitSha=commit_sha, graphBytes=graph.stat().st_size)
            report = output / "graphify-out" / "GRAPH_REPORT.md"
            if not report.is_file():
                report.write_text("# Graphify artifact\n\nGenerated from an exact commit.\n", encoding="utf-8")
            stage = "snapshot"
            source_archive = root / "source.tar.gz"
            source_file_count, source_bytes = archive_source(repo, source_archive)
            files = {name: sha256(path) for name, path in (("graph.json", graph), ("report.md", report), ("source.tar.gz", source_archive))}
            manifest = {
                "schemaVersion": 1,
                "repoId": artifact_key.split("/")[1],
                "commitSha": commit_sha,
                "artifactKey": artifact_key,
                "graphifyCommit": os.environ.get("GRAPHIFY_COMMIT", ""),
                "sourceSnapshot": {"files": source_file_count, "bytes": source_bytes},
                "files": {name: {"sha256": digest, "size": size} for name, (digest, size) in files.items()},
            }
            (root / "graph.json").write_bytes(graph.read_bytes())
            (root / "report.md").write_bytes(report.read_bytes())
            (root / "manifest.json").write_text(json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8")
            log_event("build_complete", repoId=repo_id, commitSha=commit_sha, sourceFiles=source_file_count, sourceBytes=source_bytes)
            send_json(self, {"jobId": job_id, **manifest})
        except (OSError, RuntimeError, subprocess.SubprocessError, ValueError) as error:
            log_event("build_failed", repoId=repo_id, commitSha=commit_sha, stage=stage, errorType=type(error).__name__)
            shutil.rmtree(root, ignore_errors=True)
            send_json(self, {"error": "build_failed"}, 502)
        finally:
            BUILD_LOCK.release()

    def do_DELETE(self) -> None:  # noqa: N802
        if not auth_ok(self.headers.get("x-graphify-container-token")):
            send_json(self, {"error": "unauthorized"}, 401)
            return
        match = re.fullmatch(r"/v1/build/([^/]+)", self.path)
        if not match or not JOB_RE.fullmatch(match.group(1)):
            send_json(self, {"error": "not_found"}, 404)
            return
        root = Path("/tmp/graphify-builds") / match.group(1)
        shutil.rmtree(root, ignore_errors=True)
        send_json(self, {"ok": True})


def main() -> None:
    ThreadingHTTPServer(("0.0.0.0", int(os.environ.get("PORT", "8080"))), Handler).serve_forever()


if __name__ == "__main__":
    main()
