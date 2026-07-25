# Spike: project discovery & project state (ROADMAP P8)

Date: 2026-07-25. Executor: developer session (Claude Code). All probes READ-ONLY
(`project/list`, `project/{id}`, `task/list`, `project/groups`, `project/templates`) —
no records created or mutated; Layer 3 write rules were never engaged. Probe scripts ran
from the session scratchpad with credentials read from the local MCP config at runtime
(never logged). Swagger fetched 2026-07-25 from
`https://help.planfix.com/restapidocs/swagger.json`.

## Verdict

1. **`/project/list` supports complex filters** (`ComplexProjectFilter`), including
   name-contains (5001) and status (5006). Verified live. `search_projects` is buildable
   with no workarounds.
2. **The `#2` status is BOTH a fetch gap and a render gap.** Fetch side: the API returns
   project `status` as a bare `{"id": 2}` — no `name`, unlike task statuses which arrive
   fully labeled (`name`, `color`, `isActive`, `texts[]`). No endpoint lists project
   statuses. They are the three fixed system statuses (Draft / Active / Completed) —
   label resolution must be a client-side constant map. Render side: `formatProject`
   (`src/format.ts`) renders only `id`/`name`/`status` and silently drops every other
   fetched field (owner, group, dates, parent…) — that is why extra `fields` "changed
   nothing visible".
3. **State aggregates are compose-only but cheap enough.** No count/aggregate endpoint
   and no sort parameter on `task/list` exist. Task counts by status = page
   `task/list` with a project filter (fields `id,status,dateOfLastUpdate`, ≤100/page) and
   count client-side; recency = the same call with filter type 79 ("updated after date")
   ANDed in, which returns only recently-active tasks in one page. Both verified live.

## Endpoints and schemas (swagger, verified live where noted)

| Method | Path | Notes |
|---|---|---|
| POST | `/project/list` | body `{offset, pageSize (max 100), fields, filters: ComplexProjectFilter[]}`. Filters verified live: 5001, 5006. |
| GET | `/project/{id}?fields=…` | Full system-field list per swagger: `id, name, description, status, owner, parent, template, group, counterparty, startDate, endDate, hiddenForEmployees, hiddenForClients, overdue, isCloseToDeadline, hasEndDate, assignees, participants, auditors, clientManagers, isDeleted` + custom field ids. Verified live: owner/group/template/startDate/overdue/assignees all come back when requested. |
| GET | `/project/groups?fields=id,name` | Project groups with names (4 in this account: Marketing Department, Customer care department, Sales Department, Dublin). Without `fields` returns ids only. Verified live. |
| GET | `/project/templates` | Returns `[{id: 2}]` in this account. |
| POST | `/task/list` | Already used by `search_tasks`; project filter type 5, updated-after type 79. `TaskResponse.dateOfLastUpdate` is available as a field. No sort parameter exists (swagger checked); result order observed: ascending task id. |

No `/project/statuses`-like endpoint exists anywhere in the swagger. `/object/{id}/statuses`
is task-process statuses only.

### ComplexProjectFilter (from swagger + help page "REST API: Complex project filters")

`{type, operator: equal|notequal|gt|lt, value, field?}`; multiple filters AND.

| Type | Meaning | Value | Live-verified |
|---|---|---|---|
| 5001 | Project name — **contains** semantics for strings, like task filter 8 | string | ✅ `"MCP"` → matched `MCP-Test` (572465) |
| 5002 | Project group | int group id | — |
| 5003 | Counterparty | `contact:N` | — |
| 5004 | Author/owner | `user:N` / `group:N` / `contact:N` | — |
| 5005 | Due date | date object | — |
| 5006 | Project status | int status id | ✅ value 2 → 100+ rows; value 1 → the 6 status-1 projects; value 0 → the 2 status-0 projects |
| 5007 | Project number | int | — |
| 5008/5011/5012 | Client manager / assignee / auditor | people ref | — |
| 5010 | Template | int | — |
| 5013 | Creation date | date object | — |
| 5014 | Parent project | int | — |
| 5101–5117 | Custom-field filters (`field` = custom field id) | varies | — |

## Project status ids: fixed system statuses, resolved by constant map

