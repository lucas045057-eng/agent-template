import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { diffFeatureBaseline } from "../scripts/guard.mjs";

const GUARD_SRC = fileURLToPath(new URL("../scripts/guard.mjs", import.meta.url));

test("diffFeatureBaseline：拦截删除已有项、修改 verification 与将 passing 降级，放行新增与正常升级", () => {
  const before = [
    { id: "F1", behavior: "a", verification: "node t1.mjs", state: "passing" },
    { id: "F2", behavior: "b", verification: "node t2.mjs", state: "active" },
  ];
  assert.deepEqual(
    diffFeatureBaseline(before, [
      { id: "F1", behavior: "a", verification: "node t1.mjs", state: "passing" },
      { id: "F2", behavior: "b", verification: "node t2.mjs", state: "passing" },
      { id: "F3", behavior: "c", verification: "node t3.mjs", state: "not_started" },
    ]),
    [],
  );
  assert.ok(diffFeatureBaseline(before, [before[1]]).some((p) => p.includes("F1 被删除")));
  assert.ok(
    diffFeatureBaseline(before, [
      { ...before[0], state: "active" },
      before[1],
    ]).some((p) => p.includes("状态被降级")),
  );
  assert.ok(
    diffFeatureBaseline(before, [
      { ...before[0], verification: "node weaker.mjs" },
      before[1],
    ]).some((p) => p.includes("验证命令被改动")),
  );
});

test("guard CLI：保护 scripts/ 自身、ops/delivery.json、passing 降级，且 CI 缺基线时 Fail-Closed", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "template-guard-"));
  const gitEnv = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  const git = (...args) => assert.equal(spawnSync("git", args, { cwd: dir, env: gitEnv, encoding: "utf8" }).status, 0);
  try {
    git("init", "-q", "--initial-branch=main");
    mkdirSync(path.join(dir, "scripts"), { recursive: true });
    mkdirSync(path.join(dir, "ops"), { recursive: true });
    writeFileSync(path.join(dir, "scripts/guard.mjs"), "console.log('orig');\n");
    writeFileSync(path.join(dir, "ops/delivery.json"), '{"repo":"o/r"}\n');
    writeFileSync(
      path.join(dir, "features.json"),
      JSON.stringify({ features: [{ id: "F1", behavior: "x", verification: "node x.mjs", state: "passing" }] }) + "\n",
    );
    git("add", ".");
    git("commit", "-qm", "base");

    // CI missing base must fail closed (exit 1)
    const missingBaseCi = spawnSync(process.execPath, [GUARD_SRC], {
      cwd: dir,
      env: { ...gitEnv, GUARD_BASE: "origin/nonexistent", GITHUB_ACTIONS: "true" },
      encoding: "utf8",
    });
    assert.equal(missingBaseCi.status, 1);

    git("checkout", "-qb", "pr");
    writeFileSync(path.join(dir, "scripts/guard.mjs"), "process.exit(0);\n");
    writeFileSync(path.join(dir, "ops/delivery.json"), '{"repo":"o/r2"}\n');
    writeFileSync(
      path.join(dir, "features.json"),
      JSON.stringify({ features: [{ id: "F1", behavior: "x", verification: "node x.mjs", state: "active" }] }) + "\n",
    );
    git("add", ".");
    git("commit", "-qm", "tamper");

    const blocked = spawnSync(process.execPath, [GUARD_SRC], {
      cwd: dir,
      env: { ...gitEnv, GUARD_BASE: "main", GITHUB_ACTIONS: "true" },
      encoding: "utf8",
    });
    assert.equal(blocked.status, 1);
    assert.match(blocked.stderr, /scripts\/guard\.mjs/);
    assert.match(blocked.stderr, /ops\/delivery\.json/);
    assert.match(blocked.stderr, /状态被降级/);

    const eventFile = path.join(dir, "event.json");
    writeFileSync(eventFile, JSON.stringify({ pull_request: { labels: [{ name: "baseline-approved" }] } }));
    const approved = spawnSync(process.execPath, [GUARD_SRC], {
      cwd: dir,
      env: { ...gitEnv, GUARD_BASE: "main", GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: eventFile },
      encoding: "utf8",
    });
    assert.equal(approved.status, 0, approved.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
