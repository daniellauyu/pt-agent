const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

test("repository ships a complete secret-free local config template", () => {
  const source = fs.readFileSync(path.join(__dirname, "private-config.example.js"), "utf8");
  const context = vm.createContext({ globalThis: null });
  context.globalThis = context;
  vm.runInContext(source, context);

  const config = context.PT_AGENT_PRIVATE_CONFIG;
  assert.match(config.qbAddress, /^https?:\/\//);
  assert.equal(config.qbUsername, "your_qb_username");
  assert.equal(config.qbPassword, "your_qb_password");
  assert.equal(config.mteamSiteUrl, "https://kp.m-team.cc/");
  assert.equal(config.mteamApiUrl, "https://api.m-team.cc/");
  assert.equal(config.mteamApiKey, "your_mteam_api_key");
  assert.ok(!("coreServiceUrl" in config), "local mode template must not ship a Core service URL");
});
