#!/usr/bin/env node
// 质量基线守卫：PR 只要改动了「质量基线」或削弱已通过功能项，就判 CI 失败。
//
// 保护的是这几样东西——它们决定「什么算做完」，一旦能随手改，闸门就形同虚设：
//   * AGENTS.md        —— 审查要点与硬约束
//   * Makefile         —— make check 到底跑什么
//   * ops/delivery.json —— 交付检查与审查入口设置
//   * .github/workflows/** —— CI 本身
//   * scripts/**       —— 守卫自身（guard.mjs）及 lint / features / e2e / build 等验证脚本
//   * features.json    —— 已有功能项的 verification、已有功能项不得删除、已 passing 功能项不得降级状态
//
// 允许改的：features.json 里非 passing 项推进为 passing / active / blocked，以及新增功能项。
//
// 需要改动基线时：让丞相审批，审批通过后给 PR 打 `baseline-approved` 标签，本守卫放行。
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

export const PROTECTED_FILES = ["AGENTS.md", "Makefile", "ops/delivery.json"];
export const PROTECTED_DIRS = [".github/workflows/", "scripts/"];
const FEATURES = "features.json";
const BYPASS_LABEL = "baseline-approved";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();

function labelsOfPullRequest() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return [];
  try {
    const event = JSON.parse(readFileSync(path, "utf8"));
    return (event.pull_request?.labels ?? []).map((label) => label.name);
  } catch {
    return [];
  }
}

export function diffFeatureBaseline(beforeFeatures, afterFeatures) {
  const problems = [];
  const afterById = new Map((afterFeatures ?? []).map((f) => [f.id, f]));
  for (const prev of beforeFeatures ?? []) {
    const cur = afterById.get(prev.id);
    if (!cur) {
      problems.push(`${FEATURES}: 已有功能项 ${prev.id} 被删除`);
      continue;
    }
    if (prev.verification !== cur.verification) {
      problems.push(`${FEATURES}: 功能项 ${prev.id} 的验证命令被改动（${prev.verification} → ${cur.verification}）`);
    }
    if (prev.state === "passing" && cur.state !== "passing") {
      problems.push(`${FEATURES}: 已通过功能项 ${prev.id} 的状态被降级（passing → ${cur.state}）`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const base = process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : process.env.GUARD_BASE || "origin/main";
  const inCi = process.env.GITHUB_ACTIONS === "true" || process.env.CI === "true";

  let baseSha;
  try {
    baseSha = git("merge-base", base, "HEAD");
  } catch (error) {
    if (inCi) {
      console.error(`[guard] CI 环境下找不到基线 ${base}（必须 fetch-depth: 0 且存在目标分支），拒绝放行：${error.message}`);
      process.exit(1);
    }
    console.log(`[guard] 本地找不到基线 ${base}（尚未推送到远端），跳过守卫。`);
    process.exit(0);
  }

  const changed = git("diff", "--name-only", `${baseSha}..HEAD`).split("\n").filter(Boolean);
  if (!changed.length) {
    console.log("[guard] 相对基线没有文件改动，跳过。");
    process.exit(0);
  }

  const bomFiles = [];
  for (const file of git("ls-files", "*.json").split("\n").filter(Boolean)) {
    if (!existsSync(file)) continue;
    const head = readFileSync(file).subarray(0, 3);
    if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) bomFiles.push(file);
  }
  if (bomFiles.length) {
    console.error("[guard] 下面这些 JSON 文件带 UTF-8 BOM，JSON.parse 会失败：");
    for (const f of bomFiles) console.error(`  - ${f}`);
    console.error("修法：sed -i '1s/^\\xEF\\xBB\\xBF//' <文件>");
    process.exit(1);
  }

  const labels = labelsOfPullRequest();
  const approved = labels.includes(BYPASS_LABEL);

  const problems = [];
  for (const file of changed) {
    if (PROTECTED_FILES.includes(file)) problems.push(`${file} 是质量基线文件`);
    else if (PROTECTED_DIRS.some((dir) => file.startsWith(dir))) problems.push(`${file} 属于受保护的守卫/CI/构建脚本目录`);
  }

  if (changed.includes(FEATURES)) {
    try {
      const before = JSON.parse(git("show", `${baseSha}:${FEATURES}`)).features ?? [];
      const after = JSON.parse(readFileSync(FEATURES, "utf8")).features ?? [];
      problems.push(...diffFeatureBaseline(before, after));
    } catch (error) {
      problems.push(`${FEATURES} 无法与基线比对：${error.message}`);
    }
  }

  if (!problems.length) {
    console.log(`[guard] 通过：相对 ${base} 改了 ${changed.length} 个文件，没有触碰质量基线。`);
    process.exit(0);
  }

  if (approved) {
    console.log("[guard] 触碰了质量基线，但 PR 带 baseline-approved 标签（丞相已批准），放行：");
    for (const p of problems) console.log(`  - ${p}`);
    process.exit(0);
  }

  console.error("[guard] 这个 PR 改动了质量基线，判定失败：");
  for (const p of problems) console.error(`  - ${p}`);
  console.error("");
  console.error(`确实需要改的话：请丞相审批，通过后给这个 PR 打 \`${BYPASS_LABEL}\` 标签，本检查就会放行。`);
  process.exit(1);
}
