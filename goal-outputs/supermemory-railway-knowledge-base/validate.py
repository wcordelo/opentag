#!/usr/bin/env python3
"""Deterministic structural validation for the Supermemory Railway KB plan."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SPEC = ROOT / "KNOWLEDGE-BASE-SPEC.md"
READINESS = Path(__file__).resolve().parent / "RAILWAY-READINESS.md"


def require(errors: list[str], condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def require_terms(
    errors: list[str], text: str, terms: list[str], label: str
) -> None:
    folded = text.casefold()
    for term in terms:
        require(
            errors,
            term.casefold() in folded,
            f"{label}: missing required term or phrase: {term!r}",
        )


def validate_work_packages(errors: list[str], spec: str) -> None:
    matches = list(re.finditer(r"^### (B\d+) — .+$", spec, re.MULTILINE))
    ids = [match.group(1) for match in matches]
    require(errors, ids == [f"B{i}" for i in range(10)], f"SPEC: expected B0-B9 in order, got {ids}")

    fields = [
        "Owner surface",
        "Autonomy",
        "Deliverables (exact paths where known)",
        "Dependencies",
        "Procedure",
        "Acceptance criteria",
        "Validation commands",
        "Rollback",
    ]
    autonomy_values = ("file-only", "read-only external", "external mutation")
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else spec.find("\n## 10.", match.end())
        section = spec[match.start() : end if end != -1 else len(spec)]
        package = match.group(1)
        for field in fields:
            require(errors, f"**{field}:**" in section, f"SPEC {package}: missing field {field!r}")
        autonomy_line = re.search(r"^- \*\*Autonomy:\*\* (.+)$", section, re.MULTILINE)
        require(errors, autonomy_line is not None, f"SPEC {package}: malformed Autonomy field")
        if autonomy_line:
            require(
                errors,
                any(value in autonomy_line.group(1) for value in autonomy_values),
                f"SPEC {package}: autonomy must name an allowed classification",
            )
        if "external mutation" in section:
            require(
                errors,
                "STOP GATE" in section or "stop for explicit" in section,
                f"SPEC {package}: external mutation lacks an explicit stop gate",
            )


def main() -> int:
    errors: list[str] = []

    require(errors, SPEC.is_file(), f"missing canonical SPEC: {SPEC}")
    require(errors, READINESS.is_file(), f"missing Railway readiness report: {READINESS}")
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    spec = SPEC.read_text(encoding="utf-8")
    readiness = READINESS.read_text(encoding="utf-8")
    require(errors, len(spec.encode()) >= 25_000, "SPEC: unexpectedly small (<25 KB)")
    require(errors, len(readiness.encode()) >= 8_000, "READINESS: unexpectedly small (<8 KB)")

    spec_sections = [
        "## 1. Decision summary and superseded design",
        "## 2. Invariants, non-goals, and autonomy",
        "## 3. Target architecture and trust boundaries",
        "## 4. Exact contracts",
        "## 5. Ingestion ledger, state machine, and convergence",
        "## 6. `search_slack` retrieval and degraded behavior",
        "## 7. Railway service contract",
        "## 8. Current Railway readiness and cleanup boundary",
        "## 9. Dependency-ordered work packages",
        "## 10. Staged execution gates and acceptance matrix",
        "## 11. Operator approval checklist and handoff",
    ]
    for heading in spec_sections:
        require(errors, heading in spec, f"SPEC: missing section {heading!r}")

    require_terms(
        errors,
        spec,
        [
            "encrypted embedded retrieval storage",
            "one Railway service",
            "one persistent Railway volume",
            "server-v0.0.5",
            "PORT",
            "0.0.0.0",
            "SUPERMEMORY_DATA_DIR=/var/lib/supermemory",
            "Do not set `DATABASE_URL`",
            "one process/one machine",
            "cannot use Railway replicas",
            "brief downtime",
            "exact opaque namespaces",
            "workspace:{teamId}",
            "fan out every query to exact project tags",
            "deliberately duplicate",
            "waitUntil -> KnowledgeDO -> Cloudflare Queue -> opentag-bot queue() consumer -> Supermemory Local",
            "Slack traffic still terminates only at `opentag-bot`",
            "configuration and exact authorization precede automatic ingestion",
            "slack:{teamId}:{channelId}:{threadTs}",
            "client.add",
            "client.search.memories({ searchMode: \"hybrid\" })",
            "search_slack",
            "SUPERMEMORY_URL",
            "SUPERMEMORY_API_KEY",
            "OPENAI_API_KEY",
            "OPENAI_MODEL=gpt-5.1",
            "SUPERMEMORY_EMBEDDING_PROVIDER=local",
            "Xenova/bge-base-en-v1.5",
            "pagination-aware",
            "customId",
            "localDocumentId",
            "client.documents.get(id)",
            "processing_unconfirmed",
            "Only terminal `done` may set `indexed_revision`",
            "DLQ",
            "reconciliation",
            "backfill",
            "tombstone",
            "KnowledgeCitation",
            "Railway-managed public HTTPS domain",
            "infra/supermemory/entrypoint.sh",
            "signal-safe redactor",
            "first-boot contract test",
            "same service",
            "retain/unmount the original volume",
            "restore test",
            "cost guardrails",
            "build context is explicitly `infra/supermemory/`",
            "defaults to **RETAIN**",
            "STOP GATE R1",
            "STOP GATE R2",
            "STOP GATE C1/S1",
            "STOP GATE P1",
            "STOP GATE D1",
        ],
        "SPEC",
    )

    forbidden_current_claims = [
        r"Supermemory uses Postgres under the hood",
        r"self-hosted on Supabase",
        r"DATABASE_URL pointing at Supabase",
        r"containerTag is a prefix filter",
        r"Cloudflare Container with DATABASE_URL",
        r"^## Appendix: D1 core schema",
        r"^## 10\. RRF \+ Reranking",
        r"^## 8\. Burst embeddings",
    ]
    for pattern in forbidden_current_claims:
        require(
            errors,
            re.search(pattern, spec, re.IGNORECASE | re.MULTILINE) is None,
            f"SPEC: superseded architecture still presented as current: /{pattern}/",
        )

    require(
        errors,
        "Workers cannot reach Railway private networking directly" in spec,
        "SPEC: missing Cloudflare-to-Railway public-network limitation",
    )
    require(
        errors,
        "outside Codex transcripts" in spec and "wrangler secret put SUPERMEMORY_API_KEY" in spec,
        "SPEC: missing secret-safe generated API-key capture procedure",
    )
    require(
        errors,
        "first boot writes a generated `sm_...` bearer key to stdout" in spec
        and "neither that exact key nor secret patterns occur" in spec,
        "SPEC: missing first-boot Railway log-leak prevention and proof",
    )
    require(
        errors,
        "Railway native restore is not an isolated-project/service restore" in spec
        and "reattach the original" in spec,
        "SPEC: missing executable same-service native restore and rollback contract",
    )
    require(
        errors,
        "goal-outputs/supermemory-railway-knowledge-base/validate.py" in spec
        and "nonzero" in spec,
        "SPEC: missing deterministic validator path and failure behavior",
    )
    require(
        errors,
        "No live ingestion" in spec and "backup restoration" in spec and "cross-workspace" in spec,
        "SPEC: missing restore/auth-before-live-ingestion gate",
    )
    validate_work_packages(errors, spec)

    readiness_sections = [
        "## Verified access and method",
        "## Current visible resource inventory",
        "## Cleanup assessment — separate future work package",
        "## Deployment gate for Supermemory Local",
        "## Reproduction commands (read-only only)",
    ]
    for heading in readiness_sections:
        require(errors, heading in readiness, f"READINESS: missing section {heading!r}")

    require_terms(
        errors,
        readiness,
        [
            "bunx @railway/cli@5.27.0",
            "railway 5.27.0",
            "William Lopez-Cordero",
            "William Lopez-Cordero's Projects",
            "546abf5f-9447-4d89-84d3-5e5e08c809a0",
            "Not linked",
            "Read operations proven",
            "Writes not proven",
            "opentag-hybrid",
            "signalsci",
            "consulting",
            "senpi-openclaw",
            "15 services",
            "10 active public domains",
            "three volumes",
            "Default is RETAIN",
            "70f5cb39-7923-490e-85aa-b00c7b64c1f1",
            "owner confirmation",
            "explicit approval",
            "backup/rollback",
            "No candidate is `ELIGIBLE`",
            "no token value was read, printed, or retained",
        ],
        "READINESS",
    )
    require(
        errors,
        re.search(r"(?:token|api[_ -]?key|secret)\s*[=:]\s*[A-Za-z0-9_-]{16,}", readiness, re.IGNORECASE) is None,
        "READINESS: possible secret-like value detected",
    )

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        print(f"\n{len(errors)} validation failure(s)")
        return 1

    print(f"PASS: {SPEC} ({len(spec.encode())} bytes)")
    print(f"PASS: {READINESS} ({len(readiness.encode())} bytes)")
    print("PASS: required architecture, work-package, gate, readiness, cleanup, and secret-safety checks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
