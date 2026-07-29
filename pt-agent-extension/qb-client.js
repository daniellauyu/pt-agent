globalThis.PT_AGENT_QB = (() => {
  const normalizeAddress = (value) => `${String(value || "").trim().replace(/\/+$/, "")}/`;

  const endpoint = (settings, path) => {
    return new URL(`api/v2/${String(path).replace(/^\/+/, "")}`, normalizeAddress(settings.address)).toString();
  };

  // qB 在连续认证失败后会封禁 IP（默认 5 次 / 封 1 小时）。这类 403 绝不能重试登录，
  // 否则每次操作都再撞一次，封禁永远不会自然恢复。
  const isBanMessage = (text) => {
    return /banned|封禁|封禁|too many failed|失败次数过多/i.test(String(text || ""));
  };

  const createClient = (settings, fetchImpl = globalThis.fetch.bind(globalThis), onLog = () => {}) => {
    // qB 登录后会下发 SID Cookie，后续请求靠它维持会话。
    // 以前每个操作都先 login() 一次，等于自制登录风暴，密码一旦不对立刻触发封禁。
    // 现在改成：直接发请求，只有真的因为没有会话被拒时才登录一次并重试。
    let sessionReady = false;

    const request = async (path, options = {}, { allowAuthRetry = true } = {}) => {
      const method = options.method || "GET";
      const url = endpoint(settings, path);
      onLog("qb:req", { method, path, url });
      let response;
      try {
        response = await fetchImpl(url, { credentials: "include", ...options });
      } catch (error) {
        onLog("qb:req-error", { path, error: String(error?.message || error) });
        throw new Error(`qBittorrent 无法连接（${String(error?.message || error)}）`);
      }
      onLog("qb:res", { path, status: response.status, ok: response.ok });
      if (response.ok) {
        if (path === "auth/login") sessionReady = true;
        return response;
      }

      // 响应体只能读一次，这里统一读出来供后续所有判断复用。
      const detail = (await response.text()).trim();
      const isLoginCall = path === "auth/login";

      if (response.status === 403 && isBanMessage(detail)) {
        sessionReady = false;
        const banError = new Error(`qBittorrent 已封禁当前 IP：${detail}`);
        banError.code = "QB_IP_BANNED";
        onLog("qb:banned", { path, detail: detail.slice(0, 300) });
        throw banError;
      }

      if (response.status === 403 && !isLoginCall && allowAuthRetry) {
        // 会话缺失或过期：登录一次再重试，且只重试一次，避免和封禁互相放大。
        onLog("qb:session-expired", { path });
        sessionReady = false;
        await login();
        return request(path, options, { allowAuthRetry: false });
      }

      // 4xx/5xx 的响应体决定了是谁拒绝的：qB 自身返回 "Unauthorized"，
      // 反向代理返回 HTML 错误页，Cloudflare 会带 Ray ID。不记下来就没法定位。
      onLog("qb:res-error", {
        path,
        status: response.status,
        server: response.headers.get("server") || undefined,
        contentType: response.headers.get("content-type") || undefined,
        detailLength: detail.length,
        detail: detail.slice(0, 300)
      });
      const hint = detail ? `：${detail.replace(/\s+/g, " ").slice(0, 120)}` : "";
      const error = new Error(`qBittorrent 请求失败（HTTP ${response.status}）${hint}`);
      if (isLoginCall) error.code = "QB_LOGIN_FAILED";
      throw error;
    };

    const login = async () => {
      const body = new URLSearchParams();
      body.set("username", settings.username || "");
      body.set("password", settings.password || "");
      const response = await request("auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      const result = (await response.text()).trim();
      if (response.status !== 204 && result !== "Ok.") {
        throw new Error(result === "Fails." ? "qBittorrent 账号或密码错误" : `qBittorrent 登录失败：${result || "未知错误"}`);
      }
      return true;
    };

    const getVersion = async () => {
      const response = await request("app/version");
      return (await response.text()).trim();
    };

    const addTorrent = async ({ url, file, filename = "download.torrent", tag, savePath = "", category = "PT_AGENT" }) => {
      const body = new FormData();
      // 优先上传 .torrent 文件字节（插件在浏览器侧已鉴权取到），避免 qB 服务器端去抓 M-Team 链接失败而静默丢弃。
      if (file) {
        body.append("torrents", file, filename);
      } else {
        body.set("urls", url);
      }
      if (tag) body.set("tags", tag);
      if (savePath) body.set("savepath", savePath);
      if (category) body.set("category", category);
      onLog("qb:add-request", { route: file ? "file" : "url", filename: file ? filename : undefined, fileSize: file?.size, tag, savePath, category });
      const response = await request("torrents/add", { method: "POST", body });
      const contentType = response.headers.get("content-type") || "";
      // 判定原则：HTTP 2xx 已经说明 qB 收下了请求，只有「明确的失败标志」才算失败。
      // 之前要求响应体严格等于 "Ok."，任何空响应体、大小写差异或被反向代理改写过的响应
      // 都会把实际添加成功的种子误报成失败。
      if (contentType.includes("application/json")) {
        const result = await response.json().catch(() => null);
        const successCount = Number(result?.success_count);
        const failureCount = Number(result?.failure_count);
        onLog("qb:add-response", { contentType, successCount, failureCount });
        // 只有 qB 明确说「失败了 N 个且成功 0 个」才判失败；字段缺失一律按成功处理。
        if (Number.isFinite(failureCount) && failureCount > 0 && !(successCount > 0)) {
          throw new Error(`qBittorrent 添加失败（成功 ${successCount || 0}，失败 ${failureCount}）`);
        }
        return result || { success_count: 1 };
      }
      const result = (await response.text()).trim();
      const explicitFailure = /^fails?\.?$/i.test(result);
      onLog("qb:add-response", {
        contentType,
        status: response.status,
        accepted: !explicitFailure,
        body: result.slice(0, 120),
        responseLength: result.length
      });
      if (explicitFailure) {
        throw new Error(`qBittorrent 拒绝了这个种子（响应：${result}）`);
      }
      return { success_count: 1, response: result };
    };

    const listTorrents = async (filter = "all") => {
      const params = new URLSearchParams({
        filter,
        sort: "added_on",
        reverse: "true"
      });
      const response = await request(`torrents/info?${params.toString()}`);
      return response.json();
    };

    const listCategories = async () => {
      const response = await request("torrents/categories");
      return response.json();
    };

    const ensureCategory = async (category, savePath = "") => {
      if (!category) return false;
      const categories = await listCategories();
      if (categories?.[category]) return true;
      const body = new URLSearchParams();
      body.set("category", category);
      if (savePath) body.set("savePath", savePath);
      await request("torrents/createCategory", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      return true;
    };

    const addTags = async (hashes, tags) => {
      const body = new URLSearchParams();
      body.set("hashes", Array.isArray(hashes) ? hashes.join("|") : String(hashes || ""));
      body.set("tags", tags);
      await request("torrents/addTags", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      return true;
    };

    const deleteTorrents = async (hashes, deleteFiles = true) => {
      const body = new URLSearchParams();
      body.set("hashes", Array.isArray(hashes) ? hashes.join("|") : String(hashes || ""));
      body.set("deleteFiles", deleteFiles ? "true" : "false");
      await request("torrents/delete", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body
      });
      return true;
    };

    // 轻量可达性探测：只看能不能拿到 HTTP 响应，不登录，带超时。用于内外网自动选路。
    const probe = async ({ timeoutMs = 3000 } = {}) => {
      const startedAt = Date.now();
      try {
        const response = await fetchImpl(endpoint(settings, "app/version"), {
          credentials: "include",
          cache: "no-store",
          signal: AbortSignal.timeout(timeoutMs)
        });
        return { ok: true, status: response.status, latencyMs: Date.now() - startedAt };
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error),
          latencyMs: Date.now() - startedAt
        };
      }
    };

    const diagnose = async () => {
      const stages = [];
      const fail = (failedStage, label, error) => {
        stages.push({
          key: failedStage,
          label,
          status: "error",
          detail: String(error?.message || error || "未知错误")
        });
        return { ok: false, failedStage, stages };
      };

      const probeStartedAt = Date.now();
      try {
        const response = await fetchImpl(endpoint(settings, "app/version"), {
          credentials: "include",
          cache: "no-store"
        });
        stages.push({
          key: "reachability",
          label: "网络可达性",
          status: "ok",
          detail: `收到 HTTP ${response.status} · ${Date.now() - probeStartedAt} ms`
        });
      } catch (error) {
        return fail("reachability", "网络可达性", error);
      }

      try {
        await login();
        stages.push({
          key: "login",
          label: "登录鉴权",
          status: "ok",
          detail: "账号密码验证通过"
        });
      } catch (error) {
        return fail("login", "登录鉴权", error);
      }

      try {
        const version = await getVersion();
        if (!version) throw new Error("版本接口返回空响应");
        stages.push({
          key: "api",
          label: "Web API",
          status: "ok",
          detail: `qBittorrent ${version}`
        });
        return { ok: true, version, stages };
      } catch (error) {
        return fail("api", "Web API", error);
      }
    };

    return {
      diagnose,
      probe,
      login,
      getVersion,
      addTorrent,
      addTags,
      deleteTorrents,
      ensureCategory,
      listCategories,
      listTorrents
    };
  };

  const deadlineTag = (value, formatter = String) => {
    return value ? formatter(value) : "";
  };

  const deadlineFromTags = (tags) => {
    const value = String(tags || "");
    const isoMatch = value.match(/ptagent-free-end=([^,]+)/i);
    if (isoMatch) return isoMatch[1].trim();
    const legacyMatch = value.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    return legacyMatch ? legacyMatch[0] : "";
  };

  const torrentTags = (deadline) => {
    return ["ptagent", deadline ? `ptagent-free-end=${deadline}` : ""]
      .filter(Boolean)
      .join(", ");
  };

  const sourceTag = (site, torrentId) => {
    const normalizedSite = String(site || "").trim().toLowerCase();
    const normalizedId = String(torrentId || "").trim();
    return normalizedSite && normalizedId ? `ptagent-source=${normalizedSite}:${normalizedId}` : "";
  };

  const sourceFromTags = (tags) => {
    const match = String(tags || "").match(/(?:^|,\s*)ptagent-source=([^,:\s]+):([^,\s]+)/i);
    return match ? { site: match[1].toLowerCase(), torrentId: match[2] } : null;
  };

  const normalizeTorrentName = (value) => {
    return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  };

  const findMatchingTorrent = (title, torrents) => {
    const target = normalizeTorrentName(title);
    if (!target) return null;
    return (torrents || []).find((torrent) => {
      const candidate = normalizeTorrentName(torrent.name);
      return candidate === target || candidate.startsWith(target) || target.startsWith(candidate);
    }) || null;
  };

  // 站点标题和 qB 任务名（取自种子文件内的 name 字段）经常不一致，只靠名称匹配会误判成"没添加成功"。
  // 入队时写入的 ptagent-source=<站点>:<种子ID> 是精确标识，优先用它。
  const findTorrentBySource = (site, torrentId, torrents) => {
    const normalizedSite = String(site || "").trim().toLowerCase();
    const normalizedId = String(torrentId || "").trim();
    if (!normalizedSite || !normalizedId) return null;
    return (torrents || []).find((torrent) => {
      const source = sourceFromTags(torrent.tags);
      return source && source.site === normalizedSite && source.torrentId === normalizedId;
    }) || null;
  };

  // 先按来源标签精确匹配，找不到再退回名称模糊匹配（兼容本版本之前添加的旧任务）。
  const matchTorrent = (resource, torrents) => {
    const bySource = findTorrentBySource(resource?.site, resource?.torrentId, torrents);
    if (bySource) return { torrent: bySource, matchedBy: "source-tag" };
    const byName = findMatchingTorrent(resource?.title, torrents);
    return { torrent: byName, matchedBy: byName ? "name" : "none" };
  };

  const summarizeMteamSeeding = (torrents) => {
    const completed = (torrents || []).filter((torrent) => {
      let trackerHost = "";
      try {
        trackerHost = new URL(torrent.tracker || "").hostname;
      } catch (_) {}
      return trackerHost.endsWith("m-team.cc") && Number(torrent.progress || 0) >= 1;
    });
    const stateCounts = {};
    completed.forEach((torrent) => {
      const state = String(torrent.state || "unknown");
      stateCounts[state] = (stateCounts[state] || 0) + 1;
    });
    const activeCount = completed.filter((torrent) => {
      return /uploading|stalledUP|forcedUP/i.test(String(torrent.state || ""));
    }).length;
    return {
      count: completed.length,
      sizeBytes: completed.reduce((total, torrent) => total + Number(torrent.size || 0), 0),
      activeCount,
      queuedCount: Number(stateCounts.queuedUP || 0),
      stateCounts
    };
  };

  return {
    createClient,
    deadlineFromTags,
    deadlineTag,
    findMatchingTorrent,
    findTorrentBySource,
    matchTorrent,
    normalizeAddress,
    normalizeTorrentName,
    sourceFromTags,
    sourceTag,
    summarizeMteamSeeding,
    torrentTags
  };
})();
