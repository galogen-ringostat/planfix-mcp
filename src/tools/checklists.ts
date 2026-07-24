import { z } from "zod";
import { planfixPost } from "../client.js";
import { postListPage } from "../paging.js";
import { formatChecklist, jsonFallback } from "../format.js";
import { assertTaskInTestProject } from "../safemode.js";

// Task checklists via /task/{id}/checklist* — endpoints, schemas, and limits
// verified live: docs/spikes/checklists.md (P6 spike, 2026-07-24).
// API limits (state them in tool descriptions):
//   - NO delete endpoint for checklist items;
//   - NO nesting on create (the create schema has no `parent` field — nesting
//     is readable on old items but not settable);
//   - NO ordering control (items live in creation order).

const DEFAULT_CHECKLIST_PAGE_SIZE = 50;

export const getTaskChecklistSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).max(100).optional()
    .describe(`Items per page (default ${DEFAULT_CHECKLIST_PAGE_SIZE}, max 100)`),
});

export async function handleGetTaskChecklist(params: z.infer<typeof getTaskChecklistSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_CHECKLIST_PAGE_SIZE;
  const { resp, hasMore } = await postListPage(`task/${params.taskId}/checklist/list`, {
    fields: "id,name,isDone,assignees",
  }, ["items"], offset, pageSize);
  return formatChecklist(resp, pageSize, offset, hasMore, params.taskId);
}

export const addChecklistItemSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  name: z.string().min(1).describe("Checklist item text"),
  isDone: z.boolean().optional().describe("Create the item already checked (default: unchecked)"),
  assigneeId: z.number().int().positive().optional().describe("Assignee (employee) ID. Find it with the list_users tool"),
});

export async function handleAddChecklistItem(params: z.infer<typeof addChecklistItemSchema>): Promise<string> {
  await assertTaskInTestProject("add_checklist_item", params.taskId);
  const body: Record<string, unknown> = { name: params.name };
  if (params.isDone !== undefined) body.isDone = params.isDone;
  if (params.assigneeId !== undefined) body.assignees = { users: [{ id: `user:${params.assigneeId}` }] };
  const result = await planfixPost(`task/${params.taskId}/checklist`, body);
  const id = (result as { id?: unknown })?.id;
  if (id === undefined) {
    return `Checklist item request accepted, but the response had an unexpected shape (no id):\n${jsonFallback(result)}`;
  }
  return `✓ Checklist item created: id ${id} on task ${params.taskId}.`;
}

export const updateChecklistItemNameSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  itemId: z.number().int().positive().describe("Checklist item ID (find it with get_task_checklist)"),
  name: z.string().min(1).describe("New item text (replaces the previous text)"),
});

export async function handleUpdateChecklistItemName(params: z.infer<typeof updateChecklistItemNameSchema>): Promise<string> {
  await assertTaskInTestProject("update_checklist_item_name", params.taskId);
  const result = await planfixPost(`task/${params.taskId}/checklist/${params.itemId}`, { name: params.name });
  const failures = (result as { failures?: Array<{ field?: string; error?: string }> })?.failures;
  if (Array.isArray(failures) && failures.length > 0) {
    return `Checklist item ${params.itemId} rename reported failures:\n${jsonFallback(failures)}`;
  }
  return `✓ Checklist item ${params.itemId} on task ${params.taskId} renamed to: ${params.name}`;
}

export const setChecklistItemDoneSchema = z.object({
  taskId: z.number().int().positive().describe("Task ID"),
  itemId: z.number().int().positive().describe("Checklist item ID (find it with get_task_checklist)"),
  isDone: z.boolean().describe("true — mark checked [x]; false — mark unchecked [ ]. Required and explicit; there is no toggle"),
});

export async function handleSetChecklistItemDone(params: z.infer<typeof setChecklistItemDoneSchema>): Promise<string> {
  await assertTaskInTestProject("set_checklist_item_done", params.taskId);
  const result = await planfixPost(`task/${params.taskId}/checklist/${params.itemId}`, { isDone: params.isDone });
  // The update endpoint can return { result: "success", failures: [...] } —
  // surface per-field failures instead of claiming success.
  const failures = (result as { failures?: Array<{ field?: string; error?: string }> })?.failures;
  if (Array.isArray(failures) && failures.length > 0) {
    return `Checklist item ${params.itemId} update reported failures:\n${jsonFallback(failures)}`;
  }
  return `✓ Checklist item ${params.itemId} on task ${params.taskId} marked ${params.isDone ? "checked [x]" : "unchecked [ ]"}.`;
}
