// Git branch probe for the session card (`🌿 branch: <name>` under the dir
// line).
//
// One `git -C <cwd> rev-parse --abbrev-ref HEAD` per card render — fast
// (~10–50 ms), bounded by execFile's own `timeout` plus a Promise.race
// (defense in depth, mirroring the GPU probe). Every failure mode — no git
// on PATH, not a repository, empty output, timeout, synchronous spawn
// failure — resolves `undefined`; this module never throws. Detached HEAD
// passes through as the literal `HEAD` (rev-parse's own answer, honest).
import { execFile } from "node:child_process";

export const GIT_BRANCH_TIMEOUT_MS = 1000; // typical call is ~10–50 ms

export interface GitProbeOptions {
  timeoutMs?: number;
  /** Injectable for tests; defaults to child_process.execFile. */
  execFile?: (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout?: string) => void) => void;
}

/**
 * The current branch of the repo at `cwd`, or `undefined` when it can't be
 * determined (no git, not a repo, empty output, timeout).
 */
export function probeGitBranch(cwd: string, opts: GitProbeOptions = {}): Promise<string | undefined> {
  const timeoutMs = opts.timeoutMs ?? GIT_BRANCH_TIMEOUT_MS;
  const run =
    opts.execFile ??
    ((cmd, args, _o, cb) =>
      execFile(cmd, args, { timeout: timeoutMs }, (err, stdout) => cb(err ?? null, stdout)));
  const attempt = () =>
    new Promise<string | undefined>((resolve) => {
      try {
        run("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {}, (err, out) => {
          if (err) return resolve(undefined);
          const branch = (out ?? "").trim();
          resolve(branch === "" ? undefined : branch);
        });
      } catch {
        resolve(undefined); // synchronous spawn failure
      }
    });
  return Promise.race([
    attempt(),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), timeoutMs).unref()),
  ]);
}
