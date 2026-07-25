import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/client.js", () => ({
  planfixPost: vi.fn(),
  planfixGet: vi.fn(),
}));

import { planfixPost, planfixGet } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockGet = vi.mocked(planfixGet);

const CYRILLIC = /[а-яА-ЯёЁ]/;

// ── search_projects ───────────────────────────────────────────────────────────

describe("search_projects", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("maps each param to its complex project filter (5001/5006/5002/5004, AND-combined)", async () => {
    mockPost.mockResolvedValue({ projects: [] });
    const { handleSearchProjects } = await import("../src/tools/projects.js");
    await handleSearchProjects({ nameContains: "RevOps", activeOnly: true, groupId: 30212, ownerId: 403 });
    expect(mockPost).toHaveBeenCalledWith("project/list", expect.objectContaining({
      filters: [
        { type: 5001, operator: "equal", value: "RevOps" },
        { type: 5006, operator: "equal", value: 2 },
        { type: 5002, operator: "equal", value: 30212 },
        { type: 5004, operator: "equal", value: "user:403" },
      ],
    }));
  });

  it("requires at least one filter; error is actionable English", async () => {
    const { handleSearchProjects } = await import("../src/tools/projects.js");
    const err = await handleSearchProjects({}).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("at least one filter");
    expect((err as Error).message).toContain("get_projects");
    expect((err as Error).message).not.toMatch(CYRILLIC);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("activeOnly: false is not a filter (alone it still refuses)", async () => {
    const { handleSearchProjects } = await import("../src/tools/projects.js");
    await expect(handleSearchProjects({ activeOnly: false })).rejects.toThrow("at least one filter");
    expect(mockPost).not.toHaveBeenCalled();
  });

  it("renders rows with mapped status labels and exact has_more from over-fetch", async () => {
    // pageSize 2 → over-fetch requests 3; 3 rows back ⇒ has_more: true, third row never rendered.
    mockPost.mockResolvedValue({ projects: [
      { id: 1, name: "Alpha", status: { id: 2 } },
      { id: 2, name: "Beta", status: { id: 1 } },
      { id: 3, name: "Hidden", status: { id: 0 } },
    ] });
    const { handleSearchProjects } = await import("../src/tools/projects.js");
    const out = await handleSearchProjects({ nameContains: "a", pageSize: 2 });
    expect(mockPost).toHaveBeenCalledWith("project/list", expect.objectContaining({ pageSize: 3, offset: 0 }));
    expect(out).toContain("status: Active");
    expect(out).toContain("status: Completed");
    expect(out).not.toContain("Hidden");
    expect(out).toContain("has_more: true — next page: search_projects with the same filters and offset: 2.");
  });

  it("empty result returns an English hint, not an empty list", async () => {
    mockPost.mockResolvedValue({ projects: [] });
    const { handleSearchProjects } = await import("../src/tools/projects.js");
    const out = await handleSearchProjects({ nameContains: "nope" });
    expect(out).toContain("No projects matched");
    expect(out).toContain("has_more: false");
    expect(out).not.toMatch(CYRILLIC);
  });

  it("schema rejects an empty nameContains and out-of-range pageSize", async () => {
    const { searchProjectsSchema } = await import("../src/tools/projects.js");
    expect(searchProjectsSchema.safeParse({ nameContains: "" }).success).toBe(false);
    expect(searchProjectsSchema.safeParse({ nameContains: "x", pageSize: 101 }).success).toBe(false);
    expect(searchProjectsSchema.safeParse({ nameContains: "x", pageSize: 100 }).success).toBe(true);
  });

  it("propagates API failure", async () => {
    mockPost.mockRejectedValue(new Error("Planfix API error 22: rate limit"));
    const { handleSearchProjects } = await import("../src/tools/projects.js");
    await expect(handleSearchProjects({ nameContains: "x" })).rejects.toThrow("Planfix API error 22");
  });
});

// ── get_project / get_projects defaults (P8 render/fetch fix) ─────────────────

describe("project card defaults", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("get_project fetches the widened single-project field set by default", async () => {
    mockGet.mockResolvedValue({ project: { id: 45, name: "P", status: { id: 2 } } });
    const { handleGetProject } = await import("../src/tools/projects.js");
    const out = await handleGetProject({ projectId: 45 });
    expect(mockGet).toHaveBeenCalledWith("project/45", {
      fields: "id,name,description,status,owner,parent,template,group,startDate,endDate,overdue",
    });
    expect(out).toContain("status: Active");
  });

  it("get_projects keeps the lean list default (no output regression)", async () => {
    mockPost.mockResolvedValue({ projects: [] });
    const { handleGetProjects } = await import("../src/tools/projects.js");
    await handleGetProjects({});
    expect(mockPost).toHaveBeenCalledWith("project/list", expect.objectContaining({
      fields: "id,name,description,status",
    }));
  });

  it("formatProject renders owner/group/dates when fetched and falls back to #N on unknown status ids", async () => {
    const { formatProject } = await import("../src/format.js");
    const row = formatProject({
      id: 7, name: "X", status: { id: 7 },
      owner: { id: "user:403", name: "Galogen" },
      group: { id: 30212, name: "Sales Department" },
      parent: { id: 100, name: "Goal" },
      startDate: { date: "01-02-2026" },
      overdue: true,
    });
    expect(row).toContain("status: #7");
    expect(row).toContain("owner: Galogen (#user:403)");
    expect(row).toContain("group: Sales Department (#30212)");
    expect(row).toContain("parent: Goal (#100)");
    expect(row).toContain("start: 01-02-2026");
    expect(row).toContain("OVERDUE");
  });
});

