import { z } from "zod";
import { formatDatatagList } from "../format.js";
import { postListPage } from "../paging.js";

const DATATAG_FIELDS = "id,name";

export const listDatatagsSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Data tags per page (default 100, API max 100)"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${DATATAG_FIELDS})`),
});

export async function handleListDatatags(params: z.infer<typeof listDatatagsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  const { resp, hasMore } = await postListPage("datatag/list", {
    fields: params.fields ?? DATATAG_FIELDS,
  }, ["dataTags", "datatags"], offset, pageSize);
  return formatDatatagList(resp, pageSize, offset, hasMore);
}
