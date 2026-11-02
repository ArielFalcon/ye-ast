import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteRefresh, defaultRemoteRefreshDeps, fetchArguments, REFRESH_LOCK_SUFFIX, remoteRefreshEnvironment } from "./remote-refresh.adapter.ts";
import type { RemoteRefreshDeps } from "./remote-refresh.adapter.ts";

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

const NOW = new Date("2026-11-02T10:00:00.000Z");
const DIGEST = { of: (text: string): string => createHash("sha256").update(text, "utf8").digest("hex") };

let scratch: string;
let counter = 0;

before(() => {
  scratch = mkdtempSync(join(tmpdir(), "ye-ast-refresh-"));
});

after(() => rmSync(scratch, { recursive: true, force: true }));

function caseDirectory(): string {
  counter += 1;
  const root = join(scratch, `case-${counter}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" }).trim();
}

function repository(path: string): string {
  mkdirSync(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  return path;
}

function commit(path: string, name: string, content: string): string {
  writeFileSync(join(path, name), content);
  git(path, "add", "-A");
  git(path, "commit", "-qm", name);
  return git(path, "rev-parse", "HEAD");
}

function branchFrom(path: string, name: string, file: string, content: string): string {
  git(path, "checkout", "-q", "-b", name);
  const sha = commit(path, file, content);
  git(path, "checkout", "-q", "main");
  return sha;
}

function orphanBranchFrom(path: string, name: string, file: string, content: string): string {
  git(path, "checkout", "-q", "--orphan", name);
  git(path, "rm", "-q", "-rf", ".");
  const sha = commit(path, file, content);
  git(path, "checkout", "-q", "main");
  return sha;
}

function depsFor(cacheDirectory: string, overrides: Partial<RemoteRefreshDeps> = {}): RemoteRefreshDeps {
  return {
    cacheDirectory,
    digest: DIGEST,
    pid: () => 4242,
    isAlive: () => true,
    sleep: async () => undefined,
    now: () => NOW,
    ...overrides,
  };
}

function mirrorOf(cacheBase: string, url: string): string {
  return join(cacheBase, "remotes", DIGEST.of(url));
}

function lockOf(cacheBase: string, url: string): string {
  return join(cacheBase, "remotes", `${DIGEST.of(url)}${REFRESH_LOCK_SUFFIX}`);
}

function refs(path: string): string[] {
  return git(path, "for-each-ref", "--format=%(refname)").split("\n").filter((ref) => ref !== "");
}

function hasObject(repo: string, sha: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", sha], { cwd: repo, env: GIT_ENV, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("the mirror is keyed by a digest of the url and is a private bare repository", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;

  const [answer] = await createRemoteRefresh(depsFor(join(root, "cache"), { protocols: "file" })).refresh([{ url }]);

  const mirror = mirrorOf(join(root, "cache"), url);
  assert.equal(answer!.mirror, mirror);
  assert.equal(statSync(mirror).mode & 0o077, 0);
  assert.equal(git(mirror, "rev-parse", "--is-bare-repository"), "true");
});

test("the listing states each branch and the default branch from --symref, ignoring tags and HEAD", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  const mainSha = commit(origin, "a.txt", "a\n");
  const devSha = branchFrom(origin, "dev", "b.txt", "b\n");
  git(origin, "tag", "v1");
  const url = `file://${origin}`;

  const [answer] = await createRemoteRefresh(depsFor(join(root, "cache"), { protocols: "file" })).refresh([{ url }]);

  assert.deepEqual(answer!.listing, { branches: [{ name: "dev", sha: devSha }, { name: "main", sha: mainSha }], defaultBranch: "main" });
  assert.equal(answer!.freshness.status, "verified");
});

test("every branch the mirror lacks is fetched under refs/ye-ast/heads", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  const mainSha = commit(origin, "a.txt", "a\n");
  const devSha = orphanBranchFrom(origin, "dev", "b.txt", "b\n");
  git(origin, "tag", "v1");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");

  await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);

  const mirror = mirrorOf(cacheBase, url);
  assert.equal(git(mirror, "for-each-ref", "--format=%(refname) %(objectname)", "refs/ye-ast/heads"), `refs/ye-ast/heads/dev ${devSha}\nrefs/ye-ast/heads/main ${mainSha}`);
  assert.equal(git(mirror, "for-each-ref", "refs/tags"), "");
});

