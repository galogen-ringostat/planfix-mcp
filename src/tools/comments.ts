import { z } from "zod";
import { planfixPost } from "../client.js";
import { formatCommentList, formatCreated } from "../format.js";
import { postListPage } from "../paging.js";
import { assertTaskInTestProject } from "../safemode.js";
import { uploadLocalFile } from "./files.js";

const COMMENT_FIELDS = "id,dateTime,owner,description,isPinned,isHidden,files";

export const getCommentsSchema = z.object({
  taskId: z.number().describe("Task ID"),
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Comments per page (default 100, API max 100)"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${COMMENT_FIELDS})`),
});

export async function handleGetComments(params: z.infer<typeof getCommentsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  // Planfix uses the PLURAL path: /task/{id}/comments/list
  const { resp, hasMore } = await postListPage(`task/${params.taskId}/comments/list`, {
    fields: params.fields ?? COMMENT_FIELDS,
  }, ["comments"], offset, pageSize);
  return formatCommentList(resp, pageSize, offset, hasMore);
}

export const addCommentSchema = z.object({
  taskId: z.number().describe("Task ID"),
  body: z.string().describe("Comment text"),
  files: z.array(z.union([
    z.string().min(1).describe("Absolute local file path to upload (max 50 MB)"),
    z.number().int().positive().describe("Existing Planfix file ID"),
  ])).max(10).optional()
    .describe("Files to attach: absolute local paths (uploaded first) and/or existing Planfix file IDs, max 10. One file may be attached to several comments"),
});

export async function handleAddComment(params: z.infer<typeof addCommentSchema>): Promise<string> {
  // The task gate runs BEFORE any upload: no upload happens without a
  // resolvable target (docs/TESTING.md safe-mode contract).
  await assertTaskInTestProject("add_comment", params.taskId);

  const attached: Array<{ id: number; label: string }> = [];
  for (const item of params.files ?? []) {
    if (typeof item === "number") {
      attached.push({ id: item, label: `#${item}` });
    } else {
      const uploaded = await uploadLocalFile(item);
      attached.push({ id: uploaded.id, label: `#${uploaded.id} "${uploaded.name}"` });
    }
  }

  // The path is PLURAL: /task/{id}/comments/. The text field is `description`.
  const result = await planfixPost(`task/${params.taskId}/comments/`, {
    description: params.body,
    ...(attached.length > 0 ? { files: attached.map((f) => ({ id: f.id })) } : {}),
  });
  const ack = formatCreated("Comment", result);
  return attached.length > 0
    ? `${ack} Attached files: ${attached.map((f) => f.label).join(", ")}.`
    : ack;
}
