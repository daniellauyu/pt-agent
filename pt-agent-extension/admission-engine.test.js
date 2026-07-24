const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const loadEngine = () => {
  const context = vm.createContext({ globalThis: null });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "admission-engine.js"), "utf8"), context);
  return context.PT_AGENT_ADMISSION;
};

const safeTorrent = {
  decision: "recommend",
  score: 88,
  sizeBytes: 20 * 1024 ** 3,
  leftHours: 24
};

test("admits a safe recommendation below the concurrency limit", () => {
  const result = loadEngine().evaluate({
    torrent: safeTorrent,
    account: { ratio: 2.5 },
    activeDownloads: 2
  });
  assert.equal(result.allowed, true);
  assert.equal(result.activeAfterEnqueue, 3);
});

test("applies the same score, size, time, ratio, and concurrency gate", () => {
  const result = loadEngine().evaluate({
    torrent: {
      ...safeTorrent,
      score: 70,
      sizeBytes: 60 * 1024 ** 3,
      leftHours: 5
    },
    account: { ratio: 0.8 },
    activeDownloads: 3
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reasons.length, 5);
  assert.match(result.reasons.join("；"), /评分低于 80/);
  assert.match(result.reasons.join("；"), /体积超过 50GB/);
  assert.match(result.reasons.join("；"), /Free 剩余不足 12 小时/);
  assert.match(result.reasons.join("；"), /活动下载已达到 3 个/);
  assert.match(result.reasons.join("；"), /分享率低于 1\.0/);
});

test("does not admit a risk item even if all numeric limits pass", () => {
  const result = loadEngine().evaluate({
    torrent: { ...safeTorrent, decision: "risk" },
    account: { ratio: 2 }
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons[0], /未达到推荐级别/);
});
