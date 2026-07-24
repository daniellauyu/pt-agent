const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "qb-client.js"), "utf8");

const loadClient = () => {
  const context = vm.createContext({
    URL,
    URLSearchParams,
    FormData,
    Blob,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(source, context);
  return context.PT_AGENT_QB;
};

test("logs in and sends a torrent URL with the Free deadline tag", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/login")) return new Response("Ok.");
    if (url.endsWith("/torrents/add")) return new Response("Ok.");
    throw new Error(`Unexpected URL: ${url}`);
  };
  const qb = loadClient();
  const client = qb.createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, fetchMock);

  await client.login();
  await client.addTorrent({
    url: "https://tracker.example/download/1",
    tag: qb.torrentTags("2026-07-24 23:32:27"),
    savePath: "/downloads/pt"
  });

  assert.equal(calls[0].url, "http://192.168.1.10:8080/api/v2/auth/login");
  assert.equal(calls[1].url, "http://192.168.1.10:8080/api/v2/torrents/add");
  assert.equal(calls[1].options.body.get("urls"), "https://tracker.example/download/1");
  assert.equal(
    calls[1].options.body.get("tags"),
    "ptagent, ptagent-free-end=2026-07-24 23:32:27"
  );
  assert.equal(calls[1].options.body.get("category"), "PT_AGENT");
  assert.equal(calls[1].options.body.get("savepath"), "/downloads/pt");
});

test("uploads the .torrent file bytes instead of a URL when a file is provided", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/auth/login")) return new Response("Ok.");
    if (url.endsWith("/torrents/add")) return new Response("Ok.");
    throw new Error(`Unexpected URL: ${url}`);
  };
  const qb = loadClient();
  const client = qb.createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, fetchMock);

  await client.login();
  await client.addTorrent({
    url: "https://api.m-team.cc/token/should-not-be-used",
    file: new Blob([new Uint8Array([100, 51, 58])], { type: "application/x-bittorrent" }),
    filename: "movie.torrent",
    tag: qb.torrentTags("2026-07-24 23:32:27"),
    savePath: "/downloads/pt"
  });

  const addBody = calls[1].options.body;
  assert.equal(calls[1].url, "http://192.168.1.10:8080/api/v2/torrents/add");
  assert.ok(addBody.get("torrents"), "must upload the torrent file bytes");
  assert.equal(addBody.get("urls"), null, "must not fall back to the M-Team URL when a file is present");
  assert.equal(addBody.get("category"), "PT_AGENT");
  assert.equal(addBody.get("savepath"), "/downloads/pt");
});

test("extracts the Free deadline from qBittorrent tags", () => {
  const qb = loadClient();
  assert.equal(
    qb.deadlineFromTags("movie, 2026-07-24 23:32:27, free"),
    "2026-07-24 23:32:27"
  );
});

test("adds the fixed ptagent tag before the Free deadline", () => {
  const qb = loadClient();
  assert.equal(
    qb.torrentTags("2026-07-24 23:32:27"),
    "ptagent, ptagent-free-end=2026-07-24 23:32:27"
  );
});

test("extracts an ISO 8601 deadline without dropping its offset", () => {
  const qb = loadClient();
  assert.equal(
    qb.deadlineFromTags("ptagent, ptagent-free-end=2026-07-24T23:32:27+08:00"),
    "2026-07-24T23:32:27+08:00"
  );
});

test("matches a scanned M-Team title to the qBittorrent task name", () => {
  const qb = loadClient();
  const match = qb.findMatchingTorrent(
    "Click 2006 BluRay 2160p HDR x265 Atmos TrueHD 7.1-MTeam",
    [{ name: "Click.2006.BluRay.2160p.HDR.x265.Atmos.TrueHD.7.1-MTeam", progress: 0.5 }]
  );
  assert.equal(match.progress, 0.5);
});

test("adds tags to an existing qBittorrent task", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response("");
  };
  const qb = loadClient();
  const client = qb.createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, fetchMock);
  await client.addTags("abc123", "ptagent, 2026-07-24 23:32:27");
  assert.match(calls[0].url, /\/torrents\/addTags$/);
  assert.equal(calls[0].options.body.get("hashes"), "abc123");
  assert.equal(calls[0].options.body.get("tags"), "ptagent, 2026-07-24 23:32:27");
});

test("creates the PT_AGENT category only when it does not already exist", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/torrents/categories")) return Response.json({});
    return new Response("");
  };
  const client = loadClient().createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, fetchMock);
  await client.ensureCategory("PT_AGENT", "/downloads/pt");
  assert.match(calls[0].url, /\/torrents\/categories$/);
  assert.match(calls[1].url, /\/torrents\/createCategory$/);
  assert.equal(calls[1].options.body.get("category"), "PT_AGENT");
  assert.equal(calls[1].options.body.get("savePath"), "/downloads/pt");
});

test("reuses an existing PT_AGENT category", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    return Response.json({ PT_AGENT: { name: "PT_AGENT" } });
  };
  const client = loadClient().createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, fetchMock);
  await client.ensureCategory("PT_AGENT");
  assert.equal(calls.length, 1);
});

test("deletes only the requested qB task and explicitly controls file deletion", async () => {
  const calls = [];
  const fetchMock = async (url, options = {}) => {
    calls.push({ url, options });
    return new Response("");
  };
  const client = loadClient().createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, fetchMock);
  await client.deleteTorrents("abc123", true);
  assert.match(calls[0].url, /\/torrents\/delete$/);
  assert.equal(calls[0].options.body.get("hashes"), "abc123");
  assert.equal(calls[0].options.body.get("deleteFiles"), "true");
});

test("summarizes every completed M-Team torrent in qB regardless of ptagent tags", () => {
  const qb = loadClient();
  const summary = qb.summarizeMteamSeeding([
    {
      tracker: "https://tracker.m-team.cc/announce?passkey=hidden",
      progress: 1,
      size: 10,
      tags: "",
      state: "queuedUP"
    },
    {
      tracker: "https://tracker.m-team.cc/announce?passkey=hidden",
      progress: 1,
      size: 20,
      tags: "ptagent",
      state: "uploading"
    },
    {
      tracker: "https://tracker.other.example/announce",
      progress: 1,
      size: 40,
      tags: ""
    },
    {
      tracker: "https://tracker.m-team.cc/announce?passkey=hidden",
      progress: 0.5,
      size: 80,
      tags: ""
    }
  ]);
  assert.equal(summary.count, 2);
  assert.equal(summary.sizeBytes, 30);
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.queuedCount, 1);
  assert.equal(summary.stateCounts.queuedUP, 1);
  assert.equal(summary.stateCounts.uploading, 1);
});
