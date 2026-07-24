const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const loadEngine = () => {
  const context = vm.createContext({ globalThis: null, Date });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "guard-engine.js"), "utf8"), context);
  return context.PT_AGENT_GUARD;
};

const nowMs = Date.parse("2026-07-24T12:00:00+08:00");
const torrent = {
  tags: "ptagent, 2026-07-24 14:00:00",
  progress: 0.5,
  amount_left: 1024,
  dlspeed: 1024
};

test("classifies managed downloads as safe when they finish before the guard window", () => {
  assert.equal(loadEngine().evaluate(torrent, { nowMs, guardMinutes: 10 }).status, "safe");
});

test("predicts when a managed task cannot finish before Free protection starts", () => {
  const result = loadEngine().evaluate(
    { ...torrent, amount_left: 10_000_000, dlspeed: 100 },
    { nowMs, guardMinutes: 10 }
  );
  assert.equal(result.status, "cannot_finish");
});

test("distinguishes completed, expiring, expired, missing, and unmanaged tasks", () => {
  const guard = loadEngine();
  assert.equal(guard.evaluate({ ...torrent, progress: 1 }, { nowMs }).status, "completed");
  assert.equal(
    guard.evaluate({ ...torrent, tags: "ptagent, 2026-07-24 12:05:00" }, { nowMs }).status,
    "expiring"
  );
  assert.equal(
    guard.evaluate({ ...torrent, tags: "ptagent, 2026-07-24 11:59:59" }, { nowMs }).status,
    "expired"
  );
  assert.equal(guard.evaluate({ ...torrent, tags: "ptagent" }, { nowMs }).status, "missing_deadline");
  assert.equal(guard.evaluate({ ...torrent, tags: "other" }, { nowMs }).status, "unmanaged");
});

test("parses offset-aware deadlines and honors delete protection tags", () => {
  const guard = loadEngine();
  const deadline = "2026-07-24T23:32:27+08:00";
  assert.equal(
    guard.deadlineFromTags(`ptagent, ptagent-free-end=${deadline}`),
    deadline
  );
  const result = guard.evaluate({
    tags: `ptagent, PT_AGENT_NODEL, ptagent-free-end=${deadline}`,
    progress: 0.5,
    amount_left: 1024,
    dlspeed: 0
  });
  assert.equal(result.status, "protected");
});
