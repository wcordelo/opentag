from __future__ import annotations

import argparse
import hashlib
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GOAL_DIR = Path(__file__).resolve().parent
SPEC = ROOT / "docs/centaur-gap-implementation-spec.md"
REPORT = GOAL_DIR / "implementation-report.md"
EXPECTED_SPEC_SHA256 = (
    "5ebb36d85bd675eb5741e405131a571303107b092c4166aa55a716a4214fbdfa"
)


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
        assert needle not in text, f"{relative}: forbidden behavior remains {needle!r}"


def check_spec_identity() -> None:
    digest = hashlib.sha256(SPEC.read_bytes()).hexdigest()
    assert digest == EXPECTED_SPEC_SHA256, (
        "authoritative spec changed during implementation: "
        f"expected {EXPECTED_SPEC_SHA256}, got {digest}"
    )


def check_permission_track() -> None:
    require(
        "edge/src/request-context.ts",
        'kind: "slack_user"',
        'kind: "slack_automation"',
        "requesterIdForActor",
    )
    require(
        "edge/src/permissions/contract.ts",
        "PermissionSnapshotV1",
        "AUTOMATION_SAFE_TOOLS",
        "PERMISSION_SNAPSHOT_MAX_BYTES",
    )
    require(
        "edge/src/permissions/snapshot.ts",
        "metadataVisibility",
        "mcpEndpoints: endpoints",
        "secretRefs: automation ? []",
        "assertPermissionSnapshotSize",
    )
    require(
        "edge/src/permissions/context.ts",
        "WeakMap",
        "bindPermissionSnapshot",
        "requirePermissionSnapshot",
    )
    require(
        "edge/src/tools/index.ts",
        'name: "show_permissions"',
        "assertExactTurnActive",
        "requirePermissionSnapshot(thread)",
    )
    require(
        "edge/src/worker.ts",
        'app.get("/admin/permissions"',
        '"cache-control": "no-store"',
        '"permission_snapshot_generated"',
    )
    require(
        "edge/workers/sandbox/turn-contract.ts",
        "validatePermissionSnapshot",
        "permission_snapshot_forbidden_field",
        "hasOnlyKeys",
        "credentialExposure",
    )
    require(
        "edge/workers/sandbox/src/router.ts",
        "allowedRepoHosts",
        "remoteGitApproved: turnBody.remoteGitApproved === true",
        "validateTurnRequest(turnBody",
    )
    require(
        "edge/workers/sandbox/harness-server.ts",
        "materializePermissionSnapshot",
        "OPENTAG_PERMISSIONS_FILE",
        "mode: 0o600",
    )
    require(
        "containers/harness/Dockerfile",
        "/usr/local/bin/opentag",
        "OPENTAG_PERMISSIONS_FILE",
        "permissions",
    )

    permission_reads = []
    for path in (ROOT / "edge/src").rglob("*.ts"):
        if "requirePermissionSnapshot" in path.read_text(encoding="utf-8"):
            permission_reads.append(path.relative_to(ROOT).as_posix())
    assert sorted(permission_reads) == [
        "edge/src/permissions/context.ts",
        "edge/src/tools/index.ts",
    ], f"permission snapshot gained an authorization consumer: {permission_reads}"
    forbid(
        "edge/workers/sandbox/src/egress-policy.ts",
        "OPENTAG_PERMISSIONS_FILE",
        "permissionSnapshot",
    )


def check_runtime_track() -> None:
    require(
        "edge/src/config/access-bundle.ts",
        "ChannelRuntimeDefaults",
        "normalizeChannelRuntimeDefaults",
        "channel model requires harnessType=claudecode",
    )
    require(
        "edge/src/config/workspace-config-do.ts",
        "PRAGMA table_info(channel_config)",
        "default_harness_type",
        "default_model",
    )
    require(
        "edge/src/store/thread-overrides.ts",
        "channelDefaults?.model",
        '"explicit"',
        '"sticky"',
        '"channel"',
        '"deployment"',
    )
    require(
        "edge/src/commands/index.ts",
        'name: "config"',
        "parseRuntimeCommand",
        "/config runtime set --harness claude-code",
        "Automation actors cannot change channel configuration",
    )
    require(
        "edge/src/agent-turn.ts",
        "config.runtimeDefaults",
        "harnessSource: overrides.harnessSource",
        "This authoritative turn was not sent to AG-UI",
    )
    forbid(
        "edge/src/store/thread-overrides.ts",
        "model: channelDefaults?.model",
        "harnessType: channelDefaults?.harnessType",
    )


