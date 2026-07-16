from pathlib import Path


REPORT = Path(__file__).with_name("gap-audit.md")


def require(text: str, needle: str) -> None:
    assert needle in text, f"missing required content: {needle!r}"


def main() -> None:
    assert REPORT.is_file(), f"missing report: {REPORT}"
    text = REPORT.read_text(encoding="utf-8")
    assert len(text) >= 8_000, "report is unexpectedly thin"

    for heading in (
        "## Critical",
        "## High",
        "## Medium",
        "## Low",
        "## SPEC section 7 coverage",
        "## Centaur functionality not carried forward",
        "## SPEC section 8 file census",
        "## Verification run on main",
        "## Confirmed-correct areas",
    ):
        require(text, heading)

    for gap in (
        "No live streaming",
        "No delivery guarantee",
        "No progress visibility",
        "No stop/interrupt",
        "No model/harness selection",
        "Isolate-local agent state",
        "No real coding harness",
        "Thin attachment handling",
        "No interactive follow-up cards",
        "No observability",
        "No session viewer / console link",
        "No requester→GitHub identity",
    ):
        require(text, gap)

    for command in (
        "npm run typecheck",
        "npm test",
        "npm run test:e2e",
        "edge/workers/sandbox",
    ):
        require(text, command)

    require(text, "559 passed")
    require(text, "24 passed")
    require(text, "session-link.ts")
    require(text, "One-line fix:")
    require(text, "file:line")

    print(f"PASS: {REPORT} ({len(text)} chars)")


if __name__ == "__main__":
    main()
