# planfix-mcp — Ringostat fork

MCP server (stdio) for the [Planfix REST API v2](https://help.planfix.com/restapidocs/). **36 tools, 2 prompt skills.** TypeScript + `@modelcontextprotocol/sdk` + Zod; all HTTP mocked in tests.

This is a private working fork of [theYahia/planfix-mcp](https://github.com/theYahia/planfix-mcp) (MIT), grown friction-first for Ringostat's RevOps workflows. It is **not published to npm** (`private: true`); the upstream package `@theyahia/planfix-mcp` is a different, smaller server. Development history lives in [`docs/ROADMAP.md`](docs/ROADMAP.md); API behavior evidence in [`docs/spikes/`](docs/spikes/).

## Install (local)

```bash
git clone https://github.com/galogen-ringostat/planfix-mcp.git
cd planfix-mcp
npm install
npm run build   # → dist/
```

MCP config (Claude Code / Claude Desktop — placeholders, never commit real values):

```json
{
  "mcpServers": {
    "planfix": {
      "command": "node",
      "args": ["<path-to-repo>/dist/index.js"],
      "env": {
        "PLANFIX_ACCOUNT": "<your-account-subdomain>",
        "PLANFIX_API_KEY": "<your-rest-api-key>"
      }
    }
  }
}
```

Optional env: `PLANFIX_HOST` (host suffix, default `planfix.com`); `PLANFIX_SAFE_MODE=1` + `PLANFIX_TEST_PROJECT_ID=<id>` confine every mutating tool to the dedicated test project — see [`docs/TESTING.md`](docs/TESTING.md) (three-layer protocol; there is no test Planfix instance, so the safe-mode guard is deterministic code, not discipline).

## Tools (36)

**Tasks** — `get_tasks`, `get_task`, `get_task_full` (task + comments in one call), `search_tasks` (name/assignee/status/project/updated-since/List-custom-field filters), `get_task_children`, `create_task`, `update_task`.

**Projects** — `get_projects`, `get_project`, `search_projects` (name-contains / active-only / group / owner), `get_project_overview` (status label + task aggregates + recency signal).

**Comments & files** — `get_comments`, `add_comment` (optional file attachments: local paths and/or file ids), `attach_file_to_task` (localPath | url | fileId → task card), `get_file` (metadata + expiring downloadUrl), `upload_file_from_url` (target-less; prefer the two tools above).

**Time tracking** — `add_time_entry`, `get_task_time_entries`, `log_workday` (validated day composite with required exclusions), `get_time_report` (cross-task per-person totals + unlogged days).

**Custom fields & planning** — `list_custom_fields`, `set_task_custom_field` (enum-validated, read-back-verified), `add_estimation` (workday-layout chunking, APPEND semantics).

**Checklists** — `get_task_checklist`, `add_checklist_item`, `set_checklist_item_done`, `update_checklist_item_name` (the API has no item delete).

**Directory data** — `list_users`, `get_user`, `get_contacts`, `get_contact`, `create_contact`, `update_contact`, `list_directories`, `list_directory_entries`, `list_datatags`.

Conventions: read tools carry `readOnlyHint`; list tools return exact `has_more` + next-offset hints; capped scans report `N+` lower bounds explicitly; all server-authored text is English (data passes through in its source language); errors are actionable (what was wrong + which tool fixes it). Mutating calls never retry 5xx/timeouts (double-write protection); rate-limit retries stay.

## Development

```bash
npm run dev     # run from source (tsx, stdio)
npm test        # vitest, all HTTP mocked
npm run build   # required after every change — the live config runs dist/
npx @modelcontextprotocol/inspector node dist/index.js
```

See [`CLAUDE.md`](CLAUDE.md) for working conventions and [`docs/audit-2026-07.md`](docs/audit-2026-07.md) for the latest codebase audit.

## License & attribution

MIT (see [LICENSE](LICENSE)). Forked from [theYahia/planfix-mcp](https://github.com/theYahia/planfix-mcp) by [@theYahia](https://github.com/theYahia); upstream attribution and license kept intact. The upstream `CHANGELOG.md` is frozen at the fork point — fork history is tracked in [`docs/ROADMAP.md`](docs/ROADMAP.md).
