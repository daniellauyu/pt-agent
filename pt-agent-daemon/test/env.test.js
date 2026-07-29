"use strict";

// .env 是「把一台机器的配置整体搬到另一台」的载体。
// 最要命的失败是搬过去以后某个值悄悄变了样（密码里有 # 被当成注释截断之类），
// 所以解析和导出的往返一致性要逐条锁死。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { applyEnv, mapEnv, parseEnvFile, toEnvFile } = require("../src/env");
const { cleanup, createHome, withHome } = require("./helpers");

test("基本键值、注释、空行", () => {
  const parsed = parseEnvFile([
    "# 这是注释",
    "",
    "PTAGENT_SITE_API_KEY=abc123",
    "PTAGENT_WEB_PORT=7788   # 行尾注释",
    "export PTAGENT_AUTO_DOWNLOAD=true"
  ].join("\n"));
  assert.equal(parsed.PTAGENT_SITE_API_KEY, "abc123");
  assert.equal(parsed.PTAGENT_WEB_PORT, "7788");
  assert.equal(parsed.PTAGENT_AUTO_DOWNLOAD, "true", "export 前缀要能识别");
});

test("密码里的 # 和空格不会被当成注释截断", () => {
  const parsed = parseEnvFile([
    'PTAGENT_DOWNLOADER_1_PASSWORD="pa ss#word"',
    "PTAGENT_DOWNLOADER_2_PASSWORD='另一个 #密码'",
    'PTAGENT_DOWNLOADER_3_PASSWORD="带引号"   # 收尾引号后还能跟注释'
  ].join("\n"));
  assert.equal(parsed.PTAGENT_DOWNLOADER_1_PASSWORD, "pa ss#word");
  assert.equal(parsed.PTAGENT_DOWNLOADER_2_PASSWORD, "另一个 #密码");
  assert.equal(parsed.PTAGENT_DOWNLOADER_3_PASSWORD, "带引号");
});

test("双引号内支持转义，单引号内一切都是字面量", () => {
  const parsed = parseEnvFile([
    'A="他说\\"你好\\""',
    "B='原样\\n不转义'"
  ].join("\n"));
  assert.equal(parsed.A, '他说"你好"');
  assert.equal(parsed.B, "原样\\n不转义");
});

test("空值表示「不覆盖」，不会把已有配置清空", () => {
  const patch = mapEnv({ PTAGENT_SITE_API_KEY: "", PTAGENT_MIN_SCORE: "90" });
  assert.equal(patch.site.apiKey, undefined, "空字符串不该覆盖掉已经填好的 Key");
  assert.equal(patch.policy.minimumScore, 90);
});

test("非法数字被忽略，而不是把配置写成 NaN", () => {
  const patch = mapEnv({ PTAGENT_MIN_SCORE: "不是数字", PTAGENT_MAX_SIZE_GB: "60" });
  assert.equal(patch.policy.minimumScore, undefined);
  assert.equal(patch.policy.maxTorrentSizeGB, 60);
});

test("布尔值接受常见写法", () => {
  for (const value of ["true", "1", "on", "yes", "开"]) {
    assert.equal(mapEnv({ PTAGENT_AUTO_DOWNLOAD: value }).daemon.autoDownload, true, value);
  }
  for (const value of ["false", "0", "off", "no"]) {
    assert.equal(mapEnv({ PTAGENT_AUTO_DOWNLOAD: value }).daemon.autoDownload, false, value);
  }
});

test("多台下载器按序号成组，顺序即探测优先级", () => {
  const patch = mapEnv({
    PTAGENT_DOWNLOADER_1_NAME: "内网",
    PTAGENT_DOWNLOADER_1_ADDRESS: "http://192.168.1.9:8080/",
    PTAGENT_DOWNLOADER_1_USERNAME: "admin",
    PTAGENT_DOWNLOADER_1_PASSWORD: "a",
    PTAGENT_DOWNLOADER_2_NAME: "公网",
    PTAGENT_DOWNLOADER_2_ADDRESS: "https://qb.example.com/",
    PTAGENT_DOWNLOADER_2_USERNAME: "admin",
    PTAGENT_DOWNLOADER_2_PASSWORD: "b"
  });
  assert.equal(patch.downloaders.length, 2);
  assert.deepEqual(patch.downloaders.map((item) => item.name), ["内网", "公网"]);
  assert.deepEqual(patch.downloaders.map((item) => item.id), ["dl_env_1", "dl_env_2"]);
});

test("序号中断就停，不会把后面孤立的配置误当成一台", () => {
  const patch = mapEnv({
    PTAGENT_DOWNLOADER_1_ADDRESS: "http://a/",
    PTAGENT_DOWNLOADER_3_ADDRESS: "http://c/"
  });
  assert.equal(patch.downloaders.length, 1);
});

test("managed 列出所有被托管的键，供界面和 doctor 提示", () => {
  const patch = mapEnv({ PTAGENT_MIN_SCORE: "90", PTAGENT_WEB_PORT: "8000" });
  assert.deepEqual(patch.managed, ["PTAGENT_MIN_SCORE", "PTAGENT_WEB_PORT"]);
});

