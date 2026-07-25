# Spike: task custom fields — writes (ROADMAP P9 Part B)

Date: 2026-07-26. Executor: developer session (Claude Code). Probes per docs/TESTING.md
Layer 3 rules: ONE probe task created inside project MCP-Test (572465), name prefixed
`[MCP-TEST]`; every write targeted only that task or entries this run created on it;
user references limited to 403 (Galogen). Reads against production tasks (allowed).
Read-side ground truth (fetch mechanics, field inventory) came pre-verified in the
ROADMAP P9 entry (reviewing session, task 412626, 2026-07-26) and was reconfirmed here.

## Verdict

Both write paths work, each with a sharp edge the future tools MUST guard:

1. **Estimation writes work** via data tag 61 "Estimation" (`POST /task/{id}/datatags/`,
   same mechanism as time entries / tag 59) — but ONLY the `{from, to}` clock-range
   value shape stores anything. The `{durationSec}` shape returns `success` and stores
   an EMPTY Time (silent no-op). The task's `Estimation RevOps` summary (22453) updates
   immediately after a successful entry write.
2. **List-field writes work** via `customFieldData` in `POST /task/{id}` — but the API
   validates NOTHING: values outside `enumValues` are stored verbatim, and writes to
   fields not attached to the task's template return `success` (HTTP 200 or 202) while
   storing NOTHING. Partial `customFieldData` updates preserve other custom fields.

The API never signals any of these failures — a write tool without client-side
validation and read-back verification would corrupt data or lie about success.

## Estimation: data tag 61

Discovery (read-only): `POST /datatag/list` → 14 tags; tag **61 "Estimation"** (tag 59
"Time spent" is its sibling). `GET /datatag/61?fields=id,name,fields` → two fields:

| Field id | Name | Type | Write value shape |
|---|---|---|---|
| 187 | Name | 14 List of users | `[{ id: "user:<N>" }]` |
| 189 | Time | 6 Period of time | `{ from: { time: "HH:MM" }, to: { time: "HH:MM" } }` — `durationSec` computed server-side |

Existing production entries on task 412626 (estimation "30 ч" = summary value 1800
minutes): two entries, `durationSec` 86400 (rendered "00:00 - 24:00") + the remainder —
i.e. **one entry holds at most 24h** (clock-range representation); larger estimations
are entered as multiple ≤24h entries.

Write evidence (probe task 574545, created this run in 572465):

1. Shape A `{ field 189, value: { durationSec: 5400 } }` → `201 {"result":"success",
   "keys":[127900], "commentId":47886309}` — but read-back shows field 189 `value: null`,
   and summary 22453 stayed `0 ч`. **Silent no-op — never use this shape.**
2. Shape B `{ field 189, value: { from: {time: "00:00"}, to: {time: "01:30"} } }` →
   `201 {"result":"success","keys":[127901],"commentId":47886313}`; read-back:
   `{from 00:00, to 01:30, durationSec: 5400}`; task 22453 → `90` / `"1 ч 30 мин"`
   immediately. **This is the working shape.**

Entry list endpoint for reads: `POST /datatag/61/entry/list` with
`fields: "key,commentId,187,189"` + `taskId` (same pattern as get_task_time_entries).

## List fields: customFieldData in POST task/{id}

Write shape: `POST /task/{id}` body `{ customFieldData: [{ field: { id: <N> }, value:
"<option label>" }] }` — value is the option's plain string (enumValues are bare
strings; there are no option ids anywhere in the API).

Evidence matrix (probe task 574545, template 1 = plain; reference task 412626 uses
template 326294, a RevOps template):

| Field | Attached to probe task's template? | Write result | Stored? |
|---|---|---|---|
| 22571 `[RevOps] Sprint` | yes (account-wide) | 200 success | ✅ `Sprint 4 - 2026` round-trips |
| 22559 `Complexity Level` | yes (account-wide) | 200 success | ✅ `Advanced` round-trips |
| 21752 `Priority` | NO (template-bound) | 200 success | ❌ nothing stored |
| 22443 `Status [RevOps]` | NO (template-bound, groupId 29) | 200 success / one 202 (queued) | ❌ nothing stored, also not after the async 202 |
| 22571 with **invalid** value `"Sprint 99 - 2099"` | yes | 200 success | ⚠️ **stored verbatim** — no enum validation at all |

Findings:

