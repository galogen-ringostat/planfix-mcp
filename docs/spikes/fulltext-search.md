# Spike: full-text search over descriptions & comments (ROADMAP P11 — DECISION DOCUMENT)

Date: 2026-07-27. Executor: developer session (Claude Code). RESEARCH ONLY — no tool
design commitment, no implementation. Audience: the operator + Harbor (sibling Planfix
MCP server; possible repo merge). All probes read-only against production.

Harbor's claim under test: *"search over comments and task descriptions is the key
problem; probably needs an index."*

## Verdict (short)

- **Q1: The REST API cannot search task descriptions.** No filter type matches
  description text; filter 8 matches the NAME only (live-verified both ways); a live
  sweep of all 19 undocumented filter-type codes found no hidden text filter.
- **Q2: No full-text surface over comments exists.** No search-shaped endpoint
  anywhere in the swagger; `ComplexCommentFilter` supports only date (3000) and author
  (3001). Harbor's diagnosis is CONFIRMED: anything beyond name-contains requires
  fetching text and matching it ourselves.
- **Q3: a local index is feasible but a FULL-account build is expensive** (600k–1M
  comments; the flat `/comment/list` scan surface exists but runs 6–49 s per call
  depending on filter width → a one-time build measured in HOURS, not minutes). A
  SCOPED index (projects / recent window) or the no-index bounded grep are the
  practical shapes. Numbers below.
- **Recommendation: bounded grep now; if index, scope it.** Details in the options
  table.

## Q1 — description search via the API: NO (evidence)

### Docs + swagger sweep

- The complex-task-filter help page documents NO description/text filter. The only
  text-shaped filters: **8** (task name; equal = contains) and **101** (custom
  "Short text" field, requires `field` id — not the description).
- Swagger `ComplexTaskFilter` enum lists these type codes:
  1, 2, 3, 5, 7, 8, 9, 10, 11, 12, 13, 14, 16-26, 28, 29, 33-35, 38, 39, 41, 51, 57,
  59, 60, 69-73, 79, 93, 97, 101-117, 152, 153, 307, 325. All documented ones are
  dates/people/enums/hierarchy; none is "description".

### Live probes (task 412626; term «пояснюваність» exists ONLY in its description, term "Change Log" in its name)

Request shape for every probe:
`POST /task/list {offset: 0, pageSize: 100, fields: "id,name", filters: [{type: T, operator: "equal", value: V}]}`

| Probe | type / value | Result |
|---|---|---|
| Positive control | 8 / "Change Log" | `success`, 1 task, **412626 present** — name-contains works |
| Filter 8 on description-only term | 8 / «пояснюваність» | `success`, **0 tasks** — **filter 8 does NOT secretly match descriptions** |
| Sweep of undocumented types | 9, 11, 16, 17, 18, 22, 23, 24, 26, 28, 29, 33, 39, 41, 57, 93, 152, 153, 325 / «пояснюваність» | **zero hits.** 93 errors (`JSONObject["subfilter"] not found` — a datatag subfilter type); 11/39/57/152/153 return 0 rows; the rest return full 100-row pages regardless of the string (value ignored — they are non-text filters). Task 412626 appeared in NONE of them |

## Q2 — full-text over comments: NO (evidence)

- **Swagger path sweep**: zero endpoints matching `search|query|fulltext` anywhere in
  the spec. The UI's global search has no visible/documented REST v2 backing endpoint
  (help-site search also surfaces none); per the brief, undocumented private endpoints
  were not probed.
- **`POST /task/{id}/comments/list`** body: `{offset, pageSize, fields, typeList,
  resultOrder}` — pagination only, no text parameter.
- **`POST /comment/list`** (task-agnostic — see Q3) body: `{offset, pageSize, fields,
  typeList, resultOrder, filters: ComplexCommentFilter[]}`; `ComplexCommentFilter`
  supports exactly **3000 Comment date** and **3001 Comment author**. No text filter.

## Q3 — implementation space (survey only; nothing built)

### The flat scan surface: task-agnostic `POST /comment/list` — exists, with teeth

`{offset, pageSize ≤100, fields: "id,task,dateTime,description", typeList: "Comments",
filters: [3000 date / 3001 author]}` returns comments across ALL tasks with task
back-references. Measured behavior (2026-07-27):

- A **bare** call (no filters) → `400 {"result":"fail","code":0,"error":"Rest API
  error"}` — some narrowing filter is effectively REQUIRED.
- A **wide** date filter (`gt 01-01-2000`) works but costs **40–49 s per call**, at any
  offset (server-side filter evaluation over the whole comment corpus).
- A **narrow** one-week `otherRange` costs **6–12 s per call** and this account logs
  400+ comments/week.
