const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const load = () => {
  const context = vm.createContext({ globalThis: null, Date, Array, Map, Set, String, Number, Boolean, Promise });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "torrent-links.js"), "utf8"), context);
  return context.PT_AGENT_TORRENT_LINKS;
};

const fakeStorage = (initial = {}) => {
  const data = { ...initial };
  return {
    data,
    get: async (key) => (key in data ? { [key]: data[key] } : {}),
    set: async (patch) => Object.assign(data, patch)
  };
};

const sourceFromTags = (tags) => {
  const match = String(tags || "").match(/(?:^|,\s*)ptagent-source=([^,:\s]+):([^,\s]+)/i);
  return match ? { site: match[1].toLowerCase(), torrentId: match[2] } : null;
};

test("links a site resource to the downloader task that actually landed", async () => {
  const api = load();
  const storage = fakeStorage();
  const store = api.createStore(storage);
  await store.link({
    site: "mteam",
    torrentId: "1218558",
    hash: "ABCDEF0123",
    siteTitle: "某剧集 第01集 中文标题",
    qbName: "Some.Show.S01E01.2160p.WEB-DL-MTeam"
  });

  const index = api.createIndex(await store.list());
  const link = index.forResource("mteam", "1218558");
  assert.equal(link.hash, "abcdef0123", "infoHash 统一小写便于比对");
  assert.equal(link.siteTitle, "某剧集 第01集 中文标题");
  assert.equal(link.qbName, "Some.Show.S01E01.2160p.WEB-DL-MTeam");
  // 反查：任务列表要显示这个任务对应哪个站点资源
  assert.equal(index.forHash("ABCDEF0123").siteTitle, "某剧集 第01集 中文标题");
});

test("keeps the original link time when the same resource is re-linked", async () => {
  const api = load();
  const store = api.createStore(fakeStorage());
  const first = await store.link({ site: "mteam", torrentId: "1", hash: "aaa", linkedAt: "2026-01-01T00:00:00.000Z" });
  await store.link({ site: "mteam", torrentId: "1", hash: "aaa", qbName: "改名后的任务" });
  const links = await store.list();
  assert.equal(links.length, 1);
  assert.equal(links[0].linkedAt, first.linkedAt);
  assert.equal(links[0].qbName, "改名后的任务");
});

test("backfills links from the source tags of already-added tasks", async () => {
  const api = load();
  const store = api.createStore(fakeStorage());
  const links = await store.backfillFromTasks([
    { hash: "H1", name: "Task.One", tags: "ptagent, ptagent-source=mteam:111" },
    { hash: "H2", name: "Task.Two", tags: "ptagent" },
    { hash: "H3", name: "Task.Three", tags: "ptagent, ptagent-source=mteam:333" }
  ], sourceFromTags);

  const index = api.createIndex(links);
  assert.equal(index.size, 2, "没有来源标签的任务不建立关联");
  assert.equal(index.forResource("mteam", "111").hash, "h1");
  assert.equal(index.forResource("mteam", "333").hash, "h3");
});

test("drops links whose task no longer exists in the downloader", async () => {
  const api = load();
  const store = api.createStore(fakeStorage());
  await store.link({ site: "mteam", torrentId: "1", hash: "alive" });
  await store.link({ site: "mteam", torrentId: "2", hash: "deleted" });
  const remaining = await store.prune(["ALIVE"]);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].hash, "alive");
});

test("ignores records that cannot identify both sides", async () => {
  const api = load();
  const store = api.createStore(fakeStorage());
  assert.equal(await store.link({ site: "mteam", torrentId: "1" }), null, "缺少 infoHash 不能建立关联");
  assert.equal(await store.link({ hash: "abc" }), null, "缺少站点资源标识不能建立关联");
  assert.equal((await store.list()).length, 0);
});
