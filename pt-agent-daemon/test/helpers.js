"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// 在任何测试替换 globalThis.fetch 之前先抓住真身。
const REAL_FETCH = globalThis.fetch;

const QB_ADDRESS = "http://qb.test:8080/";
const API_URL = "https://api.test/";
const SITE_URL = "https://site.test/";

/** 每个测试一个独立数据目录，互不干扰，也不会碰到用户真实的 ~/.ptagent。 */
const createHome = (seed = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ptagent-test-"));
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    ptAgentDownloaders: [{
      id: "dl_test",
      name: "测试下载器",
      type: "qbittorrent",
      address: QB_ADDRESS,
      username: "admin",
      password: "correct",
      savePath: "/downloads",
      category: "PT_AGENT",
      enabled: true
    }],
    ptAgentSites: [{
      id: "site_test",
      name: "测试站点",
      type: "mteam",
      siteUrl: SITE_URL,
      apiUrl: API_URL,
      apiKey: "test-key",
      enabled: true
    }],
    // 测试里不等真实的元数据解析延迟。
    ptAgentDaemon: { verifyAttempts: 1, verifyDelayMs: 0, ...seed.daemon },
    ptAgentSettings: { ...seed.policy },
    ...seed.extra
  }, null, 2));
  return root;
};

const hoursFromNow = (hours) => new Date(Date.now() + hours * 3600000).toISOString();

/** 一个「值得推荐」的资源：Free 剩余充足、做种够多、需求高于供给、体积适中。 */
const goodRow = (id, overrides = {}) => ({
  id,
  name: `Great.Release.${id}.2160p`,
  smallDescr: `好资源 ${id}`,
  size: 10 * 1024 ** 3,
  createdDate: hoursFromNow(-2),
  status: {
    discount: "FREE",
    discountEndTime: hoursFromNow(48),
    seeders: 12,
    leechers: 30,
    timesCompleted: 50,
    createdDate: hoursFromNow(-2)
  },
  ...overrides
});

/**
 * 一个同时扮演 M-Team 和 qBittorrent 的假网络。
 *
 * 用假 fetch 而不是打桩内部函数，是为了让 mteam.js、qb-client.js、决策引擎、
 * 准入引擎全部按真实路径跑一遍——真正会出问题的正是它们串起来的那些边界
 * （会话过期、409 冲突、种子字节取不到时的降级）。
 */
