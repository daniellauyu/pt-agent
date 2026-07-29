"use strict";

// Free 到期保护：这是无人值守跑起来后风险最高的一段——它会删文件。
// 所以「什么时候删、什么时候绝不能删」必须逐条锁住。
const assert = require("node:assert/strict");
const test = require("node:test");

const { cleanup, createFakeNetwork, createHome, hoursFromNow, installFetch, withHome } = require("./helpers");

const runGuardIn = async (root, network, options = {}) => {
  const restore = installFetch(network.fetchImpl);
  try {
    return await withHome(root, async () => {
      delete require.cache[require.resolve("../src/context")];
      const { createContext } = require("../src/context");
      const { runGuard } = require("../src/guard");
      const ctx = createContext({ mirrorToConsole: false });
      const result = await runGuard(ctx, options);
      await ctx.logger.flush();
      return { result, ctx };
    });
  } finally {
    restore();
  }
};

const task = (overrides = {}) => ({
  hash: "d".repeat(40),
  name: "下载中的任务",
  size: 10 * 1024 ** 3,
  amount_left: 5 * 1024 ** 3,
  progress: 0.5,
  state: "downloading",
  dlspeed: 1024 ** 2,
  tags: `ptagent, ptagent-free-end=${hoursFromNow(24)}`,
  tracker: "https://tracker.test/announce",
  ...overrides
});

test("Free 已到期且没下完的任务会被连文件一起删除", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: `ptagent, ptagent-free-end=${hoursFromNow(-1)}` })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0].status, "expired");
    assert.deepEqual(network.state.deleted, ["d".repeat(40)]);
  } finally {
    cleanup(root);
  }
});

test("进入保护窗口（默认到期前 10 分钟）就动手，不等真的过期", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: `ptagent, ptagent-free-end=${hoursFromNow(0.1)}` })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0].status, "expiring");
  } finally {
    cleanup(root);
  }
});

test("Free 还很充裕的任务一根汗毛都不能动", async () => {
  const root = createHome();
  const network = createFakeNetwork({ qbTorrents: [task()] });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 0);
    assert.equal(network.state.deleted.length, 0);
  } finally {
    cleanup(root);
  }
});

test("已完成的任务即使 Free 过期也不删——种子还要留着做种", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbTorrents: [task({
      progress: 1,
      amount_left: 0,
      state: "uploading",
      tags: `ptagent, ptagent-free-end=${hoursFromNow(-48)}`
    })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 0);
    assert.equal(network.state.deleted.length, 0);
  } finally {
    cleanup(root);
  }
});

test("不是本工具添加的任务一律不碰", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: "" }), task({ hash: "e".repeat(40), tags: "别人的标签" })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.warnings.length, 0);
  } finally {
    cleanup(root);
  }
});

test("打了保护标签的任务即使到期也保留", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: `ptagent, pt_agent_keep, ptagent-free-end=${hoursFromNow(-5)}` })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 0);
  } finally {
    cleanup(root);
  }
});

test("关掉 autoDeleteExpired 后只告警不删除", async () => {
  const root = createHome({ policy: { autoDeleteExpired: false } });
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: `ptagent, ptagent-free-end=${hoursFromNow(-1)}` })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.deleted.length, 0);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].status, "expired");
    assert.equal(network.state.deleted.length, 0);
  } finally {
    cleanup(root);
  }
});

test("dry-run 报告会删什么但不真删", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: `ptagent, ptagent-free-end=${hoursFromNow(-1)}` })]
  });
  try {
    const { result } = await runGuardIn(root, network, { dryRun: true });
    assert.equal(result.deleted.length, 1);
    assert.equal(result.deleted[0].dryRun, true);
    assert.equal(network.state.deleted.length, 0);
  } finally {
    cleanup(root);
  }
});

test("关闭保护监控后整个检查都不跑", async () => {
  const root = createHome({ policy: { guardMonitorEnabled: false } });
  const network = createFakeNetwork({
    qbTorrents: [task({ tags: `ptagent, ptagent-free-end=${hoursFromNow(-1)}` })]
  });
  try {
    const { result } = await runGuardIn(root, network);
    assert.equal(result.skipped, "guardMonitorEnabled=false");
    assert.equal(network.state.deleted.length, 0);
  } finally {
    cleanup(root);
  }
});

test("密码错误会触发退避，下一次检查直接跳过而不是再撞一次", async () => {
  const root = createHome();
  const network = createFakeNetwork({
    qbPassword: "something-else",
    qbTorrents: [task()]
  });
  try {
    await assert.rejects(() => runGuardIn(root, network));
    // 第二次必须被冷却期挡住：qB 连续认证失败会封 IP，
    // 每分钟撞一次等于把封禁窗口无限续期，永远等不到自动恢复。
    const { result } = await runGuardIn(root, network);
    assert.equal(result.skipped, "auth-cooldown");
    assert.ok(result.resumesInSeconds > 0);
  } finally {
    cleanup(root);
  }
});
