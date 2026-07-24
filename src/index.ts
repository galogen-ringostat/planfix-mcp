#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createServer } from "node:http";

import { getTasksSchema, handleGetTasks, getTaskSchema, handleGetTask, createTaskSchema, handleCreateTask, updateTaskSchema, handleUpdateTask, getTaskFullSchema, handleGetTaskFull, searchTasksSchema, handleSearchTasks, getTaskChildrenSchema, handleGetTaskChildren } from "./tools/tasks.js";
import { getContactsSchema, handleGetContacts, getContactSchema, handleGetContact, createContactSchema, handleCreateContact, updateContactSchema, handleUpdateContact } from "./tools/contacts.js";
import { getProjectsSchema, handleGetProjects, getProjectSchema, handleGetProject } from "./tools/projects.js";
import { getCommentsSchema, handleGetComments, addCommentSchema, handleAddComment } from "./tools/comments.js";
import { listUsersSchema, handleListUsers, getUserSchema, handleGetUser } from "./tools/users.js";
import { listDirectoriesSchema, handleListDirectories, listDirectoryEntriesSchema, handleListDirectoryEntries } from "./tools/directories.js";
import { listCustomFieldsSchema, handleListCustomFields } from "./tools/customfields.js";
import { listDatatagsSchema, handleListDatatags } from "./tools/datatags.js";
import { uploadFileFromUrlSchema, handleUploadFileFromUrl, getFileSchema, handleGetFile } from "./tools/files.js";
import { addTimeEntrySchema, handleAddTimeEntry, getTaskTimeEntriesSchema, handleGetTaskTimeEntries, logWorkdaySchema, handleLogWorkday } from "./tools/timeentries.js";
import { getTaskChecklistSchema, handleGetTaskChecklist, addChecklistItemSchema, handleAddChecklistItem, setChecklistItemDoneSchema, handleSetChecklistItemDone } from "./tools/checklists.js";
import { skillMyTasks, skillCreateTask } from "./skills.js";

const VERSION = "1.2.0";

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;
const ADDITIVE_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false } as const;
// update_* overwrite prior field values — per MCP semantics (destructiveHint:
// false = "only additive updates") that is destructive; the same payload still
// converges to the same state, so idempotent.
const IDEMPOTENT_UPDATE = { readOnlyHint: false, destructiveHint: true, idempotentHint: true } as const;

