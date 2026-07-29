"use strict";

// 端到端：真实跑完 扫描 → 决策 → 准入 → 入队 → 验证落地 这条链，
// 只把网络换成假的。会出问题的从来不是单个函数，而是它们串起来的边界。
const assert = require("node:assert/strict");
const test = require("node:test");

const {
  cleanup, createFakeNetwork, createHome, goodRow, hoursFromNow, installFetch, withHome
} = require("./helpers");

const runScanIn = async (root, network, options = {}) => {
  const restore = installFetch(network.fetchImpl);
  try {
    return await withHome(root, async () => {
      // context 会读 PTAGENT_HOME，必须在设置环境变量之后再 require。
      delete require.cache[require.resolve("../src/context")];
      const { createContext } = require("../src/context");
      const { runScan } = require("../src/runner");
      const ctx = createContext({ mirrorToConsole: false });
      const result = await runScan(ctx, options);
      await ctx.logger.flush();
      return { ...result, ctx };
    });
  } finally {
    restore();
  }
};

test("推荐的资源会被自动推送，并带上 Free 截止和来源标签", async () => {
  const root = createHome();
  const network = createFakeNetwork({ rows: [goodRow(1001)] });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 1);
    assert.equal(summary.pushed.length, 1);
    assert.equal(summary.failed.length, 0);
    assert.equal(summary.pushed[0].duplicate, false);
    // 走的是「先取种子字节再上传」这条路，而不是把 URL 丢给下载器自己抓。
    assert.equal(summary.pushed[0].route, "file");

    const added = network.state.torrents.at(-1);
    assert.match(added.tags, /ptagent/);
    assert.match(added.tags, /ptagent-free-end=/, "没有截止标签，Free 到期保护就无从判断");
    assert.match(added.tags, /ptagent-source=mteam:1001/);
  } finally {
    cleanup(root);
  }
});

test("非推荐资源一个都不推送", async () => {
  const root = createHome();
  // 做种 0：决策引擎判定无法保证完成下载。
  const network = createFakeNetwork({
    rows: [goodRow(2001, { status: { ...goodRow(2001).status, seeders: 0, leechers: 5 } })]
  });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 0);
    assert.equal(summary.pushed.length, 0);
    assert.equal(network.state.torrents.length, 0);
  } finally {
    cleanup(root);
  }
});

test("Free 剩余不足阈值的资源不会被推送", async () => {
  const root = createHome();
  const row = goodRow(3001);
  row.status.discountEndTime = hoursFromNow(2); // 低于默认的 12 小时
  const network = createFakeNetwork({ rows: [row] });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 0);
    assert.equal(summary.pushed.length, 0);
  } finally {
    cleanup(root);
  }
});

test("dry-run 只评估不推送", async () => {
  const root = createHome();
  const network = createFakeNetwork({ rows: [goodRow(1001)] });
  try {
    const { summary } = await runScanIn(root, network, { dryRun: true });
    assert.equal(summary.counts.recommend, 1);
    assert.equal(summary.pushed.length, 0);
    assert.equal(network.state.torrents.length, 0);
  } finally {
    cleanup(root);
  }
});

test("autoDownload 关闭时同样只评估不推送", async () => {
  const root = createHome({ daemon: { autoDownload: false } });
  const network = createFakeNetwork({ rows: [goodRow(1001)] });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 1);
    assert.equal(summary.pushed.length, 0);
  } finally {
    cleanup(root);
  }
});

test("maxPushPerScan 限制单轮推送数量，其余留给下一轮", async () => {
  const root = createHome({ daemon: { maxPushPerScan: 2 } });
  const network = createFakeNetwork({ rows: [goodRow(1), goodRow(2), goodRow(3), goodRow(4)] });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 4);
    assert.equal(summary.candidates, 4);
    assert.equal(summary.pushed.length, 2);
  } finally {
    cleanup(root);
  }
});

