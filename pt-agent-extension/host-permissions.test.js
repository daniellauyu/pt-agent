const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const load = () => {
  const context = vm.createContext({ globalThis: null, URL, Promise, Array, Set });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "host-permissions.js"), "utf8"), context);
  return context.PT_AGENT_HOST_PERMISSIONS;
};

test("derives an origin pattern from any downloader address", () => {
  const api = load();
  assert.equal(api.originPattern("http://192.168.1.10:8080/"), "http://192.168.1.10:8080/*");
  assert.equal(api.originPattern("https://qb.example.com/qb/"), "https://qb.example.com/*");
  assert.equal(api.originPattern("not-a-url"), "");
  assert.equal(api.originPattern("ftp://192.168.1.10/"), "", "only http(s) can be requested");
});

test("asks for the new origin when the address is not granted yet", async () => {
  const api = load();
  const requested = [];
  const manager = api.createManager({
    contains: async () => false,
    request: async (value) => {
      requested.push(value);
      return true;
    }
  });
  const result = await manager.ensure("http://192.168.1.10:8080/");
  assert.equal(result.granted, true);
  assert.equal(result.requested, true);
  assert.equal(requested.length, 1);
  assert.deepEqual(Array.from(requested[0].origins), ["http://192.168.1.10:8080/*"]);
});

test("does not re-prompt for an address that is already granted", async () => {
  const api = load();
  let requests = 0;
  const manager = api.createManager({
    contains: async () => true,
    request: async () => {
      requests += 1;
      return true;
    }
  });
  const result = await manager.ensure("http://192.168.1.10:8080/");
  assert.equal(result.granted, true);
  assert.equal(result.requested, false);
  assert.equal(requests, 0);
});

test("reports a denied grant instead of pretending the downloader works", async () => {
  const api = load();
  const manager = api.createManager({
    contains: async () => false,
    request: async () => false
  });
  const result = await manager.ensure("https://qb.example.com/");
  assert.equal(result.granted, false);
  assert.equal(result.requested, true);
});

test("treats a permissions API failure as not granted", async () => {
  const api = load();
  const manager = api.createManager({
    contains: async () => {
      throw new Error("unavailable");
    },
    request: async () => true
  });
  assert.equal(await manager.has("http://192.168.1.10:8080/"), false);
});

test("refuses to request access for an invalid address", async () => {
  const api = load();
  const manager = api.createManager({ contains: async () => false, request: async () => true });
  await assert.rejects(() => manager.request("192.168.1.10:8080"), /地址无效/);
});
