from __future__ import annotations

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GOAL_DIR = Path(__file__).resolve().parent
AUDIT = ROOT / "goal-outputs/opentag-2-gap-audit/gap-audit.md"
REPORT = GOAL_DIR / "remediation-report.md"

FINDING_IDS = [
    *(f"C{i}" for i in range(1, 5)),
    *(f"H{i}" for i in range(1, 9)),
    *(f"M{i}" for i in range(1, 9)),
    *(f"L{i}" for i in range(1, 4)),
]


def read(relative: str) -> str:
    path = ROOT / relative
    assert path.is_file(), f"missing required file: {relative}"
    text = path.read_text(encoding="utf-8")
    assert text.strip(), f"empty required file: {relative}"
    return text


def require(relative: str, *needles: str) -> None:
    text = read(relative)
    for needle in needles:
        assert needle in text, f"{relative}: missing required evidence {needle!r}"


def forbid(relative: str, *needles: str) -> None:
    text = read(relative)
    for needle in needles:
        assert needle not in text, f"{relative}: forbidden stale behavior remains {needle!r}"


def check_audit_census() -> None:
    audit = AUDIT.read_text(encoding="utf-8")
    observed = re.findall(r"^### ([CHML]\d+)\.", audit, flags=re.MULTILINE)
    assert observed == FINDING_IDS, f"audit census changed: {observed!r}"


def check_source_evidence() -> None:
    # One or more mechanically detectable implementation anchors per finding.
    # Fitness and correctness of these implementations are reserved for Tier 2.
    anchors: dict[str, list[tuple[str, tuple[str, ...]]]] = {
        "C1": [("edge/src/agent-turn.ts", ("AuthoritativeHarnessError",))],
        "C2": [
            ("edge/src/slack/client-message-id.ts", ("UUID", "stableSlackClientMessageId")),
            ("edge/src/slack/cloudflare-slack-adapter.ts", ("confirmLiveMessage", "markLiveMessageAbsent")),
        ],
        "C3": [("edge/src/slack/cloudflare-slack-adapter.ts", ("persistSessionTerminal",))],
        "C4": [("edge/src/slack/stream-render.ts", ("buildSlackMessagePages",))],
        "H1": [
            ("edge/src/slack/stop-routing.ts", ("/opentag/control/interrupt", "quiescent")),
            ("runtime.ts", ("/opentag/control/interrupt", "executionId")),
        ],
        "H2": [("edge/src/slack/overrides.ts", ("--codex", "--model"))],
        "H3": [
            ("edge/src/slack/download-files.ts", ("AttachmentStager",)),
            ("edge/src/slack/late-file-repair.ts", ("PendingFilelessMention", "matchLateFileEvent")),
            ("edge/workers/sandbox/turn-contract.ts", ("attachments", "staged")),
            ("edge/workers/sandbox/src/router.ts", ("resolveStagedTurnAttachments", "staged_attachment_digest_mismatch")),
            ("edge/workers/sandbox/wrangler.toml", ('binding = "BLOBS"',)),
            ("edge/test/harness-container-router.test.ts", ("staged", "BLOBS")),
        ],
        "H4": [("edge/src/slack/web-api.ts", ("SlackChannelRateScheduler", "Retry-After"))],
        "H5": [("edge/src/store/session-event-do.ts", ("transactionSync",))],
        "H6": [
            ("slack-app-manifest.yaml", ("users.profile:read",)),
            ("edge/src/slack/web-api.ts", ("users.profile.get", "include_labels")),
            ("edge/workers/sandbox/src/egress-policy.ts", ("Prompted by:",)),
        ],
        "H7": [
            ("edge/src/slack/stream-render.ts", ("buildSlackMessagePages", "MAX_BLOCKS")),
            ("edge/test/stream-render-pages.test.ts", ("200_000",)),
            ("lib/research/delivery/slack.ts", ("researchDeliveryPages", "slack-pages-v2")),
            ("lib/research/__tests__/delivery.test.ts", ("200k", "stable per-page identities")),
        ],
        "H8": [("edge/src/worker.ts", ("preAdmitSlackTurn", "waitUntil"))],
        "M1": [("edge/src/slack/cloudflare-slack-adapter.ts", ("createRunRenderer", "showToolStatus"))],
        "M2": [("edge/src/slack/turn-lifecycle.ts", ("Thinking", 'status: ""'))],
        "M3": [("edge/src/slack/session-history.ts", ("reconstructSessionHistory",))],
        "M4": [("edge/src/slack/cloudflare-slack-adapter.ts", ("normalizeSlackHistoryMessage",))],
        "M5": [
            ("edge/src/slack/quick-card.ts", ("Re-generate", "View files", "Delete", "dig_deeper", "export")),
            ("edge/src/slack/quick-actions.ts", ("dig_deeper", "export", 'type === "research"')),
            ("lib/research/delivery/slack.ts", ("researchResultBlocks", "quick_dig_deeper", "quick_export")),
            ("lib/research/__tests__/delivery.test.ts", ("quick_dig_deeper", "quick_export")),
        ],
        "M6": [
            ("edge/src/health.ts", ("probeDurabilityHealth",)),
            ("edge/src/store/conversation-state-do.ts", ("emitDeliveryOutcome", "DELIVERY_METRICS")),
        ],
        "M7": [("edge/src/env.ts", ("SESSION_EVENTS: DurableObjectNamespace", "DELIVERY_METRICS"))],
        "M8": [("edge/src/store/session-handoff-engine.ts", ("SessionHandoff", "MAX_ATTEMPTS"))],
        "L1": [("edge/src/slack/session-link.ts", ("HMAC", "7 * 24 * 60 * 60"))],
        "L2": [
            ("edge/src/store/session-event-do.ts", ("authoritative",)),
            ("docs/operations.md", ("fail visibly",)),
        ],
        "L3": [
            ("edge/src/store/session-event-do.ts", ("compact(", "safeThroughEventId")),
            ("edge/src/store/conversation-state-do.ts", ("sessionDo.compact", "afterEventId")),
        ],
    }
    assert list(anchors) == FINDING_IDS
    for finding_id, checks in anchors.items():
        for relative, needles in checks:
            try:
                require(relative, *needles)
            except AssertionError as error:
                raise AssertionError(f"{finding_id}: {error}") from error

    forbid("lib/research/delivery/slack.ts", "…(truncated)")

    required_tests = [
        "edge/test/active-turn-delivery.test.ts",
        "edge/test/control-surfaces.test.ts",
        "edge/test/download-files.test.ts",
        "edge/test/health.test.ts",
        "edge/test/late-file-repair.test.ts",
        "edge/test/session-event-do.test.ts",
        "edge/test/session-handoff-engine.test.ts",
        "edge/test/session-history.test.ts",
        "edge/test/slack-agent-stop.integration.test.ts",
        "edge/test/slack-stream.test.ts",
        "edge/test/stream-render-pages.test.ts",
    ]
    for relative in required_tests:
        read(relative)


