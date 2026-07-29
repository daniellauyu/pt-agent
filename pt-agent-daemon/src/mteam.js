"use strict";

const { load } = require("./engines");

const DEFAULT_TIMEOUT_MS = 20000;

/**
 * M-Team API 客户端。请求形状与插件 popup.js 里的实现一致，
 * 只是把浏览器的 fetch 换成 Node 的 fetch。
 *
 * 顺带解决了插件版最难缠的一个问题：genDlToken 返回的地址会 302 到 CDN（halomt.com），
 * 浏览器里要靠 host 权限才能跨域取回种子字节，取不到就只能退化成让 qB 自己抓。
 * Node 里没有同源策略，种子文件永远能拿到字节再上传，成功率天然更高。
 */
const createSiteClient = (site, { logger, operationId = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) => {
  const log = (event, data, level = "debug") => logger?.[level]?.(event, data, { operationId });

  if (!site?.apiKey) throw new Error("缺少站点 API Key，请先执行 ptagent site add 或在 WebUI 里填写");
  if (!site?.apiUrl) throw new Error("缺少站点 API 地址");

  const request = async (path, { json, form } = {}) => {
    const headers = { "x-api-key": site.apiKey };
    let body;
    if (json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(json);
    } else if (form !== undefined) {
      body = form;
    }
    const url = new URL(String(path).replace(/^\/+/, ""), site.apiUrl).toString();
    log("mteam:req", { path, params: json || null });
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      log("mteam:req-error", { path, error: String(error?.message || error) }, "error");
      throw new Error(`M-Team 无法连接（${String(error?.message || error)}）`);
    }
    const payload = await response.json().catch(() => ({}));
    log("mteam:res", { path, status: response.status, message: payload?.message });
    if (!response.ok || payload?.message !== "SUCCESS") {
      log("mteam:res-error", { path, status: response.status, message: payload?.message }, "error");
      throw new Error(payload?.message || `M-Team 请求失败（HTTP ${response.status}）`);
    }
    return payload.data;
  };

  const fetchAccount = async () => {
    const [profile, statistics, bonusData] = await Promise.all([
      request("/api/member/profile"),
      request("/api/tracker/myPeerStatistics"),
      request("/api/tracker/mybonus")
    ]);
    const uploadedBytes = Number(profile?.memberCount?.uploaded || 0);
    const downloadedBytes = Number(profile?.memberCount?.downloaded || 0);
    return {
      username: profile?.username || "",
      createdDate: profile?.createdDate || "",
      uploadedBytes,
      downloadedBytes,
      ratio: downloadedBytes > 0 ? uploadedBytes / downloadedBytes : null,
      bonus: Number(profile?.memberCount?.bonus || 0),
      seedingCount: Number(statistics?.seederCount || 0),
      seedingSizeBytes: Number(statistics?.seederSize || 0),
      trackerSeedingCount: Number(statistics?.seederCount || 0),
      trackerSeedingSizeBytes: Number(statistics?.seederSize || 0),
      bonusPerHour: Number(bonusData?.formulaParams?.finalBs || 0),
      newUserExamine: Boolean(bonusData?.formulaParams?.newUserExamine),
      source: "mteam-api"
    };
  };

  // 只抓仍在 Free 期内的资源；连续两页没有有效 Free 就停，避免把整个列表翻完。
  const fetchFreeCatalog = async ({ pageSize = 100, maxPages = 10 } = {}) => {
    const core = load().backfill;
    const fetchMode = async (mode) => {
      const torrents = [];
      let pagesRead = 0;
      let emptyFreePages = 0;
      for (let pageNumber = 1; pageNumber <= maxPages; pageNumber += 1) {
        const data = await request("/api/torrent/search", {
          json: { mode, pageNumber, pageSize, discount: "FREE" }
        });
        const rows = data?.data || [];
        const freeRows = rows.filter((row) => {
          const deadline = core.freeDeadline(row);
          return deadline && Date.parse(deadline) > Date.now();
        });
        pagesRead += 1;
        torrents.push(...freeRows);
        emptyFreePages = freeRows.length === 0 ? emptyFreePages + 1 : 0;
        if (rows.length < pageSize || emptyFreePages >= 2) break;
      }
      return { mode, pagesRead, torrents };
    };

    const areas = [await fetchMode("normal"), await fetchMode("adult")];
    const deduplicated = new Map();
    for (const area of areas) {
      for (const row of area.torrents) {
        deduplicated.set(String(row.id), {
          rowIndex: 0,
          site: "mteam",
          torrentId: String(row.id),
          infoHash: "",
          title: row.name || "",
          subtitle: row.smallDescr || "",
          category: row.category || area.mode,
          sizeBytes: Number(row.size || 0),
          sizeText: "",
          freeType: "free",
          freeStartAt: row.status?.createdDate || row.createdDate || "",
          freeEndAt: core.freeDeadline(row),
          freeLeftText: "",
          seeders: Number(row.status?.seeders || 0),
          leechers: Number(row.status?.leechers || 0),
          completed: Number(row.status?.timesCompleted || 0),
          hasHr: false,
          detailUrl: new URL(`/detail/${row.id}`, site.siteUrl || "https://kp.m-team.cc/").toString(),
          downloadUrl: "",
          publishedAt: row.createdDate || row.status?.createdDate || "",
          source: `mteam-api-${area.mode}`
        });
      }
    }
    const torrents = Array.from(deduplicated.values()).map((torrent, rowIndex) => ({ ...torrent, rowIndex }));
    return {
      torrents,
      stats: {
        normalPages: areas.find((area) => area.mode === "normal")?.pagesRead || 0,
        adultPages: areas.find((area) => area.mode === "adult")?.pagesRead || 0,
        total: torrents.length,
        pageSize,
        maxPages
      }
    };
  };

  const resolveDownloadUrl = async (torrent) => {
    if (torrent.downloadUrl) return torrent.downloadUrl;
    if (!torrent.torrentId) throw new Error("无法识别 M-Team 种子 ID");
    const form = new FormData();
    form.set("id", String(torrent.torrentId));
    const downloadUrl = await request("/api/torrent/genDlToken", { form });
    log("mteam:gen-dl-token", { torrentId: torrent.torrentId, generated: Boolean(downloadUrl) });
    if (!downloadUrl) throw new Error("未能生成 M-Team 种子下载地址");
    return downloadUrl;
  };

  // 取回 .torrent 字节。拿到就直接上传给下载器，比让下载器自己去抓可靠得多
  // （下载器的出口 IP 未必被站点认可，抓失败还常常是静默的）。
  const fetchTorrentFile = async (downloadUrl) => {
    try {
      const response = await fetch(downloadUrl, {
        redirect: "follow",
        signal: AbortSignal.timeout(timeoutMs)
      });
      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      let finalHost = "";
      try { finalHost = new URL(response.url || downloadUrl).hostname; } catch (_) {}
      if (!response.ok) {
        log("site:torrent-fetch-failed", { status: response.status, finalHost }, "warn");
        return null;
      }
      const buffer = Buffer.from(await response.arrayBuffer());
      // 排除 HTML 错误页和明显过小的响应，避免把一个错误页当种子传给下载器。
      if (contentType.includes("html") || buffer.length < 40) {
        log("site:torrent-fetch-suspect", { size: buffer.length, contentType, finalHost }, "warn");
        return null;
      }
      log("site:torrent-fetch", { size: buffer.length, contentType, finalHost });
      return new Blob([buffer], { type: "application/x-bittorrent" });
    } catch (error) {
      log("site:torrent-fetch-error", { error: String(error?.message || error) }, "warn");
      return null;
    }
  };

  // 给下载器里缺 Free 截止标签的任务回查截止时间：只有名称和体积都精确对上才写标签。
  const findFreeDeadlines = async (tasks, { concurrency = 3 } = {}) => {
    const core = load().backfill;
    const search = async (keyword, mode) => {
      const data = await request("/api/torrent/search", {
        json: { mode, pageNumber: 1, pageSize: 100, keyword }
      });
      return data?.data || [];
    };
    const updates = [];
    let nextIndex = 0;
    const worker = async () => {
      while (nextIndex < tasks.length) {
        const task = tasks[nextIndex++];
        let matched = null;
        for (const mode of core.searchModes(task.name)) {
          for (const keyword of core.keywordCandidates(task.name)) {
            matched = core.findExactMatch(task, await search(keyword, mode));
            if (matched) break;
          }
          if (matched) break;
        }
        const deadline = core.freeDeadline(matched);
        if (matched && deadline) {
          updates.push({ hash: task.hash, name: task.name, torrentId: matched.id, deadline });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return updates;
  };

  return {
    request,
    fetchAccount,
    fetchFreeCatalog,
    resolveDownloadUrl,
    fetchTorrentFile,
    findFreeDeadlines,
    site
  };
};

module.exports = { createSiteClient, DEFAULT_TIMEOUT_MS };
