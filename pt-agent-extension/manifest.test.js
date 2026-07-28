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
  const hosts = manifest.host_permissions || [];
  assert.ok(
    hosts.every((host) => /m-team\.cc/.test(host)),
    `host_permissions must only cover site hosts, got ${JSON.stringify(hosts)}`
  );
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

test("publishes the multi-downloader and site settings update as version 0.14.0", () => {
  assert.equal(manifest.version, "0.14.0");
});

test("service worker imports and migrates the local downloader preset", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  ["logger.js", "private-config.js", "guard-engine.js", "qb-client.js",
   "downloader-registry.js", "downloader-store.js", "site-store.js",
   "network-router.js", "host-permissions.js"].forEach((file) => {
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
