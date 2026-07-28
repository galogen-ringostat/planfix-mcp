import { z } from "zod";
import { planfixGet, planfixPost } from "../client.js";
import {
  findArray,
  formatProjectList,
  formatProjectOverview,
  formatProjectSearchList,
  formatSingleProject,
} from "../format.js";
import { postListPage } from "../paging.js";
import { obj, isoToPlanfixDate } from "../util.js";

const PROJECT_FIELDS = "id,name,description,status";
// GET project/{id} default is wider than the list default: the single-project
// card renders owner/group/parent/dates, the list stays lean (P8).
const SINGLE_PROJECT_FIELDS = "id,name,description,status,owner,parent,template,group,startDate,endDate,overdue";

export const getProjectsSchema = z.object({
  offset: z.number().optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().optional().describe("Projects per page (default 100, API max 100)"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${PROJECT_FIELDS})`),
});

export async function handleGetProjects(params: z.infer<typeof getProjectsSchema>): Promise<string> {
  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? 100;
  // project/list has NO filterId parameter (contacts only) — never send it.
  const { resp, hasMore } = await postListPage("project/list", {
    fields: params.fields ?? PROJECT_FIELDS,
  }, ["projects"], offset, pageSize);
  return formatProjectList(resp, pageSize, offset, hasMore);
}

export const getProjectSchema = z.object({
  projectId: z.number().describe("Project ID"),
  fields: z.string().optional().describe(`Comma-separated field list (default: ${SINGLE_PROJECT_FIELDS})`),
});

export async function handleGetProject(params: z.infer<typeof getProjectSchema>): Promise<string> {
  const result = await planfixGet(`project/${params.projectId}`, { fields: params.fields ?? SINGLE_PROJECT_FIELDS });
  return formatSingleProject(result);
}

// ── search_projects — filtered discovery (read-only) ──────────────────────────

// Planfix complex project filter mapping (docs/spikes/projects.md;
// https://planfix.com/help/REST_API:_Complex_project_filters):
//   type 5001 — project name; operator "equal" means "contains" for strings
//               (verified live 2026-07-25, same semantics as task filter 8)
//   type 5002 — project group; value is the numeric group id
//   type 5004 — project owner; value is the prefixed string "user:<id>"
//   type 5006 — project status; value is the numeric system status id
//               (0 = Draft, 1 = Completed, 2 = Active — see
//               PROJECT_STATUS_LABELS in src/format.ts)
// Filters combine with AND.

const SEARCH_PROJECT_FIELDS = "id,name,status,group,parent,owner";
const DEFAULT_SEARCH_PAGE_SIZE = 50;
const ACTIVE_STATUS_ID = 2;

export const searchProjectsSchema = z.object({
  nameContains: z.string().min(1).optional().describe("Substring of the project name"),
  activeOnly: z.boolean().optional().describe("true — only projects in the Active system status (excludes Draft and Completed)"),
  groupId: z.number().int().positive().optional().describe("Project group ID"),
  ownerId: z.number().int().positive().optional().describe("Project owner (employee) ID. Find it with the list_users tool"),
  offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)"),
  pageSize: z.number().int().min(1).max(100).optional()
    .describe(`Results per page (default ${DEFAULT_SEARCH_PAGE_SIZE}, max 100)`),
});

export async function handleSearchProjects(params: z.infer<typeof searchProjectsSchema>): Promise<string> {
  const filters: Array<{ type: number; operator: string; value: unknown }> = [];
  if (params.nameContains !== undefined) filters.push({ type: 5001, operator: "equal", value: params.nameContains });
  if (params.activeOnly === true) filters.push({ type: 5006, operator: "equal", value: ACTIVE_STATUS_ID });
  if (params.groupId !== undefined) filters.push({ type: 5002, operator: "equal", value: params.groupId });
  if (params.ownerId !== undefined) filters.push({ type: 5004, operator: "equal", value: `user:${params.ownerId}` });

  if (filters.length === 0) {
    throw new Error(
      "search_projects requires at least one filter: nameContains, activeOnly: true, groupId, or ownerId. " +
      "To page through all projects without filters, use get_projects instead.",
    );
  }

  const offset = params.offset ?? 0;
  const pageSize = params.pageSize ?? DEFAULT_SEARCH_PAGE_SIZE;
  const { resp, hasMore } = await postListPage("project/list", {
    fields: SEARCH_PROJECT_FIELDS,
    filters,
  }, ["projects"], offset, pageSize);
  return formatProjectSearchList(resp, pageSize, offset, hasMore);
}

// ── get_project_overview — project state card (read-only) ─────────────────────

// Composition (docs/spikes/projects.md): the API has no aggregate/count
// endpoint and no sort on task/list, so "state" is composed client-side:
//   1. GET project/{id} — the card.
//   2. task/list, project filter (type 5), fields id,status — task counts by
//      status via status.isActive, paged with a hard scan cap so a
//      thousand-task project cannot blow the token/latency budget. When the
//      cap is hit the counts are reported as explicit lower bounds.
//   3. task/list, project filter + type 79 ("changed or commented after
//      date", same shape as search_tasks.updatedSince) — the recency signal.
//      One page (≤100 rows); a full page is reported as "100+", never a bare
//      100. Client-sorted by dateOfLastUpdate desc (the API has no sort).

const OVERVIEW_PROJECT_FIELDS = "id,name,description,status,owner,parent,template,group,counterparty,startDate,endDate,hasEndDate,overdue,isDeleted";
const SCAN_PAGE_SIZE = 100;
const SCAN_CAP = 300;
const DEFAULT_RECENT_DAYS = 30;
const DEFAULT_RECENT_LIMIT = 10;

export const getProjectOverviewSchema = z.object({
  projectId: z.number().int().positive().describe("Project ID"),
  recentDays: z.number().int().min(1).max(365).optional()
    .describe(`Recency window in days for the activity signal (default ${DEFAULT_RECENT_DAYS})`),
  recentLimit: z.number().int().min(1).max(20).optional()
    .describe(`Max recently-updated tasks listed (default ${DEFAULT_RECENT_LIMIT})`),
});

/** Count tasks by status across up to SCAN_CAP tasks (sequential pages). */
async function scanTaskCounts(projectId: number): Promise<{
  scanned: number; scanCapped: boolean; activeCount: number; closedCount: number;
  byStatus: Array<[string, number]>;
}> {
  let scanned = 0;
  let activeCount = 0;
  const byStatus = new Map<string, number>();
  for (let offset = 0; offset < SCAN_CAP; offset += SCAN_PAGE_SIZE) {
    const resp = await planfixPost("task/list", {
      offset,
      pageSize: SCAN_PAGE_SIZE,
      fields: "id,status",
      filters: [{ type: 5, operator: "equal", value: projectId }],
    });
    const tasks = findArray(resp, ["tasks"]) ?? [];
    for (const t of tasks) {
      const status = obj(obj(t)?.status);
      const name = typeof status?.name === "string" && status.name.length
        ? status.name
        : `status #${status?.id ?? "?"}`;
      byStatus.set(name, (byStatus.get(name) ?? 0) + 1);
      if (status?.isActive === true) activeCount++;
    }
    scanned += tasks.length;
    if (tasks.length < SCAN_PAGE_SIZE) {
      return { scanned, scanCapped: false, activeCount, closedCount: scanned - activeCount, byStatus: sortCounts(byStatus) };
    }
  }
  // Every page up to the cap came back full — more tasks may follow.
  return { scanned, scanCapped: true, activeCount, closedCount: scanned - activeCount, byStatus: sortCounts(byStatus) };
}

