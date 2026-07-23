import { z } from "zod";
import { planfixPost, planfixGet } from "../client.js";
import { formatTaskList, formatSingleTask, formatCreated, formatUpdated, formatTaskFull, formatTaskSearchList } from "../format.js";
import { postListPage } from "../paging.js";
import { assertCreateTaskAllowed, assertTaskInTestProject } from "../safemode.js";

// Без явного `fields` Planfix возвращает почти пустые (id-only) объекты,
// поэтому всегда запрашиваем осмысленный набор полей.
const TASK_FIELDS = "id,name,description,status,priority,assignees,project,startDateTime,endDateTime";

// response_format: "CONCISE" — identifier-grade output for flows that only
// need ids for a follow-up call. Overrides `fields` and trims rendering.
const CONCISE_TASK_FIELDS = "id,name,status";
const responseFormatSchema = z.enum(["CONCISE", "DETAILED"]).optional()
  .describe("DETAILED (default): full fields. CONCISE: identifier-grade rows only (id, name, status); overrides `fields`. Pick CONCISE when you only need IDs for a follow-up call");

// Ad-hoc Planfix filter: { type, operator, value } (combined with AND).
const filterSchema = z.object({
  type: z.number().describe("Filter type (Planfix numeric code, e.g. 8 — task name, 51 — template)"),
  operator: z.string().describe("Comparison operator, e.g. 'equal', 'gt', 'lt'"),
  value: z.unknown().describe("Filter value"),
});

export const getTasksSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Tasks per page (default 100, API max 100)"),
  filterId: z.union([z.string(), z.number()]).optional().describe("ID of a saved task filter (see /task/filters)"),
  filters: z.array(filterSchema).optional().describe("Array of ad-hoc filters for arbitrary filtering"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${TASK_FIELDS})`),
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
  fields: z.string().optional().describe(`Comma-separated field list (default: ${TASK_FIELDS})`),
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
  // Planfix ждёт PeopleRequest: { users: [{ id: "user:<N>" }] }, id — строка с префиксом.
  if (params.assigneeId) body.assignees = { users: [{ id: `user:${params.assigneeId}` }] };
  if (params.priority) body.priority = params.priority;

  const result = await planfixPost("task/", body);
  return formatCreated("Задача", result);
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

  // Planfix возвращает пустое тело (200 — применено, 202 — поставлено в очередь);
  // подтверждение формируем из taskId.
  await planfixPost(`task/${params.taskId}`, body);
  return formatUpdated("Задача", params.taskId);
}

// ── get_task_full — task + comments in one call (read-only) ──────────────────

const COMMENT_FIELDS = "id,dateTime,owner,description";
const DEFAULT_COMMENTS_LIMIT = 30;

export const getTaskFullSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  commentsLimit: z.number().int().min(1).max(100).optional()
    .describe(`Maximum comments in the response (default ${DEFAULT_COMMENTS_LIMIT}, max 100)`),
  response_format: responseFormatSchema,
});

const CONCISE_COMMENT_FIELDS = "id,dateTime,owner";

export async function handleGetTaskFull(params: z.infer<typeof getTaskFullSchema>): Promise<string> {
  const limit = params.commentsLimit ?? DEFAULT_COMMENTS_LIMIT;
  const concise = params.response_format === "CONCISE";
  const [taskResp, comments] = await Promise.all([
    planfixGet(`task/${params.taskId}`, { fields: concise ? CONCISE_TASK_FIELDS : TASK_FIELDS }),
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
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).max(100).optional()
    .describe(`Results per page (default ${DEFAULT_SEARCH_PAGE_SIZE}, max 100)`),
});

export async function handleSearchTasks(params: z.infer<typeof searchTasksSchema>): Promise<string> {
  const filters: Array<{ type: number; operator: string; value: unknown }> = [];
  if (params.nameContains !== undefined) filters.push({ type: 8, operator: "equal", value: params.nameContains });
  if (params.assigneeId !== undefined) filters.push({ type: 2, operator: "equal", value: `user:${params.assigneeId}` });
  if (params.statusId !== undefined) filters.push({ type: 10, operator: "equal", value: params.statusId });
  if (params.projectId !== undefined) filters.push({ type: 5, operator: "equal", value: params.projectId });
  if (params.updatedSince !== undefined) {
    const [y, m, d] = params.updatedSince.split("-");
    filters.push({ type: 79, operator: "gt", value: { dateType: "otherDate", dateValue: `${d}-${m}-${y}` } });
  }

  if (filters.length === 0) {
    throw new Error(
      "search_tasks requires at least one filter: nameContains, assigneeId, statusId, projectId, or updatedSince. " +
      "To page through all tasks without filters, use get_tasks instead.",
    );
  }

  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  const { resp, hasMore } = await postListPage("task/list", {
    fields: SEARCH_FIELDS,
    filters,
  }, ["tasks"], offset, pageSize);
  return formatTaskSearchList(resp, pageSize, offset, hasMore);
}
