# Spike: file attachments — upload from disk & attach to comments/tasks (ROADMAP P12)

Date: 2026-07-28. Executor: developer session (Claude Code). Writes per docs/TESTING.md:
ONE probe task created inside MCP-Test (572465); every upload/attach targeted only that
task; file reads/downloads only on files this run uploaded. Raw shapes below for every
claim.

## Verdict

Everything the friction needs works, in one round-trip each:

1. **Multipart upload from disk works** (`POST /file/`, form field `file`) — small text
   and a 2 MB binary with a **Cyrillic filename** both round-trip cleanly.
2. **All three attach surfaces work**: `files: [{id}]` in the comment-create body,
   `files: [{id}]` in the task-update body, and the dedicated
   `POST /file/{id}/attach/task?id=<taskId>`. **One uploaded file can be attached to
   multiple comments** (verified: same fileId on two comments, both read back with it).
3. **Read-backs are clean**: `GET /task/{id}/files`, comment lists with `files` in
   `fields`, and `GET /file/{id}?fields=id,name,size,downloadUrl,link` — `downloadUrl`
   is a **presigned S3 URL with an expiry** (usable immediately, not storable).
4. **`file/from-url/` works for general URLs** but rejected `https://planfix.com/…`
   with `code 41 "Unsafe url for downloading file"` (own-domain/SSRF guard) — the
   existing `upload_file_from_url` tool inherits this behavior.

## Q1 — upload from disk (evidence)

Request: `POST /file/` as `multipart/form-data`, single required binary field **`file`**
(swagger-confirmed). Node implementation used: `FormData` + `new Blob([buffer])` +
explicit filename — no extra dependency needed on Node ≥18.

| Upload | Request | Response |
|---|---|---|
| 55-byte UTF-8 text, ASCII filename | `form.append("file", blob, "mcp-test-small.txt")` | `200 {"result":"success","id":1729843}` |
| 2,097,152-byte binary, **Cyrillic filename** | `form.append("file", blob, "тест-файл-2мб.bin")` | `200 {"result":"success","id":1729845}` |

- No ceiling hunted (per brief); 2 MB is comfortably in.
- **`size` in every read surface is KILOBYTES, rounded up**: the 55-byte file reads
  `size: 1`, the 2 MB file `size: 2048`. Render as KB, do not mislabel as bytes.
- Windows pitfalls observed: none — `fs.readFileSync` takes `W:\…` paths natively; the
  multipart `filename` must be the **basename** (pass it explicitly; `path.basename`
  handles backslashes on Windows); the Cyrillic name survived into `name` and the
  S3 `downloadUrl` (percent-encoded).

## Q2 — attach semantics (evidence, all on probe task 576633)

| Surface | Request | Response |
|---|---|---|
| (a) comment create | `POST /task/576633/comments/ {description, files: [{id: 1729843}]}` | `201 {"result":"success","id":47922723}` |
| (a2) SAME file, second comment | same body, new comment | `201 {"result":"success","id":47922725}` — re-attach allowed; both comments read back with file 1729843 |
| (b) task card via update body | `POST /task/576633 {files: [{id: 1729845}]}` | `200 {"result":"success"}` |
| (b2) task card via dedicated endpoint | `POST /file/1729843/attach/task?id=576633` (no body; task id is a QUERY param also named `id`) | `200 {"result":"success"}` |
| (c) URL upload | `POST /file/from-url/ {name, url}` | planfix.com URL → `400 code 41 "Unsafe url for downloading file"`; raw.githubusercontent.com / example.com / google.com robots.txt → `200 success` (ids 1729847/1729849/1729851). URL-uploaded files attach exactly like disk-uploaded ones (attach endpoint verified on all three) |

Also: `TaskCreateRequest` carries the same `files: [{id}]` array (swagger) — attaching
at task creation is available if ever needed; not live-probed (update path covers the
mechanism).

## Q3 — read-back surfaces (evidence)

