import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function skillMyTasks(server: McpServer): void {
  server.prompt(
    "skill-my-tasks",
    "My tasks for today — lists tasks that are due today or overdue.",
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              "Find the current user's employee ID with list_users, then call search_tasks with assigneeId set to it",
              "(fall back to get_tasks paging only if the assignee is unknown).",
              "From the results keep only the tasks where:",
              "1. endDate is today or already past (overdue)",
              "2. The task is not in a completed/closed status",
              "",
              "Output the result in this format:",
              "My tasks for today:",
              "- [ID] Task name | Project: ... | Deadline: ... | Status: ...",
              "",
              "If there are no due or overdue tasks, say: 'All clear — nothing due or overdue.'",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}

export function skillCreateTask(server: McpServer): void {
  server.prompt(
    "skill-create-task",
    "Create a task in a project — an assistant flow for creating a task with project and assignee selection.",
    {
      description: z.string().describe("Short task description, e.g.: 'Prepare the March report'"),
    },
    async ({ description }) => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `The user wants to create a task: "${description}"`,
              "",
              "Steps:",
              "1. Use search_projects (or get_projects) to find candidate projects",
              "2. Show the user the project list and ask which project the task belongs in",
              "3. After the project is chosen, call create_task with:",
              "   - name: a short title derived from the description",
              "   - description: the full description",
              "   - projectId: the chosen project's ID",
              "4. Confirm the task was created and show its ID",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
