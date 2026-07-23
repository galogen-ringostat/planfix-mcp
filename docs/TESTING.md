# Testing protocol — no test environment exists

Hard constraint: the only Planfix instance is **Ringostat production**. The ceiling for live testing is *creating test records and working with records the test itself created*. Modifying or deleting production records is never acceptable, in any layer.

## Layer 1 — Unit tests (always safe)

- `npm test` (vitest, `tests/`). All Planfix HTTP is mocked — zero network calls.
- Every new or changed tool gets: a happy-path test, an invalid-input test (Zod rejection), and an API-failure test (fail envelope / rate-limit code 22).
- This is the default layer: most development iterations should complete here.

## Layer 2 — MCP Inspector (protocol layer, safe with dummy credentials)

```bash
npm run build
npx @modelcontextprotocol/inspector node dist/index.js
```

- With `PLANFIX_API_KEY=dummy PLANFIX_ACCOUNT=dummy`: verify tool discovery, schema rendering, parameter validation — no real API is reachable.
- With real credentials: **read-only tools only** (`get_*`, `list_*`). No mutating calls from Inspector against prod outside Layer 3 rules.
- If Inspector shows "Unexpected token" parse errors: something logged to stdout — move it to stderr.

## Layer 3 — Live tests against production (gated)

### One-time setup (manual, Galogen)

1. Create a Planfix project named **`MCP-TEST`** in the UI (the API/MCP cannot create projects).
2. Record its ID here and in the local env: `PLANFIX_TEST_PROJECT_ID=<id>`.

Current value: `PLANFIX_TEST_PROJECT_ID=572465` (project `MCP-Test`, created by Galogen 2026-07-24).

### Rules for every live test run

1. **Create-only entry point**: tests may create tasks/comments only inside project `MCP-TEST`, with names prefixed `[MCP-TEST]`.
2. **Own-records-only mutation**: `update_*` / delete operations may target ONLY IDs that the same test run created (track created IDs in the test script; never look IDs up by search for mutation).
3. **Never touch prod records**: no update/delete/comment on any record outside `MCP-TEST`, even "harmless" ones, even to revert a mistake — report instead.
4. **Contacts caution**: `create_contact`/`update_contact` have no project scoping in Planfix. Avoid live contact tests; if unavoidable, use obviously-fake data prefixed `[MCP-TEST]` and get explicit approval first.
5. **Cleanup**: prefer leaving `[MCP-TEST]` records in the test project (auditable) over deleting; batch-clean manually from the UI when noisy.
6. **Assignees**: test tasks may assign ONLY Galogen (user 403). Assigning anyone else sends a real notification to a real employee.
7. **Refusal paths are verified in unit tests only.** Never aim a live mutating call at a record outside `MCP-Test` "expecting the guard to refuse" — if the guard has a bug, that call mutates production. Live testing exercises allowed paths only.

## Safe mode — deterministic guard (spec; implement in the fork)

Instruction-level discipline is not enough; the guard must live in code (deterministic > discipline).

> **Status: implemented** in `src/safemode.ts`, wired into `handleCreateTask`, `handleUpdateTask`, `handleAddComment`, `handleCreateContact`, `handleUpdateContact`, `handleUploadFileFromUrl`. Unit tests: `tests/safemode.test.ts`. Note: `upload_file_from_url` currently has no `taskId` parameter (it uploads a standalone file), so there is no target task to resolve — it is refused entirely in safe mode, like contacts.

- Env: `PLANFIX_SAFE_MODE=1` + `PLANFIX_TEST_PROJECT_ID=<id>`.
- When safe mode is ON, every mutating tool (create/update/upload/comment) must verify the target lives in `PLANFIX_TEST_PROJECT_ID` before issuing the HTTP call:
  - `create_task`: forced/validated `project.id === TEST_PROJECT_ID`.
  - `update_task`, `add_comment`, `upload_file_from_url`: resolve the target task first (`GET task`), refuse unless its project is the test project.
  - `create_contact` / `update_contact`: refused entirely in safe mode (no project scoping exists).
- Fail closed: safe mode ON without `PLANFIX_TEST_PROJECT_ID` set → all mutating tools refuse.
- Refusal message must say what to do (e.g. "safe mode: target task 123 is outside MCP-TEST project 456").
- Read-only tools are unaffected.
- The live MCP entries in `~/.claude.json` / `~/.claude-personal/.claude.json` run WITHOUT safe mode (normal work needs prod writes: comments, task mirror). Safe mode is for development sessions of this fork.

## References

- [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
- [Anthropic — Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [anthropics/skills → mcp-builder reference](https://github.com/anthropics/skills/tree/main/skills/mcp-builder)