- `GET /task/{id}/files` → `{"result":"success","files":[{"id":1729843,"size":1,"name":"mcp-test-small.txt"},{"id":1729845,"size":2048,"name":"тест-файл-2мб.bin"}]}`.
- `POST /task/{id}/comments/list` with `fields: "id,description,files"` → each comment
  carries `files: [{id, size, name}]`. (The fork's current default `COMMENT_FIELDS`
  omits `files` — a render/fields addition is part of the design below.)
- `GET /file/{id}?fields=id,name,size,downloadUrl,link` → metadata + `downloadUrl`:
  presigned S3 (`X-Amz-Expires` present) — valid temporarily; fetch fresh each time,
  never store. `link` is for online documents (empty for uploaded binaries).
- `GET /file/{id}/download` → the raw bytes (verified: 55 bytes, `text/plain`, matches
  the local file exactly).

## Proposed tool design (for review BEFORE implementation — not built)

1. **`add_comment` gains an optional `files` param**: array of items, each EITHER an
   absolute local path (string) OR an existing Planfix fileId (number), max ~10 per
   call. Flow: safe-mode `assertTaskInTestProject` FIRST → local-path validation
   (absolute, exists, is a file — clear English refusals; directory/missing named
   explicitly) → size guard (refuse > 50 MB per file, limit stated in the message;
   spike verified 2 MB, ceiling deliberately not hunted) → multipart upload each path
   (basename as filename; contents never logged) → comment create with
   `files: [{id}, …]`. Ack lists uploaded fileIds + comment id. Because the task gate
   runs before any upload, **no upload can happen without a resolvable target** —
   the target-less `upload_file_from_url` guard stays untouched.
2. **`attach_file_to_task`** (composite, additive write): `{taskId REQUIRED, source:
   localPath | url | fileId (exactly one), name?}` → upload if needed (disk = multipart;
   url = `file/from-url/`, documenting code 41 as a known refusal for some domains,
   e.g. planfix.com itself) → attach to the task CARD via
   `POST /file/{id}/attach/task?id=`. Covers "put this document on the task"; comments
   stay `add_comment`'s job. `upload_file_from_url` gets a description note pointing
   here (deprecation candidate — kept for backward compatibility, still refused
   entirely in safe mode).
3. **Read side**: add `files` to the comment fields fetched by `get_comments` /
   `get_task_full` and render `file: name (#id, N KB)` segments; `get_file` gains
   `downloadUrl` in its default fields with an "expires — fetch fresh" note in the
   description. Sizes rendered as **KB** (API unit, verified).
4. Annotations: both writes `ADDITIVE_WRITE`; read changes stay read-only. Unit tests
   mock the multipart call and assert the form field name (`file`), filename
   (basename, Cyrillic-safe), size-guard refusal, path refusals, and the
   files-array body shape; no org-specific anything in code.

Rejected:
- Loosening the safe-mode refusal of target-less uploads (explicit brief constraint).
- Attaching at `create_task` time — mechanism exists (swagger) but no observed
  friction; add later if the workflow appears.
- A generic file-download tool returning file CONTENTS through MCP — token hazard;
  `get_file`'s `downloadUrl` covers agent-side inspection.

## Probe-artifact inventory (Layer 3 rule 5 — leave auditable, batch-clean from UI)

- Task `576633` "[MCP-TEST] P12 spike: file attach probe" in project 572465.
- Files (all attached to that task): `1729843` mcp-test-small.txt (also on comments
  `47922723`, `47922725`), `1729845` тест-файл-2мб.bin (2 MB), and the three
  from-url probes `1729847` readme.md / `1729849` example.html / `1729851` robots.txt
  (attached to the card post-hoc to keep them discoverable).
- Local scratch files live in the session scratchpad (auto-cleaned).

## Open questions

1. The 50 MB tool-side cap is a proposal, not an API fact — the real ceiling was
   deliberately not probed; the reviewing session may pick a different number.
2. `file/from-url/` code-41 scope (which domains trigger it) — characterized only as
   "planfix.com blocked, three common external hosts fine"; document as-is, no fix.
