globalThis.PT_AGENT_DOWNLOADER_STORE = (() => {
  "use strict";

  const STORAGE_KEY = "ptAgentDownloaders";
  const LEGACY_KEY = "ptAgentQbSettings";

  const newId = () => {
    if (globalThis.crypto?.randomUUID) {
      return `dl_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
    return `dl_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  };

  const normalizeAddress = (value) => {
    const trimmed = String(value || "").trim();
    return trimmed ? `${trimmed.replace(/\/+$/, "")}/` : "";
  };

  // 内网地址优先探测：换到外网时这一条会快速失败并落到下一条，反之亦然。
  const isPrivateAddress = (address) => {
    let hostname = "";
    try {
      hostname = new URL(String(address || "")).hostname;
    } catch (_) {
      return false;
    }
    return /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i.test(hostname) ||
      /\.local$/i.test(hostname);
  };

  const normalize = (value = {}, index = 0) => {
    const types = globalThis.PT_AGENT_DOWNLOADER_TYPES;
    const type = types?.get(value.type) ? String(value.type) : "qbittorrent";
    const address = normalizeAddress(value.address);
    return {
      id: String(value.id || "") || newId(),
      name: String(value.name || "").trim() || `下载器 ${index + 1}`,
      type,
      address,
      username: String(value.username || ""),
      password: String(value.password || ""),
      savePath: String(value.savePath || ""),
      category: String(value.category || "PT_AGENT"),
      enabled: value.enabled !== false,
      note: String(value.note || ""),
      isPrivate: isPrivateAddress(address)
    };
  };

  const normalizeList = (values) => (Array.isArray(values) ? values : []).map(normalize);

  // 传入的记录已经过 normalize（名称为空时会自动补默认名），因此这里不再校验名称。
  const validate = (downloader) => {
    const errors = [];
    if (!/^https?:\/\//i.test(downloader.address)) errors.push("地址必须以 http:// 或 https:// 开头");
    if (!downloader.username) errors.push("请填写账号");
    if (!downloader.password) errors.push("请填写密码");
    const type = globalThis.PT_AGENT_DOWNLOADER_TYPES?.get(downloader.type);
    if (type && !type.implemented) errors.push(`${type.name} 适配器尚未实现`);
    return errors;
  };

  // 旧版本只有一个 ptAgentQbSettings；首次运行时把它转成第一条下载器，不丢用户已填的密码。
  const migrateLegacy = (legacySettings, presets = {}) => {
    const address = normalizeAddress(legacySettings?.address || presets.qbAddress);
    if (!address) return [];
    return [normalize({
      id: "dl_legacy",
      name: isPrivateAddress(address) ? "内网下载器" : "默认下载器",
      type: "qbittorrent",
      address,
      username: legacySettings?.username || presets.qbUsername || "",
      password: legacySettings?.password || presets.qbPassword || "",
      savePath: legacySettings?.savePath || presets.qbSavePath || "",
      category: "PT_AGENT",
      enabled: true,
      note: "由旧版单下载器设置自动迁移"
    })];
  };

  const createStore = (
    storageArea = globalThis.chrome?.storage?.local,
    presets = globalThis.PT_AGENT_PRIVATE_CONFIG || {}
  ) => {
    if (!storageArea) throw new Error("浏览器本地存储不可用");

    const readRaw = async () => {
      const data = await storageArea.get([STORAGE_KEY, LEGACY_KEY]);
      return {
        downloaders: data?.[STORAGE_KEY],
        legacy: data?.[LEGACY_KEY]
      };
    };

    const save = async (downloaders) => {
      const next = normalizeList(downloaders);
      await storageArea.set({ [STORAGE_KEY]: next });
      return next;
    };

    const list = async () => {
      const { downloaders, legacy } = await readRaw();
      if (Array.isArray(downloaders)) return normalizeList(downloaders);
      const migrated = migrateLegacy(legacy, presets);
      if (migrated.length) await save(migrated);
      return migrated;
    };

    const upsert = async (value) => {
      const record = normalize(value);
      const records = await list();
      const index = records.findIndex((item) => item.id === record.id);
      if (index >= 0) records[index] = record;
      else records.push(record);
      await save(records);
      return record;
    };

    const remove = async (id) => {
      const records = (await list()).filter((item) => item.id !== id);
      return save(records);
    };

    const move = async (id, offset) => {
      const records = await list();
      const index = records.findIndex((item) => item.id === id);
      const target = index + offset;
      if (index < 0 || target < 0 || target >= records.length) return records;
      const [record] = records.splice(index, 1);
      records.splice(target, 0, record);
      return save(records);
    };

    return { list, save, upsert, remove, move };
  };

  return {
    STORAGE_KEY,
    LEGACY_KEY,
    createStore,
    isPrivateAddress,
    migrateLegacy,
    newId,
    normalize,
    normalizeAddress,
    normalizeList,
    validate
  };
})();
