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

test("keeps one-seeder high-demand torrents in risk when they cannot finish in time", () => {
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    seeders: 1,
    leechers: 258,
    freeEndAt: "2026-07-24T03:00:00+08:00"
  }, settings, now);
  assert.equal(result.decision, "risk");
  assert.ok(result.requiredSpeedBps > 512 * 1024);
  assert.match(result.reasons.join("；"), /Free 剩余不足|供给不足|竞争过高/);
});

test("recommends a small scarce torrent with high demand when it is feasible before Free ends", () => {
  const screenshotNow = Date.parse("2026-07-24T13:32:23+08:00");
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    title: "Natural Legend 2026 E202",
    sizeBytes: 2.8 * 1024 ** 3,
    seeders: 1,
    leechers: 360,
    freeEndAt: "2026-07-25T01:25:23+08:00"
  }, settings, screenshotNow);
  assert.equal(result.decision, "recommend");
  assert.ok(result.score >= 80);
  assert.equal(result.scarceHighDemandOpportunity, true);
  assert.ok(result.requiredSpeedBps < 512 * 1024);
  assert.match(result.reasons.join("；"), /低做种高需求/);
});

test("recommends a screenshot-sized scarce torrent when required speed is feasible", () => {
  const screenshotNow = Date.parse("2026-07-24T16:58:00+08:00");
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    title: "The Dink 2026 2160p ATVP WEB-DL",
    sizeBytes: 18.3 * 1024 ** 3,
    seeders: 1,
    leechers: 560,
    freeEndAt: "2026-07-25T04:01:12+08:00"
  }, settings, screenshotNow);
  assert.equal(result.decision, "recommend");
  assert.ok(result.score >= 80);
  assert.equal(result.scarceHighDemandOpportunity, true);
  assert.ok(result.requiredSpeedBps < 512 * 1024);
});

test("keeps large or urgent single-seeder torrents in risk", () => {
  const screenshotNow = Date.parse("2026-07-24T13:32:23+08:00");
  const result = context.PT_AGENT_DECISION.evaluateTorrent({
    ...baseTorrent,
    sizeBytes: 61.3 * 1024 ** 3,
    seeders: 1,
    leechers: 360,
    freeEndAt: "2026-07-24T19:10:04+08:00"
  }, settings, screenshotNow);
  assert.equal(result.decision, "risk");
  assert.match(result.reasons.join("；"), /Free 剩余不足|体积超过|供给不足/);
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
