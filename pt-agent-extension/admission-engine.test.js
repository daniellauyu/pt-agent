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
  assert.deepEqual(Array.from(result.warnings), []);
});

test("applies the same score, size, time, and ratio gate", () => {
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
  assert.equal(result.reasons.length, 4);
  assert.match(result.reasons.join("；"), /评分低于 80/);
  assert.match(result.reasons.join("；"), /体积超过 50GB/);
  assert.match(result.reasons.join("；"), /Free 剩余不足 12 小时/);
  assert.match(result.reasons.join("；"), /分享率低于 1\.0/);
  // 并发不再拦截，只作为提示
  assert.doesNotMatch(result.reasons.join("；"), /活动下载/);
  assert.match(result.warnings.join("；"), /排队/);
});

test("never blocks on concurrency because the downloader queues extra tasks", () => {
  const result = loadEngine().evaluate({
    torrent: safeTorrent,
    account: { ratio: 2.5 },
    activeDownloads: 99,
    batchQueued: 5
  });
  assert.equal(result.allowed, true, "并发再高也不该拦截，下载器会排队");
  assert.deepEqual(Array.from(result.reasons), []);
  assert.match(result.warnings.join("；"), /超过提醒阈值/);
  assert.match(result.warnings.join("；"), /Free 是否来得及/);
});

test("does not admit a risk item even if all numeric limits pass", () => {
  const result = loadEngine().evaluate({
    torrent: { ...safeTorrent, decision: "risk" },
    account: { ratio: 2 }
  });
  assert.equal(result.allowed, false);
  assert.match(result.reasons[0], /未达到推荐级别/);
});

test("admits a short-Free scarce high-demand opportunity approved by the decision engine", () => {
  const result = loadEngine().evaluate({
    torrent: {
      ...safeTorrent,
      score: 85,
      sizeBytes: 2.8 * 1024 ** 3,
      leftHours: 11 + 53 / 60,
      scarceHighDemandOpportunity: true
    },
    account: { ratio: 2 },
    activeDownloads: 0
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(Array.from(result.reasons), []);
});
