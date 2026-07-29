// 端到端流程测试：用一个「有状态的假 qBittorrent」跑真实的 qb-client，
// 断言用户最终看到的那句报错文案。
//
// 之前排查外网 403 时反复靠截图猜原因，就是因为没有这层测试：
// 单元测试只覆盖单个请求，而真正出问题的是「分类已存在 + 种子已存在 + 会话过期」
// 这些组合起来的完整入队序列。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const loadClient = () => {
  const context = vm.createContext({
    // Headers 是 qb-client 组装请求头时用的：Node 侧要手动带 Cookie 和 Origin/Referer，
    // 浏览器里这两样是自动的。vm 上下文不继承外层全局，漏掉哪个就会在运行时才炸。
    URL, URLSearchParams, Headers, FormData, Blob, Response, Date, Number, String, Object, Array, Math,
    globalThis: null
  });
  context.globalThis = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "qb-client.js"), "utf8"), context);
  return context.PT_AGENT_QB;
};

/**
 * 模拟 qBittorrent WebUI 的关键行为，包括那些让我们踩坑的地方：
 * 会话过期返回 403、分类已存在返回 409、种子重复返回 409、认证失败多次后封禁 IP。
 */
const createFakeQb = ({
  password = "correct",
  categories = [],
  torrents = [],
  maxAuthFailures = 5,
  requireSession = true
} = {}) => {
  const state = {
    session: false,
    failures: 0,
    banned: false,
    categories: new Set(categories),
    torrents: new Set(torrents),
    log: []
  };

  const fetchImpl = async (url, options = {}) => {
    const path = new URL(url).pathname.replace("/api/v2/", "");
    state.log.push(path);

    if (state.banned) {
      return new Response("身份认证失败次数过多，您的 IP 地址已被封禁。", { status: 403 });
    }

    if (path === "auth/login") {
      const body = String(options.body || "");
      const ok = body.includes(`password=${password}`);
      if (!ok) {
        state.failures += 1;
        if (state.failures >= maxAuthFailures) state.banned = true;
        return new Response("Fails.", { status: 200 });
      }
      state.session = true;
      return new Response("Ok.");
    }

    if (requireSession && !state.session) return new Response("Forbidden", { status: 403 });

    if (path === "torrents/categories") {
      return new Response(
        JSON.stringify(Object.fromEntries([...state.categories].map((name) => [name, { name }]))),
        { headers: { "content-type": "application/json" } }
      );
    }

    if (path === "torrents/createCategory") {
      const name = new URLSearchParams(String(options.body)).get("category");
      if (state.categories.has(name)) return new Response("Conflict", { status: 409 });
      state.categories.add(name);
      return new Response("Ok.");
    }

    if (path === "torrents/add") {
      const id = "fixed-torrent-id";
      if (state.torrents.has(id)) return new Response("Conflict", { status: 409 });
      state.torrents.add(id);
      return new Response("Ok.");
    }

    return new Response("Ok.");
  };

  return { state, fetchImpl };
};

const enqueue = async (client, category = "PT_AGENT") => {
  await client.ensureCategory(category, "");
  return client.addTorrent({ url: "https://tracker/1", tag: "ptagent", category });
};

test("a first-time enqueue logs in once and succeeds", async () => {
  const qb = createFakeQb();
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "correct" },
    qb.fetchImpl
  );
  const result = await enqueue(client);
  assert.equal(result.duplicate, undefined);
  assert.equal(qb.state.log.filter((p) => p === "auth/login").length, 1, "只登录一次");
  assert.ok(qb.state.categories.has("PT_AGENT"));
  assert.equal(qb.state.torrents.size, 1);
});

test("re-enqueueing the same torrent reports duplicate instead of failure", async () => {
  const qb = createFakeQb({ categories: ["PT_AGENT"], torrents: ["fixed-torrent-id"] });
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "correct" },
    qb.fetchImpl
  );
  // 分类已存在(409) + 种子已存在(409)，两个 409 都不该让入队失败
  const result = await enqueue(client);
  assert.equal(result.duplicate, true);
});

test("an existing category alone never fails the enqueue", async () => {
  const qb = createFakeQb({ categories: ["PT_AGENT"] });
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "correct" },
    qb.fetchImpl
  );
  const result = await enqueue(client);
  assert.equal(result.duplicate, undefined, "分类已存在不影响种子新增");
  assert.equal(qb.state.torrents.size, 1);
});

test("a wrong password surfaces the credential error, not a generic failure", async () => {
  const qb = createFakeQb({ password: "correct" });
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "wrong" },
    qb.fetchImpl
  );
  await assert.rejects(() => enqueue(client), /账号或密码错误/);
});

test("repeated wrong passwords end in the ban message and stop retrying", async () => {
  const qb = createFakeQb({ password: "correct", maxAuthFailures: 2 });
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "wrong" },
    qb.fetchImpl
  );
  await assert.rejects(() => enqueue(client));
  const error = await enqueue(client).then(() => null, (err) => err);
  assert.equal(error.code, "QB_IP_BANNED");
  assert.match(error.message, /已封禁当前 IP/);

  const before = qb.state.log.length;
  await enqueue(client).catch(() => {});
  const loginsAfterBan = qb.state.log.slice(before).filter((p) => p === "auth/login").length;
  assert.equal(loginsAfterBan, 0, "封禁后一次登录都不能再试，否则封禁窗口会被不断刷新");
});

test("an expired session is renewed transparently mid-flow", async () => {
  const qb = createFakeQb({ categories: ["PT_AGENT"] });
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "correct" },
    qb.fetchImpl
  );
  await enqueue(client);
  // qB 重启：会话失效，但下一次操作应当自动恢复而不是报错
  qb.state.session = false;
  qb.state.torrents.clear();
  const result = await enqueue(client);
  assert.equal(result.duplicate, undefined);
  assert.equal(qb.state.log.filter((p) => p === "auth/login").length, 2);
});

test("a reverse proxy rewriting the add response does not break the enqueue", async () => {
  const qb = createFakeQb({ categories: ["PT_AGENT"] });
  const original = qb.fetchImpl;
  const client = loadClient().createClient(
    { address: "https://qb.example.com/", username: "admin", password: "correct" },
    async (url, options) => {
      const response = await original(url, options);
      // 反向代理把 "Ok." 换成空响应体——这曾把成功的添加误报成失败
      if (new URL(url).pathname.endsWith("/torrents/add") && response.status === 200) {
        return new Response("", { status: 200 });
      }
      return response;
    }
  );
  const result = await enqueue(client);
  assert.equal(result.success_count, 1);
});

test("a genuine server error still fails loudly with its status", async () => {
  const qb = createFakeQb({ categories: ["PT_AGENT"] });
  const original = qb.fetchImpl;
  const client = loadClient().createClient(
    { address: "http://qb.local/", username: "admin", password: "correct" },
    async (url, options) => (new URL(url).pathname.endsWith("/torrents/add")
      ? new Response("Internal Server Error", { status: 500 })
      : original(url, options))
  );
  await assert.rejects(() => enqueue(client), /HTTP 500.*Internal Server Error/s);
});
