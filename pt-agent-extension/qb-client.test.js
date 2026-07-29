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

test("round-trips the source identity tag", () => {
  const qb = loadClient();
  assert.equal(qb.sourceTag("MTEAM", 123), "ptagent-source=mteam:123");
  assert.deepEqual(
    { ...qb.sourceFromTags("ptagent, ptagent-source=mteam:123") },
    { site: "mteam", torrentId: "123" }
  );
});

test("diagnoses a network-level qBittorrent reachability failure", async () => {
  const qb = loadClient();
  const client = qb.createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, async () => {
    throw new TypeError("Failed to fetch");
  });
  const result = await client.diagnose();
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, "reachability");
  assert.deepEqual(Array.from(result.stages, (stage) => stage.status), ["error"]);
});

test("distinguishes reachable qBittorrent from a login failure", async () => {
  const qb = loadClient();
  const client = qb.createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "wrong"
  }, async (url) => {
    if (url.includes("/app/version")) return new Response("Forbidden", { status: 403 });
    if (url.includes("/auth/login")) return new Response("Fails.");
    throw new Error(`Unexpected URL: ${url}`);
  });
  const result = await client.diagnose();
  assert.equal(result.ok, false);
  assert.equal(result.failedStage, "login");
  assert.deepEqual(Array.from(result.stages, (stage) => stage.status), ["ok", "error"]);
});

test("reports all qBittorrent diagnostic stages and the version on success", async () => {
  let versionCalls = 0;
  const qb = loadClient();
  const client = qb.createClient({
    address: "http://192.168.1.10:8080/",
    username: "admin",
    password: "secret"
  }, async (url) => {
    if (url.includes("/auth/login")) return new Response("Ok.");
    if (url.includes("/app/version")) {
      versionCalls += 1;
      return new Response(versionCalls === 1 ? "Forbidden" : "v5.1.2", {
        status: versionCalls === 1 ? 403 : 200
      });
    }
    throw new Error(`Unexpected URL: ${url}`);
  });
  const result = await client.diagnose();
  assert.equal(result.ok, true);
  assert.equal(result.version, "v5.1.2");
  assert.deepEqual(Array.from(result.stages, (stage) => stage.status), ["ok", "ok", "ok"]);
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

test("surfaces who rejected a 403 instead of only the status code", async () => {
  const logs = [];
  const fetchMock = async () => new Response("Unauthorized", {
    status: 403,
    headers: { server: "nginx/1.24.0", "content-type": "text/plain" }
  });
  const client = loadClient().createClient(
    { address: "https://qb.example.com/", username: "admin", password: "secret" },
    fetchMock,
    (event, data) => logs.push({ event, data })
  );

  // 错误信息要带上响应体，否则外网 403 时看不出是 qB 还是反向代理拒绝的
  await assert.rejects(() => client.login(), /HTTP 403.*Unauthorized/s);

  const failure = logs.find((entry) => entry.event === "qb:res-error");
  assert.ok(failure, "a failed response must be logged");
  assert.equal(failure.data.status, 403);
  assert.equal(failure.data.detail, "Unauthorized");
  assert.equal(failure.data.server, "nginx/1.24.0");
});

test("truncates a long error page so the log stays readable", async () => {
  const fetchMock = async () => new Response("x".repeat(5000), { status: 403 });
  const logs = [];
  const client = loadClient().createClient(
    { address: "https://qb.example.com/", username: "a", password: "b" },
    fetchMock,
    (event, data) => logs.push({ event, data })
  );
  await assert.rejects(() => client.login());
  assert.equal(logs.find((entry) => entry.event === "qb:res-error").data.detail.length, 300);
});

test("reuses the session cookie instead of logging in for every operation", async () => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(new URL(url).pathname);
    return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
  };
  const client = loadClient().createClient(
    { address: "http://192.168.1.10:8080/", username: "admin", password: "secret" },
    fetchMock
  );
  await client.listTorrents("all");
  await client.listTorrents("all");
  // 会话有效时一次登录都不该发：过去每个操作都先 login，正是触发 qB 封禁 IP 的原因
  assert.equal(calls.filter((path) => path.endsWith("/auth/login")).length, 0);
});

test("logs in once and retries when the session has expired", async () => {
  const calls = [];
  let authed = false;
  const fetchMock = async (url) => {
    const path = new URL(url).pathname;
    calls.push(path);
    if (path.endsWith("/auth/login")) {
      authed = true;
      return new Response("Ok.");
    }
    if (!authed) return new Response("Forbidden", { status: 403 });
    return new Response(JSON.stringify([]), { headers: { "content-type": "application/json" } });
  };
  const client = loadClient().createClient(
    { address: "http://192.168.1.10:8080/", username: "admin", password: "secret" },
    fetchMock
  );
  assert.deepEqual(Array.from(await client.listTorrents("all")), []);
  assert.equal(calls.filter((path) => path.endsWith("/auth/login")).length, 1);
});

