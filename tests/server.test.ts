import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPlanfixServer } from "../src/index.js";

const READ_ONLY_TOOLS = [
  "get_tasks", "get_task", "get_contacts", "get_contact", "get_projects", "get_project",
  "get_comments", "list_users", "get_user", "list_directories", "list_directory_entries",
  "list_custom_fields", "list_datatags", "get_file",
  "get_task_full", "search_tasks", "get_task_time_entries",
];

const ADDITIVE_WRITE_TOOLS = ["create_task", "add_comment", "create_contact", "upload_file_from_url", "add_time_entry"];
const IDEMPOTENT_UPDATE_TOOLS = ["update_task", "update_contact"];

type ToolInfo = {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  inputSchema: { properties?: Record<string, { description?: string }> };
};

describe("createPlanfixServer (tools/list over an in-memory transport)", () => {
  let tools: ToolInfo[];

  beforeAll(async () => {
    const server = createPlanfixServer();
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    tools = (await client.listTools()).tools as unknown as ToolInfo[];
  });

  it("exposes exactly the 24 expected tools", () => {
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [...READ_ONLY_TOOLS, ...ADDITIVE_WRITE_TOOLS, ...IDEMPOTENT_UPDATE_TOOLS].sort(),
    );
  });

  it("annotates every read tool readOnly + idempotent", () => {
    for (const name of READ_ONLY_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations, name).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    }
  });

  it("annotates additive write tools non-readonly, non-destructive, non-idempotent", () => {
    for (const name of ADDITIVE_WRITE_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false });
    }
  });

  it("annotates update tools non-readonly, DESTRUCTIVE (they overwrite prior values), idempotent", () => {
    for (const name of IDEMPOTENT_UPDATE_TOOLS) {
      const t = tools.find((x) => x.name === name)!;
      expect(t.annotations, name).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: true });
    }
  });

  it("has no Cyrillic in any tool description or parameter .describe() string", () => {
    const cyrillic = /[а-яА-ЯёЁ]/;
    for (const t of tools) {
      expect(t.description ?? "", `${t.name} description`).not.toMatch(cyrillic);
      for (const [prop, def] of Object.entries(t.inputSchema.properties ?? {})) {
        expect(def.description ?? "", `${t.name}.${prop}`).not.toMatch(cyrillic);
      }
    }
  });

  it("every description carries an input example", () => {
    for (const t of tools) {
      expect(t.description ?? "", t.name).toMatch(/Input example: \{/);
    }
  });
});
