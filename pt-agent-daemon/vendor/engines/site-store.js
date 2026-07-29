globalThis.PT_AGENT_SITE_STORE = (() => {
  "use strict";

  const STORAGE_KEY = "ptAgentSites";
  const LEGACY_KEY = "ptAgentQbSettings";

  // 站点适配器：抓取逻辑目前只实现了 M-Team 的 API 模式，generic 走页面 DOM 扫描。
  const SITE_TYPES = {
    mteam: {
      id: "mteam",
      name: "M-Team",
      implemented: true,
      requiresApiKey: true,
      defaultSiteUrl: "https://kp.m-team.cc/",
      defaultApiUrl: "https://api.m-team.cc/"
    },
    generic: {
      id: "generic",
      name: "通用站点（页面扫描）",
      implemented: true,
      requiresApiKey: false,
      defaultSiteUrl: "",
      defaultApiUrl: ""
    }
  };

  const newId = () => {
    if (globalThis.crypto?.randomUUID) {
      return `site_${globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    }
    return `site_${Date.now().toString(36)}${Math.random().toString(16).slice(2, 8)}`;
  };

  const normalizeUrl = (value) => {
    const trimmed = String(value || "").trim();
    return trimmed ? `${trimmed.replace(/\/+$/, "")}/` : "";
  };

  const normalize = (value = {}, index = 0) => {
    const type = SITE_TYPES[String(value.type || "")] ? String(value.type) : "mteam";
    return {
      id: String(value.id || "") || newId(),
      name: String(value.name || "").trim() || SITE_TYPES[type].name || `站点 ${index + 1}`,
      type,
      siteUrl: normalizeUrl(value.siteUrl || SITE_TYPES[type].defaultSiteUrl),
      apiUrl: normalizeUrl(value.apiUrl || SITE_TYPES[type].defaultApiUrl),
      apiKey: String(value.apiKey || ""),
      enabled: value.enabled !== false,
      note: String(value.note || "")
    };
  };

  const normalizeList = (values) => (Array.isArray(values) ? values : []).map(normalize);

  const validate = (site) => {
    const errors = [];
    const type = SITE_TYPES[site.type];
    if (!/^https?:\/\//i.test(site.siteUrl)) errors.push("站点地址必须以 http:// 或 https:// 开头");
    if (type?.requiresApiKey) {
      if (!/^https?:\/\//i.test(site.apiUrl)) errors.push("API 地址必须以 http:// 或 https:// 开头");
      if (!site.apiKey) errors.push("请填写 API Key");
    }
    return errors;
  };

  // 旧版本把 M-Team API Key 混在下载器设置里，站点地址写死在 private-config。
  const migrateLegacy = (legacySettings, presets = {}) => {
    const siteUrl = normalizeUrl(presets.mteamSiteUrl || SITE_TYPES.mteam.defaultSiteUrl);
    const apiUrl = normalizeUrl(presets.mteamApiUrl || SITE_TYPES.mteam.defaultApiUrl);
    return [normalize({
      id: "site_mteam",
      name: "M-Team",
      type: "mteam",
      siteUrl,
      apiUrl,
      apiKey: legacySettings?.mteamApiKey || presets.mteamApiKey || "",
      enabled: true,
      note: "由旧版下载器设置中的 API Key 自动迁移"
    })];
  };

  const createStore = (
    storageArea = globalThis.chrome?.storage?.local,
    presets = globalThis.PT_AGENT_PRIVATE_CONFIG || {}
  ) => {
    if (!storageArea) throw new Error("浏览器本地存储不可用");

    const save = async (sites) => {
      const next = normalizeList(sites);
      await storageArea.set({ [STORAGE_KEY]: next });
      return next;
    };

    const list = async () => {
      const data = await storageArea.get([STORAGE_KEY, LEGACY_KEY]);
      const stored = data?.[STORAGE_KEY];
      if (Array.isArray(stored)) return normalizeList(stored);
      const migrated = migrateLegacy(data?.[LEGACY_KEY], presets);
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

    const remove = async (id) => save((await list()).filter((item) => item.id !== id));

    const active = async () => {
      const records = await list();
      return records.find((item) => item.enabled && item.type === "mteam") ||
        records.find((item) => item.enabled) ||
        null;
    };

    return { list, save, upsert, remove, active };
  };

  return {
    STORAGE_KEY,
    LEGACY_KEY,
    SITE_TYPES,
    createStore,
    migrateLegacy,
    newId,
    normalize,
    normalizeList,
    normalizeUrl,
    validate
  };
})();
