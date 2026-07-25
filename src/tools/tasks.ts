import { z } from "zod";
import { planfixPost, planfixGet } from "../client.js";
import { formatTaskList, formatSingleTask, formatCreated, formatUpdated, formatTaskFull, formatTaskSearchList } from "../format.js";
import { postListPage } from "../paging.js";
import { assertCreateTaskAllowed, assertTaskInTestProject } from "../safemode.js";

// Without an explicit `fields` Planfix returns near-empty (id-only) objects,
// so a meaningful field set is always requested.
const TASK_FIELDS = "id,name,description,status,priority,assignees,project,startDateTime,endDateTime";

// response_format: "CONCISE" — identifier-grade output for flows that only
// need ids for a follow-up call. Overrides `fields` and trims rendering.
const CONCISE_TASK_FIELDS = "id,name,status";
const responseFormatSchema = z.enum(["CONCISE", "DETAILED"]).optional()
  .describe("DETAILED (default): full fields. CONCISE: identifier-grade rows only (id, name, status); overrides `fields`. Pick CONCISE when you only need IDs for a follow-up call");

// Ad-hoc Planfix filter: { type, operator, value, field? } (combined with AND).
// `field` is required by the API for custom-field filter types (101–117) and
// was previously missing from this schema — Zod stripped it silently, making
// custom-field filtering impossible (P9 fix).
const filterSchema = z.object({
  type: z.number().describe("Filter type (Planfix numeric code, e.g. 8 — task name, 51 — template, 106 — List custom field)"),
  operator: z.string().describe("Comparison operator, e.g. 'equal', 'gt', 'lt'"),
  value: z.unknown().describe("Filter value"),
  field: z.number().int().positive().optional()
    .describe("Custom field ID — required for custom-field filter types (101-117). Find field IDs with list_custom_fields"),
});

const FIELDS_CUSTOM_HINT =
  "To include custom fields, append their NUMERIC ids (e.g. \"id,name,22571\") — " +
  "the literal word \"customFieldData\" is silently ignored by the API. Discover ids with list_custom_fields";

export const getTasksSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Tasks per page (default 100, API max 100)"),
  filterId: z.union([z.string(), z.number()]).optional().describe("ID of a saved task filter (see /task/filters)"),
  filters: z.array(filterSchema).optional().describe("Array of ad-hoc filters for arbitrary filtering"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${TASK_FIELDS}). ${FIELDS_CUSTOM_HINT}`),
  response_format: responseFormatSchema,
});

export async function handleGetTasks(params: z.infer<typeof getTasksSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  const concise = params.response_format === "CONCISE";
  const { resp, hasMore } = await postListPage("task/list", {
    fields: concise ? CONCISE_TASK_FIELDS : params.fields ?? TASK_FIELDS,
    ...(params.filterId !== undefined ? { filterId: String(params.filterId) } : {}),
    ...(params.filters ? { filters: params.filters } : {}),
  }, ["tasks"], offset, pageSize);
  return formatTaskList(resp, pageSize, offset, hasMore, concise);
}

export const getTaskSchema = z.object({
  taskId: z.number().describe("Task ID"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${TASK_FIELDS}). ${FIELDS_CUSTOM_HINT}`),
  response_format: responseFormatSchema,
});

export async function handleGetTask(params: z.infer<typeof getTaskSchema>): Promise<string> {
  const concise = params.response_format === "CONCISE";
  const result = await planfixGet(`task/${params.taskId}`, {
    fields: concise ? CONCISE_TASK_FIELDS : params.fields ?? TASK_FIELDS,
  });
  return formatSingleTask(result, concise);
}

export const createTaskSchema = z.object({
  name: z.string().describe("Task name"),
  description: z.string().optional().describe("Task description"),
  projectId: z.number().optional().describe("Project ID"),
  assigneeId: z.number().optional().describe("Assignee (employee) ID. Find it with the list_users tool"),
  // NOTE: priority is a string, but the exact allowed values are not verified
  // against the live API. Passed through as-is.
  priority: z.string().optional().describe("Task priority (string). Allowed values not verified against the live API"),
});

export async function handleCreateTask(params: z.infer<typeof createTaskSchema>): Promise<string> {
  assertCreateTaskAllowed(params.projectId);
  const body: Record<string, unknown> = { name: params.name };
  if (params.description) body.description = params.description;
  if (params.projectId) body.project = { id: params.projectId };
  // Planfix expects PeopleRequest: { users: [{ id: "user:<N>" }] } — the id is a prefixed string.
  if (params.assigneeId) body.assignees = { users: [{ id: `user:${params.assigneeId}` }] };
  if (params.priority) body.priority = params.priority;

  const result = await planfixPost("task/", body);
  return formatCreated("Task", result);
}