export function createPlanfixServer(): McpServer {
  const server = new McpServer({
    name: "planfix-mcp",
    version: VERSION,
  });

  const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

  server.registerTool(
    "get_tasks",
    {
      description:
        "List Planfix tasks with pagination and raw Planfix filters. " +
        "Use it to page through tasks when no specific search criteria exist; for criteria-driven discovery prefer search_tasks. " +
        'Set response_format: "CONCISE" for identifier-grade rows (id, name, status) when you only need IDs for a follow-up call. ' +
        'Input example: { pageSize: 50, offset: 0 }.',
      inputSchema: getTasksSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetTasks(params)),
  );

  server.registerTool(
    "get_task",
    {
      description:
        "Get one task by ID (name, description, status, priority, assignees, project, dates). " +
        "Use get_task_full instead when you also need the task's comments. " +
        'Set response_format: "CONCISE" for an identifier-grade line (id, name, status) when you only need to confirm the task for a follow-up call. ' +
        "Input example: { taskId: 123 }.",
      inputSchema: getTaskSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetTask(params)),
  );

  server.registerTool(
    "create_task",
    {
      description:
        "Create a new task in Planfix. " +
        "Find assigneeId via list_users and projectId via get_projects first. " +
        'Input example: { name: "Prepare report", projectId: 45, assigneeId: 403 }.',
      inputSchema: createTaskSchema.shape,
      annotations: ADDITIVE_WRITE,
    },
    async (params) => text(await handleCreateTask(params)),
  );

  server.registerTool(
    "update_task",
    {
      description:
        "Update an existing task: name, description, status, and/or assignee. Only the provided fields change. " +
        "Status IDs come from list_directory_entries on the relevant status set. " +
        "Input example: { taskId: 123, status: 2 }.",
      inputSchema: updateTaskSchema.shape,
      annotations: IDEMPOTENT_UPDATE,
    },
    async (params) => text(await handleUpdateTask(params)),
  );

  server.registerTool(
    "get_contacts",
    {
      description:
        "List Planfix contacts with pagination and an optional saved filter. " +
        "Use get_contact when you already know the contact ID. " +
        'Set response_format: "CONCISE" for identifier-grade rows (id, name) when you only need IDs for a follow-up call. ' +
        "Input example: { pageSize: 50 }.",
      inputSchema: getContactsSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetContacts(params)),
  );

  server.registerTool(
    "get_contact",
    {
      description:
        "Get one contact by ID (name, email, phones, company). " +
        "Input example: { contactId: 7 }.",
      inputSchema: getContactSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetContact(params)),
  );

  server.registerTool(
    "get_projects",
    {
      description:
        "List Planfix projects (id, name, status). " +
        "Use it to find a projectId for create_task or search_tasks. " +
        "Input example: {}.",
      inputSchema: getProjectsSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetProjects(params)),
  );

  server.registerTool(
    "get_project",
    {
      description:
        "Get one project by ID (name, description, status). " +
        "Input example: { projectId: 45 }.",
      inputSchema: getProjectSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetProject(params)),
  );

  server.registerTool(
    "get_comments",
    {
      description:
        "List a task's comments with pagination (author, timestamp, text). " +
        "Use get_task_full when you need the task card and its comments in one call. " +
        "Input example: { taskId: 123, pageSize: 50 }.",
      inputSchema: getCommentsSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetComments(params)),
  );

  server.registerTool(
    "add_comment",
    {
      description:
        "Add a comment to a task. " +
        "Do NOT use it for time logging — that is add_time_entry. " +
        'Input example: { taskId: 123, body: "Status update: done." }.',
      inputSchema: addCommentSchema.shape,
      annotations: ADDITIVE_WRITE,
    },
    async (params) => text(await handleAddComment(params)),
  );

  server.registerTool(
    "create_contact",
    {
      description:
        "Create a contact (or a company, with isCompany: true) in Planfix. " +
        'Input example: { name: "Acme Ltd", email: "info@acme.com", isCompany: true }.',
      inputSchema: createContactSchema.shape,
      annotations: ADDITIVE_WRITE,
    },
    async (params) => text(await handleCreateContact(params)),
  );

  server.registerTool(
    "update_contact",
    {
      description:
        "Update a contact's name, email, and/or phone. Only the provided fields change. " +
        "Input example: { contactId: 7, email: \"new@acme.com\" }.",
      inputSchema: updateContactSchema.shape,
      annotations: IDEMPOTENT_UPDATE,
    },
    async (params) => text(await handleUpdateContact(params)),
  );

  server.registerTool(
    "list_users",
    {
      description:
        "List Planfix employees (id, name, email, position). " +
        "Use it to resolve a person's name to the numeric ID required by create_task, update_task, search_tasks, and add_time_entry. " +
        "Input example: {}.",
      inputSchema: listUsersSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleListUsers(params)),
  );

  server.registerTool(
    "get_user",
    {
      description:
        "Get one employee by ID (name, email, position). " +
        "Input example: { userId: 403 }.",
      inputSchema: getUserSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetUser(params)),
  );

  server.registerTool(
    "list_directories",
    {
      description:
        "List Planfix directories — custom task status sets are stored as directories. " +
        "Follow up with list_directory_entries to see a directory's values. " +
        "Input example: {}.",
      inputSchema: listDirectoriesSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleListDirectories(params)),
  );

  server.registerTool(
    "list_directory_entries",
    {
      description:
        "List the entries of a directory by its ID — e.g. the status options usable as update_task's status. " +
        "Find the directoryId via list_directories first. " +
        "Input example: { directoryId: 3 }.",
      inputSchema: listDirectoryEntriesSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleListDirectoryEntries(params)),
  );

  server.registerTool(
    "list_custom_fields",
    {
      description:
        "List the custom fields configured for an object type (task, contact, project, user, or main). " +
        "Use it to discover field IDs before reading or writing custom field values. " +
        'Input example: { objectType: "task" }.',
      inputSchema: listCustomFieldsSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleListCustomFields(params)),
  );

  server.registerTool(
    "list_datatags",
    {
      description:
        "List Planfix data tags (analytics definitions: id, name, group). " +
        "For reading or writing time entries use get_task_time_entries / add_time_entry instead. " +
        "Input example: {}.",
      inputSchema: listDatatagsSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleListDatatags(params)),
  );

  server.registerTool(
    "upload_file_from_url",
    {
      description:
        "Upload a file to Planfix from a direct URL (no multipart upload from disk). " +
        'Input example: { url: "https://example.com/report.pdf", name: "report.pdf" }.',
      inputSchema: uploadFileFromUrlSchema.shape,
      annotations: ADDITIVE_WRITE,
    },
    async (params) => text(await handleUploadFileFromUrl(params)),
  );

  server.registerTool(
    "get_file",
    {
      description:
        "Get a file's metadata by ID (name, size). " +
        "Input example: { fileId: 9 }.",
      inputSchema: getFileSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetFile(params)),
  );

  server.registerTool(
    "get_task_full",
    {
      description:
        "Get a task together with its comments in a single call (equivalent to get_task + get_comments). " +
        "Use it when you need both the task card and its discussion — e.g. syncing a task mirror. " +
        "Use get_task when comments are not needed, or get_comments with offset to page through older comments. " +
        'Set response_format: "CONCISE" to trim output to identifiers (task id/name/status; comment ids, authors, dates without text). ' +
        "Input example: { taskId: 123, commentsLimit: 30 }.",
      inputSchema: getTaskFullSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetTaskFull(params)),
  );

  server.registerTool(
    "search_tasks",
    {
      description:
        "Search tasks by filters (AND-combined): name substring (nameContains), assignee (assigneeId), " +
        "status (statusId), project (projectId), changed or commented after a date (updatedSince, ISO YYYY-MM-DD). " +
        "At least one filter is required; to page through all tasks unfiltered use get_tasks. " +
        "Prefer search_tasks over paging get_tasks when looking for specific tasks. " +
        'Input example: { nameContains: "report", projectId: 572465, updatedSince: "2026-07-01" }.',
      inputSchema: searchTasksSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleSearchTasks(params)),
  );

  server.registerTool(
    "add_time_entry",
    {
      description:
        'Log time spent on a task (the "Time spent" analytic). ' +
        "Logging convention: ONE comment per logging period holding several entries. " +
        "Make the first call without commentId — Planfix creates a new logging-period comment; " +
        "take commentId from the result and pass it on subsequent calls so entries land on the same comment. " +
        "Before the first call, check get_task_time_entries for an existing period comment. " +
        'Input example: { taskId: 123, date: "2026-07-24", timeFrom: "10:00", timeTo: "10:30", type: "Task", comment: "text edits", userId: 403 }.',
      inputSchema: addTimeEntrySchema.shape,
      annotations: ADDITIVE_WRITE,
    },
    async (params) => text(await handleAddTimeEntry(params)),
  );

  server.registerTool(
    "get_task_time_entries",
    {
      description:
        'Get a task\'s logged time entries (the "Time spent" analytic): key, date, interval, duration, employee, type, comment, commentId. ' +
        "Use it before add_time_entry to find an existing logging-period comment (commentId) instead of spawning new comments. " +
        "Input example: { taskId: 123 }.",
      inputSchema: getTaskTimeEntriesSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetTaskTimeEntries(params)),
  );

  server.registerTool(
    "get_task_children",
    {
      description:
        "List the DIRECT subtasks of a parent task (one level only — no recursive tree walk; recurse by calling it again on a child if needed). " +
        "Use it to discover task hierarchy, e.g. finding the subtasks where time is logged. " +
        "Not for comments (get_task_full) or criteria search (search_tasks). " +
        'Set response_format: "CONCISE" for identifier-grade rows (id, name, status). ' +
        "Input example: { taskId: 123 }.",
      inputSchema: getTaskChildrenSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetTaskChildren(params)),
  );

  server.registerTool(
    "log_workday",
    {
      description:
        "Log a whole working day of time entries in one validated call (composite over add_time_entry). " +
        "The day is validated BEFORE anything is written: intervals must be well-formed and non-overlapping across the whole day (regardless of task). " +
        "The REQUIRED exclusions array (no default) lists the day's no-work windows (lunch, meetings, breaks): every logged interval is cut around every window, " +
        "splitting it into segments marked with the window's label; an interval left with nothing to log is rejected; pass [] to log straight through. " +
        "Any violation refuses the entire day; nothing is partially written. " +
        "Writes one comment per task per call: the task's first entry opens the comment, the rest chain onto it via commentId. " +
        "Set validate_only: true to preview the resolved plan (post-split segments, applied windows, per-task and day totals) with zero writes — RECOMMENDED before the real run. " +
        "If a write fails mid-run the tool stops, reports exactly what was written (entries cannot be rolled back) and what was not, and never retries. " +
        'Input example: { date: "2026-07-24", userId: 403, entries: [{ taskId: 123, timeFrom: "09:00", timeTo: "18:00", type: "Task", comment: "feature work" }], ' +
        'exclusions: [{ timeFrom: "13:00", timeTo: "13:45", label: "lunch" }], validate_only: true }.',
      inputSchema: logWorkdaySchema.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async (params) => ({ content: [{ type: "text", text: await handleLogWorkday(params) }] }),
  );

  server.registerTool(
    "get_task_checklist",
    {
      description:
        "List a task's checklist items: id, text, checked state [x]/[ ], assignees when present. " +
        "Items come in creation order (the API has no ordering control). " +
        "Use it before set_checklist_item_done to find the itemId, and instead of asking the operator to paste the checklist. " +
        "Input example: { taskId: 123 }.",
      inputSchema: getTaskChecklistSchema.shape,
      annotations: READ_ONLY,
    },
    async (params) => text(await handleGetTaskChecklist(params)),
  );

  server.registerTool(
    "add_checklist_item",
    {
      description:
        "Add an item to a task's checklist. The item is appended at the end (creation order only — no mid-list insertion, no nesting: " +
        "the API accepts no parent on create), and items CANNOT be deleted via the API — only renamed or (un)checked. " +
        'Input example: { taskId: 123, name: "Review the draft", assigneeId: 403 }.',
      inputSchema: addChecklistItemSchema.shape,
      annotations: ADDITIVE_WRITE,
    },
    async (params) => text(await handleAddChecklistItem(params)),
  );

  server.registerTool(
    "set_checklist_item_done",
    {
      description:
        "Check or uncheck a task's checklist item. isDone is required and explicit (true = checked, false = unchecked) — there is no toggle, " +
        "so re-running the same call is safe. Find the itemId with get_task_checklist first. Items cannot be deleted via the API. " +
        "Input example: { taskId: 123, itemId: 456, isDone: true }.",
      inputSchema: setChecklistItemDoneSchema.shape,
      annotations: IDEMPOTENT_UPDATE,
    },
    async (params) => text(await handleSetChecklistItemDone(params)),
  );

  skillMyTasks(server);
  skillCreateTask(server);

  return server;
}

async function startHttpServer(port: number): Promise<void> {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", version: VERSION }));
      return;
    }

    if (url.pathname !== "/mcp") {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "POST" || req.method === "GET" || req.method === "DELETE") {
      let transport: StreamableHTTPServerTransport;

      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
      } else if (req.method === "POST" && !sessionId) {
        transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => crypto.randomUUID() });
        const server = createPlanfixServer();
        await server.connect(transport);

        transport.onclose = () => {
          const sid = transport.sessionId;
          if (sid) transports.delete(sid);
        };

        await transport.handleRequest(req, res);

        const newSid = res.getHeader("mcp-session-id") as string | undefined;
        if (newSid) transports.set(newSid, transport);
        return;
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "No valid session" }));
        return;
      }

      await transport.handleRequest(req, res);
    } else {
      res.writeHead(405);
      res.end("Method not allowed");
    }
  });

  httpServer.listen(port, () => {
    console.error(`[planfix-mcp] HTTP server on http://localhost:${port}/mcp`);
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const httpIndex = args.indexOf("--http");

  if (httpIndex !== -1) {
    const port = parseInt(args[httpIndex + 1] ?? "8080", 10);
    await startHttpServer(port);
  } else {
    const server = createPlanfixServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[planfix-mcp] v${VERSION} started. 29 tools, 2 skills. Stdio.`);
  }
}

main().catch((error) => {
  console.error("[planfix-mcp] Error:", error);
  process.exit(1);
});