test("a sha the mirror already holds is not fetched again, and two refreshes answer the same", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const real = defaultRemoteRefreshDeps.runGit!;
  const calls: string[][] = [];
  const refresh = createRemoteRefresh({
    ...depsFor(cacheBase, { protocols: "file" }),
    runGit: async (cwd, args, environment, signal) => {
      calls.push([...args]);
      return real(cwd, args, environment, signal);
    },
  });

  const [first] = await refresh.refresh([{ url }]);
  calls.length = 0;
  const [second] = await refresh.refresh([{ url }]);

  assert.deepEqual(second, first);
  assert.deepEqual(calls.filter((args) => args.includes("fetch")), []);
});

test("two requests that name one url share one refresh and one mirror", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const real = defaultRemoteRefreshDeps.runGit!;
  const calls: string[][] = [];
  const refresh = createRemoteRefresh({
    ...depsFor(cacheBase, { protocols: "file" }),
    runGit: async (cwd, args, environment, signal) => {
      calls.push([...args]);
      return real(cwd, args, environment, signal);
    },
  });

  const answers = await refresh.refresh([{ url }, { url }]);

  assert.deepEqual(answers[0], answers[1]);
  assert.deepEqual(answers.map((answer) => answer.freshness), [{ status: "verified" }, { status: "verified" }]);
  assert.deepEqual(readdirSync(join(cacheBase, "remotes")), [DIGEST.of(url)]);
  assert.equal(calls.filter((args) => args[0] === "ls-remote").length, 1);
});

test("a first refresh is seeded from the local clone of the url, and an existing mirror is never reseeded", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const seed = join(root, "seed");
  execFileSync("git", ["clone", "-q", origin, seed], { env: GIT_ENV });
  git(seed, "checkout", "-q", "-b", "local-only");
  const localSha = commit(seed, "local.txt", "local\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const refresh = createRemoteRefresh(depsFor(cacheBase, { protocols: "file" }));

  const [first] = await refresh.refresh([{ url, seed }]);
  const mirror = mirrorOf(cacheBase, url);
  assert.equal(first!.freshness.status, "verified");
  assert.equal(git(mirror, "rev-parse", "refs/ye-ast/seed/local-only"), localSha);
  assert.equal(hasObject(mirror, localSha), true);
  assert.deepEqual(refs(mirror).filter((ref) => !ref.startsWith("refs/ye-ast/")), []);

  const other = repository(join(root, "other"));
  commit(other, "marker.txt", "marker\n");
  const [second] = await refresh.refresh([{ url, seed: other }]);

  assert.equal(second!.freshness.status, "verified");
  assert.equal(refs(mirror).includes("refs/ye-ast/seed/marker"), false);
  assert.equal(git(mirror, "rev-parse", "refs/ye-ast/seed/local-only"), localSha);
});

test("a shallow seed is refused and leaves no mirror", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const seed = join(root, "shallow");
  execFileSync("git", ["clone", "-q", "--depth", "1", `file://${origin}`, seed], { env: GIT_ENV });
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");

  const [answer] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url, seed }]);

  assert.deepEqual(answer!.freshness, { status: "unverified", reason: "failed" });
  assert.equal(existsSync(mirrorOf(cacheBase, url)), false);
});

test("a shallow mirror is refused and removed", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const mirror = mirrorOf(cacheBase, url);
  mkdirSync(join(cacheBase, "remotes"), { recursive: true, mode: 0o700 });
  execFileSync("git", ["clone", "-q", "--bare", "--depth", "1", url, mirror], { env: GIT_ENV });
  chmodSync(mirror, 0o700);

  const [answer] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);

  assert.deepEqual(answer!.freshness, { status: "unverified", reason: "failed" });
  assert.equal(existsSync(mirror), false);
});

