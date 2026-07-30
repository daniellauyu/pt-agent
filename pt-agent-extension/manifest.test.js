const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const manifest = JSON.parse(
  fs.readFileSync(path.join(__dirname, "manifest.json"), "utf8")
);

test("grants scripting access to M-Team pages", () => {
  const permissions = manifest.host_permissions || [];
  assert.ok(
    permissions.includes("https://*.m-team.cc/*"),
    "manifest must grant access to M-Team hosts"
  );
});

test("does not hard-code any downloader host in the manifest", () => {
  // 写死的局域网地址是上一版的真实故障：用户在面板里改了 qB 地址后 fetch 被权限挡掉。
  // 站点和它的下载 CDN 可以固定声明；下载器地址由用户配置，只能走 optional_host_permissions。
  const hosts = manifest.host_permissions || [];
  hosts.forEach((host) => {
    assert.doesNotMatch(host, /\d+\.\d+\.\d+\.\d+/, `${host} 看起来是写死的下载器 IP`);
    assert.doesNotMatch(host, /:\d+/, `${host} 带端口，像是写死的下载器地址`);
  });
});

test("requests downloader hosts at runtime through optional permissions", () => {
  const optional = manifest.optional_host_permissions || [];
  assert.ok(optional.includes("http://*/*"));
  assert.ok(optional.includes("https://*/*"));
});

test("does not request the removed PT Core Service host", () => {
  assert.ok(!manifest.host_permissions.some((host) => host.includes("8090")));
});

test("keeps the toolbar popup as the compact mode", () => {
  assert.equal(manifest.action.default_popup, "popup.html");
});

// 之前这里写死了版本号，每次发版都要改一次，而它并不能证明任何事——
// 断言的值就是从同一个文件读出来的。改成校验格式，真正的功能由下面的用例覆盖。
test("declares a well-formed version", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

test("lets the user export every setting for the terminal daemon", () => {
  const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "popup.html"), "utf8");
  assert.match(html, /id="exportConfigBtn"/);
  assert.match(popup, /exportConfigBtn.*addEventListener/s);
  // 导出的必须是配置，不能顺手把日志和审计也带出去——那些换台机器毫无意义，
  // 却会让一个本来就含密钥的文件更大更敏感。
  const exportBlock = popup.slice(popup.indexOf("const exportConfigJson"), popup.indexOf("const applyTheme"));
  ["ptAgentDownloaders", "ptAgentSites", "ptAgentSettings", "ptAgentExcludedTorrents"]
    .forEach((key) => assert.match(exportBlock, new RegExp(key), `导出缺少 ${key}`));
  ["ptAgentDebugLog", "ptAgentAuditLog"]
    .forEach((key) => assert.doesNotMatch(exportBlock, new RegExp(key), `导出不该包含 ${key}`));
  assert.match(exportBlock, /confirm\(/, "含密钥配置导出前必须二次确认");
  assert.match(exportBlock, /CONTAINS-SECRETS/, "文件名必须提醒用户里面有密钥");
});

test("scan JSON is privacy-safe for sharing", () => {
  const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
  const block = popup.slice(popup.indexOf("const exportPayload"), popup.indexOf("const copyJson"));
  assert.match(block, /PT_AGENT_LOGGER\.redact/);
  assert.match(block, /account:\s*\{\s*redacted:\s*true\s*\}/);
  assert.doesNotMatch(block, /state\.scan\?\.account/);
});