- The REST API returns `status` as `BaseEntity` with **id only** — no name, ever
  (list and single-project probes, all fields requested).
- Planfix help ("Project statuses") documents exactly three system project statuses:
  **Draft** (visible only to its author), **Active**, **Completed**. The legacy XML API
  page ("Planfix API: Project statuses") enumerates them in the order **DRAFT,
  COMPLETED, ACTIVE** with string values only.
- Live status universe across **all 218 projects** in the account: `{0: 2 projects,
  1: 6 projects, 2: 210 projects}` — a three-value set matching the three system
  statuses.

**Mapping: 0 = Draft, 1 = Completed, 2 = Active.** Evidence:

- `2 = Active` is **proven**: `MCP-Test` (572465, created 2026-07-23, in active use) has
  status 2; so do 210/218 projects — consistent with the operator's observation that
  stale goal-tree nodes were simply never closed (which is the friction).
- `1 = Completed` is **strongly supported**: project 7854 «Маркетинг Ringostat»
  (status 1) has 74 tasks, **zero** with `status.isActive`, latest `dateOfLastUpdate`
  2025-02-26. All six status-1 projects are recognizable finished initiatives.
- `0 = Draft` is **strongly supported**: both status-0 projects are single-task 2021
  leftovers, and 0/1/2 in the legacy docs' enumeration order (DRAFT, COMPLETED, ACTIVE)
  lands on exactly this mapping.
- Confidence: Active certain; Draft/Completed near-certain but unconfirmed by an
  authoritative id table (none exists). One-glance UI check by the operator would make
  it airtight; the implementation should keep the map in one exported constant.

## "State" aggregates: cost measured live

- **Task counts by status**: `POST /task/list` `{filters: [{type: 5, operator: "equal",
  value: <projectId>}], fields: "id,status,dateOfLastUpdate", pageSize: 100}` returns
  task `status` fully labeled **including `isActive`** — active/closed counting is one
  boolean per row, no extra calls. Cost: 1 HTTP call per 100 tasks. Projects probed:
  7854 → 74 tasks in one page; 14 → 100+ (needs paging). A scan cap is required for
  token/latency bounds.
- **Recency**: ANDing filter type 79 (`gt`, `{dateType: "otherDate", dateValue:
  "DD-MM-YYYY"}` — same shape `search_tasks` already uses) restricts to tasks changed OR
  commented after the date. Verified live: project 7854 since 2026-06-25 → 0 tasks
  (dead); MCP-Test since 2026-06-25 → its 3 tasks. One call answers "is this project
  alive?" and yields the recent-task list in the same response.
- **No server-side sort**: `task/list` result order is ascending id. "Most recently
  updated tasks" = fetch the type-79-filtered page and sort client-side by
  `dateOfLastUpdate` (bounded: ≤100 rows in that page by construction).

## Render gap in the existing tools (fix alongside)

`formatProject` (`src/format.ts:156`) renders `#id | name | статус: ref(status)` and
drops owner/group/parent/template/dates/overdue entirely; `ref()` on a nameless
`{id: 2}` degrades to `#2`. So even today `get_project` fetches more than it shows.
Fixing `formatProject` (render known fields when present + status label map) upgrades
`get_projects`/`get_project` for free.

## Proposed tool design (for review BEFORE implementation — not built in this spike)

Shared constant in `src/tools/projects.ts`:
`PROJECT_STATUS_LABELS: Record<number, string> = {0: "Draft", 1: "Completed", 2: "Active"}`,
fallback `status #N` when unmapped. (English by convention? No — data labels in rendered
output stay Russian per CLAUDE.md; proposal: `Черновик` / `Завершен` / `Активен`, with
the English map name kept in code comments. Reviewer to confirm which language project
STATUS labels count as — they are data-adjacent labels, not data; recommendation:
Russian, consistent with «статус:» prefix already in output.)

