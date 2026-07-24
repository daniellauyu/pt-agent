globalThis.PT_AGENT_QB = (() => {
  const normalizeAddress = (value) => `${String(value || "").trim().replace(/\/+$/, "")}/`;

  const endpoint = (settings, path) => {
    return new URL(`api/v2/${String(path).replace(/^\/+/, "")}`, normalizeAddress(settings.address)).toString();
  };

  const responseError = async (response, action) => {
    const detail = (await response.text()).trim();
    throw new Error(`${action}失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
  };

  const createClient = (settings, fetchImpl = globalThis.fetch.bind(globalThis)) => {
    const request = async (path, options = {}) => {
      const response = await fetchImpl(endpoint(settings, path), {
        credentials: "include",
        ...options
      });
      if (!response.ok) await responseError(response, "qBittorrent 请求");
      return response;
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

    const addTorrent = async ({ url, tag, savePath = "", category = "PT_AGENT" }) => {
      const body = new FormData();
      body.set("urls", url);
      if (tag) body.set("tags", tag);
      if (savePath) body.set("savepath", savePath);
      if (category) body.set("category", category);
      const response = await request("torrents/add", { method: "POST", body });
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const result = await response.json();
        const success = (result.success_count ?? 0) > 0 && (result.failure_count ?? 0) === 0;
        if (!success) throw new Error(`qBittorrent 添加失败：${JSON.stringify(result)}`);
        return result;
      }
      const result = (await response.text()).trim();
      if (result !== "Ok.") throw new Error(`qBittorrent 添加失败：${result || "未知错误"}`);
      return { success_count: 1 };
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

    return {
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
    const match = String(tags || "").match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/);
    return match ? match[0] : "";
  };

  const torrentTags = (deadline) => {
    return ["ptagent", deadline].filter(Boolean).join(", ");
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
    normalizeAddress,
    normalizeTorrentName,
    summarizeMteamSeeding,
    torrentTags
  };
})();