export const updateTaskSchema = z.object({
  taskId: z.number().describe("Task ID"),
  name: z.string().optional().describe("New name"),
  description: z.string().optional().describe("New description"),
  status: z.number().optional().describe("New status ID"),
  assigneeId: z.number().optional().describe("New assignee ID (see list_users)"),
});

export async function handleUpdateTask(params: z.infer<typeof updateTaskSchema>): Promise<string> {
  await assertTaskInTestProject("update_task", params.taskId);
  const body: Record<string, unknown> = {};
  if (params.name) body.name = params.name;
  if (params.description) body.description = params.description;
  if (params.status) body.status = { id: params.status };
  if (params.assigneeId) body.assignees = { users: [{ id: `user:${params.assigneeId}` }] };

  // Planfix responds with an empty body (200 — applied, 202 — queued);
  // the acknowledgement is built from taskId.
  await planfixPost(`task/${params.taskId}`, body);
  return formatUpdated("Task", params.taskId);
}

// ── get_task_full — task + comments in one call (read-only) ──────────────────

const COMMENT_FIELDS = "id,dateTime,owner,description";
const DEFAULT_COMMENTS_LIMIT = 30;

export const getTaskFullSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  commentsLimit: z.number().int().min(1).max(100).optional()
    .describe(`Maximum comments in the response (default ${DEFAULT_COMMENTS_LIMIT}, max 100)`),
  fields: z.string().optional().describe(`Comma-separated task field list (default: ${TASK_FIELDS}). ${FIELDS_CUSTOM_HINT}`),
  response_format: responseFormatSchema,
});

const CONCISE_COMMENT_FIELDS = "id,dateTime,owner";

export async function handleGetTaskFull(params: z.infer<typeof getTaskFullSchema>): Promise<string> {
  const limit = params.commentsLimit ?? DEFAULT_COMMENTS_LIMIT;
  const concise = params.response_format === "CONCISE";
  const [taskResp, comments] = await Promise.all([
    planfixGet(`task/${params.taskId}`, { fields: concise ? CONCISE_TASK_FIELDS : params.fields ?? TASK_FIELDS }),
    postListPage(
      `task/${params.taskId}/comments/list`,
      { fields: concise ? CONCISE_COMMENT_FIELDS : COMMENT_FIELDS },
      ["comments"], 0, limit,
    ),
  ]);
  return formatTaskFull(taskResp, comments.resp, { taskId: params.taskId, limit, hasMore: comments.hasMore, concise });
}

// ── search_tasks — filtered discovery (read-only) ─────────────────────────────

// Planfix complex task filter mapping
// (https://planfix.com/help/REST_API:_Complex_task_filters):
//   type 8  — task name; operator "equal" means "contains" for string values
//   type 2  — assignee;  value is the prefixed string "user:<id>"
//   type 10 — status;    value is the numeric status id
//   type 5  — project;   value is the numeric project id
//   type 106 — List custom field; requires the extra `field` key (custom
//             field id); value is the option's string label, exact match
//             (verified live 2026-07-26: field 22571 value "Sprint 4 - 2026"
//             matched its tasks; a nonexistent label matched zero).
//             Custom-field types are 101-117 by field type (106 = List);
//             search_tasks sugars ONLY the List case — the observed friction
//             (Sprint/Status/Priority/Complexity) is all List fields; other
//             types go through get_tasks ad-hoc filters with `field`.
//   type 79 — date of latest change OR comment; operator "gt",
//             value { dateType: "otherDate", dateValue: "DD-MM-YYYY" }
//             Type 79 over type 38 ("latest change" only) is deliberate: the
//             primary consumer is the task-mirror sync, where a new comment
//             must count as task activity — type 38 misses comment-only
//             activity. The `dateValue` field name was verified live against
//             production (boundary test 2026-07-24: 2026-07-23 matches,
//             2026-07-25 empty); the docs' "dateFrom" is wrong or an
//             alternative.
// Filters combine with AND.

const SEARCH_FIELDS = "id,name,status,assignees,project";
const DEFAULT_SEARCH_PAGE_SIZE = 50;

