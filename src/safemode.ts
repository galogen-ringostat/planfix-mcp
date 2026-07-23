import { planfixGet } from "./client.js";

// Safe mode — deterministic guard (docs/TESTING.md § Safe mode).
// When PLANFIX_SAFE_MODE is on, every mutating tool must prove its target lives
// inside the dedicated test project (PLANFIX_TEST_PROJECT_ID) BEFORE issuing the
// mutating HTTP call. With safe mode off every guard is a no-op, so behavior is
// identical to a build without this module.

/**
 * Safe mode is ON when PLANFIX_SAFE_MODE is set to anything except an explicit
 * falsy value. The documented activation value is "1"; unrecognized truthy
 * values ("true", "yes", …) also enable it so a misspelled toggle fails safe
 * (guard on) rather than silently running unguarded against production.
 */
export function isSafeModeOn(): boolean {
  const raw = process.env.PLANFIX_SAFE_MODE?.trim().toLowerCase();
  if (raw === undefined || raw === "" || raw === "0" || raw === "false" || raw === "off" || raw === "no") {
    return false;
  }
  return true;
}

/** The configured test project id, or null when unset / not a positive integer. */
export function getTestProjectId(): number | null {
  const raw = process.env.PLANFIX_TEST_PROJECT_ID?.trim();
  if (!raw || !/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return id > 0 ? id : null;
}

/** Fail closed: safe mode ON without a valid test project id refuses every mutation. */
function requireTestProjectId(tool: string, target: string): number {
  const testProjectId = getTestProjectId();
  if (testProjectId === null) {
    throw new Error(
      `Safe mode: ${tool} on ${target} refused — PLANFIX_SAFE_MODE is set but PLANFIX_TEST_PROJECT_ID is unset or not a positive integer. ` +
      `Fix: set PLANFIX_TEST_PROJECT_ID to the MCP-TEST project id (see docs/TESTING.md § Layer 3).`,
    );
  }
  return testProjectId;
}

/** create_task guard: the new task must explicitly target the test project. */
export function assertCreateTaskAllowed(projectId: number | undefined): void {
  if (!isSafeModeOn()) return;
  const testProjectId = requireTestProjectId("create_task", "new task");
  if (projectId !== testProjectId) {
    throw new Error(
      `Safe mode: create_task refused — target project is ${projectId ?? "(not specified)"}, but only the test project ${testProjectId} (MCP-TEST) accepts writes in safe mode. ` +
      `Fix: pass projectId: ${testProjectId}.`,
    );
  }
}

/**
 * Guard for tools that mutate an existing task (update_task, add_comment, …):
 * resolves the task via GET first and refuses unless its project is the test
 * project. Tasks with no project, or an unreadable project, are refused (fail
 * closed). No-op when safe mode is off — no extra GET is issued.
 */
export async function assertTaskInTestProject(tool: string, taskId: number): Promise<void> {
  if (!isSafeModeOn()) return;
  const testProjectId = requireTestProjectId(tool, `task ${taskId}`);
  const result = await planfixGet(`task/${taskId}`, { fields: "id,project" });
  const actualProjectId = (result as { task?: { project?: { id?: unknown } } })?.task?.project?.id;
  if (actualProjectId !== testProjectId) {
    const actual = typeof actualProjectId === "number" ? `project ${actualProjectId}` : "no readable project";
    throw new Error(
      `Safe mode: ${tool} refused — task ${taskId} has ${actual}, not the test project ${testProjectId} (MCP-TEST). ` +
      `Fix: target a task inside project ${testProjectId} (create one with create_task).`,
    );
  }
}

/**
 * Blanket refusal for mutating tools whose target cannot be scoped to a project
 * (create_contact, update_contact, upload_file_from_url). Refused regardless of
 * PLANFIX_TEST_PROJECT_ID. No-op when safe mode is off.
 */
export function refuseUnscopedMutation(tool: string, target: string, reason: string): void {
  if (!isSafeModeOn()) return;
  throw new Error(
    `Safe mode: ${tool} on ${target} refused — ${reason}, so it cannot be confined to the test project. ` +
    `This tool cannot be used while safe mode is on. Report to the operator; do not attempt to disable safe mode.`,
  );
}
