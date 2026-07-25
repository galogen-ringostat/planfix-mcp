// CLAUDE.md § Working language (operator decision 2026-07-26): ALL
// server-authored text is English — errors, descriptions, AND rendered-output
// labels/templates. Only DATA echoed from Planfix keeps its source language.
// Enforced two ways:
//   1. A source-level scan: no Cyrillic anywhere under src/ (templates, error
//      strings, comments — data never lives in source).
//   2. Rendered-output smoke tests: every formatter, fed neutral data, must
//      emit zero Cyrillic (catches dynamic composition the scan cannot).
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const CYRILLIC = /[а-яА-ЯёЁ]/;

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return tsFiles(p);
    return name.endsWith(".ts") ? [p] : [];
  });
}

describe("English-only server text", () => {
  it("no Cyrillic anywhere in src/ (templates, errors, comments)", () => {
    for (const file of tsFiles(join(__dirname, "..", "src"))) {
      const lines = readFileSync(file, "utf-8").split("\n");
      lines.forEach((line, i) => {
        expect(line, `${file}:${i + 1}`).not.toMatch(CYRILLIC);
      });
    }
  });

  it("every list formatter renders English-only templates (empty + populated + paged)", async () => {
    const f = await import("../src/format.js");
    const empty = { tasks: [], contacts: [], projects: [], users: [], comments: [], directories: [], directoryEntries: [], customFields: [], dataTags: [], items: [], dataTagEntries: [] };
    const item = { id: 1, name: "Data", status: { id: 2, name: "Active" } };
    const three = (key: string) => ({ [key]: [item, { ...item, id: 2 }, { ...item, id: 3 }] });

    const outputs = [
      f.formatTaskList(empty, 50, 0, false),
      f.formatTaskList(three("tasks"), 2, 0, true),
      f.formatSingleTask({ task: { ...item, description: "d", priority: 1, assignees: { users: [{ id: 5, name: "N" }] }, endDateTime: { date: "01-01-2026" } } }),
      f.formatTaskSearchList(empty, 50, 0, false),
      f.formatTaskSearchList(three("tasks"), 2, 0, true),
      f.formatTaskFull({ task: item }, { comments: [] }, { taskId: 1, limit: 10, hasMore: false }),
      f.formatTaskFull({ task: item }, { comments: [{ id: 9, owner: { id: 1, name: "A" }, dateTime: { date: "01-01-2026" }, description: "t" }] }, { taskId: 1, limit: 10, hasMore: false }),
      f.formatContactList(empty, 50, 0, false),
      f.formatContactList({ contacts: [{ id: 1, name: "C", email: "e@x.com", phones: [{ number: "1" }], company: { id: 2, name: "Co" } }] }, 50, 0, false),
      f.formatProjectList(empty, 50, 0, false),
      f.formatProjectSearchList(empty, 50, 0, false),
      f.formatProjectSearchList(three("projects"), 2, 0, true),
      f.formatSingleProject({ project: { ...item, description: "d", owner: { id: "user:1", name: "O" } } }),
      f.formatProjectOverview({
        projectResp: { project: item }, scanned: 300, scanCapped: true, activeCount: 1, closedCount: 299,
        byStatus: [["Done", 299], ["New", 1]], recentDays: 30, recentCount: 100, recentCapped: true,
        recentTasks: [{ id: 1, name: "T", status: { id: 1, name: "New" }, dateOfLastUpdate: { date: "01-01-2026" } }], recentLimit: 10,
      }),
      f.formatProjectOverview({
        projectResp: { project: item }, scanned: 0, scanCapped: false, activeCount: 0, closedCount: 0,
        byStatus: [], recentDays: 30, recentCount: 0, recentCapped: false, recentTasks: [], recentLimit: 10,
      }),
      f.formatUserList({ users: [{ id: 1, name: "U", email: "u@x.com", position: { id: 1, name: "Dev" } }] }, 50, 0, true),
      f.formatCommentList(empty, 50, 0, false),
      f.formatDirectoryList(empty, 50, 0, false),
      f.formatDirectoryEntryList(empty, 50, 0, false),
      f.formatCustomFieldList({ customFields: [{ id: 1, name: "F", type: { id: 2, name: "T" } }] }, 50, 0, false),
      f.formatDatatagList(empty, 50, 0, false),
      f.formatChecklist({ items: [{ id: 1, name: "I", isDone: true, assignees: { users: [{ id: 1, name: "A" }] } }] }, 50, 0, true, 123),
      f.formatChecklist(empty, 50, 0, false, 123),
      f.formatTimeEntryList(empty, 50, 0, { date: 1, time: 2, user: 3, type: 4, comment: 5 }),
      f.formatTimeEntryList({ dataTagEntries: [{ key: 1, customFieldData: [] }, { key: 2, customFieldData: [] }] }, 1, 0, { date: 1, time: 2, user: 3, type: 4, comment: 5 }),
      f.formatFile({ file: { id: 1, name: "f.pdf", size: 10 } }),
      f.formatCreated("Task", { result: "success", id: 1 }),
      f.formatCreated("Task", {}),
      f.formatUpdated("Task", 1),
    ];

    for (const out of outputs) {
      expect(out).not.toMatch(CYRILLIC);
    }
  });

  it("Planfix DATA keeps its source language while templates stay English", async () => {
    const f = await import("../src/format.js");
    const out = f.formatSingleTask({ task: { id: 1, name: "Задача из Планфикса", status: { id: 1, name: "Новая" } } });
    expect(out).toContain("Задача из Планфикса"); // data passes through untouched
    expect(out).toContain("status: Новая (#1)");  // label English, value is data
  });
});
