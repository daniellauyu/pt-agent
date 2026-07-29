"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * 决策相关的逻辑一律复用浏览器插件里的实现，不在这里重写。
 *
 * 那些模块本来就是纯函数 + 注入依赖（fetch、存储区都从参数进），没有任何 chrome / DOM 调用，
 * 在 Node 里 require 进来就能直接用。共享一份的好处是：调整评分或 Free 判定时
 * 插件和终端版必然同步，不会出现"网页说推荐、终端说拒绝"这种对不上的情况。
 */
const EXTENSION_DIR = path.resolve(__dirname, "..", "..", "pt-agent-extension");

// 顺序有依赖：downloader-registry 用到 PT_AGENT_QB，store 用到 PT_AGENT_DOWNLOADER_TYPES。
const SHARED_MODULES = [
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

let loaded = false;

const load = () => {
  if (loaded) return engines();
  if (!fs.existsSync(EXTENSION_DIR)) {
    throw new Error(
      `找不到插件源码目录 ${EXTENSION_DIR}。终端版复用插件的决策引擎，请保持两个子项目在同一仓库下。`
    );
  }
  for (const file of SHARED_MODULES) {
    const full = path.join(EXTENSION_DIR, file);
    if (!fs.existsSync(full)) throw new Error(`缺少共享模块 ${full}`);
    require(full);
  }
  loaded = true;
  return engines();
};

const engines = () => ({
  assessment: globalThis.PT_AGENT_ASSESSMENT,
  admission: globalThis.PT_AGENT_ADMISSION,
  decision: globalThis.PT_AGENT_DECISION,
  guard: globalThis.PT_AGENT_GUARD,
  backfill: globalThis.PT_AGENT_MTEAM_BACKFILL,
  qb: globalThis.PT_AGENT_QB,
  downloaderTypes: globalThis.PT_AGENT_DOWNLOADER_TYPES,
  downloaderStore: globalThis.PT_AGENT_DOWNLOADER_STORE,
  siteStore: globalThis.PT_AGENT_SITE_STORE,
  router: globalThis.PT_AGENT_NETWORK_ROUTER,
  exclusions: globalThis.PT_AGENT_EXCLUSIONS,
  links: globalThis.PT_AGENT_TORRENT_LINKS
});

module.exports = { load, EXTENSION_DIR, SHARED_MODULES };
