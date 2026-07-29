#!/usr/bin/env node
"use strict";

// 把浏览器插件里的决策引擎同步进 vendor/engines/，让守护进程可以单独发布。
//
// 为什么是"拷贝 + 校验"而不是"拷贝了事"：
// 决策逻辑有两份副本，最大的风险是它们悄悄跑偏——插件那边改了评分，
// 终端版还按老规则跑，而且没人会发现。所以每个文件都记 sha256，
// 由 --check 和测试来保证「vendor 副本和插件源文件逐字节一致」。

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const VENDOR_DIR = path.join(ROOT, "vendor", "engines");
const MANIFEST_PATH = path.join(VENDOR_DIR, "MANIFEST.json");
const SOURCE_DIR = path.resolve(ROOT, "..", "pt-agent-extension");

// 顺序即加载顺序，有依赖关系：
// downloader-registry 用到 PT_AGENT_QB，两个 store 用到 PT_AGENT_DOWNLOADER_TYPES。
const MODULES = [
  "assessment-engine.js",
  "admission-engine.js",
  "decision-engine.js",
  "guard-engine.js",
  "mteam-backfill.js",
  "qb-client.js",
  "downloader-registry.js",
  "downloader-store.js",
  "site-store.js",
  "network-router.js",
  "exclusion-store.js",
  "torrent-links.js"
];

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

const readManifest = () => {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (_) {
    return null;
  }
};

const sync = () => {
  if (!fs.existsSync(SOURCE_DIR)) {
    throw new Error(
      `找不到插件源码目录 ${SOURCE_DIR}。同步只能在完整仓库里做；` +
      `单独发布出去的副本请直接用 vendor/engines/ 里已有的文件。`
    );
  }
  fs.mkdirSync(VENDOR_DIR, { recursive: true });
  const files = {};
  for (const name of MODULES) {
    const source = path.join(SOURCE_DIR, name);
    if (!fs.existsSync(source)) throw new Error(`插件里缺少 ${name}`);
    const content = fs.readFileSync(source);
    fs.writeFileSync(path.join(VENDOR_DIR, name), content);
    files[name] = sha256(content);
  }
  const manifest = {
    source: "pt-agent-extension",
    syncedAt: new Date().toISOString(),
    note: "由 npm run sync-engines 生成，请勿手工编辑 vendor/engines/ 下的任何文件。",
    modules: MODULES,
    files
  };
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
};

/**
 * 校验 vendor 副本。
 * 两层：
 *   1. 副本 vs MANIFEST —— 有人手改了 vendor 文件就会被抓出来（单独发布的副本也能查）。
 *   2. 副本 vs 插件源文件 —— 插件改了但没同步就会被抓出来（只在完整仓库里能查）。
 */
const check = () => {
  const manifest = readManifest();
  const problems = [];
  if (!manifest) return { ok: false, problems: ["缺少 vendor/engines/MANIFEST.json，先跑 npm run sync-engines"] };

  for (const name of MODULES) {
    const vendored = path.join(VENDOR_DIR, name);
    if (!fs.existsSync(vendored)) {
      problems.push(`vendor 里缺少 ${name}`);
      continue;
    }
    const content = fs.readFileSync(vendored);
    if (sha256(content) !== manifest.files[name]) {
      problems.push(`${name} 与 MANIFEST 记录不符——vendor 目录被手工改过`);
      continue;
    }
    const source = path.join(SOURCE_DIR, name);
    if (fs.existsSync(source) && sha256(fs.readFileSync(source)) !== manifest.files[name]) {
      problems.push(`${name} 落后于插件源文件——跑 npm run sync-engines`);
    }
  }
  return { ok: problems.length === 0, problems, manifest, sourceAvailable: fs.existsSync(SOURCE_DIR) };
};

if (require.main === module) {
  const isCheck = process.argv.includes("--check");
  try {
    if (isCheck) {
      const result = check();
      result.problems.forEach((problem) => process.stderr.write(`✘ ${problem}\n`));
      if (result.ok) {
        process.stdout.write(
          `✔ vendor/engines 与 MANIFEST 一致${result.sourceAvailable ? "，且与插件源文件逐字节相同" : "（当前没有插件源码，跳过源文件比对）"}\n`
        );
      }
      process.exit(result.ok ? 0 : 1);
    }
    const manifest = sync();
    process.stdout.write(`✔ 已同步 ${manifest.modules.length} 个模块，来源 ${SOURCE_DIR}\n`);
  } catch (error) {
    process.stderr.write(`✘ ${String(error?.message || error)}\n`);
    process.exit(1);
  }
}

module.exports = { MODULES, VENDOR_DIR, SOURCE_DIR, MANIFEST_PATH, check, sync, sha256 };
