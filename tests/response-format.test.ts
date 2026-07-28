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

const FULL_TASK = {
  id: 5,
  name: "Card",
  description: "long description body",
  status: { id: 1, name: "New" },
  priority: "High",
  assignees: { users: [{ id: 403, name: "Galogen" }] },
  project: { id: 9, name: "Proj" },
};

describe("get_tasks response_format", () => {
  it("CONCISE requests id,name,status and renders identifier-grade rows", async () => {
    mockPost.mockResolvedValue({ tasks: [FULL_TASK] });
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    const result = await handleGetTasks({ response_format: "CONCISE" });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({ fields: "id,name,status" }));
    expect(result).toContain("#5");
    expect(result).toContain("Card");
    expect(result).toContain("New");
    expect(result).not.toContain("Galogen");
    expect(result).not.toContain("Proj");
  });

  it("CONCISE overrides an explicit fields param", async () => {
    mockPost.mockResolvedValue({ tasks: [] });
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    await handleGetTasks({ response_format: "CONCISE", fields: "id,name,description" });
    expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({ fields: "id,name,status" }));
  });

  it("default (and explicit DETAILED) keep full fields and full rows", async () => {
    mockPost.mockResolvedValue({ tasks: [FULL_TASK] });
    const { handleGetTasks } = await import("../src/tools/tasks.js");
    for (const params of [{}, { response_format: "DETAILED" as const }]) {
      vi.clearAllMocks();
      mockPost.mockResolvedValue({ tasks: [FULL_TASK] });
      const result = await handleGetTasks(params);
      expect(mockPost).toHaveBeenCalledWith("task/list", expect.objectContaining({ fields: expect.stringContaining("assignees") }));
      expect(result).toContain("Galogen");
      expect(result).toContain("Proj");
    }
  });
});

describe("get_task response_format", () => {
  it("CONCISE requests id,name,status and drops the description block", async () => {
    mockGet.mockResolvedValue({ task: FULL_TASK });
    const { handleGetTask } = await import("../src/tools/tasks.js");
    const result = await handleGetTask({ taskId: 5, response_format: "CONCISE" });
    expect(mockGet).toHaveBeenCalledWith("task/5", { fields: "id,name,status" });
    expect(result).toContain("#5");
    expect(result).toContain("New");
    expect(result).not.toContain("long description body");
  });

  it("default keeps the full card including the description", async () => {
    mockGet.mockResolvedValue({ task: FULL_TASK });
    const { handleGetTask } = await import("../src/tools/tasks.js");
    const result = await handleGetTask({ taskId: 5 });
    expect(mockGet).toHaveBeenCalledWith("task/5", { fields: expect.stringContaining("description") });
    expect(result).toContain("long description body");
  });
});

describe("get_contacts response_format", () => {
  const CONTACT = { id: 3, name: "Acme", email: "a@b.c", phones: [{ number: "+123" }] };

  it("CONCISE requests id,name and renders id/name rows only", async () => {
    mockPost.mockResolvedValue({ contacts: [CONTACT] });
    const { handleGetContacts } = await import("../src/tools/contacts.js");
    const result = await handleGetContacts({ response_format: "CONCISE" });
    expect(mockPost).toHaveBeenCalledWith("contact/list", expect.objectContaining({ fields: "id,name" }));
    expect(result).toContain("#3");
    expect(result).toContain("Acme");
    expect(result).not.toContain("a@b.c");
    expect(result).not.toContain("+123");
  });

  it("default keeps email and phones", async () => {
    mockPost.mockResolvedValue({ contacts: [CONTACT] });
    const { handleGetContacts } = await import("../src/tools/contacts.js");
    const result = await handleGetContacts({});
    expect(result).toContain("a@b.c");
    expect(result).toContain("+123");
  });
});

describe("get_task_full response_format", () => {
  const COMMENTS = [
    { id: 71, dateTime: { datetime: "2026-07-24 10:00" }, owner: { id: 403, name: "Galogen" }, description: "secret comment text" },
  ];

  it("CONCISE trims task and comment fields; comment text omitted, ids/authors/dates kept", async () => {
    mockGet.mockResolvedValue({ task: FULL_TASK });
    mockPost.mockResolvedValue({ comments: COMMENTS });
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskFull({ taskId: 5, response_format: "CONCISE" });
    expect(mockGet).toHaveBeenCalledWith("task/5", { fields: "id,name,status" });
    expect(mockPost).toHaveBeenCalledWith("task/5/comments/list", expect.objectContaining({ fields: "id,dateTime,owner" }));
    expect(result).toContain("#71");
    expect(result).toContain("Galogen");
    expect(result).toContain("2026-07-24 10:00");
    expect(result).not.toContain("secret comment text");
    expect(result).not.toContain("long description body");
  });

  it("default keeps full task card and comment text", async () => {
    mockGet.mockResolvedValue({ task: FULL_TASK });
    mockPost.mockResolvedValue({ comments: COMMENTS });
    const { handleGetTaskFull } = await import("../src/tools/tasks.js");
    const result = await handleGetTaskFull({ taskId: 5 });
    expect(mockPost).toHaveBeenCalledWith("task/5/comments/list", expect.objectContaining({ fields: expect.stringContaining("description") }));
    expect(result).toContain("secret comment text");
    expect(result).toContain("long description body");
  });
});
