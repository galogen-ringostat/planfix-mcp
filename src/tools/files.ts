import { statSync, readFileSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import { z } from "zod";
import { planfixGet, planfixMutate, planfixUploadFile } from "../client.js";
import { formatFile, formatCreated } from "../format.js";
import { assertTaskInTestProject, refuseUnscopedMutation } from "../safemode.js";

// FileUploadRequest = { name, url } (both optional). Upload by URL.
// For target-bound uploads prefer attach_file_to_task / add_comment files.
export const uploadFileFromUrlSchema = z.object({
  url: z.string().describe("Direct URL of the file to upload"),
  name: z.string().optional().describe("File name (derived from the URL when omitted)"),
});

export async function handleUploadFileFromUrl(params: z.infer<typeof uploadFileFromUrlSchema>): Promise<string> {
  // The current tool signature uploads a standalone file (no taskId parameter),
  // so there is no target task to resolve — refused entirely in safe mode.
  refuseUnscopedMutation("upload_file_from_url", params.url, "the tool has no task/project target");
  const body: Record<string, unknown> = { url: params.url };
  if (params.name) body.name = params.name;
  const result = await planfixMutate("file/from-url/", body);
  return formatCreated("File", result);
}

// downloadUrl is a presigned S3 URL with an expiry — usable immediately,
// never stored (verified live, docs/spikes/file-attachments.md).
const FILE_FIELDS = "id,name,size,downloadUrl,link";

export const getFileSchema = z.object({
  fileId: z.number().describe("File ID"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${FILE_FIELDS})`),
});

export async function handleGetFile(params: z.infer<typeof getFileSchema>): Promise<string> {
  const result = await planfixGet(`file/${params.fileId}`, { fields: params.fields ?? FILE_FIELDS });
  return formatFile(result);
}

// ── Local-disk upload (shared by attach_file_to_task and add_comment) ─────────

// A tool-side limit, not an API fact — the spike verified 2 MB and deliberately
// did not hunt the real ceiling (docs/spikes/file-attachments.md, review 2026-07-28).
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Validate an absolute local path and upload it as a Planfix file.
 * The MULTIPART filename is the path's basename (Cyrillic names verified to
 * round-trip). File contents are read once and never logged.
 */
export async function uploadLocalFile(absPath: string): Promise<{ id: number; name: string }> {
  if (!isAbsolute(absPath)) {
    throw new Error(
      `File path must be absolute (e.g. W:\\docs\\report.docx); got "${absPath}". ` +
      "The MCP server reads files from the local disk it runs on.",
    );
  }
  let stat;
  try {
    stat = statSync(absPath);
  } catch {
    throw new Error(`File not found: "${absPath}". Check the path (it must exist on the machine running the MCP server).`);
  }
  if (stat.isDirectory()) {
    throw new Error(`"${absPath}" is a directory — pass the path of a single file.`);
  }
  if (stat.size > MAX_UPLOAD_BYTES) {
    const mb = Math.ceil(stat.size / (1024 * 1024));
    throw new Error(
      `File "${absPath}" is ${mb} MB — this tool caps uploads at 50 MB (a tool limit, not an API fact). ` +
      "Split or shrink the file, or upload it via the Planfix UI.",
    );
  }
  const name = basename(absPath);
  const resp = await planfixUploadFile(name, readFileSync(absPath));
  const id = (resp as { id?: unknown })?.id;
  if (typeof id !== "number") {
    throw new Error(`Upload of "${name}" returned an unexpected response shape (no numeric id): ${JSON.stringify(resp)}`);
  }
  return { id, name };
}

// ── attach_file_to_task — composite upload + card attach (ROADMAP P12) ────────

export const attachFileToTaskSchema = z.object({
  taskId: z.number().int().positive()
    .describe("Task whose CARD the file is attached to. To attach a file to a comment, use add_comment with files"),
  localPath: z.string().min(1).optional()
    .describe("Absolute path of a local file to upload (e.g. W:\\docs\\report.docx). Max 50 MB. Exactly one of localPath/url/fileId"),
  url: z.string().url().optional()
    .describe("Public URL for Planfix to download server-side. Some URLs are refused by Planfix with code 41 \"Unsafe url\". Exactly one of localPath/url/fileId"),
  fileId: z.number().int().positive().optional()
    .describe("Existing Planfix file ID to attach (a file can attach to several targets). Exactly one of localPath/url/fileId"),
  name: z.string().min(1).optional()
    .describe("Filename override for url uploads (ignored for localPath/fileId)"),
});

export async function handleAttachFileToTask(params: z.infer<typeof attachFileToTaskSchema>): Promise<string> {
  const sources = [params.localPath, params.url, params.fileId].filter((s) => s !== undefined);
  if (sources.length !== 1) {
    throw new Error(
      `attach_file_to_task requires EXACTLY ONE source — localPath, url, or fileId; got ${sources.length}. ` +
      "Pass the local file path to upload from disk, a public URL, or the id of an already-uploaded file.",
    );
  }

  // The task gate runs BEFORE any upload: no upload happens without a
  // resolvable target (docs/TESTING.md safe-mode contract).
  await assertTaskInTestProject("attach_file_to_task", params.taskId);

  let fileId: number;
  let origin: string;
  if (params.localPath !== undefined) {
    const uploaded = await uploadLocalFile(params.localPath);
    fileId = uploaded.id;
    origin = `uploaded from ${params.localPath}`;
  } else if (params.url !== undefined) {
    const body: Record<string, unknown> = { url: params.url };
    if (params.name) body.name = params.name;
    const resp = await planfixMutate("file/from-url/", body);
    const id = (resp as { id?: unknown })?.id;
    if (typeof id !== "number") {
      throw new Error(`URL upload returned an unexpected response shape (no numeric id): ${JSON.stringify(resp)}`);
    }
    fileId = id;
    origin = `uploaded from ${params.url}`;
  } else {
    fileId = params.fileId!;
    origin = "existing Planfix file";
  }

  // Dedicated attach endpoint; the task id is a QUERY parameter also named
  // `id` (verified live, docs/spikes/file-attachments.md).
  await planfixMutate(`file/${fileId}/attach/task?id=${params.taskId}`);

  // Name/size for the acknowledgement (size is KB, API unit).
  const meta = await planfixGet(`file/${fileId}`, { fields: "id,name,size" });
  const f = (meta as { file?: { name?: string; size?: number } })?.file;
  const label = f?.name ? `"${f.name}"${typeof f.size === "number" ? ` (${f.size} KB)` : ""}` : "";
  return `✓ File #${fileId} ${label} attached to task ${params.taskId} (${origin}).`;
}