def check_trusted_trigger_track() -> None:
    require(
        "edge/src/slack/rich-display-text.ts",
        "MAX_RICH_DISPLAY_TEXT = 24_000",
        "attachment_field",
        "hidden callback metadata",
        "WeakSet",
    )
    require(
        "edge/src/slack/trusted-trigger.ts",
        "parseTrustedTriggerConfig",
        "trustedTriggerReadiness",
        "missing_target_id",
        "own_bot",
        "no_rich_mention",
    )
    require(
        "edge/src/slack/pre-admit-turn.ts",
        "classifyTrustedRichTrigger",
        "registerWithObligation",
        "actor: identity.actor",
    )
    require(
        "edge/src/slack/ingress-normalize.ts",
        'source: "trusted_rich_mention"',
        "actor: trusted.actor",
    )
    require(
        "edge/src/slack/cloudflare-slack-adapter.ts",
        "trustedTriggerConfig",
        'normalized.actor.kind === "slack_user"',
    )
    require(
        "edge/src/slack/stop-routing.ts",
        "event.bot_id",
        "event.app_id",
        "event.bot_profile",
    )
    require(
        "edge/src/worker.ts",
        "slackVerify()",
        "trusted_rich_mention_admitted",
        'reason: "duplicate"',
        "trustedRichMention",
    )
    require(
        "edge/src/bot-engine.ts",
        "AUTOMATION_SAFE_TOOLS",
        "humanActor && isResearch",
        "humanActor && remember",
        "humanActor && intent",
    )
    forbid(
        "edge/src/slack/rich-display-text.ts",
        "JSON.stringify(event)",
    )


def check_tests_and_docs() -> None:
    for relative in (
        "edge/test/permission-snapshot.test.ts",
        "edge/test/admin-permissions.test.ts",
        "edge/test/runtime-defaults.test.ts",
        "edge/test/thread-overrides.test.ts",
        "edge/test/trusted-rich-trigger.test.ts",
        "edge/test/trusted-trigger-health.test.ts",
        "edge/test/slack-agent-stop.integration.test.ts",
        "edge/test/agent-turn-harness.test.ts",
        "edge/test/harness-server.test.ts",
        "edge/test/harness-container-router.test.ts",
        "edge/test/store.workers.test.ts",
        "edge/test/tool-execution-fence.test.ts",
        "edge/test/stop-command-routing.test.ts",
    ):
        read(relative)
    require(
        "edge/test/slack-agent-stop.integration.test.ts",
        "admits one trusted rich automation turn with channel defaults and safe permissions",
        "expect(harnessTurns).toHaveLength(1)",
        "users.info",
    )
    require(
        "edge/test/trusted-rich-trigger.test.ts",
        "hidden Block Kit action values",
        "invalid-only allowlist",
    )
    require(
        "docs/extending.md",
        "show_permissions",
        "AUTOMATION_SAFE_TOOLS",
        "explicit message flag",
    )
    require(
        "docs/operations.md",
        "/admin/permissions",
        "opentag permissions",
        "SLACK_TRUSTED_TRIGGER_ACTORS",
        "missing_target_id",
    )
    require(
        "docs/centaur-port.md",
        "Redacted permission inspection",
        "Rich-payload bot mentions",
    )
    require(
        "DECISIONS.md",
        "informational views only",
        "Runtime precedence is resolved independently per field",
        "Trusted rich-payload triggering",
    )


def check_report() -> None:
    text = REPORT.read_text(encoding="utf-8")
    assert len(text) >= 8_000, "implementation report is unexpectedly thin"
    for heading in (
        "## Outcome",
        "## Permission introspection",
        "## Channel runtime defaults",
        "## Trusted rich-payload mentions",
        "## Validation results",
        "## Adversarial review",
        "## External activation checklist",
        "## Rollback",
        "## Remaining limitations",
    ):
        assert heading in text, f"missing report heading: {heading}"
    for command in (
        "pnpm check-types",
        "pnpm test",
        "cd edge && npm run typecheck",
        "cd edge && npm test",
        "cd edge && npm run test:e2e",
        "cd edge/workers/sandbox && npm run typecheck",
        "git diff --check",
    ):
        assert command in text, f"missing validation command/result: {command}"
    for forbidden_claim in (
        "deployed successfully",
        "Slack app reinstalled",
        "production activation completed",
        "PR opened",
    ):
        assert forbidden_claim not in text, (
            f"unauthorized external action claim present: {forbidden_claim}"
        )


def run(label: str, cwd: Path, *command: str) -> None:
    print(f"RUN: {label}")
    subprocess.run(command, cwd=cwd, check=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--source-only",
        action="store_true",
        help="check the immutable spec plus source, test, and documentation anchors",
    )
    parser.add_argument(
        "--skip-commands",
        action="store_true",
        help="also check the final report but do not rerun validation commands",
    )
    args = parser.parse_args()

    check_spec_identity()
    check_permission_track()
    check_runtime_track()
    check_trusted_trigger_track()
    check_tests_and_docs()
    if args.source_only:
        print("PASS: all three Centaur-gap feature tracks have source/test/doc evidence")
        return

    assert REPORT.is_file(), f"missing implementation report: {REPORT}"
    check_report()
    if not args.skip_commands:
        run("root typecheck", ROOT, "pnpm", "check-types")
        run("root tests", ROOT, "pnpm", "test")
        run("edge typecheck", ROOT / "edge", "npm", "run", "typecheck")
        run("edge tests", ROOT / "edge", "npm", "test")
        run("edge workerd", ROOT / "edge", "npm", "run", "test:e2e")
        run(
            "sandbox typecheck",
            ROOT / "edge/workers/sandbox",
            "npm",
            "run",
            "typecheck",
        )
        run("diff check", ROOT, "git", "diff", "--check")
    print(f"PASS: {REPORT} ({len(REPORT.read_text(encoding='utf-8'))} chars)")


if __name__ == "__main__":
    main()