export const searchTasksSchema = z.object({
  nameContains: z.string().min(1).optional().describe("Substring of the task name"),
  assigneeId: z.number().int().positive().optional().describe("Assignee (employee) ID. Find it with the list_users tool"),
  statusId: z.number().int().positive().optional().describe("Task status ID"),
  projectId: z.number().int().positive().optional().describe("Project ID"),
  updatedSince: z.string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "updatedSince must be an ISO date in YYYY-MM-DD format, e.g. 2026-07-01")
    .optional()
    .describe("Only tasks changed or commented after this date (ISO, YYYY-MM-DD)"),
  customField: z.object({
    fieldId: z.number().int().positive().describe("Custom field ID. Find it with list_custom_fields"),
    value: z.string().min(1).describe("The option's exact label, e.g. \"Sprint 10 - 2026\""),
  }).optional()
    .describe("Filter by a List-type custom field (exact label match). For other custom field types use get_tasks with an ad-hoc filter"),
  customFieldIds: z.array(z.number().int().positive()).max(20).optional()
    .describe("Extra custom field ids to fetch and render on each result row (e.g. estimation/time-spent fields). Find ids with list_custom_fields"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).max(100).optional()
    .describe(`Results per page (default ${DEFAULT_SEARCH_PAGE_SIZE}, max 100)`),
});

export async function handleSearchTasks(params: z.infer<typeof searchTasksSchema>): Promise<string> {
  const filters: Array<{ type: number; operator: string; value: unknown; field?: number }> = [];
  if (params.nameContains !== undefined) filters.push({ type: 8, operator: "equal", value: params.nameContains });
  if (params.assigneeId !== undefined) filters.push({ type: 2, operator: "equal", value: `user:${params.assigneeId}` });
  if (params.statusId !== undefined) filters.push({ type: 10, operator: "equal", value: params.statusId });
  if (params.projectId !== undefined) filters.push({ type: 5, operator: "equal", value: params.projectId });
  if (params.updatedSince !== undefined) {
    const [y, m, d] = params.updatedSince.split("-");
    filters.push({ type: 79, operator: "gt", value: { dateType: "otherDate", dateValue: `${d}-${m}-${y}` } });
  }
  if (params.customField !== undefined) {
    filters.push({ type: 106, operator: "equal", value: params.customField.value, field: params.customField.fieldId });
  }

  if (filters.length === 0) {
    throw new Error(
      "search_tasks requires at least one filter: nameContains, assigneeId, statusId, projectId, updatedSince, or customField. " +
      "To page through all tasks without filters, use get_tasks instead.",
    );
  }

  // Custom fields render only when fetched by numeric id: the filtered field
  // plus any explicitly requested display fields join the fetch set.
  const cfIds = new Set<number>(params.customFieldIds ?? []);
  if (params.customField !== undefined) cfIds.add(params.customField.fieldId);
  const fields = cfIds.size > 0 ? `${SEARCH_FIELDS},${[...cfIds].join(",")}` : SEARCH_FIELDS;

  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  const { resp, hasMore } = await postListPage("task/list", {
    fields,
    filters,
  }, ["tasks"], offset, pageSize);
  return formatTaskSearchList(resp, pageSize, offset, hasMore);
}

// ── get_task_children — direct subtasks of a parent (read-only) ───────────────

// Mechanism (https://planfix.com/help/REST_API:_Complex_task_filters):
//   POST task/list with complex filter type 73 ("direct parent task"),
//   operator "equal", value = the parent task id — returns DIRECT children
//   only.
// Rejected alternatives:
//   - filter type 307 ("parent task tree") — matches the whole recursive
//     subtree; this tool is deliberately non-recursive;
//   - a dedicated children endpoint — none exists in the REST v2 swagger
//     (checked 2026-07-24: no /task/{id}/children or similar path).

export const getTaskChildrenSchema = z.object({
  taskId: z.number().int().positive().describe("Parent task ID"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).max(100).optional()
    .describe(`Subtasks per page (default ${DEFAULT_SEARCH_PAGE_SIZE}, max 100)`),
  response_format: responseFormatSchema,
});

export async function handleGetTaskChildren(params: z.infer<typeof getTaskChildrenSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  const concise = params.response_format === "CONCISE";
  const { resp, hasMore } = await postListPage("task/list", {
    fields: concise ? CONCISE_TASK_FIELDS : SEARCH_FIELDS,
    filters: [{ type: 73, operator: "equal", value: params.taskId }],
  }, ["tasks"], offset, pageSize);
  return formatTaskSearchList(resp, pageSize, offset, hasMore, {
    tool: "get_task_children",
    emptyText: `Task ${params.taskId} has no subtasks. has_more: false`,
    concise,
  });
}