test("captures uncaught errors in both the popup and the service worker", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const popup = fs.readFileSync(path.join(__dirname, "popup.js"), "utf8");
  // 未捕获异常此前只出现在 Chrome 的错误页，插件日志里完全没有
  assert.match(background, /PT_AGENT_LOGGER\.installErrorCapture\(\)/);
  assert.match(background, /PT_AGENT_LOGGER\.installConsoleCapture\(\)/);
  assert.match(popup, /PT_AGENT_LOGGER\.installErrorCapture\(globalThis/);
  assert.match(popup, /PT_AGENT_LOGGER\.installConsoleCapture\(globalThis/);
});

test("covers the M-Team download CDN so the .torrent bytes can be fetched", () => {
  // genDlToken 返回的地址会 302 到 CDN；域名没有 host 权限就要走 CORS，
  // CDN 不返回 Access-Control-Allow-Origin，抓取必然失败并退化成让 qB 自己抓
  assert.ok(manifest.host_permissions.includes("https://*.halomt.com/*"));
});

test("can strip Origin/Referer only on hosts the user granted", () => {
  // 用 WithHostAccess 变体：规则只能作用于已授权的下载器地址，不需要全网络拦截权限
  assert.ok(manifest.permissions.includes("declarativeNetRequestWithHostAccess"));
  assert.ok(!manifest.permissions.includes("declarativeNetRequest"));
});

test("service worker imports and migrates the local downloader preset", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  ["logger.js", "private-config.js", "guard-engine.js", "qb-client.js",
   "downloader-registry.js", "downloader-store.js", "site-store.js",
   "network-router.js", "host-permissions.js", "request-rules.js"].forEach((file) => {
    assert.match(background, new RegExp(`"${file.replace(".", "\\.")}"`), `${file} must be imported`);
  });
  assert.match(background, /PT_AGENT_LOGGER\.installStorageOwner\(\)/);
  assert.match(background, /password:\s*stored\.ptAgentQbSettings\?\.password \|\| privateConfig\.qbPassword/);
  assert.match(background, /mteamApiKey:\s*stored\.ptAgentQbSettings\?\.mteamApiKey \|\| privateConfig\.mteamApiKey/);
  assert.doesNotMatch(background, /ptAgentCoreSettings/);
  assert.doesNotMatch(background, /coreServiceUrl/);
});

test("never overwrites downloader settings the user already saved in the panel", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const block = background.match(/updates\.ptAgentQbSettings = \{[\s\S]*?\};/)?.[0] || "";
  assert.ok(block, "onInstalled must build ptAgentQbSettings");
  ["address", "username", "password", "savePath", "mteamApiKey"].forEach((field) => {
    assert.match(
      block,
      new RegExp(`${field}:\\s*stored\\.ptAgentQbSettings\\?\\.\\w+ \\|\\|`),
      `${field} must fall back to the preset instead of replacing the stored value`
    );
  });
});

test("free guard backs off after an auth failure instead of hammering every minute", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  // 每分钟一次的后台扫描若在被封禁后继续重试，封禁窗口会被不断刷新
  assert.match(background, /ptAgentGuardAuthCooldown/);
  assert.match(background, /cooldownUntil > Date\.now\(\)/);
  assert.match(background, /QB_IP_BANNED/);
  assert.doesNotMatch(background, /await client\.login\(\)/);
});

test("free guard picks a downloader by reachability and skips unauthorized hosts", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  assert.match(background, /PT_AGENT_NETWORK_ROUTER\.selectDownloader/);
  assert.match(background, /permissions\.has\(downloader\.address\)/);
  assert.match(background, /缺少主机访问权限/);
  // Service Worker 里没有用户手势，绝不能尝试弹权限申请
  assert.doesNotMatch(background, /permissions\.request\(/);
  assert.doesNotMatch(background, /PT_AGENT_QB\.createClient/);
});

test("runs Free Guard from a background alarm with automatic deletion disabled by default", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  assert.ok(manifest.permissions.includes("alarms"));
  assert.match(background, /chrome\.alarms\.create\("ptAgentFreeGuard"/);
  assert.match(background, /autoDeleteExpired:\s*false/);
  assert.match(background, /settings\.autoDeleteExpired/);
  assert.match(background, /client\.deleteTorrents\(torrent\.hash,\s*true\)/);
  assert.match(background, /result\.managed/);
});