test("a lock held by a live pid answers the recorded listing as refresh-in-progress without running git", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const [first] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);
  writeFileSync(lockOf(cacheBase, url), "999");

  const refresh = createRemoteRefresh(
    depsFor(cacheBase, {
      protocols: "file",
      isAlive: (pid) => pid === 999,
      runGit: async () => {
        throw new Error("git must not run while the lock is held");
      },
    }),
  );
  const [answer] = await refresh.refresh([{ url }]);

  assert.deepEqual(answer!.listing, first!.listing);
  assert.deepEqual(answer!.freshness, { status: "unverified", reason: "refresh-in-progress", lastVerifiedAt: NOW.toISOString() });
});

test("a lock held by a dead pid is taken over", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);
  writeFileSync(lockOf(cacheBase, url), "777");

  const [answer] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file", isAlive: () => false })).refresh([{ url }]);

  assert.deepEqual(answer!.freshness, { status: "verified" });
  assert.equal(existsSync(lockOf(cacheBase, url)), false);
});

test("a rival refresh of the same url waits for the lock, never for the mirror's creation", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const real = defaultRemoteRefreshDeps.runGit!;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => { started = resolve; });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const holder = createRemoteRefresh({
    ...depsFor(cacheBase, { protocols: "file", pid: () => 100, isAlive: () => true }),
    runGit: async (cwd, args, environment, signal) => {
      started();
      await gate;
      return real(cwd, args, environment, signal);
    },
  });
  const first = holder.refresh([{ url }]);
  await reached;

  const rival = createRemoteRefresh(
    depsFor(cacheBase, {
      protocols: "file",
      pid: () => 200,
      isAlive: () => true,
      runGit: async () => {
        throw new Error("git must not run while another refresh holds the lock");
      },
    }),
  );
  let rivalAnswer: Awaited<ReturnType<typeof rival.refresh>>[number] | undefined;
  try {
    [rivalAnswer] = await rival.refresh([{ url }]);
  } finally {
    release();
  }
  const [verified] = await first;

  assert.deepEqual(rivalAnswer, { url, freshness: { status: "unverified", reason: "refresh-in-progress" } });
  assert.deepEqual(verified!.freshness, { status: "verified" });
});

test("an aborted signal answers the recorded listing with reason deadline", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const [first] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);
  const controller = new AbortController();
  controller.abort();

  const refresh = createRemoteRefresh(
    depsFor(cacheBase, {
      protocols: "file",
      runGit: async () => {
        throw new Error("git must not run after the signal aborted");
      },
    }),
  );
  const [answer] = await refresh.refresh([{ url }], controller.signal);

  assert.deepEqual(answer!.listing, first!.listing);
  assert.deepEqual(answer!.freshness, { status: "unverified", reason: "deadline", lastVerifiedAt: NOW.toISOString() });
});

test("a failed refresh answers the recorded listing and says failed", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const refresh = createRemoteRefresh(depsFor(cacheBase, { protocols: "file" }));
  const [first] = await refresh.refresh([{ url }]);
  rmSync(origin, { recursive: true, force: true });

  const [answer] = await refresh.refresh([{ url }]);

  const { detail, ...stated } = answer!.freshness as { status: string; reason?: string; lastVerifiedAt?: string; detail?: string };
  assert.deepEqual(answer!.listing, first!.listing);
  assert.deepEqual(stated, { status: "unverified", reason: "failed", lastVerifiedAt: NOW.toISOString() });
  assert.ok((detail ?? "").length > 0, "the failure carries git's stderr, which redaction masks before it leaves");
  assert.equal(answer!.mirror, mirrorOf(cacheBase, url));
});

test("the default protocols refuse a file:// URL", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");

  const [answer] = await createRemoteRefresh(depsFor(join(root, "cache"))).refresh([{ url: `file://${origin}` }]);

  const { detail, ...stated } = answer!.freshness as { status: string; reason?: string; lastVerifiedAt?: string; detail?: string };
  assert.deepEqual(stated, { status: "unverified", reason: "failed" });
  assert.match(detail ?? "", /transport|not allowed|fatal/i);
});

test("the refresh environment allows exactly the injected protocols and never prompts", () => {
  assert.equal(remoteRefreshEnvironment({ PATH: "/bin" }, undefined).GIT_ALLOW_PROTOCOL, "https:ssh");
  assert.equal(remoteRefreshEnvironment({ PATH: "/bin" }, "file").GIT_ALLOW_PROTOCOL, "file");
  assert.equal(remoteRefreshEnvironment({ PATH: "/bin" }, undefined).GIT_TERMINAL_PROMPT, "0");
});

