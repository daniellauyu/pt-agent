"use strict";

const os = require("node:os");
const path = require("node:path");

// 所有运行时数据集中在一个目录，便于备份、迁移，也便于 agent 直接读取。
// 优先级：--home 参数（由 CLI 注入 PTAGENT_HOME）> 环境变量 > ~/.ptagent
const home = () => {
  const configured = String(process.env.PTAGENT_HOME || "").trim();
  return configured ? path.resolve(configured) : path.join(os.homedir(), ".ptagent");
};

const paths = () => {
  const root = home();
  return {
    root,
    config: path.join(root, "config.json"),
    state: path.join(root, "state.json"),
    logFile: path.join(root, "logs", "runtime.jsonl"),
    auditFile: path.join(root, "logs", "audit.jsonl"),
    pidFile: path.join(root, "ptagent.pid")
  };
};

module.exports = { home, paths };