test("applyEnv 把配置真的写进去，下载器整份接管", async () => {
  const root = createHome();
  const envFile = path.join(root, ".env");
  fs.writeFileSync(envFile, [
    "PTAGENT_SCAN_MIN_MINUTES=25",
    "PTAGENT_SCAN_MAX_MINUTES=45",
    "PTAGENT_AUTO_DELETE_EXPIRED=false",
    "PTAGENT_SITE_API_KEY=env-key",
    "PTAGENT_DOWNLOADER_1_NAME=来自env",
    "PTAGENT_DOWNLOADER_1_ADDRESS=http://192.168.9.9:8080/",
    "PTAGENT_DOWNLOADER_1_USERNAME=admin",
    'PTAGENT_DOWNLOADER_1_PASSWORD="p@ss #1"'
  ].join("\n"));
  try {
    await withHome(root, async () => {
      delete require.cache[require.resolve("../src/context")];
      const { createContext } = require("../src/context");
      const ctx = createContext({ mirrorToConsole: false });
      const result = await applyEnv(ctx);
      assert.equal(result.applied, true);

      const daemon = await ctx.config.readDaemon();
      assert.equal(daemon.scanIntervalMinMinutes, 25);
      assert.equal(daemon.scanIntervalMaxMinutes, 45);
      assert.equal((await ctx.config.readPolicy()).autoDeleteExpired, false);

      const downloaders = await ctx.downloaders.list();
      assert.equal(downloaders[0].name, "来自env");
      assert.equal(downloaders[0].password, "p@ss #1");
      assert.equal(downloaders.length, 1, ".env 写了下载器就整份接管，不和旧记录混在一起");

      const site = await ctx.activeSite();
      assert.equal(site.apiKey, "env-key");
      await ctx.logger.flush();
    });
  } finally {
    cleanup(root);
  }
});

test("没有 .env 时什么都不做", async () => {
  const root = createHome();
  try {
    await withHome(root, async () => {
      delete require.cache[require.resolve("../src/context")];
      const { createContext } = require("../src/context");
      const ctx = createContext({ mirrorToConsole: false });
      // 项目根目录下确实可能放着开发者自己的 .env，测试里显式指一个不存在的文件。
      const result = await applyEnv(ctx, { file: path.join(root, "缺失的.env") }).catch(() => null);
      assert.ok(result === null || result.applied === false);
      await ctx.logger.flush();
    });
  } finally {
    cleanup(root);
  }
});

test("导出再读回来，每个值都要原样还原", () => {
  const original = {
    daemon: {
      scanIntervalMinMinutes: 33, scanIntervalMaxMinutes: 77, maxPushPerScan: 4,
      autoDownload: false, scanOnStart: true, guardIntervalSeconds: 90,
      webEnabled: true, webHost: "0.0.0.0", webPort: 9000, webToken: "tok#en with space"
    },
    policy: {
      minimumScore: 85, maxTorrentSizeGB: 60, minFreeHoursForAutoDownload: 8,
      minimumRatio: 1.5, maxActiveDownloads: 6, rejectHr: true, rejectMissingFreeEnd: false,
      guardMonitorEnabled: true, guardMinutes: 15, autoDeleteExpired: true
    },
    site: { name: "M-Team", type: "mteam", siteUrl: "https://kp.m-team.cc/", apiUrl: "https://api.m-team.cc/", apiKey: "key-123" },
    downloaders: [{
      name: "内网 qB", type: "qbittorrent", address: "http://192.168.1.10:8080/",
      username: "admin", password: 'pa"ss #1', savePath: "/vol1/dl", category: "PT_AGENT", enabled: true
    }]
  };
  const patch = mapEnv(parseEnvFile(toEnvFile(original)));
  assert.equal(patch.daemon.scanIntervalMinMinutes, 33);
  assert.equal(patch.daemon.webToken, "tok#en with space", "带空格和 # 的令牌必须原样还原");
  assert.equal(patch.policy.minimumRatio, 1.5);
  assert.equal(patch.policy.rejectMissingFreeEnd, false);
  assert.equal(patch.site.apiKey, "key-123");
  assert.equal(patch.downloaders[0].password, 'pa"ss #1', "带引号的密码必须原样还原");
  assert.equal(patch.downloaders[0].name, "内网 qB");
  assert.equal(patch.downloaders[0].savePath, "/vol1/dl");
});

test("--no-secrets 导出的模板不含密码，可以安全分享", () => {
  const text = toEnvFile({
    daemon: { webToken: "tok" },
    policy: {},
    site: { apiKey: "key-123" },
    downloaders: [{ address: "http://a/", password: "secret" }]
  }, { includeSecrets: false });
  assert.doesNotMatch(text, /key-123/);
  assert.doesNotMatch(text, /secret/);
  assert.doesNotMatch(text, /\btok\b/);
  assert.match(text, /PTAGENT_SITE_API_KEY=\s*$/m, "键要保留，只是值留空");
});

test("导出的文件带有醒目的密钥警告", () => {
  const text = toEnvFile({ daemon: {}, policy: {}, site: null, downloaders: [] });
  assert.match(text, /不要提交到仓库/);
});