function sortCounts(m: Map<string, number>): Array<[string, number]> {
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
}

/** UTC timestamp for sorting; falls back to the rendered date string. */
function lastUpdateKey(t: unknown): string {
  const d = obj(obj(t)?.dateOfLastUpdate);
  return (typeof d?.dateTimeUtcSeconds === "string" && d.dateTimeUtcSeconds)
    || (typeof d?.datetime === "string" && d.datetime)
    || "";
}

export async function handleGetProjectOverview(params: z.infer<typeof getProjectOverviewSchema>): Promise<string> {
  const recentDays = params.recentDays ?? DEFAULT_RECENT_DAYS;
  const recentLimit = params.recentLimit ?? DEFAULT_RECENT_LIMIT;

  const since = new Date(Date.now() - recentDays * 86_400_000);
  const dateValue = isoToPlanfixDate(since.toISOString().slice(0, 10));

  const [projectResp, counts, recentResp] = await Promise.all([
    planfixGet(`project/${params.projectId}`, { fields: OVERVIEW_PROJECT_FIELDS }),
    scanTaskCounts(params.projectId),
    planfixPost("task/list", {
      offset: 0,
      pageSize: SCAN_PAGE_SIZE,
      fields: "id,name,status,dateOfLastUpdate",
      filters: [
        { type: 5, operator: "equal", value: params.projectId },
        { type: 79, operator: "gt", value: { dateType: "otherDate", dateValue } },
      ],
    }),
  ]);

  const recentTasks = [...(findArray(recentResp, ["tasks"]) ?? [])]
    .sort((a, b) => lastUpdateKey(b).localeCompare(lastUpdateKey(a)));

  return formatProjectOverview({
    projectResp,
    ...counts,
    recentDays,
    recentCount: recentTasks.length,
    recentCapped: recentTasks.length >= SCAN_PAGE_SIZE,
    recentTasks,
    recentLimit,
  });
}