test("a fetch carries the exact flags of decision 6 and one branch refspec", () => {
  assert.deepEqual(fetchArguments("https://example.com/repo.git", "dev"), [
    "-c", "core.hooksPath=/dev/null",
    "-c", "gc.auto=0",
    "-c", "maintenance.auto=false",
    "-c", "fetch.recurseSubmodules=false",
    "-c", "transfer.credentialsInUrl=die",
    "-c", "transfer.fsckObjects=true",
    "fetch",
    "--no-tags",
    "--no-recurse-submodules",
    "--no-write-fetch-head",
    "--no-auto-maintenance",
    "--porcelain",
    "--end-of-options",
    "https://example.com/repo.git",
    "+refs/heads/dev:refs/ye-ast/heads/dev",
  ]);
});

test("a branch name that check-ref-format rejects never enters a refspec", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  const mainSha = commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);
  const otherSha = "0123456789012345678901234567890123456789";
  const fetches: string[][] = [];
  const refresh = createRemoteRefresh(
    depsFor(cacheBase, {
      protocols: "file",
      runGit: async (_cwd, args) => {
        if (args[0] === "rev-parse") return { code: 0, stdout: "false\n", stderr: "" };
        if (args[0] === "ls-remote") return { code: 0, stdout: `ref: refs/heads/main\tHEAD\n${mainSha}\trefs/heads/main\n${otherSha}\trefs/heads/bad..name\n`, stderr: "" };
        if (args[0] === "cat-file") return { code: 1, stdout: "", stderr: "" };
        if (args[0] === "check-ref-format") return { code: args[2] === "main" ? 0 : 128, stdout: "", stderr: "" };
        fetches.push([...args]);
        return { code: 0, stdout: "", stderr: "" };
      },
    }),
  );

  const [answer] = await refresh.refresh([{ url }]);

  assert.equal(answer!.freshness.status, "verified");
  assert.deepEqual(fetches.map((args) => args.at(-1)), ["+refs/heads/main:refs/ye-ast/heads/main"]);
});

test("a directory open to other accounts is refused and no git runs", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const [first] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);
  chmodSync(join(cacheBase, "remotes"), 0o755);
  const refresh = createRemoteRefresh(
    depsFor(cacheBase, {
      protocols: "file",
      runGit: async () => {
        throw new Error("git must not run on a directory open to other accounts");
      },
    }),
  );
  const [answer] = await refresh.refresh([{ url }]);

  assert.deepEqual(answer, {
    url,
    listing: first!.listing,
    freshness: { status: "unverified", reason: "failed", lastVerifiedAt: NOW.toISOString() },
    mirror: mirrorOf(cacheBase, url),
  });
});

test("a failure's detail is git's stderr only: bounded, and dropped when git said nothing", async () => {
  const root = caseDirectory();
  const origin = repository(join(root, "origin"));
  commit(origin, "a.txt", "a\n");
  const url = `file://${origin}`;
  const cacheBase = join(root, "cache");
  const [seeded] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file" })).refresh([{ url }]);
  assert.deepEqual(seeded!.freshness, { status: "verified" });
  const failsListingWith = (stderr: string) =>
    async (_cwd: string, args: readonly string[]) => {
      if (args.includes("ls-remote")) return { code: 1, stdout: "", stderr };
      if (args.includes("--is-shallow-repository")) return { code: 0, stdout: "false\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };

  const [bounded] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file", runGit: failsListingWith("f".repeat(5000)) })).refresh([{ url }]);
  const [blank] = await createRemoteRefresh(depsFor(cacheBase, { protocols: "file", runGit: failsListingWith("  \n\t ") })).refresh([{ url }]);

  const detailOf = (answer: { freshness: unknown } | undefined): string | undefined => (answer!.freshness as { detail?: string }).detail;
  assert.equal(detailOf(bounded)?.length, 2000);
  assert.equal(detailOf(blank), undefined);
  assert.deepEqual(blank!.freshness, { status: "unverified", reason: "failed", lastVerifiedAt: NOW.toISOString() });
});
