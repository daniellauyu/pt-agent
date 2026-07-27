globalThis.PT_AGENT_EXCLUSIONS = (() => {
  const STORAGE_KEY = "ptAgentExcludedTorrents";

  const normalizeTitle = (value) => {
    return String(value || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  };

  const normalizeRecord = (value = {}) => {
    const title = String(value.title || value.name || "").trim();
    return {
      id: String(value.id || ""),
      site: String(value.site || "").trim().toLowerCase(),
      torrentId: String(value.torrentId || "").trim(),
      infoHash: String(value.infoHash || value.hash || "").trim().toLowerCase(),
      title,
      normalizedTitle: String(value.normalizedTitle || normalizeTitle(title)),
      sizeBytes: Math.max(0, Number(value.sizeBytes || value.total_size || value.size || 0)),
      excludedAt: value.excludedAt || new Date().toISOString(),
      reason: value.reason || "user_manual",
      deleteFiles: value.deleteFiles !== false
    };
  };

  const recordId = (record) => {
    if (record.site && record.torrentId) return `source:${record.site}:${record.torrentId}`;
    if (record.infoHash) return `hash:${record.infoHash}`;
    return `legacy:${record.normalizedTitle}:${record.sizeBytes}`;
  };

  const matches = (candidateValue, excludedValue) => {
    const candidate = normalizeRecord(candidateValue);
    const excluded = normalizeRecord(excludedValue);
    if (candidate.site && candidate.torrentId && excluded.site && excluded.torrentId) {
      if (candidate.site === excluded.site && candidate.torrentId === excluded.torrentId) return true;
    }
    if (candidate.infoHash && excluded.infoHash && candidate.infoHash === excluded.infoHash) return true;
    return Boolean(
      candidate.normalizedTitle &&
      excluded.normalizedTitle &&
      candidate.normalizedTitle === excluded.normalizedTitle &&
      candidate.sizeBytes > 0 &&
      candidate.sizeBytes === excluded.sizeBytes
    );
  };

  const createStore = (storageArea = globalThis.chrome?.storage?.local) => {
    if (!storageArea) throw new Error("浏览器本地存储不可用");

    const list = async () => {
      const data = await storageArea.get(STORAGE_KEY);
      return Array.isArray(data?.[STORAGE_KEY])
        ? data[STORAGE_KEY].map(normalizeRecord)
        : [];
    };

    const save = async (records) => {
      await storageArea.set({ [STORAGE_KEY]: records });
      return records;
    };

    const exclude = async (value) => {
      const record = normalizeRecord(value);
      record.id = recordId(record);
      const records = await list();
      const existingIndex = records.findIndex((item) => item.id === record.id || matches(record, item));
      if (existingIndex >= 0) {
        records[existingIndex] = {
          ...records[existingIndex],
          ...record,
          id: records[existingIndex].id || record.id,
          excludedAt: records[existingIndex].excludedAt || record.excludedAt
        };
      } else {
        records.unshift(record);
      }
      await save(records);
      return record;
    };

    const restore = async (id) => {
      const records = await list();
      const next = records.filter((record) => record.id !== id);
      await save(next);
      return next;
    };

    return {
      list,
      exclude,
      restore,
      isExcluded: (candidate, records) => (records || []).some((record) => matches(candidate, record))
    };
  };

  return { STORAGE_KEY, createStore, matches, normalizeTitle };
})();
