// 站点资源名和下载器任务名是两套命名：qB 的任务名取自种子文件内的 name 字段，
// 站点标题则常带中文副标题、分辨率写法也不同，靠名称模糊匹配必然对不上。
//
// 这里持久化「站点资源 ↔ 下载器任务」的对应关系：
//   入队后验证成功时写入一条，之后所有状态判断都按 infoHash 精确命中，不再猜名字。
// 已有任务可以从 ptagent-source 标签反向补齐，所以旧任务也能自动建立关联。
globalThis.PT_AGENT_TORRENT_LINKS = (() => {
  "use strict";

  const STORAGE_KEY = "ptAgentTorrentLinks";
  const MAX_LINKS = 2000;

  const resourceKey = (site, torrentId) => {
    const normalizedSite = String(site || "").trim().toLowerCase();
    const normalizedId = String(torrentId || "").trim();
    return normalizedSite && normalizedId ? `${normalizedSite}:${normalizedId}` : "";
  };

  const normalize = (value = {}) => ({
    key: resourceKey(value.site, value.torrentId),
    site: String(value.site || "").trim().toLowerCase(),
    torrentId: String(value.torrentId || "").trim(),
    hash: String(value.hash || value.infoHash || "").trim().toLowerCase(),
    siteTitle: String(value.siteTitle || value.title || ""),
    qbName: String(value.qbName || value.name || ""),
    linkedAt: value.linkedAt || new Date().toISOString()
  });

  const isUsable = (link) => Boolean(link.key && link.hash);

  const createStore = (storageArea = globalThis.chrome?.storage?.local) => {
    if (!storageArea) throw new Error("浏览器本地存储不可用");

    const list = async () => {
      const data = await storageArea.get(STORAGE_KEY);
      return Array.isArray(data?.[STORAGE_KEY])
        ? data[STORAGE_KEY].map(normalize).filter(isUsable)
        : [];
    };

    const save = async (links) => {
      const next = links.filter(isUsable).slice(0, MAX_LINKS);
      await storageArea.set({ [STORAGE_KEY]: next });
      return next;
    };

    const link = async (value) => {
      const record = normalize(value);
      if (!isUsable(record)) return null;
      const links = await list();
      const index = links.findIndex((item) => item.key === record.key || item.hash === record.hash);
      if (index >= 0) {
        // 保留最初建立关联的时间，其余字段用最新的覆盖。
        links[index] = { ...links[index], ...record, linkedAt: links[index].linkedAt };
      } else {
        links.unshift(record);
      }
      await save(links);
      return record;
    };

    // 从下载器任务的 ptagent-source 标签批量补齐关联，让本功能之前添加的任务也能对上号。
    const backfillFromTasks = async (tasks, readSource) => {
      const links = await list();
      const byKey = new Map(links.map((item) => [item.key, item]));
      let added = 0;
      for (const task of tasks || []) {
        const source = readSource(task?.tags);
        if (!source) continue;
        const key = resourceKey(source.site, source.torrentId);
        if (!key || byKey.get(key)?.hash === String(task.hash || "").toLowerCase()) continue;
        const record = normalize({
          site: source.site,
          torrentId: source.torrentId,
          hash: task.hash,
          qbName: task.name,
          siteTitle: byKey.get(key)?.siteTitle || ""
        });
        if (!isUsable(record)) continue;
        byKey.set(key, record);
        added += 1;
      }
      if (!added) return links;
      return save(Array.from(byKey.values()));
    };

    const prune = async (validHashes) => {
      const alive = new Set((validHashes || []).map((hash) => String(hash || "").toLowerCase()));
      const links = await list();
      const next = links.filter((item) => alive.has(item.hash));
      if (next.length === links.length) return links;
      return save(next);
    };

    return { list, link, backfillFromTasks, prune, save };
  };

  const createIndex = (links) => {
    const byKey = new Map();
    const byHash = new Map();
    for (const raw of links || []) {
      const item = normalize(raw);
      if (!isUsable(item)) continue;
      byKey.set(item.key, item);
      byHash.set(item.hash, item);
    }
    return {
      forResource: (site, torrentId) => byKey.get(resourceKey(site, torrentId)) || null,
      forHash: (hash) => byHash.get(String(hash || "").toLowerCase()) || null,
      size: byKey.size
    };
  };

  return { STORAGE_KEY, MAX_LINKS, createIndex, createStore, normalize, resourceKey };
})();
