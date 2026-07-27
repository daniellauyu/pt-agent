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
