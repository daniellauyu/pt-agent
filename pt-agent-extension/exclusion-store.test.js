const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "exclusion-store.js"), "utf8");

const loadStore = (initial = []) => {
  const values = { ptAgentExcludedTorrents: structuredClone(initial) };
  const storage = {
    async get(key) { return { [key]: structuredClone(values[key]) }; },
    async set(update) { Object.assign(values, structuredClone(update)); }
  };
  const context = vm.createContext({ globalThis: null });
  context.globalThis = context;
  vm.runInContext(source, context);
  return { api: context.PT_AGENT_EXCLUSIONS, store: context.PT_AGENT_EXCLUSIONS.createStore(storage), values };
};

test("persists exclusions and matches a candidate by site and torrent ID", async () => {
  const { store } = loadStore();
  await store.exclude({ site: "mteam", torrentId: "123", title: "Movie" });
  const reloaded = await store.list();
  assert.equal(reloaded.length, 1);
  assert.equal(store.isExcluded({ site: "mteam", torrentId: 123 }, reloaded), true);
});

test("matches an existing qB task by info hash", async () => {
  const { store } = loadStore();
  await store.exclude({ hash: "ABC123", title: "Movie" });
  assert.equal(store.isExcluded({ infoHash: "abc123" }, await store.list()), true);
});

test("falls back to normalized title and exact size for legacy tasks", async () => {
  const { store } = loadStore();
  await store.exclude({ title: "Movie.Name 2026", sizeBytes: 2048 });
  const records = await store.list();
  assert.equal(store.isExcluded({ title: "Movie Name.2026", sizeBytes: 2048 }, records), true);
  assert.equal(store.isExcluded({ title: "Movie Name.2026", sizeBytes: 4096 }, records), false);
});

test("upserts duplicate exclusions and restore makes the candidate eligible again", async () => {
  const { store } = loadStore();
  await store.exclude({ site: "mteam", torrentId: "123", title: "Old title" });
  await store.exclude({ site: "mteam", torrentId: "123", title: "New title" });
  const records = await store.list();
  assert.equal(records.length, 1);
  assert.equal(records[0].title, "New title");
  await store.restore(records[0].id);
  assert.equal(store.isExcluded({ site: "mteam", torrentId: "123" }, await store.list()), false);
});
