import { z } from "zod";
import { planfixGet } from "../client.js";
import { formatCustomFieldList, findArray } from "../format.js";

// Custom fields are listed per object type: GET /customfield/{objectType}.
export const listCustomFieldsSchema = z.object({
  objectType: z
    .enum(["task", "contact", "project", "user", "main"])
    .describe("Object type whose custom fields are listed"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).optional().describe("Fields per page (default 100)"),
});

export async function handleListCustomFields(params: z.infer<typeof listCustomFieldsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  // The endpoint is a GET with no server-side pagination — it returns ALL
  // fields of the object type. Pagination (and the exact has_more) is applied
  // client-side over the full response.
  const result = await planfixGet(`customfield/${params.objectType}`);
  const all = findArray(result, ["customFields", "customfields", "fields"]);
  if (!all) return formatCustomFieldList(result, pageSize, offset, false);
  const page = all.slice(offset, offset + pageSize);
  const hasMore = all.length > offset + pageSize;
  return formatCustomFieldList({ customfields: page }, pageSize, offset, hasMore);
}