test("never retries the login when qBittorrent has banned the IP", async () => {
  const calls = [];
  const fetchMock = async (url) => {
    calls.push(new URL(url).pathname);
    return new Response("身份认证失败次数过多，您的 IP 地址已被封禁。", { status: 403 });
  };
  const client = loadClient().createClient(
    { address: "https://qb.example.com/", username: "admin", password: "secret" },
    fetchMock
  );
  const error = await client.listTorrents("all").then(() => null, (err) => err);
  assert.equal(error.code, "QB_IP_BANNED");
  assert.match(error.message, /已封禁当前 IP/);
  // 封禁时再登录只会把封禁窗口刷新，必须一次都不试
  assert.equal(calls.filter((path) => path.endsWith("/auth/login")).length, 0);
});

test("marks a failed login so the caller can back off", async () => {
  const fetchMock = async () => new Response("Forbidden", { status: 403 });
  const client = loadClient().createClient(
    { address: "https://qb.example.com/", username: "admin", password: "wrong" },
    fetchMock
  );
  const error = await client.login().then(() => null, (err) => err);
  assert.equal(error.code, "QB_LOGIN_FAILED");
});

test("verifies a sent torrent by its source tag, not by the site title", () => {
  const qb = loadClient();
  const torrents = [
    // qB 里的任务名来自种子文件，和站点标题往往对不上
    { name: "The.Dink.2026.2160p.ATVP.WEB-DL.DDP5.1.Atmos.H265-MTeam", tags: "ptagent, ptagent-source=mteam:1213980" }
  ];
  const resource = { site: "mteam", torrentId: "1213980", title: "The Dink 2026 2160p 全片名与种子名不一致" };

  assert.equal(qb.findMatchingTorrent(resource.title, torrents), null, "名称匹配在这种情况下必然失败");
  const matched = qb.matchTorrent(resource, torrents);
  assert.equal(matched.matchedBy, "source-tag");
  assert.equal(matched.torrent.name, torrents[0].name);
});

test("falls back to name matching for tasks added before source tags existed", () => {
  const qb = loadClient();
  const torrents = [{ name: "Click 2006 BluRay 2160p HDR", tags: "ptagent" }];
  const matched = qb.matchTorrent({ site: "mteam", torrentId: "999", title: "Click 2006 BluRay 2160p HDR" }, torrents);
  assert.equal(matched.matchedBy, "name");
  assert.ok(matched.torrent);
});

test("does not match a different torrent from the same site", () => {
  const qb = loadClient();
  const torrents = [{ name: "Other", tags: "ptagent, ptagent-source=mteam:111" }];
  const matched = qb.matchTorrent({ site: "mteam", torrentId: "222", title: "完全不同的标题" }, torrents);
  assert.equal(matched.matchedBy, "none");
  assert.equal(matched.torrent, null);
});

test("treats any 2xx add response as success unless qB explicitly says it failed", async () => {
  const qb = loadClient();
  const cases = [
    ["Ok.", "标准成功响应"],
    ["", "空响应体（常见于反向代理改写）"],
    ["ok.", "大小写不同"],
    ["Ok", "缺少句点"]
  ];
  for (const [body, why] of cases) {
    const client = qb.createClient(
      { address: "http://qb.local/", username: "a", password: "b" },
      async () => new Response(body)
    );
    const result = await client.addTorrent({ url: "https://tracker/1" });
    assert.equal(result.success_count, 1, `${why} 不应被判成失败`);
  }
});

test("still fails when qBittorrent explicitly rejects the torrent", async () => {
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "a", password: "b" },
    async () => new Response("Fails.")
  );
  await assert.rejects(() => client.addTorrent({ url: "https://tracker/1" }), /拒绝了这个种子/);
});

test("does not fail an add whose JSON response omits the counters", async () => {
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "a", password: "b" },
    async () => new Response("{}", { headers: { "content-type": "application/json" } })
  );
  const result = await client.addTorrent({ url: "https://tracker/1" });
  assert.ok(result, "字段缺失时按成功处理，避免误报");
});

test("fails a JSON add response that reports only failures", async () => {
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "a", password: "b" },
    async () => new Response(JSON.stringify({ success_count: 0, failure_count: 2 }), {
      headers: { "content-type": "application/json" }
    })
  );
  await assert.rejects(() => client.addTorrent({ url: "https://tracker/1" }), /添加失败/);
});
