from __future__ import annotations

import re
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 2:
        raise SystemExit("usage: validate.py OPEN_TAG_WORKTREE")

    root = Path(sys.argv[1]).resolve()
    report_dir = root / "goal-outputs" / "multi-repo-parent-sync-architecture-backfill"
    required = {
        "PROGRESS.md",
        "analysis/source-manifest.md",
        "analysis/qm.md",
        "analysis/nanocodex.md",
        "analysis/buzz.md",
        "analysis/centaur.md",
        "local-only/README.md",
        "local-only/source-manifest.md",
        "local-only/qm.md",
        "local-only/nanocodex.md",
        "local-only/buzz.md",
        "local-only/centaur.md",
        "local-only/opentag-improvement-plan.md",
        "CURRENT-STATE-RECONCILIATION.md",
    }

    missing = sorted(name for name in required if not (report_dir / name).is_file())
    if missing:
        raise SystemExit(f"missing artifacts: {', '.join(missing)}")

    text = "\n".join((report_dir / name).read_text() for name in sorted(required))
    required_terms = (
        "common ancestor",
        "Validation",
        "Adopt",
        "Adapt",
        "Covered",
        "Defer",
        "Not Applicable",
        "HANDOFF.md",
        "VISION-SPEC.md",
        "CURRENT-STATE-RECONCILIATION.md",
    )
    absent = [term for term in required_terms if term not in text]
    if absent:
        raise SystemExit(f"missing required evidence terms: {', '.join(absent)}")

    if re.search(r"^(<<<<<<< |\|\|\|\|\|\|\| |>>>>>>> )", text, re.MULTILINE):
        raise SystemExit("conflict marker found")

    for name in required:
        content = (report_dir / name).read_text()
        if not content.lstrip().startswith(("#", ">")):
            raise SystemExit(f"artifact is not Markdown: {name}")

    print(f"validated {len(required)} OpenTag artifacts at {report_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
