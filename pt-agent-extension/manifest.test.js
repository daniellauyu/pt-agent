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

test("grants API access to the configured qBittorrent WebUI", () => {
  assert.ok(
    manifest.host_permissions.includes("http://192.168.1.10:8080/*")
  );
});

test("grants access to the local PT Core Service", () => {
  assert.ok(manifest.host_permissions.includes("http://127.0.0.1:8090/*"));
});

test("keeps the toolbar popup as the compact mode", () => {
  assert.equal(manifest.action.default_popup, "popup.html");
});

test("publishes the Chrome direct qB fallback as extension version 0.10.3", () => {
  assert.equal(manifest.version, "0.10.3");
});

test("service worker imports and migrates the local downloader preset", () => {
  const background = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  assert.match(background, /importScripts\("private-config\.js",\s*"guard-engine\.js",\s*"qb-client\.js"\)/);
  assert.match(background, /password:\s*privateConfig\.qbPassword/);
  assert.match(background, /mteamApiKey:\s*privateConfig\.mteamApiKey/);
  assert.match(background, /ptAgentCoreSettings/);
  assert.match(background, /privateConfig\.coreServiceUrl/);
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
