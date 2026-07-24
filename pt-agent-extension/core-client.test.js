const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "core-client.js"), "utf8");

const loadClient = () => {
  const context = vm.createContext({ URL, globalThis: null });
  context.globalThis = context;
  vm.runInContext(source, context);
  return context.PT_AGENT_CORE;
};

test("syncs resources, qB-wide account seeding totals, and audit events", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/health")) return Response.json({ status: "ok", version: "0.1.0" });
    if (url.endsWith("/api/torrents/import")) return Response.json({ created: 1, updated: 0 });
    if (url.endsWith("/api/account/snapshots")) return Response.json({ id: 1 });
    if (url.endsWith("/api/audit/import")) return Response.json({ created: 1, skipped: 0 });
    throw new Error(`Unexpected URL: ${url}`);
  };
  const client = loadClient().createClient({ address: "http://127.0.0.1:8090/" }, fetchMock);
  const result = await client.sync({
    scan: {
      page: { url: "https://kp.m-team.cc/" },
      site: { siteId: "mteam", siteName: "M-Team" },
      account: {
        createdDate: "2026-07-17T21:45:42+08:00",
        uploadedBytes: 10,
        downloadedBytes: 5,
        ratio: 2,
        bonus: 836.7,
        bonusPerHour: 2.223,
        seedingCount: 1,
        seedingSizeBytes: 100
      }
    },
    torrents: [{ torrentId: "1", title: "Example", site: "mteam" }],
    qbSeedingSummary: { count: 108, sizeBytes: 1251886864038 },
    auditEvents: [{
      id: "event-1",
      timestamp: "2026-07-24T12:00:00.000Z",
      action: "enqueue",
      status: "queued"
    }]
  });

  assert.equal(result.service.status, "ok");
  assert.equal(calls.length, 4);
  const accountCall = calls.find((call) => call.url.endsWith("/api/account/snapshots"));
  const accountBody = JSON.parse(accountCall.options.body);
  assert.ok(accountBody.captured_at);
  assert.equal(accountBody.seedingCount, 108);
  assert.equal(accountBody.seedingSizeBytes, 1251886864038);
  const auditCall = calls.find((call) => call.url.endsWith("/api/audit/import"));
  assert.equal(JSON.parse(auditCall.options.body).events[0].id, "event-1");
});

test("reports a Core Service HTTP error without affecting other clients", async () => {
  const client = loadClient().createClient(
    { address: "http://127.0.0.1:8090/" },
    async () => new Response("offline", { status: 503 })
  );
  await assert.rejects(client.health(), /PT Core 请求失败（HTTP 503）/);
});
