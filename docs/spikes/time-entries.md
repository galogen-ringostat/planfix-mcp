# Spike: can Planfix REST write time entries? (ROADMAP P2)

Date: 2026-07-24. Executor: developer session (Claude Code). Probes ran against production
per docs/TESTING.md Layer 3; the single write targeted only a task this spike itself created
inside project MCP-Test (572465).

## Verdict: TOOL GAP

The Planfix REST API v2 **fully supports** reading and writing time-entry analytics. They are
exposed as **data tag entries** (Planfix "analytics" = REST "datatags"). A create round-tripped
successfully on the first attempt (HTTP 201, entry key `127822`). The 2026-07 failure was caused
by this server simply having no datatag-entry write tool (`list_datatags` is its only datatag
tool, and it only lists definitions) — not by any API limitation.

## Endpoints discovered (from https://help.planfix.com/restapidocs/swagger.json)

| Method | Path | Purpose |
|---|---|---|
| POST | `/datatag/list` | List data tag definitions (id, name, group) |
| GET | `/datatag/{id}?fields=id,name,group,fields` | One definition incl. field ids/types |
| GET | `/customfield/datatag/{id}` | Field ids of a data tag |
| POST | `/datatag/{id}/entry/list` | List entries of a data tag (supports complex filters 3101–3123) |
| GET | `/datatag/entry/{key}` | One entry; request custom fields **by numeric id** in `fields` |
| POST | `/task/{id}/datatags/` | **Create** entry on a task (attaches a new comment) |
| POST | `/task/{id}/datatags/{commentId}` | Create entry attached to an existing comment |
| POST | `/datatag/entry/{key}` | Update an entry |
| DELETE | `/datatag/entry/{key}` | Delete an entry |

## The time-logging data tag

`POST /datatag/list` returned 14 data tags. The org's time-logging analytic is data tag
**59 "Time spent"** (group 13 "Marketing"): user list + date + clock-range field, matching the
described "Time spent RevOps" analytic. (No data tag is literally named "Time spent RevOps";
group 15 "RevOps" holds only `revops_period` (65) and `revops_scope` (67), neither time-shaped.
See Open questions.)

Fields of data tag 59 (from `GET /datatag/59?fields=id,name,group,fields`):

| Field id | Name | Type | Mandatory | Write value format |
|---|---|---|---|---|
| 173 | Name | 14 "List of users" | yes | `[{ "id": "user:<N>" }]` |
| 175 | Date | 3 "Date" | yes | `{ "date": "DD-MM-YYYY" }` |
| 185 | Time | 6 "Period of time" | yes | `{ "from": { "time": "HH:MM" }, "to": { "time": "HH:MM" } }` — `durationSec` is computed server-side |
| 191 | Type | 8 "List", enum `Task \| Meeting \| Feedback \| Edits` | yes | the enum string, e.g. `"Task"` |
| 181 | Comment | 0 "Short text" | yes | string |
| 199 | Scoring | 1 "Number" | no | number |

## Write evidence (Layer 3, one attempt, succeeded)

Probe task created first (create-only entry point): `POST /task/` with
`{ name: "[MCP-TEST] P2 spike: time entry write probe", project: { id: 572465 } }` →
`201 { "result": "success", "id": 572467 }`, project verified as 572465 before writing.

Request — `POST /task/572467/datatags/`:

```json
{
  "dataTag": { "id": 59 },
  "items": [{
    "customFieldData": [
      { "field": { "id": 173 }, "value": [{ "id": "user:403" }] },
      { "field": { "id": 175 }, "value": { "date": "24-07-2026" } },
      { "field": { "id": 185 }, "value": { "from": { "time": "10:00" }, "to": { "time": "10:30" } } },
      { "field": { "id": 191 }, "value": "Task" },
      { "field": { "id": 181 }, "value": "[MCP-TEST] P2 spike probe entry" }
    ]
  }]
}
```

Response: `201 { "result": "success", "keys": [127822], "commentId": 47856597 }`

Read-back — `GET /datatag/entry/127822?fields=key,task,commentId,173,175,185,191,181` →
`200`, every field round-tripped exactly; the Time field came back as
`{ "from": { "time": "10:00" }, "to": { "time": "10:30" }, "durationSec": 1800 }` (duration
computed by Planfix); field 173 resolved to `user:403` "Dmytro Galogen Halahan".

## API gotchas (cost real probe iterations — encode into the future tool)

1. Custom field values are returned **only when requested by numeric field id** in `fields`
   (e.g. `fields=key,task,173,175,185`); the literal name `customFieldData` in `fields` returns
   nothing, silently.
2. Creating an entry via `/task/{id}/datatags/` **also creates a comment** on the task
   (`commentId` in the response) — a time-entry write is visible task activity.
3. `POST /datatag/{id}/entry/list` paginates oldest-first; finding a fresh entry requires the
   `keys` from the create response (or a complex filter), not paging.
4. Dates are `DD-MM-YYYY` in write values and `stringValue`, but read back with an additional
   ISO `datetime` — same duality the task filters have (`dateValue`, spike of 2026-07-24).

## Proposed tool design (for review BEFORE implementation — not built in this spike)

- **`add_time_entry`** (mutating): inputs `taskId` (int), `date` (`YYYY-MM-DD`, converted to
  `DD-MM-YYYY` like search_tasks does), `timeFrom`/`timeTo` (`HH:MM`, Zod regex), `type`
  (Zod enum `Task|Meeting|Feedback|Edits`), `comment` (string), `userId` (int; the logging
  user; description points to `list_users`). Emits the exact request shape above. Data tag id
  59 and field ids 173/175/185/191/181 live as named constants with a comment linking here.
  Annotations: `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false`.
  **Safe-mode wiring: `await assertTaskInTestProject("add_time_entry", taskId)` before the
  POST** — same guard as add_comment; the write path is unreachable outside MCP-Test when
  `PLANFIX_SAFE_MODE` is on.
- **`get_task_time_entries`** (read-only, optional companion): `POST /datatag/59/entry/list`
  filtered by task (complex datatag filter type 3117 "Custom field Task" if applicable, else
  client-side filter), fields by id; annotations `readOnlyHint: true, idempotentHint: true`.
- Rejected alternative: a generic `add_datatag_entry` (arbitrary datatag id + raw
  customFieldData) — maximally flexible but agent-hostile (caller must know field ids and the
  five per-type value formats) and safe-mode-hard (arbitrary datatags may not be task-scoped).
  Consolidation guidance says model the workflow: time logging is the observed friction.

## Probe artifacts left in place (Layer 3 rule 5 — auditable, batch-clean from UI)

- Task `572467` "[MCP-TEST] P2 spike: time entry write probe" in project 572465.
- Data tag 59 entry key `127822` (comment `47856597`) on that task, 10:00–10:30 24-07-2026,
  user 403, comment "[MCP-TEST] P2 spike probe entry".

## Open questions

1. Confirm with the operator that data tag **59 "Time spent"** is the analytic RevOps actually
   logs into (the brief said "Time spent RevOps"; no data tag carries that exact name, and 59
   sits in the Marketing group — sample entries on it were Marketing tasks).
2. Should `add_time_entry` default `userId` to the operator's own user (403) or always require
   it explicitly? Explicit is safer against silently logging time as the wrong person.
3. Whether the mandatory "Scoring"-adjacent workflow needs field 199 exposed (it is optional in
   the definition and was omitted successfully).
