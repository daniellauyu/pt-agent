const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const load = () => {
  const context = vm.createContext({ globalThis: null, Date, Math, crypto });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "site-store.js"), "utf8"), context);
  return context.PT_AGENT_SITE_STORE;
};

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    get: async (keys) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]]));
    },
    set: async (patch) => Object.assign(data, patch)
  };
};

test("moves the M-Team API Key out of the downloader settings on first run", async () => {
  const store = load();
  const storage = fakeStorage({
    ptAgentQbSettings: { address: "http://192.168.1.10:8080/", mteamApiKey: "legacy-key" }
  });
  const sites = await store.createStore(storage, {
    mteamSiteUrl: "https://kp.m-team.cc/",
    mteamApiUrl: "https://api.m-team.cc/"
  }).list();
  assert.equal(sites.length, 1);
  assert.equal(sites[0].type, "mteam");
  assert.equal(sites[0].apiKey, "legacy-key");
  assert.equal(sites[0].siteUrl, "https://kp.m-team.cc/");
  assert.equal(sites[0].apiUrl, "https://api.m-team.cc/");
  assert.equal(storage.data.ptAgentSites.length, 1);
});

test("supports more than one site and picks the enabled M-Team entry as active", async () => {
  const store = load();
  const storage = fakeStorage({
    ptAgentSites: [
      { id: "s1", name: "旧站", type: "generic", siteUrl: "https://a.example/", enabled: false },
      { id: "s2", name: "M-Team", type: "mteam", apiKey: "k", enabled: true }
    ]
  });
  const api = store.createStore(storage, {});
  assert.equal((await api.list()).length, 2);
  assert.equal((await api.active()).id, "s2");
});

test("requires an API key only for site types that call an API", () => {
  const store = load();
  const mteam = store.normalize({ name: "M-Team", type: "mteam", apiKey: "" });
  assert.match(store.validate(mteam).join("；"), /API Key/);
  const generic = store.normalize({
    name: "某站",
    type: "generic",
    siteUrl: "https://example.com/"
  });
  assert.equal(store.validate(generic).length, 0);
});

test("normalizes site URLs to a single trailing slash", () => {
  const store = load();
  const site = store.normalize({ name: "X", type: "mteam", siteUrl: "https://kp.m-team.cc///" });
  assert.equal(site.siteUrl, "https://kp.m-team.cc/");
});
