import { z } from "zod";
import { planfixPost } from "../client.js";
import { formatCommentList, formatCreated } from "../format.js";
import { assertTaskInTestProject } from "../safemode.js";

const COMMENT_FIELDS = "id,dateTime,owner,description,isPinned,isHidden";

export const getCommentsSchema = z.object({
  taskId: z.number().describe("Task ID"),
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Comments per page (default 100, API max 100)"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${COMMENT_FIELDS})`),
});

export async function handleGetComments(params: z.infer<typeof getCommentsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  // Planfix использует МНОЖЕСТВЕННОЕ число пути: /task/{id}/comments/list
  const result = await planfixPost(`task/${params.taskId}/comments/list`, {
    offset,
    pageSize,
    fields: params.fields ?? COMMENT_FIELDS,
  });
  return formatCommentList(result, pageSize, offset);
}

export const addCommentSchema = z.object({
  taskId: z.number().describe("Task ID"),
  body: z.string().describe("Comment text"),
});

export async function handleAddComment(params: z.infer<typeof addCommentSchema>): Promise<string> {
  await assertTaskInTestProject("add_comment", params.taskId);
  // Путь — МНОЖЕСТВЕННОЕ число: /task/{id}/comments/. Поле текста — `description`.
  const result = await planfixPost(`task/${params.taskId}/comments/`, {
    description: params.body,
  });
  return formatCreated("Комментарий", result);
}
