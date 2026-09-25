# LCT consolidation — 2026-09-25

## Intent and safety boundary

The user requested review of outstanding work and screenshots, integration of
ready changes into main, and branch cleanup. Work is prepared in an isolated
checkout. Current main at inventory time is `0d4285eb89f2c2fab98287cb0f5d4994a06ba1ee`.
No private operational notes, recordings, transcripts, runtime logs, or generated
review artifacts belong in this publication.

Test intent:
- The missing-writer alert fires only when the IndrasNet scrape succeeds.
- Native horizontal card navigation preserves the current vertical-reading contract.
- Local artifacts stay recoverable without appearing as source changes.
- Branch retirement uses exact content evidence and retained recovery references.

The inventory and a verified complete Git recovery bundle are retained locally
under `tmp/kept/consolidation-20260925/`. They are excluded from publication.
Active owners retain their worktrees. No unknown or active work is discarded.

## Completed branch content already represented in main

Whole-tree equality against a merged squash proves the following mappings;
ancestry alone is insufficient because these changes were squash merged.

| Branch | Tip | Integrated commit | Evidence |
|---|---|---|---|
| codex/public-drive-viewer-release-20260906 | b5e4f8f | 265fc4a (#191) | identical trees |
| codex/overlapping-threads-demo-20260908 | 9f7a928 | 817c857 (#194) | identical trees |
| codex/transcript-ready-20260909 | ac4a943 | 8867567 (#195) | identical trees |
| fix/observability-reap-plugin-tree | 06d4f6e | c84a03c (#196) | identical trees |
| docs/adr069-ratify | 883169d | 6720b31 (#197) | identical trees |
| feat/probe-telemetry | d34f4bb | 214f836 (#198) | identical trees |
| feat/telemetry-scrape | 5d4f420 | 0d4285e (#199) | identical trees |
| codex/arc-duration-video-sync-20260908 | 2af87b6 | 817c857 (#194) | ancestor of 9f7a928 |

These are eligible for retirement after confirming their remote tips are
unchanged and creating recovery references. This table does not claim deletion.

## Integration candidates

- `codex/observability-writer-alert-gate@8cca8af`: two commits containing the
  narrow Prometheus rule correction, synthetic regression, and incident notes.
  One pytest test runs three actual promtool scenarios; all pass. Promtool
  validates all 15 rules. Required independent-family review remains a gate.
- PR #192 (`c8905f8`): native horizontal swipe/scroll behavior and regression
  coverage require a bounded salvage. Its old vertical-swipe abstraction
  navigation contradicts the current product contract and must not be restored.
  Prior issue notes are historical observations, not newly reproduced failures.

## Preserved pending work

- Active Meet Angel changes remain with their owner until a clean reviewed
  source commit is handed off. The adjacent TemporalCoordination checkout is a
  different repository; it must never be accidentally added as an LCT gitlink.
- Maple study documents are local-only operational notes. The owner explicitly
  identified them as outside the publication boundary; they remain local.
- `codex/interleaved-thread-memory-20260907@67d1a51` contains 212 changed files,
  21,054 additions and 79 deletions against its merge base. It is not represented
  in main. Its recorded production integration and independent-review findings
  are unfinished. Scope clarification was requested before integration.

## Artifact review

Desktop and mobile PNGs show the synthetic Meet Angel transcript-review preview:
audio controls, source tabs, transcript text, source disagreement review, and
correction controls. Both screenshots fit their respective viewport widths.
They are useful local review evidence, not executable product implementation or
proof of interaction. They are preserved in place and excluded from Git.

Crash stack dumps, nested worktrees, generated independent-review artifacts,
and the historical inaccessible pytest scratch directory are also excluded from
source inventory. Ignoring them does not mean active source work is integrated.
This narrow ignore-only housekeeping needs Git matching checks, not unit tests.

## Validation and independent review

Final source validation and the independent-family receipt will be recorded
before merge. No code review approval is claimed by this initial inventory.

## Verified checkpoint

Eight represented branches were archived to remote tags and retired atomically;
four redundant local branch refs were also removed. The native repair passes
four Chromium touch regressions, 21 focused unit tests, 394 full frontend unit
tests, source lint and production build. The alert passes actual promtool
scenarios and all 15 rules validate. Anthropic independently returned PASS;
its exact packet receipt is in WORKLOG. The final documentation-only receipt
update is undergoing confirmation. Public source publication awaits resolution
of the automatic approval gate. Active and parked work remains unintegrated.
