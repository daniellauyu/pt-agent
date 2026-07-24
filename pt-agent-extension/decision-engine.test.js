const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "decision-engine.js"), "utf8");
const context = vm.createContext({ globalThis: null, Date });
context.globalThis = context;
vm.runInContext(source, context);

const settings = {
  guardMinutes: 10,
  minFreeHoursForAutoDownload: 12,
  maxTorrentSizeGB: 80,
  rejectHr: true,
  rejectMissingFreeEnd: true
};
const now = Date.parse("2026-07-24T00:00:00+08:00");
const baseTorrent = {
  title: "Fixture",
  freeType: "free",
  freeEndAt: "2026-07-25T00:00:00+08:00",
  sizeBytes: 20 * 1024 ** 3,
  seeders: 10,
  leechers: 15,
  hasHr: false
};

test("marks one seeder versus hundreds of leechers as risk", () => {
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    seeders: 1,
    leechers: 258
  }, settings, now);
  assert.equal(result.decision, "risk");
  assert.match(result.reasons.join("；"), /供给不足|竞争过高/);
});

test("recommends a Free torrent only when supply is stable", () => {
  const result = context.PT_AGENT_DECISION.evaluateTorrent(baseTorrent, settings, now);
  assert.equal(result.decision, "recommend");
  assert.ok(result.score >= 80);
  assert.match(result.reasons.join("；"), /做种供给充足/);
});

test("still rejects expired Free torrents", () => {
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    freeEndAt: "2026-07-23T23:59:59+08:00"
  }, settings, now);
  assert.equal(result.decision, "reject");
});

test("does not recommend when downloads are not greater than seeders", () => {
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    seeders: 10,
    leechers: 10
  }, settings, now);
  assert.equal(result.decision, "risk");
  assert.match(result.reasons.join("；"), /不进入推荐/);
});
