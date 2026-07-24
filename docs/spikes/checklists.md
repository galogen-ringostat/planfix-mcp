# Spike: are Planfix checklists exposed via REST? (ROADMAP P6)

Date: 2026-07-24. Executor: developer session (Claude Code). Probes per docs/TESTING.md
Layer 3: reads against known production tasks (allowed), writes only on a task this spike
itself created inside project MCP-Test (572465). Hard cap respected: one item create + one
update of that same item.

## Verdict: FULLY EXPOSED — the 2026-07-20 "not exposed" verdict is obsolete

All four checklist operations work against the production account: list a task's items,
get one item, create an item, update an item (including toggling `isDone`). Every probe
returned `result: "success"`; the create→read→update→read round-trip was exact.

## Endpoints and schemas (from https://help.planfix.com/restapidocs/swagger.json, fetched 2026-07-24)

| Method | Path | Purpose | Notes |
|---|---|---|---|
| POST | `/task/{id}/checklist/list` | List a task's checklist items | body `{offset, pageSize (max 100), fields}`; fields: `id,name,isDone,parent,dateTime,assignees` |
| GET | `/task/{id}/checklist/{itemId}?fields=…` | One item | same field set |
| POST | `/task/{id}/checklist` | Create item | `ChecklistItemCreateRequest`: `name` (required), `isDone?` (bool), `assignees?` (PeopleRequest, prefixed ids `user:5`) — **no `parent` field**: nesting is readable but not settable on create via this schema |
| POST | `/task/{id}/checklist/{itemId}` | Update item | `ChecklistItemUpdateRequest`: `name?`, `isDone?`, `assignees?`; response `{result, failures?}` |

Item shape (`ChecklistItemResponse`): `id` (int), `name` (string), `isDone` (bool),
`parent` (BaseEntity), `dateTime` (TimePoint), `assignees` (PeopleResponse). No explicit
ordering field is exposed; the list endpoint returned items in creation order in every probe.
`parent` on all observed production items points at the **task** id (flat lists); no nested
item-under-item was observed, and the create schema offers no way to make one.
No DELETE endpoint exists for checklist items in the swagger.

## Read evidence (read-only, production tasks)

`POST /task/{id}/checklist/list` returned HTTP 200 `result: "success"` with full items
(name, `isDone`, `parent`, `dateTime`) for **all 11 probed tasks**: 401356 (3 items, mixed
done/undone), 425626 (6 items — the operator's standard 5-step list, all done), and all nine
Ф0–Ф8 children of 401356 (475316…562294; 3–7 items each; Ф5/Ф6/Ф7/Ф8 mostly undone). No 404,
no 403, no empty-despite-UI case — reads are unconditionally usable.

## Write evidence (Layer 3, MCP-Test only, one create + one update)

1. Probe task created: `POST /task/` `{name: "[MCP-TEST] P6 spike: checklist write probe", project: {id: 572465}}` → `201 {"result":"success","id":572468}`; project verified before writing.
2. Create: `POST /task/572468/checklist` `{name: "[MCP-TEST] P6 probe item"}` → `201 {"result":"success","id":572469}`.
3. Read-back: `GET /task/572468/checklist/572469?fields=id,name,isDone,parent,dateTime` → item exact, `isDone: false`, `parent: {id: 572468}` (the task).
4. Update: `POST /task/572468/checklist/572469` `{isDone: true}` → `200 {"result":"success"}`.
5. Read-back via list: `POST /task/572468/checklist/list` → `[{id: 572469, name: "[MCP-TEST] P6 probe item", isDone: true, parent: {id: 572468}}]`.

## Why did 2026-07-20 conclude "not exposed"? (hypotheses — cannot be proven from here)

1. **Most likely: probe-surface confusion.** The 2026-07 attempts ran through the upstream
   `theYahia/planfix-mcp` npx server, which has no checklist tool; "the MCP can't do it" was
   recorded as "the API can't do it" without a direct REST probe. The P2 time-entries failure
   had exactly this root-cause shape (tool gap misdiagnosed as API gap), on the same date range.
2. **Possible: the endpoints shipped between 2026-07-20 and 2026-07-24.** Cannot be ruled out
   (no changelog checked), but four days is a narrow window, and production tasks carry
   checklist items created via the UI as far back as 2026-04 — the feature itself is old; only
   its REST exposure was in question.

The empirical result stands regardless of which hypothesis is right.

## Proposed tool design (for review BEFORE implementation — not built in this spike)

- **`get_task_checklist`** (read-only): `taskId`, `offset`/`pageSize` (default 50, max 99 —
  over-fetch pattern via `postListPage`), rows `#id | name | [x]/[ ] | assignees?`, exact
  `has_more`, English empty hint ("Task N has no checklist items."). Annotations
  `readOnlyHint: true, idempotentHint: true`. This alone kills the operator's copy-paste gap.
- **`add_checklist_item`** (mutating): `taskId`, `name`, optional `isDone`, optional
  `assigneeId` (prefixed `user:` internally). Safe-mode wiring:
  `await assertTaskInTestProject("add_checklist_item", taskId)` before the POST.
  Annotations `{readOnlyHint: false, destructiveHint: false, idempotentHint: false}`.
- **`set_checklist_item_done`** (mutating): `taskId`, `itemId`, `isDone` (explicit bool — the
  tool both checks and unchecks; no toggle ambiguity). Same safe-mode guard. Annotations
  `{readOnlyHint: false, destructiveHint: true, idempotentHint: true}` (overwrites the flag;
  same payload converges).
- **Safe-mode OFF is the end-goal, deliberately** (same pattern as add_time_entry): checking
  off items on REAL production tasks is the actual workflow. The deterministic guard exists
  for development sessions (`PLANFIX_SAFE_MODE=1` confines all three writes to MCP-Test);
  production sessions run without safe mode by explicit configuration in `~/.claude.json`,
  exactly as documented in docs/TESTING.md § Safe mode. No new mechanism needed — wiring
  through `assertTaskInTestProject` gives the identical deliberate-OFF semantics.
- Rejected: an update-name tool (no observed friction); a generic checklist CRUD (no delete
  endpoint exists anyway); exposing `parent` on create (the API does not accept it).

## Probe-artifact inventory (Layer 3 rule 5 — batch-clean from the UI when noisy)

- Task `572468` "[MCP-TEST] P6 spike: checklist write probe" in project 572465.
- Checklist item `572469` "[MCP-TEST] P6 probe item" on that task, now `isDone: true`.

## Open questions

1. Whether `assignees` on a checklist item round-trips (not probed — outside the one-create
   cap; recommend covering it in the implementation slice's Layer 3 run).
2. Item ordering control (no order field in the schema; creation order observed) — matters
   only if the operator wants to insert items mid-list.
