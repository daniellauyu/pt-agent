"use strict";

const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { redact } = require("./redact");

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const newOperationId = () => `op_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

// 日志按行存 JSON（JSONL）：既能 tail 看，也能被 agent 直接逐行 JSON.parse，
// 不需要先解析一个巨大的数组。
const parseLine = (line) => {
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" ? record : null;
  } catch (_) {
    return null;
  }
};

const summarize = (data) => {
  if (data === undefined || data === null) return "";
  if (typeof data === "string") return data;
  try {
    const text = JSON.stringify(data);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  } catch (_) {
    return String(data);
  }
};

const createLogger = ({
  logFile,
  auditFile,
  retention = 5000,
  auditRetention = 2000,
  mirrorToConsole = true,
  minLevel = "debug"
} = {}) => {
  let writes = 0;
  let queue = Promise.resolve();
  const threshold = LEVELS[minLevel] || LEVELS.debug;

  const serialize = (task) => {
    const next = queue.then(task, task);
    queue = next.then(() => {}, () => {});
    return next;
  };

  const appendLine = async (file, record, cap) => {
    const directory = path.dirname(file);
    await fsp.mkdir(directory, { recursive: true, mode: 0o700 });
    await fsp.chmod(directory, 0o700);
    await fsp.appendFile(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    await fsp.chmod(file, 0o600);
    writes += 1;
    // 每写 200 条裁剪一次，而不是每条都重写整个文件。
    if (writes % 200 === 0) await trim(file, cap);
  };

  const trim = async (file, cap) => {
    try {
      const raw = await fsp.readFile(file, "utf8");
      const lines = raw.split("\n").filter(Boolean);
      if (lines.length <= cap) return;
      await fsp.writeFile(file, `${lines.slice(-cap).join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
      await fsp.chmod(file, 0o600);
    } catch (error) {
      if (error.code !== "ENOENT") process.stderr.write(`[PT] 日志裁剪失败：${error.message}\n`);
    }
  };

  const write = (level, event, data, { operationId = null } = {}) => {
    if ((LEVELS[level] || LEVELS.info) < threshold) return Promise.resolve();
    const record = redact({
      at: new Date().toISOString(),
      level,
      event: String(event || "unknown"),
      operationId,
      data: data === undefined ? null : data
    });
    if (mirrorToConsole) {
      const stream = level === "error" || level === "warn" ? process.stderr : process.stdout;
      const detail = summarize(record.data);
      const time = record.at.slice(11, 19);
      stream.write(`[PT ${time}] ${level.toUpperCase().padEnd(5)} ${record.event}${detail ? ` ${detail}` : ""}\n`);
    }
    return serialize(() => appendLine(logFile, record, retention)).catch((error) => {
      process.stderr.write(`[PT] 日志写入失败：${error.message}\n`);
    });
  };

  /**
   * 生命周期审计。和插件里的审计记录同构，字段保持一致，
   * 这样两边导出的 JSON 可以放进同一个分析脚本。
   */
  const appendAudit = (record) => {
    const entry = redact({
      at: new Date().toISOString(),
      operation_id: record.operation_id || null,
      action: String(record.action || "unknown"),
      status: String(record.status || ""),
      title: record.title || "",
      site: record.site || "",
      torrentId: record.torrentId || "",
      hash: record.hash || "",
      deadline: record.deadline || "",
      progress: Number(record.progress || 0),
      downloader: record.downloader || "",
      reason: record.reason || "",
      deleteFiles: Boolean(record.deleteFiles)
    });
    return serialize(() => appendLine(auditFile, entry, auditRetention)).catch((error) => {
      process.stderr.write(`[PT] 审计写入失败：${error.message}\n`);
    });
  };

  const readRecords = async (file, { limit = 200, level = null, prefix = null, since = null } = {}) => {
    let raw = "";
    try {
      raw = await fsp.readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { total: 0, records: [] };
      throw error;
    }
    let records = raw.split("\n").filter(Boolean).map(parseLine).filter(Boolean).map((item) => redact(item));
    if (level) records = records.filter((item) => (LEVELS[item.level] || 0) >= (LEVELS[level] || 0));
    if (prefix) records = records.filter((item) => String(item.event || "").startsWith(prefix));
    if (since) records = records.filter((item) => item.at >= since);
    const total = records.length;
    return { total, records: limit > 0 ? records.slice(-limit) : records };
  };

  const clear = async (file) => {
    await fsp.rm(file, { force: true });
  };

  const logger = {
    debug: (event, data, options) => write("debug", event, data, options),
    info: (event, data, options) => write("info", event, data, options),
    warn: (event, data, options) => write("warn", event, data, options),
    error: (event, data, options) => write("error", event, data, options),
    appendAudit,
    newOperationId,
    readLogs: (options) => readRecords(logFile, options),
    readAudit: (options) => readRecords(auditFile, options),
    clearLogs: () => clear(logFile),
    clearAudit: () => clear(auditFile),
    flush: () => queue,
    files: { logFile, auditFile }
  };

  // 未捕获的异常和 Promise 拒绝也必须进日志。
  // 只打到 stderr 的错误在守护进程里等于消失了——没人盯着终端。
  logger.installProcessCapture = () => {
    process.on("uncaughtException", (error) => {
      logger.error("runtime.uncaught-error", {
        message: String(error?.message || error),
        stack: String(error?.stack || "").split("\n").slice(0, 6).join("\n")
      });
    });
    process.on("unhandledRejection", (reason) => {
      logger.error("runtime.unhandled-rejection", {
        message: String(reason?.message || reason),
        stack: String(reason?.stack || "").split("\n").slice(0, 6).join("\n")
      });
    });
    return logger;
  };

  return logger;
};

module.exports = { createLogger, newOperationId, summarize, redact, LEVELS };
