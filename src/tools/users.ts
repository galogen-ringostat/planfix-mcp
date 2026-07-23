import { z } from "zod";
import { planfixPost, planfixGet } from "../client.js";
import { formatUserList, formatSingleUser } from "../format.js";

// Ресурс сотрудников — /user (несмотря на тег "Employee" в спецификации).
const USER_FIELDS = "id,name,midname,lastname,email,position";

export const listUsersSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Employees per page (default 100, API max 100)"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${USER_FIELDS})`),
});

export async function handleListUsers(params: z.infer<typeof listUsersSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  const result = await planfixPost("user/list", {
    offset,
    pageSize,
    fields: params.fields ?? USER_FIELDS,
  });
  return formatUserList(result, pageSize, offset);
}

export const getUserSchema = z.object({
  userId: z.number().describe("Employee ID"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${USER_FIELDS})`),
});

export async function handleGetUser(params: z.infer<typeof getUserSchema>): Promise<string> {
  const result = await planfixGet(`user/${params.userId}`, { fields: params.fields ?? USER_FIELDS });
  return formatSingleUser(result);
}