def check_report() -> None:
    text = REPORT.read_text(encoding="utf-8")
    assert len(text) >= 10_000, "remediation report is unexpectedly thin"
    for finding_id in FINDING_IDS:
        count = len(re.findall(rf"^\| {finding_id} \|", text, flags=re.MULTILINE))
        assert count == 1, f"report must contain exactly one matrix row for {finding_id}; got {count}"

    for heading in (
        "## Resolution summary",
        "## Finding-by-finding matrix",
        "## Validation results",
        "## External activation checklist",
        "## Remaining limitations",
    ):
        assert heading in text, f"missing report heading: {heading}"

    for command in (
        "cd edge && npm run typecheck",
        "cd edge && npm test",
        "cd edge && npm run test:e2e",
        "cd edge/workers/sandbox && npm run typecheck",
    ):
        assert command in text, f"missing validation command/result: {command}"

    for forbidden_claim in (
        "deployed successfully",
        "Slack app reinstalled",
        "live GitHub smoke test passed",
        "production activation completed",
    ):
        assert forbidden_claim not in text, f"external action claim present: {forbidden_claim}"


def run_command(label: str, cwd: Path, *command: str) -> None:
    print(f"RUN: {label}")
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-only", action="store_true", help="check audit and source/test anchors only")
    parser.add_argument("--skip-commands", action="store_true", help="check source and final report without running suites")
    args = parser.parse_args()

    check_audit_census()
    check_source_evidence()
    if args.source_only:
        print(f"PASS: source/test anchors cover all {len(FINDING_IDS)} audit findings")
        return

    assert REPORT.is_file(), f"missing remediation report: {REPORT}"
    check_report()
    if not args.skip_commands:
        run_command("root typecheck", ROOT, "pnpm", "check-types")
        run_command("root tests", ROOT, "pnpm", "test")
        run_command("edge typecheck", ROOT / "edge", "npm", "run", "typecheck")
        run_command("edge unit", ROOT / "edge", "npm", "test")
        run_command("edge workerd e2e", ROOT / "edge", "npm", "run", "test:e2e")
        run_command("sandbox typecheck", ROOT / "edge/workers/sandbox", "npm", "run", "typecheck")
    print(f"PASS: {REPORT} ({len(REPORT.read_text(encoding='utf-8'))} chars), {len(FINDING_IDS)} findings covered")


if __name__ == "__main__":
    main()
