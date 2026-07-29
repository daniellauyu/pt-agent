"use strict";

/**
 * 下载器选路与客户端创建。
 *
 * 沿用插件的可达性探测方案：不去猜"现在连的是内网还是外网"，
 * 而是按配置顺序探一遍谁连得上。内网在家时局域网地址秒通，出门后它超时并落到下一条。
 * 终端版跑在 NAS / 常开机器上时，这条逻辑同样适用（比如主地址挂了自动切备用）。
 */
const ROUTE_CACHE_KEY = "ptAgentDaemonRoute";

const selectDownloader = async (ctx, { operationId = null, force = false } = {}) => {
  const { engines, logger } = ctx;
  const all = await ctx.downloaders.list();
  const usable = all.filter((item) => item.enabled && item.address && item.password);
  if (!usable.length) {
    throw new Error("还没有可用的下载器。执行 ptagent downloader add 或在 WebUI 的「设置 → 下载器」里填写");
  }

  const cached = await ctx.storage.get(ROUTE_CACHE_KEY);
  const selection = await engines.router.selectDownloader(usable, {
    probe: (downloader) => engines.downloaderTypes
      .createAdapter(downloader, { onLog: (event, data) => logger.debug(event, data, { operationId }) })
      .probe({ timeoutMs: engines.router.DEFAULT_TIMEOUT_MS }),
    cache: force ? null : cached?.[ROUTE_CACHE_KEY]
  });
  await ctx.storage.set({ [ROUTE_CACHE_KEY]: selection.cache });
  logger.info("downloader:route", {
    reason: selection.reason,
    active: selection.downloader?.name || null,
    probes: selection.probes
  }, { operationId });

  if (!selection.downloader || selection.reason === "fallback") {
    throw new Error(engines.router.describe(selection));
  }
  return selection;
};

const createClient = (ctx, downloader, { operationId = null } = {}) => {
  return ctx.engines.downloaderTypes.createAdapter(downloader, {
    onLog: (event, data) => ctx.logger.debug(event, data, { operationId })
  });
};

/** 一步到位：选路 + 建客户端。绝大多数调用方只关心这个。 */
const connect = async (ctx, options = {}) => {
  const selection = await selectDownloader(ctx, options);
  return {
    downloader: selection.downloader,
    selection,
    client: createClient(ctx, selection.downloader, options)
  };
};

module.exports = { ROUTE_CACHE_KEY, selectDownloader, createClient, connect };
