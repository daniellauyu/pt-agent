const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "audit-utils.js"), "utf8");

const loadUtils = () => {
  const context = vm.createContext({ globalThis: null });
  context.globalThis = context;
  vm.runInContext(source, context);
  return context.PT_AGENT_AUDIT;
};

test("sorts audit events newest first without mutating the stored order", () => {
  const input = [
    { id: "old", timestamp: "2026-07-27T01:00:00+08:00" },
    { id: "invalid", timestamp: "unknown" },
    { id: "new", timestamp: "2026-07-27T03:00:00+08:00" },
    { id: "middle", timestamp: "2026-07-27T02:00:00+08:00" }
  ];
  const sorted = loadUtils().newestFirst(input);
  assert.deepEqual(Array.from(sorted, (event) => event.id), ["new", "middle", "old", "invalid"]);
  assert.deepEqual(input.map((event) => event.id), ["old", "invalid", "new", "middle"]);
});
