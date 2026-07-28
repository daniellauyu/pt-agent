const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const context = vm.createContext({ globalThis: null, Date, Promise });
context.globalThis = context;
vm.runInContext(fs.readFileSync(path.join(__dirname, "network-router.js"), "utf8"), context);
const router = context.PT_AGENT_NETWORK_ROUTER;

const lan = { id: "lan", name: "内网 qB", address: "http://192.168.1.10:8080/", enabled: true };
const wan = { id: "wan", name: "外网 qB", address: "https://qb.example.com/", enabled: true };

test("picks the LAN downloader when it answers first", async () => {
  const tried = [];
  const selection = await router.selectDownloader([lan, wan], {
    probe: async (downloader) => {
      tried.push(downloader.id);
      return { ok: true, latencyMs: 12 };
    }
  });
  assert.equal(selection.downloader.id, "lan");
  assert.equal(selection.reason, "probe");
  assert.deepEqual(tried, ["lan"], "must stop probing once one answers");
});

test("falls through to the WAN downloader when the LAN address times out", async () => {
  const selection = await router.selectDownloader([lan, wan], {
    probe: async (downloader) => (downloader.id === "lan"
      ? { ok: false, error: "TimeoutError" }
      : { ok: true, latencyMs: 88 })
  });
  assert.equal(selection.downloader.id, "wan");
  assert.equal(selection.reason, "probe");
  assert.equal(selection.probes.length, 2);
  assert.equal(selection.probes[0].ok, false);
  assert.match(router.describe(selection), /已切换到 外网 qB/);
});

test("reuses a fresh cache instead of probing again", async () => {
  let probes = 0;
  const selection = await router.selectDownloader([lan, wan], {
    probe: async () => {
      probes += 1;
      return { ok: true };
    },
    cache: { id: "wan", at: 1_000 },
    nowMs: 5_000,
    ttlMs: 30_000
  });
  assert.equal(probes, 0);
  assert.equal(selection.reason, "cache");
  assert.equal(selection.downloader.id, "wan");
});

test("re-probes once the cache expires", async () => {
  let probes = 0;
  const selection = await router.selectDownloader([lan, wan], {
    probe: async () => {
      probes += 1;
      return { ok: true };
    },
    cache: { id: "wan", at: 1_000 },
    nowMs: 999_000,
    ttlMs: 30_000
  });
  assert.equal(probes, 1);
  assert.equal(selection.reason, "probe");
  assert.equal(selection.downloader.id, "lan");
});

test("drops a cached downloader that no longer exists or was disabled", async () => {
  const selection = await router.selectDownloader([lan], {
    probe: async () => ({ ok: true }),
    cache: { id: "wan", at: Date.now() }
  });
  assert.equal(selection.reason, "probe");
  assert.equal(selection.downloader.id, "lan");
});

test("skips downloaders excluded from automatic routing", async () => {
  const tried = [];
  await router.selectDownloader([{ ...lan, enabled: false }, wan], {
    probe: async (downloader) => {
      tried.push(downloader.id);
      return { ok: true };
    }
  });
  assert.deepEqual(tried, ["wan"]);
});

test("reports a clear failure when every downloader is unreachable", async () => {
  const selection = await router.selectDownloader([lan, wan], {
    probe: async () => ({ ok: false, error: "Failed to fetch" })
  });
  assert.equal(selection.reason, "fallback");
  assert.equal(selection.downloader.id, "lan");
  assert.equal(selection.cache, null, "an unreachable pick must not be cached");
  assert.match(router.describe(selection), /均不可达/);
});

test("treats a throwing probe as unreachable instead of crashing the scan", async () => {
  const selection = await router.selectDownloader([lan, wan], {
    probe: async (downloader) => {
      if (downloader.id === "lan") throw new Error("缺少主机访问权限");
      return { ok: true };
    }
  });
  assert.equal(selection.downloader.id, "wan");
  assert.match(selection.probes[0].error, /缺少主机访问权限/);
});

test("returns nothing when no downloader is configured", async () => {
  const selection = await router.selectDownloader([], { probe: async () => ({ ok: true }) });
  assert.equal(selection.downloader, null);
  assert.equal(selection.reason, "none");
  assert.match(router.describe(selection), /没有可用的下载器/);
});
