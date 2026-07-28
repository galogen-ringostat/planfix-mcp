import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../src/client.js", () => ({
  planfixPost: vi.fn(),
  planfixGet: vi.fn(),
  planfixMutate: vi.fn(),
  planfixUploadFile: vi.fn(),
}));

import { planfixPost, planfixGet, planfixMutate } from "../src/client.js";

const mockPost = vi.mocked(planfixPost);
const mockMutate = vi.mocked(planfixMutate);
const mockGet = vi.mocked(planfixGet);

beforeEach(() => { vi.clearAllMocks(); });

// `description` included so comment rows (which render description, not name)
// also show the identifying text.
const items = (n: number, name = "Item") =>
  Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `${name} ${i + 1}`, description: `${name} ${i + 1}` }));

// Every POST-list tool: [tool name for the footer, handler loader, endpoint, response key, base params]
const LIST_TOOLS: Array<{
  tool: string;
  endpoint: string;
  key: string;
  run: (params: Record<string, unknown>) => Promise<string>;
}> = [
  {
    tool: "get_tasks", endpoint: "task/list", key: "tasks",
    run: async (p) => (await import("../src/tools/tasks.js")).handleGetTasks(p),
  },
  {
    tool: "get_contacts", endpoint: "contact/list", key: "contacts",
    run: async (p) => (await import("../src/tools/contacts.js")).handleGetContacts(p),
  },
  {
    tool: "get_projects", endpoint: "project/list", key: "projects",
    run: async (p) => (await import("../src/tools/projects.js")).handleGetProjects(p),
  },
  {
    tool: "list_users", endpoint: "user/list", key: "users",
    run: async (p) => (await import("../src/tools/users.js")).handleListUsers(p),
  },
  {
    tool: "get_comments", endpoint: "task/5/comments/list", key: "comments",
    run: async (p) => (await import("../src/tools/comments.js")).handleGetComments({ taskId: 5, ...p }),
  },
  {
    tool: "list_directories", endpoint: "directory/list", key: "directories",
    run: async (p) => (await import("../src/tools/directories.js")).handleListDirectories(p),
  },
  {
    tool: "list_directory_entries", endpoint: "directory/3/entry/list", key: "directoryEntries",
    run: async (p) => (await import("../src/tools/directories.js")).handleListDirectoryEntries({ directoryId: 3, ...p }),
  },
  {
    tool: "list_datatags", endpoint: "datatag/list", key: "dataTags",
    run: async (p) => (await import("../src/tools/datatags.js")).handleListDatatags(p),
  },
];

describe.each(LIST_TOOLS)("$tool pagination", ({ tool, endpoint, key, run }) => {
  it("over-fetches one row and reports exact has_more: true with the next offset", async () => {
    mockPost.mockResolvedValue({ [key]: items(3) }); // pageSize 2 → 3 rows back
    const result = await run({ pageSize: 2 });
    expect(mockPost).toHaveBeenCalledWith(endpoint, expect.objectContaining({ offset: 0, pageSize: 3 }));
    expect(result).toContain("Item 2");
    expect(result).not.toContain("Item 3"); // over-fetched row never rendered
    const footer = result.split("\n").at(-1)!;
    expect(footer).toBe(`has_more: true — next page: ${tool} with offset: 2.`);
  });

  it("reports has_more: false on a final page", async () => {
    mockPost.mockResolvedValue({ [key]: items(1) });
    const result = await run({ pageSize: 2 });
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });
});

describe("probe path (pageSize at the API cap of 100)", () => {
  it("issues a one-row probe when a default-size page comes back full; probe hit → has_more: true", async () => {
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    mockPost
      .mockResolvedValueOnce({ tasks: items(100) })
      .mockResolvedValueOnce({ tasks: items(1) }); // probe finds one more
    const result = await handleGetTasks({}); // default pageSize 100 → no over-fetch possible
    expect(mockPost).toHaveBeenNthCalledWith(1, "task/list", expect.objectContaining({ offset: 0, pageSize: 100 }));
    expect(mockPost).toHaveBeenNthCalledWith(2, "task/list", expect.objectContaining({ offset: 100, pageSize: 1 }));
    expect(result).toContain("has_more: true — next page: get_tasks with offset: 100.");
  });

  it("probe miss → has_more: false", async () => {
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    mockPost
      .mockResolvedValueOnce({ tasks: items(100) })
      .mockResolvedValueOnce({ tasks: [] });
    const result = await handleGetTasks({});
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });

  it("no probe when the page is not full", async () => {
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    mockPost.mockResolvedValue({ tasks: items(7) });
    const result = await handleGetTasks({});
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });
});

describe("list_custom_fields client-side pagination", () => {
  const fields = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `Field ${i + 1}` }));

  it("slices the full GET response and reports exact has_more", async () => {
    mockGet.mockResolvedValue({ customfields: fields(5) });
    const { handleListCustomFields } = await import("../src/tools/customfields.js");
    const result = await handleListCustomFields({ objectType: "task", pageSize: 3 });
    expect(mockGet).toHaveBeenCalledWith("customfield/task"); // endpoint unchanged — no server paging exists
    expect(result).toContain("Field 3");
    expect(result).not.toContain("Field 4");
    expect(result).toContain("has_more: true — next page: list_custom_fields with offset: 3.");
  });

  it("second page renders the remainder with has_more: false and offset-based numbering", async () => {
    mockGet.mockResolvedValue({ customfields: fields(5) });
    const { handleListCustomFields } = await import("../src/tools/customfields.js");
    const result = await handleListCustomFields({ objectType: "task", pageSize: 3, offset: 3 });
    expect(result).toContain("4. #4");
    expect(result).toContain("Field 5");
    expect(result).not.toContain("Field 3");
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });

  it("default call returns all fields unchanged (footer only added)", async () => {
    mockGet.mockResolvedValue({ customFields: fields(2) });
    const { handleListCustomFields } = await import("../src/tools/customfields.js");
    const result = await handleListCustomFields({ objectType: "task" });
    expect(result).toContain("Field 1");
    expect(result).toContain("Field 2");
    expect(result.split("\n").at(-1)).toBe("has_more: false");
  });
});

describe("footers are English (no Cyrillic)", () => {
  it("truncated and final-page footers carry no Cyrillic", async () => {
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    mockPost.mockResolvedValueOnce({ tasks: items(3) });
    const truncated = await handleGetTasks({ pageSize: 2 });
    expect(truncated.split("\n").at(-1)).not.toMatch(/[а-яА-ЯёЁ]/);
    mockPost.mockResolvedValueOnce({ tasks: items(1) });
    const final = await handleGetTasks({ pageSize: 2 });
    expect(final.split("\n").at(-1)).not.toMatch(/[а-яА-ЯёЁ]/);
  });
});
