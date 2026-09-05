// Coding Agent sandbox runtime — public entry point (spec §20, P2-CODING).
//
// This barrel re-exports the workspace + sandbox policy and adds the
// `withWorkspace()` helper that ensures cleanup ALWAYS runs.
//
// Usage:
//   import { withWorkspace } from "@/lib/coding";
//   const result = await withWorkspace(taskId, async (ws) => {
//     await ws.writeFile("hello.txt", "hi");
//     return ws.exec(["node", "-e", "console.log(1+1)"]);
//   });
//   // workspace is gone here, even if the callback threw.

export {
  CodingWorkspace,
  // types
  type ExecResult,
  type ExecOpts,
  type TestResult,
  type RunTestsOpts,
  type GitCloneOpts,
  type InstallDepsOpts,
} from "@/lib/coding/workspace";

export {
  SANDBOX_ALLOWED_COMMANDS,
  MAX_WORKSPACE_SIZE_MB,
  MAX_EXECUTION_TIME_MS,
  MAX_TOTAL_EXECUTION_TIME_MS,
  SandboxPolicyError,
  assertCommandAllowed,
  clampExecTimeout,
} from "@/lib/coding/sandbox-policy";

import { CodingWorkspace } from "@/lib/coding/workspace";

// ---------------------------------------------------------------------------
// withWorkspace — try/finally helper
// ---------------------------------------------------------------------------

/**
 * Create a {@link CodingWorkspace} for `taskId`, run `fn(workspace)`, and
 * ALWAYS clean up — even if `fn` throws. Returns whatever `fn` returns
 * (or re-throws the original error after cleaning up).
 *
 * This is the recommended way to use a workspace from the Coding Agent.
 * Manually calling `cleanup()` is error-prone: a thrown error between
 * creation and cleanup leaves the temp dir behind.
 *
 * @param taskId  the agent's taskId — used as the workspace suffix
 * @param fn      the work to do inside the workspace
 */
export async function withWorkspace<T>(
  taskId: string,
  fn: (workspace: CodingWorkspace) => Promise<T>
): Promise<T> {
  const ws = new CodingWorkspace(taskId);
  try {
    await ws.ensure();
    return await fn(ws);
  } finally {
    await ws.cleanup();
  }
}