- Incremental slice verified: `{type: 3000, operator: "gt", value: {dateType:
  "otherDate", dateValue: "20-07-2026"}}` → full 100-row page, `result: success`.

### Account scale (measured 2026-07-27)

| Object | Count | Basis |
|---|---|---|
| Tasks visible to this key | **163,682** (exact) | binary search on `task/list` offset (pageSize 1) |
| Comments (typeList Comments) | **600k–1M** (bracketed) | fixed-offset probes with the wide filter: offset 600,000 non-empty, 1,000,000 empty; exact bisection abandoned at 40+ s/call |
| Comment text volume | avg **1,022** chars, max 11,578 (sample: 100 most recent) | raw text ≈ **0.6–1 GB** for all comments — SQLite-fine, NOT in-memory-JSON-fine at full-account scale |

**Full-account initial index build is HOURS, not minutes**: comments alone are
6,000–10,000 calls at 6–12 s (narrow slices) ≈ **10–25 h wall-clock**, plus tasks
(163,682 / 100 = 1,637 fast `task/list` calls ≈ 30–45 min). One-time, resumable, but a
real operational commitment. **A scoped index** (e.g. the RevOps projects, or a rolling
12-month window) shrinks this by 1–2 orders of magnitude. Incremental sync after any
initial cursor is cheap and proven: tasks via task filter 79 (updated-or-commented
since — in production use), comments via 3000 `gt` (verified above); a week's delta ≈
4–6 calls.

### Options table

| | A. API-native | B. Local FTS index | C. Bounded on-the-fly grep |
|---|---|---|---|
| What | Server-side text filters | Sync tasks+comments → embedded full-text store; search locally | Tool takes a BOUNDED task set (project / assignee / updatedSince ≤ N tasks), fetches descriptions+comments on the fly, greps in the tool, returns matches only |
| Feasibility | **Does not exist** (Q1/Q2) | Feasible. Store: `node:sqlite` (built-in; FTS5 verified working on the operator's Node 24 incl. Cyrillic tokens; repo `engines: >=18` needs a bump to >=22.5) or `better-sqlite3` (native dep; heavier for npx distribution). In-memory/JSON only viable for a SCOPED corpus | Feasible today with existing endpoints; zero new dependencies, zero state |
| Initial cost | — | FULL account: ~8k–12k calls, **10–25 h** (comments dominate). SCOPED (RevOps projects / 12 months): minutes-to-an-hour | none |
| Query cost | — | ~0 calls (local) | 1 `task/list` + 2 calls per task (card + comments page): 15 tasks ≈ 31 calls; 50 ≈ 101; 200 ≈ 401 (~10 s / ~40 s / ~2.5–3 min at ~3 calls/s). Token cost low — matching happens in the tool; only matched snippets render |
| Freshness | — | Stale between syncs; incremental delta cheap (above). Sync-on-demand or timer | Always live |
| State/lifecycle | — | Index file must survive stdio restarts → `~/.planfix-mcp/<account>.index.db` or env-var path. Derived data ONLY — no secrets beyond the (already sensitive) task/comment TEXT itself; treat the file like the account; deletable any time, rebuild = re-sync | none |
| Risks | — | Hours-long full build; a second copy of production text on disk; index divergence bugs; native-dep/engines friction; more code in a possible repo merge | Latency on big sets; a 200-task sweep flirts with rate-limit code 22 (client retries exist); cannot answer "search EVERYTHING" |
| Fits friction? | n/a | Fully (account-wide) — but 96% of those 163k tasks are outside the operator's working set | Yes for the observed friction shape ("find where we discussed X" is almost always scoped to a project/person/period) |

### Recommendation (developer session's input to the operator+Harbor decision)

1. **Harbor is right that the API cannot do it** (Q1/Q2 evidence). But "needs an
   index" is only forced for account-wide search, and at 163k tasks / 600k+ comments a
   FULL index is a heavy build for a corpus that is ~96% outside the working set.
2. **First step: bounded grep (option C)** — zero state, zero dependencies, no
   staleness, covers the observed friction. Natural shape if later approved:
   `search_task_text({projectId | assigneeId | updatedSince, query, maxTasks ≤ 50})`.
3. **If account-wide search becomes real friction: option B, SCOPED** (project set or
   rolling window, `node:sqlite`/FTS5, engines → ≥22.5, index under
   `~/.planfix-mcp/`). C and B share the fetch surface — C is not throwaway work.
4. For the merge conversation with Harbor: the sync/index layer is the piece worth
   sharing between the two servers; option C needs nothing from his repo. The
   measured latencies above (40 s wide-filter calls, 400 status) are account-shape
   facts his server will hit identically.

## Probe-artifact inventory

None — every probe was read-only.
