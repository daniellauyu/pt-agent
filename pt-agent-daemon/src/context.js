"use strict";

const { paths } = require("./paths");
const { createFileStorage } = require("./storage");
const { createConfig } = require("./config");
const { createLogger } = require("./logger");
const { load } = require("./engines");

/**
 * 把存储、配置、日志和插件共享的各个 store 组装成一个运行上下文。
 * CLI 的每条命令、WebUI 的每个请求都从这里拿依赖，不各自去 new。
 */
const createContext = ({ mirrorToConsole = true, minLevel = "debug" } = {}) => {
  const engines = load();
  const location = paths();
  const storage = createFileStorage(location.config);
  const config = createConfig(storage);
  const logger = createLogger({
    logFile: location.logFile,
    auditFile: location.auditFile,
    mirrorToConsole,
    minLevel
  });

  // presets 传空对象：终端版没有插件那份 private-config.js，配置一律来自 config.json。
  const downloaders = engines.downloaderStore.createStore(storage, {});
  const sites = engines.siteStore.createStore(storage, {});
  const exclusions = engines.exclusions.createStore(storage);
  const links = engines.links.createStore(storage);

  const state = {
    read: async () => {
      const data = await storage.get("ptAgentDaemonState");
      return data?.ptAgentDaemonState || {};
    },
    merge: async (patch) => {
      const current = await state.read();
      const next = { ...current, ...patch };
      await storage.set({ ptAgentDaemonState: next });
      return next;
    }
  };

  // 选站点时优先挑「真的能用」的那条。
  // 站点列表初始化会预置一条空的 M-Team 占位记录，如果只按「第一条启用的」来选，
  // 用户后来新增的、填了 Key 的那条会被这条空记录永久挡在后面。
  const activeSite = async () => {
    const all = await sites.list();
    const usable = all.filter((item) => item.enabled && item.apiKey);
    const site = usable.find((item) => item.type === "mteam") || usable[0] || await sites.active();
    if (!site) throw new Error("还没有配置站点。执行 ptagent site add --api-key <KEY> 或在 WebUI 的「设置 → 站点」里填写");
    if (!site.apiKey) {
      throw new Error(`站点 ${site.name} 还没填 API Key。执行 ptagent site add --api-key <KEY> 或在 WebUI 的「设置 → 站点」里填写`);
    }
    return site;
  };

  return { engines, paths: location, storage, config, logger, downloaders, sites, exclusions, links, state, activeSite };
};

module.exports = { createContext };
