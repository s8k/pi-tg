// Git branch probe for the session card (`🌿 branch: <name>` under the dir
// line). One `git rev-parse --abbrev-ref HEAD` in the session cwd — fast
// (~10–50 ms), bounded by a timeout + race; every failure mode (no git, not
// a repo, empty output, timeout) resolves `undefined` → the card omits the
// line. This module never throws.
import { test } from "node:test";
import assert from "node:assert/strict";
import { probeGitBranch } from "../src/git.ts";

type FakeExecFile = (cmd: string, args: string[], opts: unknown, cb: (err: Error | null, stdout?: string) => void) => void;

test("probeGitBranch: happy path → branch name (query + cwd are right)", async () => {
  const seen: Array<{ cmd: string; args: string[] }> = [];
  const fake: FakeExecFile = (cmd, args, _opts, cb) => {
    seen.push({ cmd, args });
    cb(null, "feat/session-cost-card\n");
  };
  assert.equal(await probeGitBranch("/proj", { execFile: fake }), "feat/session-cost-card");
  assert.equal(seen[0]?.cmd, "git");
  assert.deepEqual(seen[0]?.args, ["-C", "/proj", "rev-parse", "--abbrev-ref", "HEAD"]);
});

test("probeGitBranch: detached HEAD passes through (rev-parse says 'HEAD')", async () => {
  const fake: FakeExecFile = (_c, _a, _o, cb) => cb(null, "HEAD\n");
  assert.equal(await probeGitBranch("/proj", { execFile: fake }), "HEAD");
});

test("probeGitBranch: not a repo / git missing → undefined (error callback)", async () => {
  const fake: FakeExecFile = (_c, _a, _o, cb) => cb(new Error("fatal: not a git repository"));
  assert.equal(await probeGitBranch("/proj", { execFile: fake }), undefined);
});

test("probeGitBranch: empty/whitespace output → undefined; throws synchronously → undefined", async () => {
  const empty: FakeExecFile = (_c, _a, _o, cb) => cb(null, "  \n");
  assert.equal(await probeGitBranch("/proj", { execFile: empty }), undefined);
  const syncThrow: FakeExecFile = () => { throw new Error("spawn EACCES"); };
  assert.equal(await probeGitBranch("/proj", { execFile: syncThrow }), undefined);
});

test("probeGitBranch: a stuck git never delays the card past timeoutMs", async () => {
  const fake: FakeExecFile = () => { /* never calls back */ };
  const started = Date.now();
  assert.equal(await probeGitBranch("/proj", { execFile: fake, timeoutMs: 60 }), undefined);
  assert.ok(Date.now() - started < 500, "the race resolved well before the probe 'returned'");
});
