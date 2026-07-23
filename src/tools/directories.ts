import { z } from "zod";
import { planfixPost } from "../client.js";
import { formatDirectoryList, formatDirectoryEntryList } from "../format.js";

// Справочники (directories) Planfix хранят, в т.ч., кастомные наборы статусов задач.
const DIRECTORY_FIELDS = "id,name";

export const listDirectoriesSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Directories per page (default 100, API max 100)"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${DIRECTORY_FIELDS})`),
});

export async function handleListDirectories(params: z.infer<typeof listDirectoriesSchema>): Promise<string> {
  const result = await planfixPost("directory/list", {
    offset: params.offset ?? 0,
    pageSize: params.pageSize ?? 100,
    fields: params.fields ?? DIRECTORY_FIELDS,
  });
  return formatDirectoryList(result);
}

export const listDirectoryEntriesSchema = z.object({
  directoryId: z.number().describe("Directory ID (e.g. a task status set)"),
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Entries per page (default 100, API max 100)"),
});

export async function handleListDirectoryEntries(params: z.infer<typeof listDirectoryEntriesSchema>): Promise<string> {
  const result = await planfixPost(`directory/${params.directoryId}/entry/list`, {
    offset: params.offset ?? 0,
    pageSize: params.pageSize ?? 100,
  });
  return formatDirectoryEntryList(result);
}
