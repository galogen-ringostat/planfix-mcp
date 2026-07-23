# planfix-mcp — Ringostat fork

MCP server for the Planfix REST API v2 (`https://<account>.planfix.com/rest/`), stdio transport, TypeScript + `@modelcontextprotocol/sdk` + Zod.

**This is a fork.** Upstream: `theYahia/planfix-mcp` (MIT). Origin: `github.com/galogen-ringostat/planfix-mcp`. Pull upstream updates with `git fetch upstream && git merge upstream/main`. Keep the LICENSE file intact (MIT requirement).

**Maintainer:** Galogen (d.halahan@ringostat.com), developed locally with Claude Code.

## Working language and audience

- Work entirely in **English**: reasoning, chat responses, code, comments, commit messages, docs.
- Your primary reader is **another LLM instance** (a knowledge-base/review session that evaluates your work), not a human. Write responses accordingly: exhaustive and self-contained over conversational; state file paths, function names, exact env var names, and exact behavior verbatim; enumerate every decision made and every deviation from spec explicitly; no rhetorical framing, no summarized hand-waving ("improved error handling") — name the concrete change. Assume the reader has NOT seen your session transcript.
- End-of-task reports must include: what changed (per file), why, test evidence (command + result), open questions/deviations. Machine-parseable structure (headings/lists) preferred.
- **Error messages, refusals, validation messages, and corrective hints are ALWAYS English** — in new code immediately, and migrate existing Russian error strings whenever you touch the file that contains them. Rationale: these strings are consumed by an LLM agent at failure time; they must match the working language. Tool descriptions and Zod `.describe()` strings are English as of the P3 hygiene pass (2026-07-24; tests enforce no Cyrillic there). Data labels in rendered OUTPUT (Задачи, статус, исполнители, …) stay Russian — they are read alongside Russian task data.

## Commands

| Command | Purpose |
|---|---|
| `npm run build` | tsc → `dist/`. **Required after every change** — the live MCP config runs `node dist/index.js`, not `src/`. |
| `npm run dev` | Run from source via tsx (stdio). |
| `npm test` / `npm run test:watch` | vitest (all HTTP mocked — safe, never touches Planfix). |
| `npx @modelcontextprotocol/inspector node dist/index.js` | MCP Inspector — interactive UI for protocol/schema debugging. |

## Architecture

- `src/index.ts` — server setup, tool registration, transport (stdio default, `--http <port>` optional).
- `src/client.ts` — Planfix REST client: auth (`PLANFIX_API_KEY` Bearer), 15s timeout, 3 retries, rate-limit code 22 handling.
- `src/tools/*.ts` — one file per domain: tasks, contacts, projects, comments, users, files, customfields, datatags, directories.
- `src/format.ts` — response formatting helpers.
- `tests/` — vitest, mocked HTTP.

## Environment variables

- `PLANFIX_ACCOUNT` — account subdomain (required).
- `PLANFIX_API_KEY` — REST API bearer key (required; legacy alias `PLANFIX_TOKEN`).
- `PLANFIX_HOST` — optional host suffix override (default `planfix.com`).
- Never hardcode or log secrets. Keys live only in env / the user's `~/.claude.json` MCP entry.

## ⚠️ CRITICAL: production safety

**There is NO test Planfix instance. The API key points at Ringostat production.**

- Allowed against prod: read operations; **creating** clearly-marked test records.
- FORBIDDEN: updating or deleting any record the current test run did not itself create.
- All live testing follows the protocol in `docs/TESTING.md` (three layers: mocked unit tests → MCP Inspector → gated live tests in the dedicated MCP-TEST project).
- Safe-mode guard (`PLANFIX_SAFE_MODE`) is specified in `docs/TESTING.md` § Safe mode — implement/respect it in every mutating tool.

## ⚠️ CRITICAL: stdio protocol hygiene

stdout is reserved exclusively for JSON-RPC frames. **Never `console.log` to stdout** — it corrupts the MCP stream ("Unexpected token" errors in clients). Debug output goes to stderr (`console.error`).

## Tool design conventions (Anthropic guidance, distilled)

Sources: [Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents), [anthropics/skills → mcp-builder](https://github.com/anthropics/skills/tree/main/skills/mcp-builder).

1. **Naming**: snake_case, action verb first (`get_`, `list_`, `search_`, `create_`, `update_`), consistent with the existing 20 tools. Prefer search-shaped tools over list-everything tools.
2. **Consolidate, don't wrap**: model tools on real workflows (one composite tool can beat three chained CRUD calls). Fewer, more thoughtful tools > full API coverage.
3. **Descriptions**: write for a new hire — what it does, when to use it, when NOT to, expected input formats with an example. Descriptions must match actual behavior exactly.
4. **Schemas**: Zod on every input; unambiguous parameter names (`task_id`, not `id` where ambiguous); validate sizes/ranges.
5. **Annotations**: declare `readOnlyHint` / `destructiveHint` / `idempotentHint` on every tool. Hints, not security — the safe-mode guard is the real gate.
6. **Responses**: high-signal only. Human-readable names alongside IDs; readable timestamps; sensible pagination defaults (20–50 items) with `has_more` + next offset; on truncation, tell the agent how to narrow the query.
7. **Errors**: actionable messages inside the tool result (what was wrong + how to fix, e.g. "unknown field X — call list_custom_fields first"). Never leak internal details or secrets.
8. **Evaluate with real tasks**: after tool changes, run realistic multi-step tasks through Claude and read the transcripts — where the agent stumbles is where the tool description or shape is wrong.

## Definition of done for any change

1. `npm run build` passes.
2. `npm test` passes (extend tests for new/changed tools — mocked, per `tests/` patterns).
3. New/changed tool verified in MCP Inspector (schema renders, call round-trips).
4. Live verification only per `docs/TESTING.md` protocol.
5. Commit; do not push secrets, `.env`, or `dist/` beyond what upstream tracks.
