"use strict";

// WebUI 承载着下载器密码和站点 API Key。这里锁住的主要是「什么绝不能流出去」，
// 其次才是接口本身通不通。
const assert = require("node:assert/strict");
const test = require("node:test");

const { cleanup, createFakeNetwork, createHome, installFetch, withHome } = require("./helpers");
const { isLoopback, maskDownloader, maskSite, maskDaemon } = require("../src/webui/server");

const startServer = async (root, { webToken = "" } = {}) => {
  return withHome(root, async () => {
    delete require.cache[require.resolve("../src/context")];
    const { createContext } = require("../src/context");
    const { createServer } = require("../src/webui/server");
    const ctx = createContext({ mirrorToConsole: false });
    ctx.webToken = webToken;
    const web = createServer(ctx);
    const info = await web.listen({ host: "127.0.0.1", port: 0 });
    return { ctx, web, base: `http://127.0.0.1:${web.server.address().port}`, info };
  });
};

const withServer = async (options, task) => {
  const root = createHome();
  const network = createFakeNetwork();
  const restore = installFetch(network.fetchImpl);
  const server = await startServer(root, options);
  try {
    return await task({ ...server, network, root });
  } finally {
    await server.web.close();
    // 先等日志落盘再删临时目录，否则在途的写入会撞上已被删掉的目录。
    await server.ctx.logger.flush();
    restore();
    cleanup(root);
  }
};

test("下载器密码永远不会被回读到浏览器", async () => {
  await withServer({}, async ({ base }) => {
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settings.downloaders[0].password, "");
    assert.equal(settings.downloaders[0].hasPassword, true);
    // 整段响应里也不能出现明文密码。
    assert.doesNotMatch(JSON.stringify(settings), /correct/);
  });
});

test("站点 API Key 同样只写不读", async () => {
  await withServer({}, async ({ base }) => {
    const settings = await (await fetch(`${base}/api/settings`)).json();
    assert.equal(settings.sites[0].apiKey, "");
    assert.equal(settings.sites[0].hasApiKey, true);
    assert.doesNotMatch(JSON.stringify(settings), /test-key/);
  });
});

test("保存时留空密码表示不修改，不会把已有密码清掉", async () => {
  await withServer({}, async ({ base, ctx }) => {
    const before = (await ctx.downloaders.list())[0];
    const response = await fetch(`${base}/api/downloaders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...before, password: "", name: "改了名字" })
    });
    assert.equal(response.status, 200);
    const after = (await ctx.downloaders.list())[0];
    assert.equal(after.name, "改了名字");
    assert.equal(after.password, "correct", "留空被当成清空的话，下一轮扫描就登录不上了");
  });
});

test("非法配置被拒绝并给出中文原因", async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/downloaders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "坏的", address: "不是地址", username: "a", password: "b" })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /http:\/\/ 或 https:\/\//);
  });
});

test("设置了令牌后，无令牌的请求一律 401", async () => {
  await withServer({ webToken: "s3cret-token" }, async ({ base }) => {
    assert.equal((await fetch(`${base}/api/status`)).status, 401);
    assert.equal((await fetch(`${base}/api/status?token=wrong`)).status, 401);
    assert.equal((await fetch(`${base}/api/status?token=s3cret-token`)).status, 200);
    const withHeader = await fetch(`${base}/api/status`, {
      headers: { Authorization: "Bearer s3cret-token" }
    });
    assert.equal(withHeader.status, 200);
  });
});

test("令牌本身不会随配置一起发回页面", async () => {
  await withServer({ webToken: "s3cret-token" }, async ({ base, ctx }) => {
    await ctx.config.saveDaemon({ webToken: "s3cret-token" });
    const settings = await (await fetch(`${base}/api/settings?token=s3cret-token`)).json();
    assert.equal(settings.daemon.webToken, "");
    assert.equal(settings.daemon.hasWebToken, true);
  });
});

test("在页面上保存调度设置不会把令牌清掉", async () => {
  await withServer({ webToken: "s3cret-token" }, async ({ base, ctx }) => {
    await ctx.config.saveDaemon({ webToken: "s3cret-token" });
    await fetch(`${base}/api/settings/daemon?token=s3cret-token`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scanIntervalMinMinutes: 25 })
    });
    const daemon = await ctx.config.readDaemon();
    assert.equal(daemon.scanIntervalMinMinutes, 25);
    assert.equal(daemon.webToken, "s3cret-token", "令牌被清掉的话，重启后所有人都能直接访问");
  });
});

test("静态资源不能穿越到 public 目录之外", async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/..%2f..%2fpackage.json`);
    assert.ok([403, 404].includes(response.status), `期望被拒，实际 ${response.status}`);
  });
});

test("未知接口返回结构化错误而不是 HTML", async () => {
  await withServer({}, async ({ base }) => {
    const response = await fetch(`${base}/api/nope`);
    assert.equal(response.status, 404);
    assert.match((await response.json()).error, /未知接口/);
  });
});

test("接口出错会被记进日志——只回给浏览器等于没人看得见", async () => {
  await withServer({}, async ({ base, ctx }) => {
    await fetch(`${base}/api/downloaders`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address: "坏地址" })
    });
    await ctx.logger.flush();
    const { records } = await ctx.logger.readLogs({ level: "error" });
    assert.ok(records.some((item) => item.event === "webui:error"));
  });
});

test("状态接口返回调度与上一轮扫描的全貌", async () => {
  await withServer({}, async ({ base }) => {
    const status = await (await fetch(`${base}/api/status`)).json();
    assert.equal(status.downloaderCount, 1);
    assert.equal(status.siteCount, 1);
    assert.ok(status.daemon.scanIntervalMinMinutes > 0);
    assert.equal(status.policy.autoDeleteExpired, true);
  });
});

test("回环地址判定覆盖常见写法", () => {
  assert.equal(isLoopback("127.0.0.1"), true);
  assert.equal(isLoopback("localhost"), true);
  assert.equal(isLoopback("::1"), true);
  assert.equal(isLoopback("0.0.0.0"), false);
  assert.equal(isLoopback("192.168.1.5"), false);
});

test("脱敏函数不会误报「填过」", () => {
  assert.equal(maskDownloader({ password: "" }).hasPassword, false);
  assert.equal(maskSite({ apiKey: "" }).hasApiKey, false);
  assert.equal(maskDaemon({ webToken: "" }).hasWebToken, false);
});
