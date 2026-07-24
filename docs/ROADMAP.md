# Roadmap — friction-driven development

Guiding rule (Anthropic, [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)): grow this server by removing observed agent friction, not by covering API endpoints. Every item below traces to a real stumble in production sessions. New items enter this file only with a named friction source.

Development loop: friction observed in a live session → item recorded here → KB session writes a WHAT-brief → developer session implements → KB session reviews the diff and runs a Layer 3 live check (docs/TESTING.md) → push.

## P1 — composite & search tools (observed friction)

1. **`get_task_full`** — return task fields + comments in a single call. **Implemented 2026-07-24** (`src/tools/tasks.ts`), **Layer 3 verified 2026-07-24** (live read-only run: all filters discriminate correctly against production data).
   Friction: syncing one card of the vault task mirror currently costs `get_task` + `get_comments` (2 round-trips, 2× token overhead). Follow the consolidation guidance: one tool per real workflow step.
2. **`search_tasks`** — filtered task search (name substring, assignee, status, project, updated-since). **Implemented 2026-07-24** (`src/tools/tasks.ts`), **Layer 3 verified 2026-07-24** (live read-only run: all filters discriminate correctly against production data).
   Friction: the only discovery path today is paging `get_tasks`. Planfix REST supports complex task filters (see [REST API: Complex task filters](https://planfix.com/help/REST_API:_Complex_task_filters)). Search-shaped beats list-shaped.

## P2 — time entries (investigation first)

3. **Investigate, then implement, writing time entries** (analytics/datatags on tasks).
   Friction: time logging is fully manual today; a 2026-07 attempt to write time entries via MCP failed — root cause never diagnosed (tool gap vs API gap). Step 1 is a spike: determine whether Planfix REST can create the "time spent" analytics records at all (safe-mode ON, MCP-Test project only). Only if yes, design the tool. Highest-value item in the file if the API allows it.
   **Spike done 2026-07-24 — verdict: TOOL GAP.** The REST API writes time entries fine (data tag 59 "Time spent" via `POST /task/{id}/datatags/`; verified round-trip on MCP-Test task 572467, entry key 127822). Full evidence, request/response shapes, and the proposed `add_time_entry` tool design: `docs/spikes/time-entries.md`.
   **Implemented 2026-07-24** (`src/tools/timeentries.ts`: `add_time_entry` + `get_task_time_entries`, incl. the review-mandated `commentId` chaining for the one-comment-per-period convention), **Layer 3 verified 2026-07-24**: both endpoint variants live-tested on task 572467 — new-comment (keys 127823/127825) and append after the 6425999 fix (keys 127824/127826); one-comment-per-period convention round-trips (entries share commentId 47856607).

## P3 — hygiene per Anthropic checklist (background, batch with other work)

4. **Tool annotations**: `readOnlyHint` / `destructiveHint` / `idempotentHint` on all 20 tools (currently absent). **Done 2026-07-24** — all 24 tools migrated to `registerTool` with annotations; descriptions and `.describe()` strings also moved to English (test-enforced), **Layer 3 read-only sweep verified 2026-07-24** (24 annotated tools, zero Cyrillic in schemas; probe-path has_more exact on a full 100-row get_tasks page; list_custom_fields client paging exact incl. offset numbering; CONCISE cuts get_task output ~3.5x on live data).
5. **Pagination metadata**: list tools return `has_more` + next offset hint instead of a bare page. **Done 2026-07-24** — exact `has_more` via `src/paging.ts` (over-fetch, or a one-row probe at the API's 100 cap); only schema addition: `list_custom_fields` gained `offset`/`pageSize` (client-side paging — its GET endpoint has none).
6. **`response_format` parameter** (`CONCISE` | `DETAILED`) on the heaviest read tools (`get_task`, `get_tasks`, `get_contacts`) to cut token cost when the agent only needs identifiers. **Done 2026-07-24** — also on `get_task_full`; default DETAILED, backward compatible.

## P4 — log_workday (approved next, 2026-07-24)

7. **`log_workday`** — composite day-level time logging on top of `add_time_entry`. **Implemented 2026-07-24** (`src/tools/timeentries.ts`; shared `writeTimeEntry()` core with `add_time_entry`), **Layer 3 verified 2026-07-24**: real day in MCP-Test — validate_only plan matched the real run exactly; lunch-spanning 12:30-16:45 auto-split to 12:30-14:00 + 15:00-16:45 (keys 127827/127828, one commentId 47856609); second task chained separately (key 127829); overlap probe refused with zero writes.
   Takes a whole working day (list of per-task intervals) and **deterministically enforces the operator's logging conventions before writing anything**: intervals must not overlap across tasks; no interval may cross the 14:00–15:00 lunch break (an interval spanning it is split into two entries); entries for the same task+period chain onto one comment via `commentId`. Rationale: these rules currently live only as instructions to the consuming agent (operator's vault, planfix page § Working conventions) — deterministic code beats discipline. Approved by the operator 2026-07-24 as the next slice; detailed brief to follow from the reviewing session.
   **v2 2026-07-24 (operator decision — no hardcoded conventions):** the lunch rule was removed from code and generalized to a **required `exclusions` input** (N no-work windows `{timeFrom, timeTo, label?}`, merged when overlapping/adjacent, cut out of every interval with per-window `(auto-split: label)` marks; `[]` = log straight through; no default of any kind). Semantics change: partial window overlap now splits instead of refusing. **Layer 3 v2 verified 2026-07-24**: live day — omitted exclusions refused at schema level; adjacent windows merged (standup+sync → 11:00-12:00); both intervals cut correctly (keys 127830-127833, per-task chaining intact); validate_only plan matched the real run exactly.

## P5 — get_task_children (approved 2026-07-24)

8. **`get_task_children`** — direct subtask listing for a given parent task (read-only). **Implemented 2026-07-24** (`src/tools/tasks.ts`; task/list complex filter type 73 "direct parent task" — no dedicated endpoint exists; type 307 = recursive subtree, deliberately not used), **Layer 3 verified 2026-07-24**: real hierarchy — parent 401356 (autofill Deal branch) returned exactly its 9 direct Ф0-Ф8 subtasks (parent itself absent from the list); a leaf subtask and an unrelated task both return the empty hint. Direct-only semantics consistent with live data + the 73-vs-307 docs distinction (no 3-level hierarchy existed to probe grandchild exclusion directly).
   Friction: the operator's time entries live in subtasks (e.g. autofill hours in Ф3/Ф4 branches) and the vault task mirror cannot see task hierarchy today — finding subtasks means UI navigation. Promoted from the researched backlog by operator decision 2026-07-24.
   Note (observed while checking the swagger for a children endpoint, 2026-07-24): the REST v2 swagger now lists `/task/{id}/checklist`, `/task/{id}/checklist/list`, `/task/{id}/checklist/{itemId}` — this contradicts the "checklists not exposed" out-of-scope entry below; worth a re-verification spike before dismissing checklists again.

## P6 — checklist re-verification spike (approved 2026-07-24)

9. **Checklist spike** — re-verify the "checklists are not exposed" verdict (2026-07-20) against the `/task/{id}/checklist*` endpoints discovered in the current swagger during P5. Friction: checklists are the single biggest manual gap — the operator pastes them by hand into every task-context conversation. Spike first, tools only after design review (P2 precedent).

## Researched backlog (NOT friction-validated — promote to a P-item only when real friction is observed)

Source: 2026-07-24 benchmark against peer PM-tool MCP servers (Atlassian Rovo MCP for Jira — 16 tools incl. JQL search, transitions, worklogs, linking, no deletes; ClickUp/Quire community servers). The fork already matches the peer baseline; items below are candidates, not commitments, per the guiding rule.

- **`create_task_from_template`** — RevOps runs 13 `[RevOps] / …` task templates (Priority/SP/Status fields); bare `create_task` bypasses the standard. Needs a spike first: does REST expose task templates?
- **`run_report`** — the "All completed tasks by employee" report is the SP source for the operator's velocity metric; peer precedent exists (popstas planfix server exposes report list/generation). Would automate velocity collection.
- **`update_comment`** — fix a typo in an already-posted comment without the UI; cheap (API key scopes already allow comment update).
- Not carried over from peers (no plausible local use): task linking (Jira), boards/spaces (ClickUp), MCP prompts beyond the existing two.

## Explicitly out of scope

- **Checklists** — not exposed by the Planfix REST API at all (verified empirically 2026-07 and against API docs). No MCP-side work can fix this; revisit only if Planfix ships the endpoint.
- **Endpoint-coverage parity** with the REST API — coverage is not a goal; friction is.
- **Project creation** — API does not support it; projects are created in the UI.
