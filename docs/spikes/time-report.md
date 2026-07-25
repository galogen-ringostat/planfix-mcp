# Spike: cross-task time report — per-person workload & unlogged days (ROADMAP P10)

Date: 2026-07-26. Executor: developer session (Claude Code). All probes READ-ONLY
(`POST /datatag/59/entry/list` and the swagger). Raw request/response shapes below for
every claim (checklists-misdiagnosis lesson: verdicts only from direct REST probes).

## Verdict: the tool is fully buildable, cheaply, with full team scope

1. **`POST /datatag/{id}/entry/list` is task-agnostic.** `taskId` is optional; the body
   accepts `filters: ComplexDataTagFilter[]` (swagger-confirmed, live-verified). No
   per-task iteration is needed — the cost model that could have killed the tool does
   not materialize.
2. **The operator's API key sees OTHER users' entries** — full team scope, not
   personal-only. Verified against two other employees' entries (below).
3. **All aggregation fields are available per entry**: user (173, value
   `[{id: "user:N", name}]` + `stringValue` name), date (175, value `{date:
   "DD-MM-YYYY"}`), duration (185, value `{from, to, durationSec}`). A full month for
   one active user fits in ONE page.

## Filter surface (swagger `ComplexDataTagFilter` + live)

`{type, field, operator: equal|notequal|gt|lt, value}` — `field` is the DATA TAG field
id. Types relevant here: **3103** "Custom field List of users" (→ field 173), **3101**
"Custom field Date" (→ field 175). (Task-side filters also exist on this endpoint —
project 5, status 10, template 51 per swagger examples — not needed for P10.)

| Probe | Request filters | Result |
|---|---|---|
| A bare list, no taskId, no filters | none | 200, entries across arbitrary tasks/users (oldest: other employees, 2023) |
| B user | `[{type: 3103, field: 173, operator: "equal", value: "user:403"}]` | 200, only user 403's entries, cross-task |
| C **other** user | same with `user:312` | 200, Mariia's entries — **key scope is full team** (also user 310's estimation entries and Олена's 2023 entries were readable in P9/P10 probes) |
| D date range | user + `{type: 3101, field: 175, operator: "equal", value: {dateType: "otherRange", dateFrom: "01-07-2026", dateTo: "31-07-2026"}}` | 200, July-only entries |
| E gt+lt pair | user + `gt otherDate 30-06-2026` + `lt otherDate 01-08-2026` | 200, identical result to D |

**Boundary semantics verified**: `otherRange 03-07-2026..03-07-2026` returned exactly
the same 4 entries as `equal otherDate 03-07-2026` — the range is **inclusive on both
ends**. Use `otherRange` (one filter instead of two).

## Entry shape (raw, from probe D)

```json
{ "key": 127534, "commentId": 47762231, "customFieldData": [
  { "field": {"id": 173, "name": "Name", "typeName": "List of users"},
    "value": [{"id": "user:403", "name": "Dmytro Galogen Halahan"}],
    "stringValue": "Dmytro Galogen Halahan" },
  { "field": {"id": 175, "name": "Date", "typeName": "Date"},
    "value": {"datetime": "2026-07-03T00:00Z", "date": "03-07-2026", "time": "00:00"},
    "stringValue": "03-07-2026" },
  { "field": {"id": 185, "name": "Time", "typeName": "Period of time"},
    "value": {"from": {...}, "to": {...}, "durationSec": ...},
    "stringValue": "10:00 - 13:00" } ] }
```

- The date is a plain calendar date (no timezone arithmetic needed).
- `durationSec` is present on 185 values — hours sum directly.
- The user's display name arrives free with every entry (no `list_users` round-trip
  needed for users who have entries).

## Cost at period scale (measured)

July 2026, user 403: **56 entries → 1 call** (pageSize 100). Aggregated in-probe:
13 distinct days, 109.05 h total. Cost model for the tool: `userIds.length ×
ceil(entries_in_range / 100)` calls — a 5-person month is typically 5–10 calls.
Multi-user in one call was not probed (3103 `equal` takes one `user:N` string); one
query per user is the design baseline and is cheap enough.

## Proposed tool design (for review BEFORE implementation — not built)

**`get_time_report`** (read-only; annotations `{readOnlyHint: true}` — no
`idempotentHint`, output shifts as entries are logged; P8 get_project_overview precedent).

- Params:
  - `userIds: number[]` (min 1, max 10) — REQUIRED; no team roster in code.
  - `dateFrom`, `dateTo`: ISO `YYYY-MM-DD`; validated `dateFrom ≤ dateTo`; range capped
    at **92 days** (a quarter) — refusal names the cap.
  - `workingDays?: string[]` (ISO dates) — explicit working-day calendar override; no
    calendar in code. Dates outside the range are refused.
- Mechanics: per user, page `datatag/59/entry/list` with
  `filters: [3103/173 equal user:N, 3101/175 equal otherRange dateFrom..dateTo]`,
  `fields: "key,175,185"` (+173 once for the display name), pageSize 100, scan cap
  **10 pages per user** (1000 entries) → totals reported with the `N+`/"at least"
  convention when hit.
- Output per user (aggregates only, never raw entry dumps):
  - Header: `user:N Name — total 109h 3m across 13 days (56 entries)`.
  - Per-day rows: `2026-07-03: 3h (4 entries)` — one row per day WITH entries.
  - `Unlogged days (M): 2026-07-15, 2026-07-21, …` — days in range with zero entries,
    computed against Mon–Fri by default or against `workingDays` when given.
  - A user with zero entries in range: explicit `no entries in range` row (name
    unavailable without entries — rendered as `user:N`).
- The output MUST state the definition used, verbatim requirement:
  `Unlogged = Mon-Fri days in range with zero entries.` or
  `Unlogged = the N caller-provided workingDays with zero entries.`
- English output; day keys rendered ISO (`YYYY-MM-DD`) for agent-side sorting.
- Rejected: hardcoded team roster, hardcoded weekends/holidays calendar (policy stays
  agent-side — log_workday exclusions precedent); per-task breakdown inside the report
  (get_task_time_entries covers per-task; adding it here would unbound the output).

## Open questions

1. Whether 3103 `equal` accepts multiple users in one filter (array value) — not
   probed; would only shave calls, not change the design.
2. Per-task drill-down column (top-N tasks per user) — deliberately out; revisit only
   on observed friction.

## Probe-artifact inventory

None — every probe was read-only. Nothing to clean up.
