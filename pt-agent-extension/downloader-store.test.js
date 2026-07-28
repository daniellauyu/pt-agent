const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const load = () => {
  const context = vm.createContext({ globalThis: null, Date, Math, URL, crypto });
  context.globalThis = context;
  ["downloader-registry.js", "downloader-store.js"].forEach((file) => {
    vm.runInContext(fs.readFileSync(path.join(__dirname, file), "utf8"), context);
  });
  return context;
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

test("classifies LAN and public addresses so the LAN entry can be probed first", () => {
  const store = load().PT_AGENT_DOWNLOADER_STORE;
  assert.equal(store.isPrivateAddress("http://192.168.1.10:8080/"), true);
  assert.equal(store.isPrivateAddress("http://10.0.0.2:8080/"), true);
  assert.equal(store.isPrivateAddress("http://172.16.5.9:8080/"), true);
  assert.equal(store.isPrivateAddress("http://172.32.5.9:8080/"), false);
  assert.equal(store.isPrivateAddress("http://localhost:8080/"), true);
  assert.equal(store.isPrivateAddress("https://qb.example.com/"), false);
});

test("migrates the old single-downloader settings without losing the password", async () => {
  const context = load();
  const storage = fakeStorage({
    ptAgentQbSettings: {
      address: "http://192.168.1.10:8080",
      username: "admin",
      password: "secret",
      savePath: "/downloads",
      mteamApiKey: "key"
    }
  });
  const store = context.PT_AGENT_DOWNLOADER_STORE.createStore(storage, {});
  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].address, "http://192.168.1.10:8080/");
  assert.equal(records[0].username, "admin");
  assert.equal(records[0].password, "secret");
  assert.equal(records[0].savePath, "/downloads");
  assert.equal(records[0].name, "内网下载器");
  assert.equal(records[0].category, "PT_AGENT");
  // 迁移结果必须落盘，否则每次启动都会重新生成一条
  assert.equal(storage.data.ptAgentDownloaders.length, 1);
});

test("keeps existing downloaders instead of re-running the legacy migration", async () => {
  const context = load();
  const storage = fakeStorage({
    ptAgentDownloaders: [
      { id: "a", name: "内网", address: "http://192.168.1.10:8080/", username: "u", password: "p" }
    ],
    ptAgentQbSettings: { address: "http://1.2.3.4:8080", username: "old", password: "old" }
  });
  const records = await context.PT_AGENT_DOWNLOADER_STORE.createStore(storage, {}).list();
  assert.equal(records.length, 1);
  assert.equal(records[0].id, "a");
});

test("reorders downloaders to change probe priority", async () => {
  const context = load();
  const storage = fakeStorage({
    ptAgentDownloaders: [
      { id: "wan", name: "外网", address: "https://qb.example.com/", username: "u", password: "p" },
      { id: "lan", name: "内网", address: "http://192.168.1.10:8080/", username: "u", password: "p" }
    ]
  });
  const store = context.PT_AGENT_DOWNLOADER_STORE.createStore(storage, {});
  const moved = await store.move("lan", -1);
  assert.deepEqual(Array.from(moved.map((item) => item.id)), ["lan", "wan"]);
  const unchanged = await store.move("lan", -1);
  assert.deepEqual(
    Array.from(unchanged.map((item) => item.id)),
    ["lan", "wan"],
    "must not move past the first slot"
  );
});

test("rejects an incomplete downloader before it reaches the network", () => {
  const store = load().PT_AGENT_DOWNLOADER_STORE;
  const record = store.normalize({ name: "", address: "192.168.1.10:8080" });
  assert.equal(record.name, "下载器 1", "空名称会被补上默认名");
  const errors = store.validate(record);
  assert.match(errors.join("；"), /http/);
  assert.match(errors.join("；"), /账号/);
  assert.match(errors.join("；"), /密码/);
});

test("refuses a downloader type that has no adapter yet", () => {
  const context = load();
  const store = context.PT_AGENT_DOWNLOADER_STORE;
  const record = store.normalize({
    name: "NAS",
    type: "transmission",
    address: "http://192.168.0.9:9091/",
    username: "u",
    password: "p"
  });
  assert.match(store.validate(record).join("；"), /尚未实现/);
  assert.throws(
    () => context.PT_AGENT_DOWNLOADER_TYPES.createAdapter(record),
    /Transmission 适配器尚未实现/
  );
});

test("exposes qBittorrent as the only implemented adapter with planned slots reserved", () => {
  const types = load().PT_AGENT_DOWNLOADER_TYPES;
  assert.deepEqual(Array.from(types.implementedIds()), ["qbittorrent"]);
  const ids = types.list().map((type) => type.id);
  assert.ok(ids.includes("transmission"));
  assert.ok(ids.includes("deluge"));
  assert.equal(types.get("qbittorrent").capabilities.categories, true);
  assert.equal(types.get("transmission").capabilities.categories, false);
});
