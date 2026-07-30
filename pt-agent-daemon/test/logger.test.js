"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createLogger } = require("../src/logger");

const makeLogger = (options = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptagent-log-"));
  return {
    root,
    logger: createLogger({
      logFile: path.join(root, "runtime.jsonl"),
      auditFile: path.join(root, "audit.jsonl"),
      mirrorToConsole: false,
      ...options
    })
  };
};

test("日志按行存 JSON，agent 可以逐行解析", async () => {
  const { logger } = makeLogger();
  await logger.info("scan:start", { dryRun: false });
  await logger.error("push:error", { title: "某个种子" });
  const raw = fs.readFileSync(logger.files.logFile, "utf8").trim().split("\n");
  assert.equal(raw.length, 2);
  const first = JSON.parse(raw[0]);
  assert.equal(first.event, "scan:start");
  assert.equal(first.level, "info");
  assert.deepEqual(first.data, { dryRun: false });
  assert.ok(Date.parse(first.at));
  assert.equal(fs.statSync(logger.files.logFile).mode & 0o777, 0o600);
});

test("日志写入和读取都会脱敏凭据、URL 参数与本机用户名", async () => {
  const { logger } = makeLogger();
  await logger.error("qb:error", {
    password: "plain-password",
    apiKey: "plain-api-key",
    downloadUrl: "https://m-team.cc/download?id=1&token=plain-token",
    message: "Bearer bearer-value at https://m-team.cc/api?token=query-secret",
    stack: "/Users/daniel/develop/pt-agent/file.js:1"
  });
  const raw = fs.readFileSync(logger.files.logFile, "utf8");
  assert.doesNotMatch(raw, /plain-password|plain-api-key|plain-token|bearer-value|query-secret|\/Users\/daniel/);
  const { records } = await logger.readLogs({});
  assert.equal(records[0].data.password, "[REDACTED]");
  assert.match(records[0].data.stack, /\/Users\/\[REDACTED\]/);

  fs.writeFileSync(logger.files.logFile, JSON.stringify({
    at: new Date().toISOString(),
    level: "error",
    event: "legacy",
    data: { secret: "old-secret" }
  }));
  const legacy = await logger.readLogs({});
  assert.equal(legacy.records[0].data.secret, "[REDACTED]");
});

test("按级别过滤：只看 error 时 info 不会混进来", async () => {
  const { logger } = makeLogger();
  await logger.debug("a", {});
  await logger.info("b", {});
  await logger.warn("c", {});
  await logger.error("d", {});
  const { records } = await logger.readLogs({ level: "warn" });
  assert.deepEqual(records.map((item) => item.event), ["c", "d"]);
});

test("按事件前缀过滤", async () => {
  const { logger } = makeLogger();
  await logger.info("push:add", {});
  await logger.info("push:verify", {});
  await logger.info("guard:done", {});
  const { records } = await logger.readLogs({ prefix: "push:" });
  assert.deepEqual(records.map((item) => item.event), ["push:add", "push:verify"]);
});

test("limit 取最近的若干条，同时报告总数", async () => {
  const { logger } = makeLogger();
  for (let index = 0; index < 10; index += 1) await logger.info(`e${index}`, {});
  const { records, total } = await logger.readLogs({ limit: 3 });
  assert.equal(total, 10);
  assert.deepEqual(records.map((item) => item.event), ["e7", "e8", "e9"]);
});

test("minLevel 能把 debug 噪音挡在文件之外", async () => {
  const { logger } = makeLogger({ minLevel: "info" });
  await logger.debug("noisy", {});
  await logger.info("useful", {});
  const { records } = await logger.readLogs({});
  assert.deepEqual(records.map((item) => item.event), ["useful"]);
});

test("审计记录字段与插件同构，便于同一套脚本分析两边导出", async () => {
  const { logger } = makeLogger();
  await logger.appendAudit({
    operation_id: "op_1",
    action: "guard_delete",
    status: "deleted",
    title: "某个种子",
    hash: "abc",
    reason: "Free 已到期保护删除",
    deleteFiles: true
  });
  const { records } = await logger.readAudit({});
  assert.equal(records.length, 1);
  assert.equal(fs.statSync(logger.files.auditFile).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(records[0]).sort(), [
    "action", "at", "deadline", "deleteFiles", "downloader", "hash",
    "operation_id", "progress", "reason", "site", "status", "title", "torrentId"
  ]);
  assert.equal(records[0].deleteFiles, true);
});

test("损坏的日志行被跳过，不会让整个日志页读不出来", async () => {
  const { logger } = makeLogger();
  await logger.info("good", {});
  fs.appendFileSync(logger.files.logFile, "{ 半行坏数据\n");
  await logger.info("also-good", {});
  const { records } = await logger.readLogs({});
  assert.deepEqual(records.map((item) => item.event), ["good", "also-good"]);
});

test("读不存在的日志文件返回空结果而不是抛错", async () => {
  const { logger } = makeLogger();
  assert.deepEqual(await logger.readLogs({}), { total: 0, records: [] });
});

test("清空只清运行日志，审计记录保留", async () => {
  const { logger } = makeLogger();
  await logger.info("x", {});
  await logger.appendAudit({ action: "enqueue", status: "queued" });
  await logger.clearLogs();
  assert.equal((await logger.readLogs({})).total, 0);
  assert.equal((await logger.readAudit({})).total, 1);
});

test("未捕获异常会被写进日志——守护进程没人盯着 stderr", async () => {
  const { logger } = makeLogger();
  logger.installProcessCapture();
  const handlers = process.listeners("uncaughtException");
  handlers.at(-1)(new Error("模拟崩溃"));
  await logger.flush();
  const { records } = await logger.readLogs({ level: "error" });
  assert.equal(records.at(-1).event, "runtime.uncaught-error");
  assert.equal(records.at(-1).data.message, "模拟崩溃");
  process.removeAllListeners("uncaughtException");
  process.removeAllListeners("unhandledRejection");
});
