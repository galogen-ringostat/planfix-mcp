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

## Explicitly out of scope

- **Checklists** — not exposed by the Planfix REST API at all (verified empirically 2026-07 and against API docs). No MCP-side work can fix this; revisit only if Planfix ships the endpoint.
- **Endpoint-coverage parity** with the REST API — coverage is not a goal; friction is.
- **Project creation** — API does not support it; projects are created in the UI.
