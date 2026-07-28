// 内外网自动选路。
//
// Chrome 扩展拿不到 WiFi SSID（chrome.networking.onc 只在 ChromeOS 企业环境可用），
// 所以这里不判断"连的是哪个网"，而是直接探测"哪台下载器现在连得上"——
// 内网时局域网地址通，外网时它超时失败并自动落到下一条。效果等价且不依赖系统权限。
globalThis.PT_AGENT_NETWORK_ROUTER = (() => {
  "use strict";

  const DEFAULT_TTL_MS = 30000;
  const DEFAULT_TIMEOUT_MS = 3000;

  const candidates = (downloaders) => {
    return (Array.isArray(downloaders) ? downloaders : [])
      .filter((item) => item && item.enabled !== false && item.address);
  };

  const cacheIsFresh = (cache, downloaders, nowMs, ttlMs) => {
    if (!cache?.id || !Number.isFinite(Number(cache.at))) return false;
    if (nowMs - Number(cache.at) >= ttlMs) return false;
    return candidates(downloaders).some((item) => item.id === cache.id);
  };

  /**
   * 按配置顺序依次探测，返回第一台连得上的下载器。
   * @param {object[]} downloaders 配置顺序即优先级（内网地址建议放前面）
   * @param {(downloader: object) => Promise<{ok: boolean}>} probe 注入的探测函数
   * @returns {{downloader, reason, cache, probes}} reason: cache | probe | fallback | none
   */
  const selectDownloader = async (downloaders, {
    probe,
    cache = null,
    nowMs = Date.now(),
    ttlMs = DEFAULT_TTL_MS
  } = {}) => {
    const pool = candidates(downloaders);
    if (!pool.length) {
      return { downloader: null, reason: "none", cache: null, probes: [] };
    }

    if (cacheIsFresh(cache, pool, nowMs, ttlMs)) {
      const cached = pool.find((item) => item.id === cache.id);
      return { downloader: cached, reason: "cache", cache, probes: [] };
    }

    const probes = [];
    for (const downloader of pool) {
      let result;
      try {
        result = await probe(downloader);
      } catch (error) {
        result = { ok: false, error: String(error?.message || error) };
      }
      probes.push({
        id: downloader.id,
        name: downloader.name,
        address: downloader.address,
        ok: Boolean(result?.ok),
        latencyMs: Number(result?.latencyMs) || 0,
        error: result?.ok ? undefined : String(result?.error || "无响应")
      });
      if (result?.ok) {
        return {
          downloader,
          reason: "probe",
          cache: { id: downloader.id, at: nowMs },
          probes
        };
      }
    }

    // 全部不通时仍返回第一条，让上层给出明确的连接错误而不是"没有下载器"。
    return { downloader: pool[0], reason: "fallback", cache: null, probes };
  };

  const describe = (selection) => {
    if (!selection?.downloader) return "没有可用的下载器，请先在设置里添加";
    const { downloader, reason, probes } = selection;
    if (reason === "cache") return `沿用最近探测结果：${downloader.name}`;
    if (reason === "probe") {
      const hit = probes.find((item) => item.id === downloader.id);
      const skipped = probes.filter((item) => !item.ok).length;
      return skipped
        ? `已切换到 ${downloader.name}（${hit?.latencyMs || 0}ms），跳过 ${skipped} 台不可达`
        : `已选中 ${downloader.name}（${hit?.latencyMs || 0}ms）`;
    }
    if (reason === "fallback") {
      return `${probes.length} 台下载器均不可达，暂用 ${downloader.name}；请检查网络或访问权限`;
    }
    return downloader.name;
  };

  return {
    DEFAULT_TTL_MS,
    DEFAULT_TIMEOUT_MS,
    candidates,
    cacheIsFresh,
    describe,
    selectDownloader
  };
})();