test("已经在下载器里的资源不会被重复推送", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    rows: [goodRow(1001)],
    qbTorrents: [{
      hash: "a".repeat(40),
      name: "完全不同的任务名",
      size: 10 * 1024 ** 3,
      progress: 0.5,
      state: "downloading",
      // 靠来源标签精确命中，不依赖名字对得上——这正是名称匹配会漏判的场景。
      tags: "ptagent, ptagent-source=mteam:1001",
      tracker: "https://tracker.test/announce"
    }]
  });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 1);
    assert.equal(summary.candidates, 0, "已在下载器中的资源不该再进候选");
    assert.equal(summary.pushed.length, 0);
  } finally {
    cleanup(root);
  }
});

test("分类已存在返回 409 不影响入队", async () => {
  const root = createHome();
  const network = createFakeNetwork({ rows: [goodRow(1001)], qbCategories: ["PT_AGENT"] });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.pushed.length, 1);
    assert.equal(summary.failed.length, 0);
  } finally {
    cleanup(root);
  }
});

test("取不到种子字节时降级成把链接交给下载器，而不是判失败", async () => {
  const root = createHome();
  const network = createFakeNetwork({ rows: [goodRow(1001)], failTorrentFile: true });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.pushed.length, 1);
    assert.equal(summary.pushed[0].route, "url");
  } finally {
    cleanup(root);
  }
});

test("评分不达标的资源被本地安全准入拦下，且拦截原因会写进结果", async () => {
  const root = createHome({ policy: { minimumScore: 95 } });
  const network = createFakeNetwork({ rows: [goodRow(1001)] });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.counts.recommend, 1, "决策引擎仍然认为它值得推荐");
    assert.equal(summary.pushed.length, 0);
    assert.equal(summary.skipped.length, 1, "准入是独立于决策的第二道关");
    assert.match(summary.skipped[0].reasons.join(""), /评分低于 95/);
  } finally {
    cleanup(root);
  }
});

test("并发达到上限只警告不拦截：任务会在下载器里排队", async () => {
  const root = createHome({ policy: { maxActiveDownloads: 1 } });
  const network = createFakeNetwork({
    rows: [goodRow(1001)],
    qbTorrents: [
      { hash: "b".repeat(40), name: "占位1", progress: 0.2, state: "downloading", tags: "", size: 1 },
      { hash: "c".repeat(40), name: "占位2", progress: 0.3, state: "stalledDL", tags: "", size: 1 }
    ]
  });
  try {
    const { summary } = await runScanIn(root, network);
    assert.equal(summary.slots.occupying, 2);
    assert.equal(summary.pushed.length, 1, "超出并发上限仍要发送，下载器自己会排队");
    assert.equal(summary.skipped.length, 0);
  } finally {
    cleanup(root);
  }
});

test("站点账号接口挂掉不影响整轮扫描", async () => {
  const root = createHome();
  const network = createFakeNetwork({ rows: [goodRow(1001)] });
  const original = network.fetchImpl;
  const broken = {
    state: network.state,
    fetchImpl: async (input, options) => {
      if (String(input).includes("/api/member/profile")) throw new Error("站点抽风");
      return original(input, options);
    }
  };
  try {
    const { summary } = await runScanIn(root, broken);
    assert.equal(summary.account, null);
    assert.equal(summary.pushed.length, 1, "分享率读不到不该让所有推送停摆");
  } finally {
    cleanup(root);
  }
});

test("扫描结果会落盘，供 status / WebUI 直接读取", async () => {
  const root = createHome();
  const network = createFakeNetwork({ rows: [goodRow(1001)] });
  try {
    const { ctx } = await runScanIn(root, network);
    const state = await ctx.state.read();
    assert.equal(state.lastEvaluated.length, 1);
    assert.equal(state.lastScan.pushed.length, 1);
    assert.ok(state.lastScanAt);
  } finally {
    cleanup(root);
  }
});
