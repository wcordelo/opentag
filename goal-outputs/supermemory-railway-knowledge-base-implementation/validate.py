#!/usr/bin/env python3
"""Deterministic source and focused-behavior validation for B0-B4 knowledge."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
EDGE = ROOT / "edge"

REQUIRED_FILES = {
    # B0
    "edge/src/config/workspace-config-do.ts": 2_000,
    "edge/src/config/knowledge-config.ts": 2_000,
    "edge/src/config/knowledge-source-authorization.ts": 8_000,
    "edge/src/memory/knowledge-contract.ts": 3_000,
    "edge/test/knowledge-config.test.ts": 2_000,
    "edge/test/knowledge-source-admin.test.ts": 3_000,
    "edge/test/knowledge-source-admin.workers.test.ts": 8_000,
    "edge/test/helpers/knowledge-source-grant.ts": 1_000,
    "edge/test/supermemory-contract.test.ts": 2_000,
    "edge/test/supermemory-entrypoint.test.ts": 1_000,
    "edge/test/workspace-knowledge-config.workers.test.ts": 1_000,
    "edge/package.json": 500,
    "edge/package-lock.json": 10_000,
    "infra/supermemory/README.md": 1_000,
    "infra/supermemory/Dockerfile": 1_000,
    "infra/supermemory/entrypoint.sh": 1_000,
    "infra/supermemory/test-fixtures/fake-supermemory.sh": 100,
    # B1
    "edge/src/memory/knowledge-do.ts": 5_000,
    "edge/src/memory/knowledge-ledger.ts": 10_000,
    "edge/src/memory/knowledge-jobs.ts": 5_000,
    "edge/src/memory/knowledge-queue-routing.ts": 1_000,
    "edge/src/worker.ts": 20_000,
    "edge/src/env.ts": 2_000,
    "edge/wrangler.bot.toml": 1_000,
    "edge/wrangler.bot-store.toml": 500,
    "edge/vitest.workers.bot-store.config.ts": 500,
    "edge/scripts/validate-deploy-config.mjs": 1_000,
    "edge/test/deploy-config-safety.test.ts": 1_000,
    "edge/test/knowledge-ledger.test.ts": 4_000,
    "edge/test/knowledge-ledger.workers.test.ts": 1_000,
    "edge/test/knowledge-queue.test.ts": 3_000,
    # B2
    "edge/src/slack/knowledge-thread-fetcher.ts": 4_000,
    "edge/src/memory/normalize-slack-thread.ts": 4_000,
    "edge/test/knowledge-thread-fetcher.test.ts": 2_000,
    "edge/test/normalize-slack-thread.test.ts": 2_000,
    # B3
    "edge/src/memory/supermemory-client.ts": 1_000,
    "edge/src/memory/supermemory-adapter.ts": 10_000,
    "edge/src/tools/search-slack.ts": 4_000,
    "edge/src/tools/index.ts": 10_000,
    "edge/test/supermemory-adapter.test.ts": 3_000,
    "edge/test/search-slack.test.ts": 2_000,
    # B4
    "edge/src/memory/knowledge-reconcile.ts": 2_000,
    "edge/src/memory/knowledge-backfill.ts": 3_000,
    "edge/src/memory/knowledge-backfill-authorization.ts": 5_000,
    "edge/test/knowledge-reconcile.test.ts": 1_000,
    "edge/test/knowledge-backfill.test.ts": 1_000,
    "edge/test/helpers/knowledge-backfill-approval.ts": 1_000,
    "edge/test/fixtures/knowledge-backfill/dry-run.json": 200,
    "docs/operations.md": 10_000,
    # Goal evidence
    "goal-outputs/supermemory-railway-knowledge-base-implementation/PROGRESS.md": 8_000,
    "goal-outputs/supermemory-railway-knowledge-base-implementation/b0-b2-repository-audit.md": 8_000,
    "goal-outputs/supermemory-railway-knowledge-base-implementation/supermemory-contract-audit.md": 8_000,
}

RUNTIME_FILES = [
    "edge/src/config/knowledge-config.ts",
    "edge/src/config/knowledge-source-authorization.ts",
    "edge/src/config/workspace-config-do.ts",
    "edge/src/env.ts",
    "edge/src/memory/knowledge-contract.ts",
    "edge/src/memory/knowledge-do.ts",
    "edge/src/memory/knowledge-ledger.ts",
    "edge/src/memory/knowledge-jobs.ts",
    "edge/src/memory/knowledge-queue-routing.ts",
    "edge/src/memory/knowledge-backfill.ts",
    "edge/src/memory/knowledge-backfill-authorization.ts",
    "edge/src/memory/knowledge-reconcile.ts",
    "edge/src/memory/normalize-slack-thread.ts",
    "edge/src/memory/supermemory-client.ts",
    "edge/src/memory/supermemory-adapter.ts",
    "edge/src/slack/knowledge-thread-fetcher.ts",
    "edge/src/tools/search-slack.ts",
    "infra/supermemory/Dockerfile",
    "infra/supermemory/entrypoint.sh",
]

FOCUSED_UNIT_TESTS = [
    "test/agent-turn-harness.test.ts",
    "test/knowledge-source-admin.test.ts",
    "test/knowledge-ledger.test.ts",
    "test/knowledge-queue.test.ts",
    "test/supermemory-adapter.test.ts",
    "test/knowledge-thread-fetcher.test.ts",
    "test/search-slack.test.ts",
    "test/knowledge-reconcile.test.ts",
    "test/knowledge-backfill.test.ts",
    "test/supermemory-entrypoint.test.ts",
    "test/deploy-config-safety.test.ts",
]

FOCUSED_WORKER_TESTS = [
    "test/knowledge-ledger.workers.test.ts",
    "test/knowledge-source-admin.workers.test.ts",
    "test/workspace-knowledge-config.workers.test.ts",
]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def require(errors: list[str], condition: bool, message: str) -> None:
    if not condition:
        errors.append(message)


def require_all(errors: list[str], relative: str, terms: list[str]) -> None:
    text = read(relative)
    for term in terms:
        require(errors, term in text, f"{relative}: missing required evidence {term!r}")


def require_regex(errors: list[str], relative: str, pattern: str, message: str) -> None:
    require(errors, re.search(pattern, read(relative), re.MULTILINE | re.DOTALL) is not None,
            f"{relative}: {message}")


def require_ordered(
    errors: list[str],
    relative: str,
    terms: list[str],
    *,
    after: str | None = None,
    message: str,
) -> None:
    text = read(relative)
    offset = text.find(after) if after else 0
    if after and offset < 0:
        errors.append(f"{relative}: missing call-path anchor {after!r}")
        return
    for term in terms:
        position = text.find(term, offset)
        if position < 0:
            errors.append(f"{relative}: {message}; missing/out-of-order {term!r}")
            return
        offset = position + len(term)


def focused_test_result(command: list[str]) -> tuple[bool, str]:
    result = subprocess.run(
        command,
        cwd=EDGE,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    output = re.sub(r"\x1b\[[0-9;]*m", "", result.stdout)
    summaries = [
        line.strip()
        for line in output.splitlines()
        if re.search(r"\b(Test Files|Tests)\b", line)
    ]
    detail = "; ".join(summaries[-2:]) if summaries else "\n".join(output.splitlines()[-20:])
    return result.returncode == 0, detail


def uncommented_toml(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def main(*, source_only: bool = False) -> int:
    errors: list[str] = []

    for relative, minimum_size in REQUIRED_FILES.items():
        path = ROOT / relative
        require(errors, path.is_file(), f"missing required B0-B4 path: {relative}")
        if path.is_file():
            require(errors, path.stat().st_size >= minimum_size,
                    f"{relative}: unexpectedly small ({path.stat().st_size} < {minimum_size} bytes)")
    report_path = ROOT / "goal-outputs/supermemory-railway-knowledge-base-implementation/IMPLEMENTATION-REPORT.md"
    require(errors, report_path.is_file(), "missing Task F implementation report")
    if report_path.is_file():
        require(errors, report_path.stat().st_size >= 8_000,
                f"implementation report: unexpectedly small ({report_path.stat().st_size} < 8000 bytes)")
    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        return 1

    package = json.loads(read("edge/package.json"))
    lock = json.loads(read("edge/package-lock.json"))
    require(errors, package.get("dependencies", {}).get("supermemory") == "4.24.12",
            "edge/package.json: supermemory must be pinned exactly to 4.24.12")
    require(errors, lock.get("packages", {}).get("node_modules/supermemory", {}).get("version") == "4.24.12",
            "edge/package-lock.json: installed supermemory package must be exactly 4.24.12")
    require(errors, lock.get("packages", {}).get("", {}).get("dependencies", {}).get("supermemory") == "4.24.12",
            "edge/package-lock.json: root dependency must pin supermemory exactly to 4.24.12")
    scripts = package.get("scripts", {})
    require(errors, "deploy:bot-store" not in scripts,
            "edge/package.json: deploy:bot-store must remain absent")
    require(errors, all(
        not (
            re.search(r"\bwrangler\s+deploy\b", str(command)) and
            "wrangler.bot-store.toml" in str(command)
        )
        for command in scripts.values()
    ), "edge/package.json: a deploy script targets wrangler.bot-store.toml")
    deploy_validator = subprocess.run(
        ["node", "scripts/validate-deploy-config.mjs"],
        cwd=EDGE,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    require(errors, deploy_validator.returncode == 0,
            "deploy-config validator failed: " + deploy_validator.stdout.strip())

    require_all(errors, "edge/src/memory/knowledge-contract.ts", [
        '"indexing"', 'return `workspace:${identifier(teamId, "teamId")}`',
        'return `slack:${identifier(teamId, "teamId")}:${identifier(channelId, "channelId")}:${sourcePart(threadTs, "threadTs")}`',
        'customId', 'prefix', 'glob', 'createKnowledgeJob', 'canonical ISO timestamp',
    ])
    require_all(errors, "edge/test/knowledge-config.test.ts", [
        'workspace:T1', 'slack:T1:C1:171234.000100', 'containerTags', 'canonical ISO timestamp',
    ])

    require_all(errors, "edge/src/config/knowledge-config.ts", [
        'enabled: false', 'configVersion: 0', 'enabled knowledge sources require readerPolicyRef',
        'dataDir: "/var/lib/supermemory"', 'openAiModel: "gpt-5.1"',
        'openAiFastModel: "gpt-5.1"', 'openAiTextModel: "gpt-5.1"',
        'embeddingProvider: "local"', 'embeddingModel: "Xenova/bge-base-en-v1.5"',
        'embeddingDimensions: 768',
    ])
    require_all(errors, "edge/src/config/workspace-config-do.ts", [
        'tracked_knowledge_sources', 'idx_tracked_knowledge_one_enabled_project',
        'WHERE enabled = 1', 'tracked knowledge channel already has a different enabled project',
        'verified deletion/reindex contract', '/listTrackedKnowledgeSources', '/putTrackedKnowledgeSource',
        'ever_enabled', 'tracked_knowledge_effect_leases',
        '/beginKnowledgeIngestionEffect', '/validateKnowledgeIngestionEffect',
        '/releaseKnowledgeIngestionEffect', 'tracked knowledge source has an active ingestion effect',
        'tracked_knowledge_source_authorizations', '/authorizedTrackedKnowledgeSourceAction',
        'knowledge_source_grant_replayed', 'stale_grant_config_version',
        'active_ingestion_effect', 'conflicting_project_enabled',
        'first_enable_transition_invalid',
    ])
    require_regex(errors, "edge/src/config/workspace-config-do.ts",
                  r"CREATE UNIQUE INDEX IF NOT EXISTS idx_tracked_knowledge_one_enabled_project\s+ON tracked_knowledge_sources\(team_id, channel_id\) WHERE enabled = 1",
                  "missing one-enabled-project-per-team/channel database constraint")

    require_all(errors, "edge/src/env.ts", [
        'KNOWLEDGE_QUEUE?: Queue<KnowledgeJob>', 'KNOWLEDGE_QUEUE_NAME?: string',
        'KNOWLEDGE_DLQ_NAME?: string',
        'KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED?: string',
        'KNOWLEDGE_RECONCILIATION_TEAM_IDS?: string',
        'SUPERMEMORY_URL?: string', 'SUPERMEMORY_API_KEY?: string',
        'KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY?: string',
        'KNOWLEDGE_SOURCE_AUTH_ISSUER?: string',
        'KNOWLEDGE_SOURCE_AUTH_KEY_ID?: string',
        'KNOWLEDGE_BACKFILL_APPROVAL_PUBLIC_KEY?: string',
        'KNOWLEDGE_BACKFILL_APPROVAL_ISSUER?: string',
        'KNOWLEDGE_BACKFILL_APPROVAL_KEY_ID?: string',
    ])
    require_all(errors, "edge/src/config/knowledge-source-authorization.ts", [
        'OT-KNOWLEDGE-SOURCE-GRANT', '"Ed25519"', 'KNOWLEDGE_SOURCE_GRANT_MAX_LIFETIME_MS',
        'stage_disabled', 'update_disabled', 'enable_first', 'list_exact',
        'knowledgeSourceAdminRequestDigest', 'knowledge_source_grant_signature_invalid',
        'knowledge_source_grant_scope_or_action_mismatch',
        'knowledge_source_grant_expired_or_invalid',
    ])
    wrangler_live = uncommented_toml(read("edge/wrangler.bot.toml"))
    bot_store_live = uncommented_toml(read("edge/wrangler.bot-store.toml"))
    require(errors, "ADMIN_SECRET" not in bot_store_live,
            "edge/wrangler.bot-store.toml: test admin credential must be Miniflare-only")
    for path in sorted(
        path for path in EDGE.rglob("wrangler*.toml")
        if "node_modules" not in path.parts
    ):
        live = uncommented_toml(path.read_text(encoding="utf-8"))
        require(errors, re.search(r"^\s*ADMIN_SECRET\s*=", live, re.MULTILINE) is None,
                f"{path.relative_to(ROOT)}: deployable TOML embeds ADMIN_SECRET")
        require(errors, re.search(
            r"(?:test|dev|default|sample|example)[-_]?admin[-_]?secret|change[-_]?me|password",
            live,
            re.IGNORECASE,
        ) is None, f"{path.relative_to(ROOT)}: deployable TOML embeds a known/default admin credential")
    require(errors, "[[queues.producers]]" not in wrangler_live,
            "edge/wrangler.bot.toml: production Queue producer is live before C1 approval")
    require(errors, "[[queues.consumers]]" not in wrangler_live,
            "edge/wrangler.bot.toml: production Queue consumer is live before C1 approval")
    require(errors, "[triggers]" not in wrangler_live,
            "edge/wrangler.bot.toml: production scheduled trigger is live before C1 approval")
    for variable in [
        "KNOWLEDGE_QUEUE_NAME",
        "KNOWLEDGE_DLQ_NAME",
        "KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED",
        "KNOWLEDGE_RECONCILIATION_TEAM_IDS",
        "KNOWLEDGE_SOURCE_AUTH_PUBLIC_KEY",
        "KNOWLEDGE_SOURCE_AUTH_ISSUER",
        "KNOWLEDGE_SOURCE_AUTH_KEY_ID",
        "KNOWLEDGE_BACKFILL_APPROVAL_PUBLIC_KEY",
        "KNOWLEDGE_BACKFILL_APPROVAL_ISSUER",
        "KNOWLEDGE_BACKFILL_APPROVAL_KEY_ID",
    ]:
        require(errors, variable not in wrangler_live,
                f"edge/wrangler.bot.toml: {variable} is live before its external gate")
        require(errors, variable not in bot_store_live,
                f"edge/wrangler.bot-store.toml: deployable test alias contains gated {variable}")
    worker = read("edge/src/worker.ts")
    require_all(errors, "edge/src/worker.ts", [
        'exec.waitUntil(', 'scheduleKnowledgeFromSlackEvent', 'worker.queue', 'handleKnowledgeQueue',
        'handleKnowledgeDlq', '/admin/knowledge/reconcile', '/admin/knowledge/dlq',
        'worker.scheduled', 'runScheduledKnowledgeReconciliation',
        'routeKnowledgeQueueName', 'retryKnowledgeBatchWithoutParsing',
        '/admin/knowledge/backfill/discover', '/approve', '/execute',
        'KNOWLEDGE_BACKFILL_APPROVAL_HEADER', 'KnowledgeBackfillApprovalError',
        '/admin/knowledge/sources/inspect', '/admin/knowledge/sources/list',
        '/admin/knowledge/sources/stage', '/admin/knowledge/sources/update-disabled',
        '/admin/knowledge/sources/enable-first', '/admin/knowledge/sources/disable',
        'verifyKnowledgeSourceGrant', 'knowledgeSourceActionHandler',
    ])
    require_regex(
        errors,
        "edge/src/worker.ts",
        r'app\.post\(\s*"/admin/knowledge/sources/stage",\s*requireAdminAuth\(\),\s*'
        r'knowledgeSourceActionHandler\("stage_disabled"\)',
        "disabled source staging is not connected to both admin and signed-grant authorization",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r'app\.post\(\s*"/admin/knowledge/sources/enable-first",\s*requireAdminAuth\(\),\s*'
        r'knowledgeSourceActionHandler\("enable_first"\)',
        "first-enable transition is not a separate signed exact-scope route",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r'app\.post\(\s*"/admin/knowledge/sources/disable",\s*requireAdminAuth\(\),\s*'
        r'knowledgeSourceActionHandler\("disable"\)',
        "disable transition is not a separate signed exact-scope route",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r'app\.post\("/admin/knowledge/reconcile",\s*requireAdminAuth\(\).*?'
        r"runKnowledgeReconciliationPage\(c\.env",
        "reconciliation is not connected to the authenticated admin control plane",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r'app\.post\("/admin/knowledge/backfill/:manifestId/approve",\s*requireAdminAuth\(\).*?'
        r"approveKnowledgeBackfillManifest\(c\.env",
        "P1 manifest approval is not connected to the authenticated admin control plane",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r'app\.post\("/admin/knowledge/backfill/:manifestId/execute",\s*requireAdminAuth\(\).*?'
        r"executeKnowledgeBackfillPage\(c\.env",
        "approved manifest execution is not connected to the authenticated admin control plane",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r"worker\.queue\s*=\s*async.*?"
        r"routeKnowledgeQueueName\(batch\.queue,\s*env\).*?"
        r"retryKnowledgeBatchWithoutParsing\(batch\).*?"
        r"throw error.*?"
        r'route === "dlq".*?handleKnowledgeDlq\(batch,\s*env\).*?'
        r"handleKnowledgeQueue\(batch,\s*env,\s*dispatchKnowledgeToSupermemory\)",
        "Queue entry does not fail closed before exact primary/DLQ routing",
    )
    require_regex(
        errors,
        "edge/src/worker.ts",
        r"worker\.scheduled\s*=.*?ctx\.waitUntil\(\s*"
        r"runScheduledKnowledgeReconciliation\(env,\s*\{\s*scheduledAt\s*\}\)",
        "source-level scheduled entry is not connected to the durable reconciliation coordinator",
    )
    require_all(errors, "edge/src/memory/knowledge-queue-routing.ts", [
        'KNOWLEDGE_QUEUE_NAME', 'KNOWLEDGE_DLQ_NAME',
        'primary === dlq', 'primary.endsWith("-dlq")', 'dlq.endsWith("-dlq")',
        'knowledge_queue_name_unknown', 'message.retry({ delaySeconds })',
    ])

    require_all(errors, "edge/src/memory/knowledge-ledger.ts", [
        'knowledge_ledger', 'knowledge_outbox', 'recoverSending', 'processing_unconfirmed',
        'unsupported_update_contract', 'ambiguous_add_contract', 'tombstoned',
        'resume_poll', 'local_document_id', 'indexed_revision',
        'knowledge_reconcile_runs', 'pending_page_token',
        'knowledge_reconcile_coordinator', 'claimReconcileCoordinator',
        'checkpointReconcileCoordinatorPage', 'failReconcileCoordinator',
        'knowledge_dlq_records', 'replay_disposition', 'disposed',
        'knowledge_backfill_manifests', 'approval_gate', 'claimReconcilePage',
        'claimDlqReplay', 'claimBackfillPage',
        'local_document_revision', 'add_attempt_revision',
    ])
    require_all(errors, "edge/src/memory/knowledge-do.ts", [
        'DLQ replay disposition is required',
        '/reconcile/coordinator/claim', '/reconcile/coordinator/page',
        '/reconcile/coordinator/advance', '/reconcile/coordinator/fail',
    ])
    require_regex(
        errors,
        "edge/src/memory/knowledge-ledger.ts",
        r"if \(current\.localDocumentId\).*?"
        r"current\.localDocumentRevision !== desiredRevision.*?"
        r'blocked", reason: "unsupported_update_contract".*?'
        r'decision: "poll", localDocumentId: current\.localDocumentId',
        "a retained Local ID is not revision-bound before poll resume",
    )
    require_regex(
        errors,
        "edge/src/memory/knowledge-ledger.ts",
        r"current\.localDocumentId !== outcome\.localDocumentId\s*\|\|\s*"
        r"current\.localDocumentRevision !== outcome\.desiredRevision\s*\|\|\s*"
        r"outcome\.indexedRevision !== outcome\.desiredRevision",
        "terminal indexed outcomes are not bound to the accepted Local ID revision",
    )
    require_all(errors, "edge/src/memory/knowledge-jobs.ts", [
        'createKnowledgeJob', 'tracked_source_project_conflict',
        'Queue-only consumer seam', 'parseKnowledgeJob',
        '"reply_delete"', 'const identityMismatch',
        'parentTs !== messageTs', 'previousTs &&',
        '/beginKnowledgeIngestionEffect', '/validateKnowledgeIngestionEffect',
        '/releaseKnowledgeIngestionEffect',
    ])
    require_ordered(
        errors,
        "edge/src/memory/knowledge-jobs.ts",
        [
            "const source = await loadExactSource",
            '"/beginKnowledgeIngestionEffect"',
            '"/lease"',
            "const outcome = await dispatch",
            '"/releaseKnowledgeIngestionEffect"',
        ],
        after="export async function handleKnowledgeQueue",
        message="Queue consumer source/effect/ledger/dispatch/release path is disconnected",
    )
    require_all(errors, "edge/src/memory/knowledge-do.ts", [
        'KNOWLEDGE_QUEUE?', 'knowledge_queue_binding_unavailable', 'memorySearch', 'memoryWrite',
        'this.ledger.migrate()', 'armPendingOutbox', '/reconcile/claim', '/reconcile/commit',
        '/dlq/capture', '/dlq/replay/claim', '/backfill/manifest', '/backfill/approve',
        '/backfill/claim', '/backfill/enqueue', 'backfill descriptors require approved manifest execution',
        'knowledgeBackfillManifestDigest',
    ])

    require_all(errors, "edge/src/slack/knowledge-thread-fetcher.ts", [
        'maxPages: 20', 'maxMessages: 1_000', 'maxBytes: 2_000_000',
        'cursor_missing', 'cursor_loop', 'retry_exhausted', 'MAX_KNOWLEDGE_RETRY_AFTER_MS',
        'application/x-www-form-urlencoded', 'new AbortController()',
        'DEFAULT_KNOWLEDGE_THREAD_FETCH_TIMEOUT_MS',
        'DEFAULT_KNOWLEDGE_SLACK_ATTEMPT_TIMEOUT_MS', 'signal: attemptController.signal',
    ])
    require_ordered(
        errors,
        "edge/src/slack/knowledge-thread-fetcher.ts",
        [
            "const overallController = new AbortController()",
            "const overallDeadlineAt",
            "const overallTimer = setTimeout",
            "signal: overallController.signal",
            "deadlineAt: overallDeadlineAt",
            "Promise.race",
        ],
        after="export async function fetchKnowledgeThread",
        message="overall Slack thread timeout is not carried to each page read",
    )
    require_all(errors, "edge/src/memory/normalize-slack-thread.ts", [
        'normalize("NFKC")', 'SHA-256', 'incomplete', '[deleted message]', '[bot/system message omitted]',
    ])
    require(errors, '"value"' not in read("edge/src/memory/normalize-slack-thread.ts"),
            "normalize-slack-thread.ts: generic Slack action value is included as corpus text")

    require_all(errors, "edge/src/memory/supermemory-client.ts", [
        'maxRetries: 0', 'SUPERMEMORY_REQUEST_TIMEOUT_MS = 5_000', 'url.protocol !== "https:"',
        'url.username', 'url.password', 'url.search', 'url.hash', 'url.pathname', 'baseURL: url.origin',
    ])
    require_all(errors, "edge/src/memory/supermemory-adapter.ts", [
        'containerTag: workspaceTag(input.teamId)',
        'customId: slackSourceKey(input.teamId, input.metadata.channelId, input.metadata.threadTs)',
        'searchMode: "hybrid"', 'containerTag: workspaceTag(input.teamId)',
        '{ key: "projectId", value: input.projectId }',
        '{ key: "channelId", value: input.channelId }',
        '{ key: "status", value: "active" }',
        'processing_unconfirmed', 'localDocumentId', 'pollDocument', 'status === "done"',
        'unsupported_delete_contract', 'unsupported_update_contract', 'ambiguous_add_contract',
    ])
    require_ordered(
        errors,
        "edge/src/memory/supermemory-adapter.ts",
        [
            "await context.validateSource()",
            '"/prepareRevision"',
            "await context.validateSource()",
            "await adapter.addSlackDocument",
            "await context.validateSource()",
            '"/localAccepted"',
            "await context.validateSource()",
            "await adapter.pollDocument",
            "recordFencedOutcome",
        ],
        after="export function createKnowledgeSupermemoryDispatch",
        message="ingestion does not revalidate its durable config fence across external effects",
    )
    require_all(errors, "edge/src/tools/search-slack.ts", [
        'requireRequestContext', 'requirePermissionSnapshot',
        'const channelId = dependencies.channel(thread)', 'teamId: context.teamId', 'channelId,',
        'currentTurnAccess', 'bundleIdFromReaderPolicyRef', 'policy_denied',
        'source_not_enabled', 'source_conflict', 'knowledge_unavailable', 'citationIsCurrent',
        'state.ledger.configVersion === configVersion',
    ])
    require_all(errors, "edge/test/search-slack.test.ts", [
        'exact matching turn bundle policy', 'wrong current bundle', 'wrong source policy',
        'channel bundle changes during Local', 'channel policy config changes during Local',
        'wrong $name scope', 'denies automation',
        'exact-turn Stop wins during Local',
    ])
    require_ordered(
        errors,
        "edge/src/tools/search-slack.ts",
        [
            "exactPermissionSnapshot",
            "enabledSource",
            "currentTurnAccess",
            "accessAuthorizesSource",
            "adapter.searchSlack",
            "enabledSource",
            "currentTurnAccess",
            "citationIsCurrent",
            "enabledSource",
            "currentTurnAccess",
        ],
        after="export async function searchSlackKnowledge",
        message="search authorization is not rechecked before and after Local/ledger awaits",
    )
    require_ordered(
        errors,
        "edge/src/tools/search-slack.ts",
        [
            "getTurnExecutionContext",
            "await dependencies.assertActive",
            "requirePermissionSnapshot",
            "await dependencies.assertActive",
        ],
        after="export function createSearchSlackTool",
        message="search_slack is not connected to exact-turn and permission-snapshot guards",
    )
    require_all(errors, "edge/src/tools/index.ts", ['createSearchSlackTool', 'searchSlackTool'])

    require_all(errors, "edge/src/memory/knowledge-reconcile.ts", [
        'createKnowledgeJob', 'resume_poll', 'unsupported_update_contract',
        'unsupported_delete_contract', 'replay_one', 'an exact sourceKey is required',
        'runKnowledgeReconciliationPage', 'loadAuthoritativeSource',
        'handleKnowledgeDlq', 'replayDurableKnowledgeDlqRecord',
        'rootCauseCorrectionRef', 'config drifted',
        'submitKnowledgeDescriptor', 'accepted_response_lost',
        'proveKnowledgeDescriptorDisposition', 'runScheduledKnowledgeReconciliation',
        'KNOWLEDGE_RECONCILIATION_SCHEDULE_ENABLED',
        'KNOWLEDGE_RECONCILIATION_TEAM_IDS',
        'maxPagesPerInvocation', 'maxTeamsPerInvocation',
        'knowledge_reconcile_page_completed', 'knowledge_reconcile_lag_seconds',
        'knowledge_reconcile_run_error',
    ])
    require_all(errors, "edge/src/memory/knowledge-backfill.ts", [
        'maxChannels: 50', 'maxItems: 1_000', 'maxRangeDays: 90',
        'maxDiscoveryPagesPerInvocation: 20',
        'backfill requires a dry-run manifest first',
        'a non-empty bounded explicit channel list is required',
        '"unvisited"', '"pending"', '"exhausted"', '"complete_over_budget"',
        'createKnowledgeJob', 'mode: "dry_run"', 'sourceConfigVersions',
        'knowledgeBackfillManifestDigest', 'discoverAndStoreKnowledgeBackfill',
        'exactText(input.manifestId, "manifestId", 128)',
        'approveKnowledgeBackfillManifest', 'executeKnowledgeBackfillPage',
        '/backfill/discovery/start', '/backfill/discovery/merge',
        'verifyKnowledgeBackfillApproval', 'proveKnowledgeDescriptorDisposition',
        '/backfill/result', '/backfill/fail', 'pageStatus: "partial"',
        'manifest config mismatch',
    ])
    require_all(errors, "edge/src/memory/knowledge-backfill-authorization.ts", [
        'OT-KNOWLEDGE-BACKFILL-APPROVAL', '"Ed25519"',
        'KNOWLEDGE_BACKFILL_APPROVAL_MAX_LIFETIME_MS',
        'knowledge_backfill_approval_verifier_not_configured',
        'knowledge_backfill_approval_signature_invalid',
        'knowledge_backfill_approval_scope_budget_or_release_mismatch',
        'knowledge_backfill_approval_expired_or_invalid',
        'maximumRatePerMinute', 'maximumErrors', 'releaseIds', 'rollbackOwner',
    ])
    require_all(errors, "edge/src/memory/knowledge-ledger.ts", [
        'knowledge_backfill_discoveries',
        'knowledge_backfill_discovery_channels',
        'knowledge_backfill_candidates',
        'knowledge_backfill_approvals',
        'knowledge_backfill_approval_replayed',
        'backfill execution error budget exhausted',
        'backfill execution rate budget exhausted',
        'backfill page has unclassified jobs',
        'pending_results_json', 'supersedes_approval_id',
        'knowledge_backfill_approval_overlap',
        'knowledge_backfill_approval_budget_loosened',
        'listBackfillApprovalAudit',
    ])
    require_all(errors, "edge/test/knowledge-ledger.workers.test.ts", [
        'before_add', 'after_add_started', 'after_local_accepted',
        'during_polling', 'before_terminal',
        'uncommitted reconciliation page', 'scheduled reconciliation coordinator',
        'observable DLQ records', 'replayDisposition: "superseded"',
        'global-page-capped multi-channel discovery',
        'caller-known manifest after the first Slack page fails',
        'config drift', 'one-use external P1 evidence',
        'partial page dispositions',
    ])
    require_all(errors, "edge/test/knowledge-reconcile.test.ts", [
        'live lease', 'expired lease', 'durable page', 'real DLQ batch',
        'accepted-but-response-lost', 'superseded DLQ disposition',
        'without manual calls', 'partial scheduler page',
    ])
    require_all(errors, "edge/test/knowledge-queue.test.ts", [
        'exact role-bound primary and DLQ names',
        'missing, identical, and swapped Queue role names',
        'without parsing message bodies',
    ])
    require_all(errors, "edge/test/knowledge-backfill.test.ts", [
        'pins every exact source version', 'tampering evident',
        'no empty/all-workspace discovery', 'caller cursor',
        'manifestId',
        'external Ed25519 P1 authority', 'partial page acceptance',
        'maximumCount: 9', 'maximumRatePerMinute: 4', 'maximumErrors: 0',
        '{ maximumCount: 11 }', '{ maximumRatePerMinute: 6 }',
    ])
    require_all(errors, "edge/test/knowledge-ledger.test.ts", [
        'reply deletions as refetch mutations',
        'renews expired P1 authority with stricter budgets',
        'approval-overlap', 'approval-expired-renewal',
        'approval-looser-budget', 'budget_loosened',
        'supersedesApprovalId: "approval-1"',
        'rateWindowReserved: 2', 'rateWindowReserved: 1',
        'preserves a queued root delete across a later reply/edit race',
    ])
    require_all(errors, "edge/test/knowledge-queue.test.ts", [
        'only a proven root deletion', '"thread reply"',
        '"broadcast reply"', 'malformed previous_message identity',
        'reason: "reply_delete"', 'messageTs: "171234.000199"',
    ])
    require_all(errors, "edge/test/supermemory-adapter.test.ts", [
        'tombstones only a root-delete job',
        'refetches a reply deletion',
        'unsupported_update_contract',
    ])
    require_all(errors, "edge/scripts/validate-deploy-config.mjs", [
        'wrangler deploy', 'bot-store', 'ADMIN_SECRET',
        'known/default admin credential',
        'visitFiles',
        'deploy-config validator self-test failed',
    ])
    require_all(errors, "edge/test/deploy-config-safety.test.ts", [
        'has no package deploy script for a bot-store/test/debug config',
        'keeps admin credentials out of every deployable Wrangler TOML',
        'validate-deploy-config.mjs',
    ])

    require_all(errors, "infra/supermemory/Dockerfile", [
        'server-v0.0.5', 'b2fccca3ff2b5607ce41028c759f375c4ecf5461adc9f3306f41c2757edaf375',
        'dd3e48fbabbffc628c5f61b3d895c27abf803c5a2f9fb485d73bc72f40613c0f',
        'sha256sum -c -', 'SUPERMEMORY_DATA_DIR=/var/lib/supermemory',
        'OPENAI_MODEL=gpt-5.1', 'OPENAI_FAST_MODEL=gpt-5.1', 'OPENAI_TEXT_MODEL=gpt-5.1',
        'SUPERMEMORY_EMBEDDING_PROVIDER=local', 'SUPERMEMORY_EMBEDDING_MODEL=Xenova/bge-base-en-v1.5',
        'SUPERMEMORY_EMBEDDING_DIMENSIONS=768', 'USER supermemory',
        'ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/supermemory-entrypoint"]',
        'CMD []',
    ])
    require_regex(
        errors,
        "infra/supermemory/Dockerfile",
        r'^ENTRYPOINT \["/usr/bin/tini", "--", "/usr/local/bin/supermemory-entrypoint"\]\s*'
        r'(?:#[^\n]*\n)*CMD \[\]\s*$',
        "Docker default argv must leave the wrapper-owned binary argument list empty",
    )
    require(errors, "DATABASE_URL" not in read("infra/supermemory/Dockerfile"),
            "infra/supermemory/Dockerfile: DATABASE_URL must be deliberately absent")
    require_all(errors, "infra/supermemory/entrypoint.sh", [
        'umask 077', 'REDACT_EXACT_SECRETS', 'sm_[A-Za-z0-9_-]+',
        'OPENAI_API_KEY|SUPERMEMORY_API_KEY', 'kill -TERM', 'wait "$child_pid"',
    ])
    require_all(errors, "infra/supermemory/README.md", [
        'bind host', 'health', 'generated-key', 'DATABASE_URL', 'non-root', 'R1',
    ])

    require_all(errors, "docs/operations.md", [
        'waitUntil -> KnowledgeDO -> Cloudflare Queue ->', 'opentag-bot queue()',
        'unsupported_update_contract', 'unsupported_delete_contract', 'ambiguous_add_contract',
        'processing_unconfirmed', 'Only Local status `done`', 'DLQ inspection',
        'dry-run manifest', 'R1', 'R2', 'C1/S1', 'P1', 'D1',
        'Every live canary and each backfill manifest requires separate P1 approval',
        'KNOWLEDGE_QUEUE_NAME', 'KNOWLEDGE_RECONCILIATION_TEAM_IDS',
        'scheduled reconciliation coordinator', 'application-level',
        'disposed', 'accepted_response_lost',
        'X-OpenTag-Knowledge-Source-Grant', 'ADMIN_SECRET` alone never',
        'POST /admin/knowledge/sources/stage', 'POST /admin/knowledge/sources/enable-first',
        'Re-enable', 'no grant issuer, private key, or fallback authority',
        'x-opentag-knowledge-backfill-approval',
        'complete_over_budget', 'blocked_config_drift',
        'Caller-supplied `approvalGate`', 'partial-page error',
        'KNOWLEDGE_BACKFILL_APPROVAL_PUBLIC_KEY',
        '`reply_delete`', 'actual root', 'independently signed one-use artifact',
        'npm run validate:deploy-config',
    ])
    require_regex(
        errors,
        "docs/operations.md",
        r"Manual diagnostic reconciliation\s+is one exact team at a time",
        "operations docs must keep the manual route diagnostic and exact-team scoped",
    )

    runtime = "\n".join(read(relative) for relative in RUNTIME_FILES)
    for term in ["supabase", "postgres", "hyperdrive", "pgvector", "vectorize"]:
        require(errors, term not in runtime.casefold(),
                f"runtime implementation introduces forbidden superseded architecture term: {term}")
    forbidden_addressing = [
        r"containerTag\s*:\s*[`\"']workspace:[^`\"']*[*?]",
        r"containerTag\s*:\s*[^,\n]+\.startsWith\(",
        r"workspaceTag\([^)]*\)\s*\+",
    ]
    for pattern in forbidden_addressing:
        require(errors, re.search(pattern, runtime, re.IGNORECASE) is None,
                f"runtime implementation appears to use workspace prefix/glob addressing: /{pattern}/")

    if not errors and not source_only:
        unit_ok, unit_detail = focused_test_result(
            ["npm", "test", "--", "--run", *FOCUSED_UNIT_TESTS],
        )
        require(
            errors,
            unit_ok,
            "focused blocker-correction unit behaviors failed: " + unit_detail,
        )
        if unit_ok:
            print(f"PASS: focused blocker-correction unit behaviors ({unit_detail})")
        worker_ok, worker_detail = focused_test_result(
            ["npm", "run", "test:e2e", "--", "--run", *FOCUSED_WORKER_TESTS],
        )
        require(
            errors,
            worker_ok,
            "focused blocker-correction workerd behaviors failed: " + worker_detail,
        )
        if worker_ok:
            print(f"PASS: focused blocker-correction workerd behaviors ({worker_detail})")

    if errors:
        for error in errors:
            print(f"FAIL: {error}")
        print(f"\n{len(errors)} implementation validation failure(s)")
        return 1

    total = sum((ROOT / relative).stat().st_size for relative in REQUIRED_FILES)
    print(f"PASS: {len(REQUIRED_FILES)} required B0-B4 files ({total} bytes)")
    print(f"PASS: implementation report ({report_path.stat().st_size} bytes)")
    print("PASS: exact SDK pin, Local tag/customId/status/search/runtime contracts")
    print("PASS: signed exact-scope source lifecycle, durable one-use actor evidence, and one-enabled-project constraint")
    print("PASS: deployable lifecycle/P1 verifier and activation config remains absent pending C1/S1/P1; test verifier/admin bindings are Miniflare-only")
    print("PASS: root-vs-reply deletion, durable outbox/lease/scheduled reconciliation/Queue routing/DLQ disposition/discovery/same-or-stricter external-P1 renewal/page-disposition contracts")
    print("PASS: deploy scripts and Wrangler TOMLs contain no test/debug deploy target or embedded admin credential")
    if source_only:
        print("PASS: source/call-path validation only; focused behavioral suites were explicitly skipped")
    else:
        print("PASS: focused behavior validates the declared blocker-correction paths")
    print("PASS: no superseded runtime architecture or workspace prefix/glob query")
    print("PASS: repository validation only; no deployed or external runtime behavior is claimed")
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-only",
        action="store_true",
        help="run deterministic source/call-path checks without focused Vitest behavior",
    )
    args = parser.parse_args()
    sys.exit(main(source_only=args.source_only))