// ── get_project_overview ──────────────────────────────────────────────────────

function taskPage(count: number, opts: { activeEvery?: number; startId?: number } = {}) {
  const tasks = Array.from({ length: count }, (_, i) => ({
    id: (opts.startId ?? 1) + i,
    status: {
      id: opts.activeEvery && i % opts.activeEvery === 0 ? 1 : 3,
      name: opts.activeEvery && i % opts.activeEvery === 0 ? "New" : "Completed",
      isActive: Boolean(opts.activeEvery && i % opts.activeEvery === 0),
    },
  }));
  return { tasks };
}

describe("get_project_overview", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  const PROJECT = { project: { id: 45, name: "P", status: { id: 2 }, description: "About the project" } };

  it("composes card + counts + recency; small project, quiet period", async () => {
    mockGet.mockResolvedValue(PROJECT);
    mockPost.mockImplementation(async (_ep, body) => {
      const b = body as { filters: Array<{ type: number; value?: unknown }> };
      if (b.filters.some((f) => f.type === 79)) return { tasks: [] };       // recency page
      return taskPage(40, { activeEvery: 4 });                              // scan page (40 < 100 → done)
    });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    const out = await handleGetProjectOverview({ projectId: 45 });

    expect(mockGet).toHaveBeenCalledWith("project/45", expect.objectContaining({ fields: expect.stringContaining("status") }));
    expect(out).toContain("status: Active");
    expect(out).toContain("Description:\nAbout the project");
    expect(out).toContain("Tasks: 40 scanned — active: 10, closed: 30.");
    expect(out).toContain("By status: Completed: 30, New: 10");
    expect(out).toContain("Activity: no tasks changed or commented in the last 30 days — the project looks inactive.");
    expect(out).not.toMatch(CYRILLIC);
  });

  it("scan cap: three full pages report 300+ as an explicit lower bound and stop paging", async () => {
    mockGet.mockResolvedValue(PROJECT);
    const scanCalls: number[] = [];
    mockPost.mockImplementation(async (_ep, body) => {
      const b = body as { offset: number; filters: Array<{ type: number }> };
      if (b.filters.some((f) => f.type === 79)) return { tasks: [] };
      scanCalls.push(b.offset);
      return taskPage(100, { startId: b.offset + 1 });
    });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    const out = await handleGetProjectOverview({ projectId: 45 });
    expect(scanCalls).toEqual([0, 100, 200]);
    expect(out).toContain("Tasks: 300+ scanned (scan cap reached");
    expect(out).toContain("search_tasks");
  });

  it("recency: sorts by dateOfLastUpdate desc, lists recentLimit rows, exact counts", async () => {
    mockGet.mockResolvedValue(PROJECT);
    mockPost.mockImplementation(async (_ep, body) => {
      const b = body as { filters: Array<{ type: number; value?: unknown }> };
      if (b.filters.some((f) => f.type === 79)) {
        return { tasks: [
          { id: 1, name: "Old", status: { id: 1, name: "New" }, dateOfLastUpdate: { date: "01-07-2026", dateTimeUtcSeconds: "2026-07-01T10:00:00+0000" } },
          { id: 2, name: "Newest", status: { id: 1, name: "New" }, dateOfLastUpdate: { date: "24-07-2026", dateTimeUtcSeconds: "2026-07-24T10:00:00+0000" } },
          { id: 3, name: "Middle", status: { id: 1, name: "New" }, dateOfLastUpdate: { date: "10-07-2026", dateTimeUtcSeconds: "2026-07-10T10:00:00+0000" } },
        ] };
      }
      return taskPage(3);
    });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    const out = await handleGetProjectOverview({ projectId: 45, recentLimit: 2 });
    expect(out).toContain("Activity: 3 tasks changed or commented in the last 30 days (most recent: 24-07-2026).");
    expect(out).toContain("Recently updated (2 of 3):");
    const first = out.indexOf("#2"); const second = out.indexOf("#3");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first); // Newest before Middle
    expect(out).not.toContain("#1 | Old");  // beyond recentLimit
  });

  it("recency full page reports 100+ instead of a bare 100", async () => {
    mockGet.mockResolvedValue(PROJECT);
    mockPost.mockImplementation(async (_ep, body) => {
      const b = body as { filters: Array<{ type: number }> };
      if (b.filters.some((f) => f.type === 79)) {
        return { tasks: Array.from({ length: 100 }, (_, i) => ({
          id: i + 1, name: `T${i + 1}`, status: { id: 1, name: "New" },
          dateOfLastUpdate: { date: "20-07-2026", dateTimeUtcSeconds: `2026-07-20T10:${String(i % 60).padStart(2, "0")}:00+0000` },
        })) };
      }
      return taskPage(0);
    });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    const out = await handleGetProjectOverview({ projectId: 45 });
    expect(out).toContain("Activity: 100+ tasks changed");
    expect(out).toContain("Recently updated (10 of 100+):");
  });

  it("sends the type-79 filter with the DD-MM-YYYY dateValue shape", async () => {
    mockGet.mockResolvedValue(PROJECT);
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    await handleGetProjectOverview({ projectId: 45, recentDays: 7 });
    const recencyCall = mockPost.mock.calls.find(([, body]) =>
      (body as { filters: Array<{ type: number }> }).filters.some((f) => f.type === 79));
    expect(recencyCall).toBeDefined();
    const f79 = (recencyCall![1] as { filters: Array<{ type: number; operator: string; value: unknown }> })
      .filters.find((f) => f.type === 79)!;
    expect(f79.operator).toBe("gt");
    expect(f79.value).toMatchObject({ dateType: "otherDate", dateValue: expect.stringMatching(/^\d{2}-\d{2}-\d{4}$/) });
  });

  it("truncates a long description explicitly and points at get_project", async () => {
    mockGet.mockResolvedValue({ project: { id: 45, name: "P", status: { id: 2 }, description: "x".repeat(600) } });
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    const out = await handleGetProjectOverview({ projectId: 45 });
    expect(out).toContain("[truncated — full text via get_project]");
    expect(out).not.toContain("x".repeat(501));
  });

  it("schema rejects recentDays/recentLimit out of range and a missing projectId", async () => {
    const { getProjectOverviewSchema } = await import("../src/tools/projects.js");
    expect(getProjectOverviewSchema.safeParse({}).success).toBe(false);
    expect(getProjectOverviewSchema.safeParse({ projectId: 45, recentDays: 0 }).success).toBe(false);
    expect(getProjectOverviewSchema.safeParse({ projectId: 45, recentDays: 366 }).success).toBe(false);
    expect(getProjectOverviewSchema.safeParse({ projectId: 45, recentLimit: 21 }).success).toBe(false);
    expect(getProjectOverviewSchema.safeParse({ projectId: 45, recentDays: 30, recentLimit: 10 }).success).toBe(true);
  });

  it("propagates API failure from any leg", async () => {
    mockGet.mockRejectedValue(new Error("Planfix HTTP 404: Not Found"));
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleGetProjectOverview } = await import("../src/tools/projects.js");
    await expect(handleGetProjectOverview({ projectId: 999999 })).rejects.toThrow("404");
  });
});
