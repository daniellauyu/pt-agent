"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * 决策相关的逻辑一律复用浏览器插件里的实现，不在这里重写。
 *
 * 那些模块本来就是纯函数 + 注入依赖（fetch、存储区都从参数进），没有任何 chrome / DOM 调用，
 * 在 Node 里 require 进来就能直接用。
 *
 * 它们以 vendor 副本的形式随本项目一起发布（见 vendor/engines/），所以守护进程可以
 * 脱离插件源码独立运行。副本由 `npm run sync-engines` 生成，MANIFEST.json 记录每个文件的
 * sha256；`npm run check-engines` 和 vendor-sync 测试会确认副本没被手改、也没落后于插件源文件——
 * 有两份副本时最大的风险就是它们悄悄跑偏，而且没人发现。
 */
const VENDOR_DIR = path.resolve(__dirname, "..", "vendor", "engines");

// 顺序有依赖：downloader-registry 用到 PT_AGENT_QB，两个 store 用到 PT_AGENT_DOWNLOADER_TYPES。
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
  if (!fs.existsSync(VENDOR_DIR)) {
    throw new Error(
      `找不到决策引擎目录 ${VENDOR_DIR}。完整仓库里执行 npm run sync-engines 生成；` +
      `单独发布的副本请确认打包时带上了 vendor/ 目录。`
    );
  }
  for (const file of SHARED_MODULES) {
    const full = path.join(VENDOR_DIR, file);
    if (!fs.existsSync(full)) {
      throw new Error(`缺少决策引擎模块 ${full}，执行 npm run sync-engines 重新同步`);
    }
    require(full);
  }
  loaded = true;
  return engines();
};

/** vendor 副本的来源信息，doctor 会显示它，便于确认跑的是哪一版决策逻辑。 */
const provenance = () => {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(VENDOR_DIR, "MANIFEST.json"), "utf8"));
    return { source: manifest.source, syncedAt: manifest.syncedAt, moduleCount: manifest.modules.length };
  } catch (_) {
    return null;
  }
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

module.exports = { load, provenance, VENDOR_DIR, SHARED_MODULES };
