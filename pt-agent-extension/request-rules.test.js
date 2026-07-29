const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const load = () => {
  const context = vm.createContext({ globalThis: null, Math, Number, String, Array, Promise });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "request-rules.js"), "utf8"), context);
  return context.PT_AGENT_REQUEST_RULES;
};

const fakeDnr = () => {
  const calls = [];
  const live = new Set();
  return {
    calls,
    live,
    updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
      calls.push({ removeRuleIds, addRules });
      removeRuleIds.forEach((id) => live.delete(id));
      addRules.forEach((rule) => live.add(rule.id));
    }
  };
};

test("strips only Origin and Referer, and only for XHR", () => {
  const rule = load().buildRule({ id: 1, url: "https://qb.example.com/api/v2/auth/login", method: "POST" });
  const headers = rule.action.requestHeaders.map((item) => `${item.header}:${item.operation}`);
  assert.deepEqual(Array.from(headers), ["origin:remove", "referer:remove"]);
  assert.equal(rule.action.type, "modifyHeaders");
  assert.deepEqual(Array.from(rule.condition.resourceTypes), ["xmlhttprequest"]);
  assert.deepEqual(Array.from(rule.condition.requestMethods), ["post"]);
  assert.equal(rule.condition.urlFilter, "https://qb.example.com/api/v2/auth/login");
});

test("excludes other tabs so web pages keep qB's CSRF protection", async () => {
  const api = load();
  const dnr = fakeDnr();
  const tabs = {
    query: async () => [{ id: 1 }, { id: 2 }, { id: 7 }],
    getCurrent: async () => ({ id: 2 })
  };
  const manager = api.createManager({ dnr, tabs });
  const wrapped = manager.wrapFetch(async () => "ok");
  await wrapped("https://qb.example.com/api/v2/app/version");

  const rule = dnr.calls[0].addRules[0];
  // 自己所在的标签页不能被排除，否则规则对自己不生效
  assert.ok(!rule.condition.excludedTabIds.includes(2));
  // 其它网页标签页必须排除，否则等于替所有网站关掉了 qB 的 CSRF 保护
  assert.deepEqual(Array.from(rule.condition.excludedTabIds), [1, 7]);
});

test("removes the rule after the request so the window stays minimal", async () => {
  const api = load();
  const dnr = fakeDnr();
  const manager = api.createManager({ dnr, tabs: { query: async () => [], getCurrent: async () => undefined } });
  await manager.wrapFetch(async () => "ok")("https://qb.example.com/api/v2/app/version");
  assert.equal(dnr.live.size, 0, "no session rule may outlive the request");
  assert.equal(dnr.calls.length, 2, "one install call and one removal call");
});

test("removes the rule even when the request throws", async () => {
  const api = load();
  const dnr = fakeDnr();
  const manager = api.createManager({ dnr, tabs: { query: async () => [], getCurrent: async () => undefined } });
  const wrapped = manager.wrapFetch(async () => {
    throw new Error("Failed to fetch");
  });
  await assert.rejects(() => wrapped("https://qb.example.com/api/v2/app/version"));
  assert.equal(dnr.live.size, 0);
});

test("still sends the request when the rule cannot be installed", async () => {
  const api = load();
  const dnr = {
    updateSessionRules: async () => {
      throw new Error("no permission");
    }
  };
  const manager = api.createManager({ dnr, tabs: { query: async () => [], getCurrent: async () => undefined } });
  const result = await manager.wrapFetch(async () => "sent anyway")("https://qb.example.com/");
  assert.equal(result, "sent anyway");
});

test("falls back to a plain fetch where declarativeNetRequest is unavailable", async () => {
  const api = load();
  const manager = api.createManager({ dnr: undefined, tabs: undefined });
  assert.equal(await manager.wrapFetch(async () => "plain")("https://qb.example.com/"), "plain");
});

test("gives each request a distinct rule id inside the reserved range", () => {
  const api = load();
  const ids = new Set(Array.from({ length: 200 }, () => api.newRuleId()));
  assert.ok(ids.size > 150, "ids must not collide constantly");
  ids.forEach((id) => {
    assert.ok(id >= api.RULE_ID_MIN && id <= api.RULE_ID_MAX);
  });
});
