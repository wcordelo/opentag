# Source manifest

Captured 2026-08-01 Pacific before the one-time sync backfill.

| Project | Fork | Parent | Fork branch | Parent branch | Fork HEAD | Parent HEAD | Common ancestor | Parent commits after ancestor | Fork-only commits after ancestor | Shallow clone |
|---|---|---|---|---|---|---|---|---:|---:|---|
| qm | `wcordelo/qm` | `yc-software/qm` | `main` | `main` | `7f2c9163` | `7f2c9163` | `7f2c9163` | 0 | 0 | no |
| nanocodex | `wcordelo/nanocodex` | `gakonst/nanocodex` | `master` | `master` | `1970c4b1` | `47fd09cb` | `3d4548b0` | 53 | 3 | no |
| Buzz | `wcordelo/buzz` | `block/buzz` | `main` | `main` | `2a0367ee` | `ac4fa13b` | `acfbb1bb` | 276 | 1 | no |
| Centaur | `wcordelo/centaur` | `paradigmxyz/centaur` | `main` | `main` | `acb5512a` | `6d109198` | `6d109198` | 0 | 64 | no |

## Notion destinations

| Project | Database | Data source |
|---|---|---|
| qm | https://app.notion.com/p/a6bec0130f794839892ea92370fe5b1c | `collection://bceb1dd4-8eea-4b97-b453-4563f0954839` |
| Nanocodex | https://app.notion.com/p/b8f80af8713840bb9be1b11c3c2ca268 | `collection://7eecac74-8dbc-45f8-983d-810e8151b09e` |
| Buzz | https://app.notion.com/p/b98b3f7222a44872afeada6550cc2241 | `collection://ff253ee7-fb8c-48b6-b48d-58b014a33755` |
| Centaur | https://app.notion.com/p/3f174eb0c9b24c51aa28beeae39de4ef | `collection://46953dda-a635-42a2-a359-f236b4aee316` |

## Daily automations

| Project | Automation ID | Schedule | Execution host |
|---|---|---|---|
| qm | `daily-qm-parent-sync` | Daily at 8:00 AM Pacific | `/Users/will/Documents/qm` project binding |
| Nanocodex | `daily-nanocodex-parent-sync` | Daily at 8:00 AM Pacific | qm cross-repository orchestration project |
| Buzz | `daily-buzz-parent-sync` | Daily at 8:00 AM Pacific | qm cross-repository orchestration project |

The Nanocodex and Buzz fork defaults needed parent merges. Nanocodex was published as merge commit `e9ca9258cc00413bd0580e97979a9488fba9a67b` and Buzz as `40d1bebf5fefeeb57463973af9cd8a64026abc0c`. qm was already current. Centaur's fork contains the parent tip; its dirty primary checkout is preserved and the existing Centaur automation remains the sync owner.

## Post-backfill fork heads

| Project | Fork default | Result | Validation |
|---|---|---|---|
| qm | `7f2c9163` | Already up to date | Parent/fork equality; no push |
| nanocodex | `e9ca9258` | Parent merge pushed to `master` | Merge completed, `git diff --check`, exact remote-before-push check |
| Buzz | `40d1bebf` | Parent merge pushed to `main` | Merge completed, `git diff --check`, actual conflict-marker scan, exact remote-before-push check |
| Centaur | `acb5512a` | Parent tip already present; no sync mutation | Existing dirty checkout preserved |
