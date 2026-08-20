#!/usr/bin/env python3
"""Small authenticated query surface over one immutable Graphify artifact."""
from __future__ import annotations

import hmac
import json
import os
import re
from functools import lru_cache
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import networkx as nx
from graphify.affected import DEFAULT_AFFECTED_RELATIONS, affected_nodes, load_graph, resolve_seed
from graphify.serve import _score_nodes

MAX_BODY = 1_000_000
MAX_GRAPH_BYTES = 128 * 1024 * 1024
SAFE_ARTIFACT = re.compile(r"^code-graphs/[A-Za-z0-9._-]{1,128}/[0-9a-f]{40}$")


def auth_ok(value: str | None) -> bool:
    expected = os.environ.get("GRAPHIFY_CONTAINER_AUTH_TOKEN", "")
    if not value or not expected:
        return False
    return hmac.compare_digest(value, expected)


def json_response(handler: BaseHTTPRequestHandler, value: dict[str, Any], status: int = 200) -> None:
    body = json.dumps(value, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("content-type", "application/json")
    handler.send_header("content-length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def body_json(handler: BaseHTTPRequestHandler) -> dict[str, Any] | None:
    try:
        length = int(handler.headers.get("content-length", "0"))
    except ValueError:
        return None
    if length < 0 or length > MAX_BODY:
        return None
    try:
        value = json.loads(handler.rfile.read(length))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None
    return value if isinstance(value, dict) else None


def artifact_path(artifact_key: str) -> Path:
    if not SAFE_ARTIFACT.fullmatch(artifact_key):
        raise ValueError("artifact key is invalid")
    if any(part in (".", "..") for part in artifact_key.split("/")):
        raise ValueError("artifact path traversal is invalid")
    root = Path(os.environ.get("GRAPHIFY_R2_MOUNT", "/mnt/graphs")).resolve()
    candidate = (root / Path(*artifact_key.split("/")) / "graph.json").resolve()
    if root != candidate and root not in candidate.parents:
        raise ValueError("artifact path escaped mount")
    return candidate


@lru_cache(maxsize=8)
def graph_for(path: str) -> nx.Graph:
    if Path(path).stat().st_size > MAX_GRAPH_BYTES:
        raise ValueError("graph artifact is too large")
    return load_graph(Path(path))


def node_value(graph: nx.Graph, node_id: str, **extra: Any) -> dict[str, Any]:
    data = graph.nodes[node_id]
    result: dict[str, Any] = {
        "id": str(node_id),
        "label": str(data.get("label") or node_id)[:512],
    }
    for key in ("source_file", "source_location"):
        value = data.get(key)
        if value:
            result["sourceFile" if key == "source_file" else "sourceLocation"] = str(value)[:512]
    confidence_label = data.get("confidence")
    if isinstance(confidence_label, str) and confidence_label:
        result["confidenceLabel"] = confidence_label[:64]
    confidence_score = data.get("confidence_score")
    if isinstance(confidence_score, (int, float)) and confidence_score == confidence_score:
        result["confidence"] = max(0.0, min(1.0, float(confidence_score)))
    result.update(extra)
    return result


def edge_attributes(graph: nx.Graph, source: str, target: str) -> dict[str, Any]:
    raw = graph.get_edge_data(source, target) or {}
    if not raw:
        raw = graph.get_edge_data(target, source) or {}
    if not isinstance(raw, dict):
        return {}
    if graph.is_multigraph():
        candidates = [value for value in raw.values() if isinstance(value, dict)]
        if not candidates:
            return {}
        # A shortest path is represented as one citation per node. If several
        # relations share an endpoint pair, choose a stable representative
        # rather than depending on NetworkX insertion order or hash state.
        return min(candidates, key=lambda value: (
            str(value.get("relation", "")),
            str(value.get("source_file", "")),
            str(value.get("source_location", "")),
        ))
    if 0 in raw:
        value = raw[0]
        return value if isinstance(value, dict) else {}
    return raw


def edge_value(graph: nx.Graph, source: str, target: str) -> dict[str, Any]:
    data = edge_attributes(graph, source, target)
    result: dict[str, Any] = {"source": str(source), "target": str(target)}
    for key, output in (("relation", "relation"), ("source_file", "sourceFile"), ("source_location", "sourceLocation")):
        value = data.get(key)
        if value:
            result[output] = str(value)[:512]
    confidence_label = data.get("confidence")
    if isinstance(confidence_label, str) and confidence_label:
        result["confidenceLabel"] = confidence_label[:64]
    confidence = data.get("confidence_score")
    if not isinstance(confidence, (int, float)):
        confidence = data.get("confidence")
    if isinstance(confidence, (int, float)) and confidence == confidence:
        result["confidence"] = float(confidence)
    return result


def revision(handler: BaseHTTPRequestHandler) -> tuple[str, str, str, str]:
    repo_id = handler.headers.get("x-graphify-repo", "")
    team_id = handler.headers.get("x-graphify-team", "")
    commit_sha = handler.headers.get("x-graphify-commit", "")
    artifact_key = handler.headers.get("x-graphify-artifact-key", "")
    if (
        not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", repo_id)
        or repo_id in (".", "..")
        or not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", team_id)
        or team_id in (".", "..")
        or not re.fullmatch(r"[0-9a-f]{40}", commit_sha)
    ):
        raise ValueError("graph revision is invalid")
    artifact_path(artifact_key)
    return repo_id, team_id, commit_sha, artifact_key


class Handler(BaseHTTPRequestHandler):
    server_version = "opentag-graphify/1"

    def log_message(self, _format: str, *_args: Any) -> None:
        # Request bodies and credentials must never enter Container logs.
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            json_response(self, {"status": "ok", "service": "graphify-query"})
            return
        self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802
        if not auth_ok(self.headers.get("x-graphify-container-token")):
            json_response(self, {"error": "unauthorized"}, 401)
            return
        try:
            repo_id, team_id, commit_sha, artifact_key = revision(self)
            graph = graph_for(str(artifact_path(artifact_key)))
            payload = body_json(self)
            if payload is None:
                json_response(self, {"error": "invalid_json"}, 400)
                return
            base = {"repoId": repo_id, "teamId": team_id, "commitSha": commit_sha, "artifactKey": artifact_key}
            if self.path == "/v1/code/graph-search":
                query = str(payload.get("query", "")).strip().casefold()
                limit = min(10, max(1, int(payload.get("limit", 5))))
                if not query or len(query) > 512:
                    json_response(self, {"error": "query_invalid"}, 400)
                    return
                terms = re.findall(r"\w+", query)
                scored = _score_nodes(graph, terms)
                json_response(self, {**base, "results": [node_value(graph, node_id, score=score) for score, node_id in scored[:limit]]})
                return
            if self.path == "/v1/code/path":
                source = resolve_seed(graph, str(payload.get("source", "")).strip())
                target = resolve_seed(graph, str(payload.get("target", "")).strip())
                max_hops = min(12, max(1, int(payload.get("maxHops", 6))))
                if source is None or target is None:
                    json_response(self, {**base, "nodes": [], "edges": []})
                    return
                try:
                    undirected = nx.Graph()
                    undirected.add_nodes_from(sorted(graph.nodes))
                    undirected.add_edges_from(sorted((min(left, right), max(left, right)) for left, right in graph.edges))
                    path = nx.shortest_path(undirected, source=source, target=target)
                except (nx.NetworkXNoPath, nx.NodeNotFound):
                    path = []
                if len(path) - 1 > max_hops:
                    path = []
                nodes = [node_value(graph, node_id) for node_id in path]
                edges = [edge_value(graph, path[index], path[index + 1]) for index in range(max(0, len(path) - 1))]
                json_response(self, {**base, "nodes": nodes, "edges": edges})
                return
            if self.path == "/v1/code/impact":
                seed = resolve_seed(graph, str(payload.get("symbol", "")).strip())
                depth = min(8, max(1, int(payload.get("depth", 3))))
                raw_relations = payload.get("relations")
                relations = [str(item) for item in raw_relations[:8]] if isinstance(raw_relations, list) else list(DEFAULT_AFFECTED_RELATIONS)
                if seed is None:
                    json_response(self, {**base, "results": []})
                    return
                results: list[dict[str, Any]] = []
                for hit in affected_nodes(graph, seed, relations=relations, depth=depth):
                    data = graph.nodes[hit.node_id]
                    results.append(node_value(
                        graph,
                        hit.node_id,
                        depth=hit.depth,
                        relation=hit.via_relation,
                        viaFile=hit.via_file or data.get("source_file"),
                        viaLocation=hit.via_location or data.get("source_location"),
                    ))
                json_response(self, {**base, "results": results[:64]})
                return
            self.send_error(404)
        except (ValueError, TypeError, OverflowError, OSError, nx.NetworkXError, SystemExit):
            json_response(self, {"error": "graph_query_failed"}, 400)


def main() -> None:
    port = int(os.environ.get("PORT", "8080"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()


if __name__ == "__main__":
    main()