const createFakeNetwork = ({
  rows = [goodRow(1001)],
  qbTorrents = [],
  qbCategories = [],
  qbPassword = "correct",
  // 必须超过 40 字节：更短的响应会被当成错误页而丢弃（那道校验是有意的）。
  torrentBytes = Buffer.from("d8:announce28:https://tracker.test/announce4:infod4:name9:test.mkv6:lengthi1024eee"),
  failTorrentFile = false
} = {}) => {
  const state = {
    session: false,
    calls: [],
    torrents: [...qbTorrents],
    categories: new Set(qbCategories),
    addedTags: [],
    deleted: []
  };

  const json = (payload, status = 200) => new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" }
  });

  const fetchImpl = async (input, options = {}) => {
    const url = new URL(String(input));
    const target = `${url.origin}${url.pathname}`;
    state.calls.push(target);
    const body = String(options.body || "");

    // ---- M-Team ----
    if (url.origin === new URL(API_URL).origin) {
      if (url.pathname === "/api/member/profile") {
        return json({ message: "SUCCESS", data: {
          username: "tester",
          createdDate: hoursFromNow(-24 * 10),
          memberCount: { uploaded: 200 * 1024 ** 3, downloaded: 100 * 1024 ** 3, bonus: 3000 }
        } });
      }
      if (url.pathname === "/api/tracker/myPeerStatistics") {
        return json({ message: "SUCCESS", data: { seederCount: 20, seederSize: 500 * 1024 ** 3 } });
      }
      if (url.pathname === "/api/tracker/mybonus") {
        return json({ message: "SUCCESS", data: { formulaParams: { finalBs: 12.5 } } });
      }
      if (url.pathname === "/api/torrent/search") {
        const payload = JSON.parse(String(options.body || "{}"));
        // adult 区返回空，避免同一批资源被算两遍。
        return json({ message: "SUCCESS", data: { data: payload.mode === "normal" ? rows : [] } });
      }
      if (url.pathname === "/api/torrent/genDlToken") {
        return json({ message: "SUCCESS", data: "https://cdn.test/download/abc" });
      }
      return json({ message: "NOT_FOUND" }, 404);
    }

    // ---- 种子文件 CDN ----
    if (url.origin === "https://cdn.test") {
      if (failTorrentFile) return new Response("<html>forbidden</html>", { status: 403 });
      return new Response(torrentBytes, {
        status: 200,
        headers: { "content-type": "application/x-bittorrent" }
      });
    }

    // ---- qBittorrent ----
    if (url.origin === new URL(QB_ADDRESS).origin) {
      const route = url.pathname.replace("/api/v2/", "");
      if (route === "auth/login") {
        if (!body.includes(`password=${qbPassword}`)) return new Response("Fails.", { status: 200 });
        state.session = true;
        return new Response("Ok.");
      }
      if (!state.session) return new Response("Forbidden", { status: 403 });
      if (route === "app/version") return new Response("v4.6.0");
      if (route === "torrents/info") return json(state.torrents);
      if (route === "torrents/categories") {
        return json(Object.fromEntries([...state.categories].map((name) => [name, { name }])));
      }
      if (route === "torrents/createCategory") {
        const name = new URLSearchParams(body).get("category");
        if (state.categories.has(name)) return new Response("Conflict", { status: 409 });
        state.categories.add(name);
        return new Response("Ok.");
      }
      if (route === "torrents/add") {
        // FormData 的 body 在这里是 FormData 实例，直接读字段。
        const form = options.body;
        const tags = typeof form?.get === "function" ? String(form.get("tags") || "") : "";
        const hash = `hash${state.torrents.length + 1}`.padEnd(40, "0");
        state.torrents.push({
          hash,
          name: rows[state.torrents.length]?.name || `Great.Release.${1001 + state.torrents.length}.2160p`,
          size: 10 * 1024 ** 3,
          total_size: 10 * 1024 ** 3,
          progress: 0,
          state: "downloading",
          dlspeed: 5 * 1024 ** 2,
          amount_left: 10 * 1024 ** 3,
          tags,
          category: "PT_AGENT",
          tracker: "https://tracker.test/announce"
        });
        return new Response("Ok.");
      }
      if (route === "torrents/addTags") {
        const params = new URLSearchParams(body);
        state.addedTags.push({ hashes: params.get("hashes"), tags: params.get("tags") });
        return new Response("Ok.");
      }
      if (route === "torrents/delete") {
        const params = new URLSearchParams(body);
        const hashes = String(params.get("hashes") || "").split("|");
        state.deleted.push(...hashes);
        state.torrents = state.torrents.filter((item) => !hashes.includes(item.hash));
        return new Response("Ok.");
      }
      return new Response("Ok.");
    }

    // WebUI 测试要访问本机起的测试服务器，这类请求放行到真实 fetch。
    // 其余没覆盖到的地址一律报错——静默放行等于测试会偷偷打真实站点。
    if (/^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname)) return REAL_FETCH(input, options);
    throw new Error(`假网络没有覆盖这个地址：${target}`);
  };

  return { state, fetchImpl };
};

/** 装上假 fetch 并返回卸载函数。 */
const installFetch = (fetchImpl) => {
  const original = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return () => { globalThis.fetch = original; };
};

const withHome = (root, task) => {
  const previous = process.env.PTAGENT_HOME;
  process.env.PTAGENT_HOME = root;
  return Promise.resolve(task()).finally(() => {
    if (previous === undefined) delete process.env.PTAGENT_HOME;
    else process.env.PTAGENT_HOME = previous;
  });
};

const cleanup = (root) => fs.rmSync(root, { recursive: true, force: true });

module.exports = {
  API_URL, SITE_URL, QB_ADDRESS,
  cleanup, createFakeNetwork, createHome, goodRow, hoursFromNow, installFetch, withHome
};
