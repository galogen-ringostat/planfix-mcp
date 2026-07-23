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

## P3 — hygiene per Anthropic checklist (background, batch with other work)

4. **Tool annotations**: `readOnlyHint` / `destructiveHint` / `idempotentHint` on all 20 tools (currently absent).
5. **Pagination metadata**: list tools return `has_more` + next offset hint instead of a bare page.
6. **`response_format` parameter** (`CONCISE` | `DETAILED`) on the heaviest read tools (`get_task`, `get_tasks`, `get_contacts`) to cut token cost when the agent only needs identifiers.

## Explicitly out of scope

- **Checklists** — not exposed by the Planfix REST API at all (verified empirically 2026-07 and against API docs). No MCP-side work can fix this; revisit only if Planfix ships the endpoint.
- **Endpoint-coverage parity** with the REST API — coverage is not a goal; friction is.
- **Project creation** — API does not support it; projects are created in the UI.
