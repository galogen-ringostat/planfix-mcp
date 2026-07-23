import { planfixPost } from "./client.js";
import { findArray } from "./format.js";

/** Planfix caps pageSize at 100 on every POST list endpoint (swagger-verified). */
export const API_MAX_PAGE_SIZE = 100;

/**
 * POST a list endpoint and compute an EXACT has_more without ever exceeding
 * the API's page-size cap:
 * - pageSize + 1 <= 100: over-fetch one row (the established pattern); the
 *   response may hold pageSize + 1 items — formatters slice, never render it.
 * - pageSize >= 100: request the page as-is; when it comes back full, issue a
 *   one-row probe at the next offset to check whether anything follows.
 */
export async function postListPage(
  endpoint: string,
  body: Record<string, unknown>,
  keys: string[],
  offset: number,
  pageSize: number,
): Promise<{ resp: unknown; hasMore: boolean }> {
  if (pageSize + 1 <= API_MAX_PAGE_SIZE) {
    const resp = await planfixPost(endpoint, { ...body, offset, pageSize: pageSize + 1 });
    const items = findArray(resp, keys) ?? [];
    return { resp, hasMore: items.length > pageSize };
  }
  const resp = await planfixPost(endpoint, { ...body, offset, pageSize });
  const items = findArray(resp, keys) ?? [];
  if (items.length < pageSize) return { resp, hasMore: false };
  const probe = await planfixPost(endpoint, { ...body, offset: offset + pageSize, pageSize: 1 });
  return { resp, hasMore: (findArray(probe, keys) ?? []).length > 0 };
}
