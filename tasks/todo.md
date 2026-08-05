# Plan: Edit plan items + skip status + week "finished"

Feature request (2026-08-05): edit plan items; mark items as skipped so a week
can be "finished" (every item either logged or skipped).

## Design decisions
- Skip state lives in a new top-level map `APP.skippedWorkouts` keyed
  `"<week>-<dayIdx>"`, parallel to `completedWorkouts` — NOT a field on day
  objects, because `applyPlanChange()` wholesale-replaces a week's `days` array
  and would wipe per-day fields.
- Backwards compatible: `skippedWorkouts: {}` added to `defaultData()`, plus
  migration guards after `loadData()` and inside `importData()` (same pattern
  as the existing durationInSeconds migration).
- Completed and skipped are mutually exclusive; logging a run clears skip.
- Existing green ✓ "week complete" badge keeps meaning "all completed, zero
  skips"; new neutral "Finished (N skipped)" badge for completed-or-skipped.
- Coach context gains a SKIPPED status (takes priority over MISSED).
- Owner decisions (2026-08-05): (1) skipped km are SUBTRACTED from the weekly
  mileage total shown on the week header; (2) the coach CAN set/unset skips —
  extend the `:::plan-change` protocol with an optional per-week `skips` list.

## Checklist (all in index.html)
- [x] 1. `defaultData()`: add `skippedWorkouts: {}`
- [x] 2. Migration guard after `loadData()`
- [x] 3. Same guard in `importData()` after `APP = imported`
- [x] 4. `triggerGeneratePlan()`: reset `skippedWorkouts` alongside
      `completedWorkouts` on full regen
- [x] 5. `toggleSkip(week, dayIdx)` near `toggleWorkout()` (mutual exclusion
      with completed)
- [x] 6. `logRun()`: `delete skippedWorkouts[key]` at both completion sites
- [x] 7. `#edit-item-modal` (cloned from settings modal) +
      `openEditItem`/`saveEditItem`/`closeEditItem`; fields: Day, Type,
      Distance, Pace, Notes; pencil icon next to "Log" button
- [x] 8. `renderPlan()`: skipped styling (struck-through/dimmed + "Skipped"
      tag), Skip/Unskip control, hide "Log" on skipped days, edit icon,
      `isWeekFinished()` + "Finished" badge in week header; `weekTotal`
      excludes skipped days' distance
- [x] 9. `buildCoachContext()`: SKIPPED status branch before MISSED
- [x] 10. Plan-change protocol: optional `skips: [{day, skipped}]` per change
      entry; `applyPlanChange()` applies days first then skips;
      `isPlanChangeApplied()` also compares skip state; coach system prompt
      documents the new field with an example
- [x] 11. Verify in browser (Playwright): edit flow, skip/unskip, finished
      badge, week total shrinks on skip, coach plan-change with skips,
      old-data migration, export/import round-trip

## Review section

Implemented exactly per spec, no scope deviations. Summary of write sites and
verification below (see agent report for full detail):

- Mutual exclusion (completed ⇄ skipped) enforced at every write site:
  `toggleWorkout()`, `toggleSkip()`, both `logRun()` completion paths
  (`pendingLogOrigin` and `findMatchingWorkout`), and `applyPlanChange()`'s
  skip branch.
- `isWeekFinished(week)` added as a standalone helper (`!weekCompleted &&
  every day completed-or-skipped`); green ✓ badge unchanged, "Finished · N
  skipped" badge is additive; `weekTotal` subtracts skipped days' km; the
  top-level "% complete" badge untouched (still completed-only).
- `:::plan-change` protocol gained an optional per-change `skips:
  [{day, skipped}]` array; `days` is now optional on a change entry.
  `applyPlanChange()` applies `days` first, then maps `skips` day abbrevs
  to indices in the (possibly just-replaced) days array. `isPlanChangeApplied()`
  and the `formatMarkdown()` apply-card renderer both updated to handle
  skip-only entries without crashing. Old-format payloads (no `skips` key)
  verified to still apply/render/idempotency-check exactly as before.
- All 11 verification scenarios from the spec run via Playwright against
  `python3 -m http.server`, all passing, zero new console errors (only the
  pre-existing Tailwind CDN warning). `git status --short` after cleanup:
  `M index.html`, `?? tasks/`.

## Known pre-existing gap (not fixed here, only inherited)
`applyPlanChange()` replaces a week's days by position without reconciling
`completedWorkouts` indices; `skippedWorkouts` inherits the same positional
risk. Acknowledged, out of scope.

## Done earlier this session
- [x] "Hide past weeks" checkbox on Plan tab (agent-implemented, reviewed,
      + no-plan visibility polish). Uncommitted in index.html.