- **Template attachment is the write gate**: fields attached to the task's
  template/process accept writes; unattached fields swallow them silently with a
  `success` envelope. (Read side behaves consistently: unset/unattached fields simply
  don't appear in `customFieldData`.)
- **No value validation**: any string is stored on an attached List field, even outside
  `enumValues`. The invalid value probe was reverted in the same run (own task).
- **Partial updates are safe**: writing 22443 alone did not touch the previously set
  22571; writing 22559 preserved both. No full-array requirement.
- enumValues discovery: `GET /customfield/task?fields=id,name,type,enumValues` returns
  all 303 task fields with their enumValues (plain strings). `GET /customfield/task/{id}`
  does NOT filter by id (returns the whole list) — client-side filtering is required.
- The six RevOps fields: 22571 Sprint / 22559 Complexity are writable on any task;
  21752 Priority / 22443 Status [RevOps] only on tasks created from the RevOps
  template(s); 22453 / 22451 are type-23 summaries — never directly writable, they
  update through data tags 61 / 59 respectively.

## Proposed write-tool design (for review BEFORE implementation — not built)

1. **`set_task_custom_field`** (mutating; annotations `{readOnlyHint: false,
   destructiveHint: true, idempotentHint: true}` — overwrites, converges):
   - Params: `taskId`, `fieldId`, `value` (string).
   - Deterministic guards, in order: (a) safe-mode `assertTaskInTestProject`; (b) field
     lookup in `GET /customfield/task` (client-filtered) — refuse unknown ids and
     non-List types with the field's actual type named; (c) **enum validation** —
     refuse values outside `enumValues`, listing the allowed options (the API stores
     garbage otherwise); (d) POST write; (e) **read-back verification** — if the field
     did not persist, report the template-attachment gap as an actionable error
     ("field N is not attached to this task's template; writable fields on this task
     appear in get_task with the field id in `fields`") instead of a false ✓.
   - No org field ids hardcoded; ids/examples live in the description only.
2. **`add_estimation`** (mutating; additive annotations): `taskId`, `userId`, `hours`
   (number, 0.25–100 or similar). Writes tag-61 entries in ≤24h chunks (from/to shape
   ONLY — the durationSec shape is a proven silent no-op); reads back 22453 and reports
   the new summary total. Open question for review: replace-vs-append semantics — the
   API offers entry UPDATE (`POST /task/{id}/datatags/{commentId}` appends; a dedicated
   entry-update endpoint was not probed) but no delete; appending is the only safe
   default, matching the production pattern (multiple entries summing up).
3. Rejected: extending `update_task` with raw `customFieldData` passthrough — it would
   bypass enum validation and read-back, reintroducing the silent-failure class this
   spike documented.

## Addendum 2026-07-26 (implementation session): the 24h chunk shape

Probed while implementing the approved `add_estimation` (writes on task 574545 only):

- `{from: 00:00, to: 00:00}` → `201 success`, entry `127902` stores `durationSec: 86400`
  — but the summary field **ignores it** (22453 unchanged). A THIRD silent-failure
  variant.
- `{from: "00:00", to: "24:00"}` → `201 success`, entry `127903`; summary jumped
  90 → 1530 min (+24h) immediately. **"24:00" as the `to` time is the working 24h
  chunk shape** (matches the production entry's "00:00 - 24:00" rendering).

`add_estimation` therefore renders a 1440-minute boundary as "24:00" and never emits
equal from/to times or a bare durationSec.

## Design review outcome (2026-07-26): APPROVED with amendment — IMPLEMENTED

Both tools shipped in `src/tools/customfields.ts` (registered in `src/index.ts`, 34
tools total): `set_task_custom_field` exactly as proposed; `add_estimation` with the
amended workday layout semantics (optional `workday {from, to, exclusions}` — fill the
day, skip exclusions, spill to a new visual day; entries carry no dates; NO default day
shape in code; plain 00:00-24:00 chunks when omitted), APPEND semantics with the
read-back new total in the ack, all-or-nothing validation, `validate_only`, and
log_workday-style partial-failure reporting. Unit tests: `tests/customfields-write.test.ts`
(incl. the review's 10.5h example verbatim and a no-durationSec-anywhere assertion).

## Probe-artifact inventory (Layer 3 rule 5 — leave auditable, batch-clean from UI)

- Task `574545` "[MCP-TEST] P9 spike: custom field write probe" in project 572465, left
  with: Sprint = "Sprint 4 - 2026", Complexity Level = "Advanced", Estimation = 1 ч 30 мин.
- Data tag 61 entries on it: `127900` (empty Time — the durationSec no-op evidence),
  `127901` (1.5h, comment 47886313), `127902` (the 00:00-00:00 non-counting evidence),
  `127903` (the working 24h chunk); comments 47886309/47886313/47886321/47886323.
  Task 574545's estimation summary reads "25 ч 30 мин" after the addendum probes.
- The invalid Sprint value was reverted in-run; 21752/22443 writes left no trace (that
  is the finding).

## Open questions

1. `add_estimation` replace-vs-append (see design point 2).
2. Whether a datatag ENTRY update endpoint exists (would enable estimation correction);
   not probed — outside the minimal-write budget.
3. Whether template-bound fields (21752/22443) should be writable via a task created
   from the RevOps template in MCP-Test — needs an operator-created template task in the
   test project to probe safely (task templates are UI-managed).