1. **`search_projects`** (read-only, `readOnlyHint: true, idempotentHint: true`)
   - Params: `nameContains?` (string, min 1 — filter 5001), `activeOnly?` (boolean —
     filter 5006 equal 2), `groupId?` (int — filter 5002), `ownerId?` (int → `user:N`,
     filter 5004), `offset?`, `pageSize?` (default 50, max 100). At least one of
     `nameContains | activeOnly | groupId | ownerId` required (mirror `search_tasks`,
     same error shape pointing at `get_projects` for unfiltered paging).
   - Fields fetched: `id,name,status,group,parent,owner`. Row render:
     `#id | name | статус: <label> | группа: G | родитель: P | владелец: O`
     (absent fields omitted). Exact `has_more` via existing `postListPage` over-fetch.
   - Kills the discovery friction: name lookup and "active projects only" in one call.

2. **`get_project_overview`** (read-only, `readOnlyHint: true`; NOT `idempotentHint` —
   output shifts as tasks move)
   - Params: `projectId` (int), `recentDays?` (int, default 30, range 1–365),
     `recentLimit?` (int, default 10, max 20).
   - Composition (3 HTTP calls + ≤`SCAN_CAP/100` paging calls):
     1. `GET project/{id}` fields `id,name,description,status,owner,parent,template,
        group,counterparty,startDate,endDate,hasEndDate,overdue,isDeleted` → card with
        human-readable status.
     2. `task/list` project filter, fields `id,status`, paged with **scan cap 300**
        (3 pages) → counts: total (`300+` when capped, stated explicitly with a hint to
        use search_tasks for exact slices), active vs closed via `status.isActive`,
        per-status-name breakdown.
     3. `task/list` project + type-79 (`recentDays` ago), fields
        `id,name,status,dateOfLastUpdate`, one page → recency: count of recently-active
        tasks + top `recentLimit` rows sorted client-side by `dateOfLastUpdate` desc
        (`#id | name | status | updated DD-MM-YYYY`).
   - Verdict line the agent can act on, e.g.:
     `Активность: 0 задач изменено за 30 дней — проект неактивен` vs
     `Активность: 14 задач за 30 дней; последнее изменение 24-07-2026`.
   - Token-bounded by construction: card + ≤3 count lines + ≤20 task rows. No
     CONCISE|DETAILED toggle proposed — the output is already the concise form; add only
     if review disagrees.

3. **`formatProject` upgrade** (existing `get_projects`/`get_project`): render
   status via the label map plus owner/group/parent/startDate→endDate/overdue when the
   fetch included them. The single-project default `fields` widens to
   `id,name,description,status,owner,parent,template,group,startDate,endDate,overdue`;
   the list default stays as today (`id,name,description,status`) to avoid output
   regressions on `get_projects`.

Rejected/deferred:
- **Owner/assignee name resolution beyond what the API returns inline** — `owner` comes
  back `{id: "user:403", name: "…"}` already; nothing to resolve.
- **Encoding project-selection policy** (which project fits which task type) — stays
  agent-side per ROADMAP non-goal.
- **`update_project` / project creation** — creation unsupported by the API (ROADMAP);
  no update friction observed.
- **Group-tree / goal-tree traversal tool** — `parent` rendering in search results
  covers the hierarchy signal cheaply; a dedicated tree tool has no observed friction.

## Open questions

1. ~~Operator eyeball-check of the 0=Draft/1=Completed mapping against the UI.~~
   **Closed 2026-07-26 (design review): CONFIRMED** — «Маркетинг Ringostat» (7854)
   displays as Completed in the UI. Map locked: `{0: Draft, 1: Completed, 2: Active}`.
2. ~~Language of the three status labels in rendered output.~~ **Closed 2026-07-26 the
   other way: English** — CLAUDE.md § Working language updated (all server-authored
   text English-only, including rendered-output labels); the Russian-labels
   recommendation above is superseded.
3. Whether `get_project_overview` should also surface `customFieldData` — no observed
   friction; left out.

## Design review outcome (2026-07-26)

APPROVED with changes, all implemented: status map confirmed (above); the overview's
recency count reports `100+` when its single type-79 page is full (explicit-cap
convention, same as the 300-task scan cap); English-only output sweep across
`src/format.ts` / `src/skills.ts` / remaining Russian strings, test-enforced by
`tests/english-output.test.ts`.

## Probe-artifact inventory

None — every probe was read-only. Nothing to clean up.
