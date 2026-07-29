const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

const source = fs.readFileSync(path.join(__dirname, "logger.js"), "utf8");

const loadLogger = (chrome = {}) => {
  const context = {
    URL,
    crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} },
    chrome
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return context.PT_AGENT_LOGGER;
};

test("redacts credentials, download URLs, URL queries, and bearer tokens recursively", () => {
  const logger = loadLogger();
  const safe = logger.redact({
    password: "secret",
    nested: {
      apiKey: "key-123",
      downloadUrl: "https://m-team.cc/download?id=1&token=usable",
      message: "failed at https://m-team.cc/api?q=secret with Bearer abc.def and passkey=still-hidden"
    }
  });
  const serialized = JSON.stringify(safe);
  assert.doesNotMatch(serialized, /secret|key-123|usable|abc\.def/);
  assert.doesNotMatch(serialized, /still-hidden/);
  assert.equal(safe.password, "[REDACTED]");
  assert.equal(safe.nested.downloadUrl, "[REDACTED]");
  assert.match(safe.nested.message, /https:\/\/m-team\.cc\/api/);
});

test("creates versioned structured entries with an operation id", () => {
  const logger = loadLogger();
  const entry = logger.createEntry({
    level: "warn",
    event: "qb.request.rejected",
    operationId: "op_test",
    data: { status: 403 }
  });
  assert.equal(entry.level, "warn");
  assert.equal(entry.service, "extension");
  assert.equal(entry.component, "qb");
  assert.equal(entry.operation_id, "op_test");
  assert.equal(entry.schema_version, 1);
  assert.ok(entry.id.startsWith("log_"));
});

test("storage owner serializes diagnostic and audit writes", async () => {
  const data = {};
  const listeners = [];
  const chrome = {
    storage: {
      local: {
        async get(key) {
          return { [key]: data[key] };
        },
        async set(update) {
          Object.assign(data, update);
        }
      }
    },
    runtime: {
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage() { throw new Error("owner should write directly"); }
    }
  };
  const logger = loadLogger(chrome);
  logger.installStorageOwner();
  logger.write(logger.createEntry({ event: "scan.started", data: { apiKey: "hidden" } }));
  await logger.appendAudit({
    action: "enqueue",
    status: "queued",
    operation_id: "op_1",
    downloadUrl: "https://m-team.cc/download?token=hidden"
  });
  const logs = await logger.list();
  const audit = await logger.listAudit();
  assert.equal(listeners.length, 1);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].data.apiKey, "[REDACTED]");
  assert.equal(audit[0].operation_id, "op_1");
  assert.equal(audit[0].downloadUrl, "[REDACTED]");
});

// logger 在 vm 里用的是注入的 console，这里单独造一个可捕获的上下文
const loadLoggerWithConsole = () => {
  const lines = [];
  const capture = (line) => lines.push(line);
  const context = {
    URL,
    crypto: webcrypto,
    console: { log: capture, warn: capture, error: capture },
    chrome: {}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { logger: context.PT_AGENT_LOGGER, lines };
};

test("puts the payload into the console message instead of [object Object]", () => {
  const { logger, lines } = loadLoggerWithConsole();
  logger.write({ event: "qb:res-error", level: "error", data: { status: 409, detail: "Conflict" } });
  // Chrome 的扩展错误页只 stringify 第二个参数，详情必须拼进消息字符串
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[PT\] qb:res-error/);
  assert.match(lines[0], /409/);
  assert.match(lines[0], /Conflict/);
  assert.doesNotMatch(lines[0], /\[object Object\]/);
});

test("truncates an oversized payload so the console stays readable", () => {
  const { logger, lines } = loadLoggerWithConsole();
  logger.write({ event: "qb:res", level: "info", data: { body: "x".repeat(5000) } });
  assert.ok(lines[0].length < 600, `期望被截断，实际长度 ${lines[0].length}`);
  assert.match(lines[0], /…$/);
});

test("logs an event with no payload without a trailing separator", () => {
  const { logger, lines } = loadLoggerWithConsole();
  logger.write({ event: "boot", level: "info", data: null });
  assert.equal(lines[0], "[PT] boot");
});

test("captures uncaught errors and rejections that only reached Chrome's error page", () => {
  const captured = [];
  const listeners = {};
  const scope = {
    addEventListener: (type, handler) => { listeners[type] = handler; }
  };
  const { logger } = loadLoggerWithConsole();
  assert.equal(logger.installErrorCapture(scope, (event, data) => captured.push({ event, data })), true);

  listeners.error({
    message: "Cannot read properties of undefined",
    filename: "popup.js",
    lineno: 42,
    colno: 7,
    error: { stack: "Error: boom\n  at a\n  at b" }
  });
  listeners.unhandledrejection({ reason: { message: "qBittorrent 请求失败（HTTP 409）", stack: "at x" } });

  assert.equal(captured.length, 2);
  assert.equal(captured[0].event, "runtime.uncaught-error");
  assert.equal(captured[0].data.source, "popup.js:42:7");
  assert.match(captured[0].data.message, /Cannot read properties/);
  assert.equal(captured[1].event, "runtime.unhandled-rejection");
  assert.match(captured[1].data.message, /HTTP 409/);
});

test("does not loop when the log sink itself throws", () => {
  const listeners = {};
  const scope = { addEventListener: (type, handler) => { listeners[type] = handler; } };
  const { logger } = loadLoggerWithConsole();
  let calls = 0;
  logger.installErrorCapture(scope, () => {
    calls += 1;
    throw new Error("sink exploded");
  });
  assert.doesNotThrow(() => listeners.error({ message: "boom" }));
  assert.equal(calls, 1, "记录日志失败不能反复触发自身");
});

test("persists the log locally when the service worker cannot be reached", async () => {
  const stored = {};
  const chrome = {
    runtime: { sendMessage: async () => { throw new Error("Could not establish connection"); } },
    storage: {
      local: {
        get: async (key) => (key in stored ? { [key]: stored[key] } : {}),
        set: async (patch) => Object.assign(stored, patch)
      }
    }
  };
  const logger = loadLogger(chrome);
  // Service Worker 休眠时 sendMessage 会失败，此前日志就这么静默丢了
  const items = await logger.appendAudit({ action: "enqueue", status: "queued" });
  assert.equal(items.length, 1);
  assert.equal(stored.ptAgentAuditLog.length, 1);
  assert.equal(stored.ptAgentAuditLog[0].action, "enqueue");
});

test("captures console.error from code that bypasses the logger", () => {
  const captured = [];
  const context = {
    URL,
    crypto: webcrypto,
    console: { log() {}, warn() {}, error() {} },
    chrome: {}
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  const logger = context.PT_AGENT_LOGGER;
  assert.equal(logger.installConsoleCapture(context, (event, data) => captured.push({ event, data })), true);

  context.console.error("something blew up", { code: 500 });
  context.console.warn("deprecated thing");
  // logger 自己打的带 [PT] 前缀，不能再抓回来，否则递归
  context.console.error("[PT] qb:res-error {\"status\":409}");

  assert.equal(captured.length, 2);
  assert.equal(captured[0].event, "runtime.console-error");
  assert.match(captured[0].data.message, /something blew up/);
  assert.match(captured[0].data.message, /500/);
  assert.equal(captured[1].event, "runtime.console-warn");
});
