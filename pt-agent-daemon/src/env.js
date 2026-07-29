"use strict";

const fs = require("node:fs");
const path = require("node:path");

/**
 * .env 支持。
 *
 * 目的很具体：把一台机器上调好的全部配置装进一个文件，拷到另一台机器直接跑。
 *
 * 语义是「**写在 .env 里的以 .env 为准**」——每次启动都会覆盖 config.json 里对应的字段。
 * 没写进 .env 的字段不受影响，照常可以在 WebUI 里改。这条规则必须说清楚，否则
 * 在 WebUI 改了一个由 .env 托管的值、重启后被改回去，会变成一个查不出原因的怪事；
 * 所以 doctor 和启动日志都会列出当前由 .env 托管的键。
 */

// 查找顺序：显式指定 > 数据目录 > 当前工作目录 > 项目根目录。
const candidatePaths = (homeDir) => [
  process.env.PTAGENT_ENV_FILE,
  homeDir && path.join(homeDir, ".env"),
  path.join(process.cwd(), ".env"),
  path.resolve(__dirname, "..", ".env")
].filter(Boolean);

const findEnvFile = (homeDir) => candidatePaths(homeDir).find((file) => {
  try {
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}) || null;

/**
 * 解析 .env 文本。
 * 支持 `export KEY=value`、`#` 注释、单双引号包裹（引号内的 # 不算注释）。
 */
const parseEnvFile = (text) => {
  const result = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.replace(/^export\s+/, "").match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    const [, key] = match;
    const rest = match[2].trim();
    // 引号包裹的值原样取用，允许里面有空格和 #（密码里这两样都很常见），
    // 收尾引号之后可以再跟注释。未加引号时才把行尾的 # 当注释。
    const quoted = rest.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$|^'([^']*)'\s*(?:#.*)?$/);
    if (!quoted) {
      result[key] = rest.split(/\s+#/)[0].trim();
    } else if (quoted[1] !== undefined) {
      // 双引号里支持 \" 和 \\ 转义，和导出端的写法对应。单引号内一切都是字面量。
      result[key] = quoted[1].replace(/\\(["\\])/g, "$1");
    } else {
      result[key] = quoted[2];
    }
  }
  return result;
};

const truthy = (value) => /^(1|true|on|yes|开|启用)$/i.test(String(value).trim());
const asNumber = (value) => {
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : undefined;
};

// 环境变量名 → 配置字段。第三项是转换函数。
const DAEMON_KEYS = [
  ["PTAGENT_SCAN_MIN_MINUTES", "scanIntervalMinMinutes", asNumber],
  ["PTAGENT_SCAN_MAX_MINUTES", "scanIntervalMaxMinutes", asNumber],
  ["PTAGENT_MAX_PUSH_PER_SCAN", "maxPushPerScan", asNumber],
  ["PTAGENT_AUTO_DOWNLOAD", "autoDownload", truthy],
  ["PTAGENT_SCAN_ON_START", "scanOnStart", truthy],
  ["PTAGENT_GUARD_INTERVAL_SECONDS", "guardIntervalSeconds", asNumber],
  ["PTAGENT_VERIFY_ATTEMPTS", "verifyAttempts", asNumber],
  ["PTAGENT_VERIFY_DELAY_MS", "verifyDelayMs", asNumber],
  ["PTAGENT_WEB_ENABLED", "webEnabled", truthy],
  ["PTAGENT_WEB_HOST", "webHost", String],
  ["PTAGENT_WEB_PORT", "webPort", asNumber],
  ["PTAGENT_WEB_TOKEN", "webToken", String]
];

const POLICY_KEYS = [
  ["PTAGENT_MIN_SCORE", "minimumScore", asNumber],
  ["PTAGENT_MAX_SIZE_GB", "maxTorrentSizeGB", asNumber],
  ["PTAGENT_MIN_FREE_HOURS", "minFreeHoursForAutoDownload", asNumber],
  ["PTAGENT_MIN_RATIO", "minimumRatio", asNumber],
  ["PTAGENT_MAX_ACTIVE_DOWNLOADS", "maxActiveDownloads", asNumber],
  ["PTAGENT_REJECT_HR", "rejectHr", truthy],
  ["PTAGENT_REJECT_MISSING_FREE_END", "rejectMissingFreeEnd", truthy],
  ["PTAGENT_GUARD_MINUTES", "guardMinutes", asNumber],
  ["PTAGENT_GUARD_MONITOR", "guardMonitorEnabled", truthy],
  ["PTAGENT_AUTO_DELETE_EXPIRED", "autoDeleteExpired", truthy],
  ["PTAGENT_SCARCE_MIN_FREE_HOURS", "scarceOpportunityMinFreeHours", asNumber],
  ["PTAGENT_SCARCE_MIN_LEECHERS", "scarceOpportunityMinLeechers", asNumber],
  ["PTAGENT_SCARCE_MIN_DEMAND_RATIO", "scarceOpportunityMinDemandRatio", asNumber],
  ["PTAGENT_SCARCE_MAX_REQUIRED_SPEED_BPS", "scarceOpportunityMaxRequiredSpeedBps", asNumber]
];

const SITE_KEYS = [
  ["PTAGENT_SITE_NAME", "name", String],
  ["PTAGENT_SITE_TYPE", "type", String],
  ["PTAGENT_SITE_URL", "siteUrl", String],
  ["PTAGENT_SITE_API_URL", "apiUrl", String],
  ["PTAGENT_SITE_API_KEY", "apiKey", String]
];

const DOWNLOADER_KEYS = [
  ["NAME", "name", String],
  ["TYPE", "type", String],
  ["ADDRESS", "address", String],
  ["USERNAME", "username", String],
  ["PASSWORD", "password", String],
  ["SAVE_PATH", "savePath", String],
  ["CATEGORY", "category", String],
  ["ENABLED", "enabled", truthy],
  ["NOTE", "note", String]
];

const collect = (env, keys) => {
  const values = {};
  const managed = [];
  for (const [envKey, field, cast] of keys) {
    if (env[envKey] === undefined || env[envKey] === "") continue;
    const value = cast(env[envKey]);
    if (value === undefined) continue;
    values[field] = value;
    managed.push(envKey);
  }
  return { values, managed };
};

/** 下载器按 PTAGENT_DOWNLOADER_<N>_* 分组，序号从 1 开始，中断即停。 */
const collectDownloaders = (env) => {
  const downloaders = [];
  const managed = [];
  for (let index = 1; index <= 20; index += 1) {
    const prefix = `PTAGENT_DOWNLOADER_${index}_`;
    const address = env[`${prefix}ADDRESS`];
    if (!address) {
      if (index === 1) continue;
      break;
    }
    const record = { id: `dl_env_${index}`, type: "qbittorrent", enabled: true };
    for (const [suffix, field, cast] of DOWNLOADER_KEYS) {
      const envKey = `${prefix}${suffix}`;
      if (env[envKey] === undefined || env[envKey] === "") continue;
      record[field] = cast(env[envKey]);
      managed.push(envKey);
    }
    record.name = record.name || `下载器 ${index}`;
    downloaders.push(record);
  }
  return { downloaders, managed };
};

/** 把 .env 解析成一份可以直接写进 config.json 的补丁。 */
const mapEnv = (env = {}) => {
  const daemon = collect(env, DAEMON_KEYS);
  const policy = collect(env, POLICY_KEYS);
  const site = collect(env, SITE_KEYS);
  const { downloaders, managed: downloaderManaged } = collectDownloaders(env);
  return {
    daemon: daemon.values,
    policy: policy.values,
    site: site.values,
    downloaders,
    managed: [...daemon.managed, ...policy.managed, ...site.managed, ...downloaderManaged].sort()
  };
};

// 真正的进程环境变量也算数，而且优先级高于 .env 文件。
// Docker 的 -e、systemd 的 Environment= 都是这么传配置的；只认文件的话，
// 镜像里设的 PTAGENT_WEB_HOST=0.0.0.0 会被无声忽略，端口映射了却连不上。
const processOverrides = (env = process.env) => Object.fromEntries(
  Object.entries(env).filter(([key, value]) => (
    key.startsWith("PTAGENT_") &&
    // 这两个决定「去哪里找配置」，不是配置本身，另有处理。
    key !== "PTAGENT_HOME" && key !== "PTAGENT_ENV_FILE" &&
    value !== undefined && value !== ""
  ))
);

/**
 * 把 .env 文件和进程环境变量合并后写进配置。
 * 优先级：进程环境变量 > .env 文件 > config.json。
 * 两者都没有 PTAGENT_* 时什么都不做。返回这次托管了哪些键，调用方负责告知用户。
 */
const applyEnv = async (ctx, { file = null, env = process.env } = {}) => {
  const envFile = file || findEnvFile(ctx.paths.root);
  const fromFile = envFile && fs.existsSync(envFile)
    ? parseEnvFile(fs.readFileSync(envFile, "utf8"))
    : {};
  const patch = mapEnv({ ...fromFile, ...processOverrides(env) });
  if (!patch.managed.length) return { applied: false, file: envFile, managed: [] };

  if (Object.keys(patch.daemon).length) await ctx.config.saveDaemon(patch.daemon);
  if (Object.keys(patch.policy).length) await ctx.config.savePolicy(patch.policy);

  // 站点同样整份接管。留着 config.json 里的旧站点会让「选哪个站点」变成看谁排在前面，
  // 而 .env 里写的 Key 可能永远轮不上——这正是最难查的那种「配置明明改了却没生效」。
  const droppedSites = [];
  if (Object.keys(patch.site).length) {
    const previous = await ctx.sites.list();
    droppedSites.push(...previous.filter((item) => item.id !== "site_env").map((item) => item.name));
    await ctx.sites.save([{
      id: "site_env",
      type: "mteam",
      enabled: true,
      note: "由 .env 托管",
      ...previous.find((item) => item.id === "site_env"),
      ...patch.site
    }]);
  }

  // .env 里只要写了下载器，就整份接管这个列表。
  // 不做合并是有意的：列表顺序就是探测优先级，两个来源混在一起以后，
  // 光看 .env 根本说不清实际会先连哪一台。被顶掉的记录会记进日志，不是静默丢弃。
  const dropped = [];
  if (patch.downloaders.length) {
    const previous = await ctx.downloaders.list();
    dropped.push(...previous.filter((item) => !item.id.startsWith("dl_env_")).map((item) => item.name));
    await ctx.downloaders.save(patch.downloaders);
  }

  return {
    applied: true,
    file: envFile,
    managed: patch.managed,
    downloaderCount: patch.downloaders.length,
    droppedDownloaders: dropped,
    droppedSites
  };
};

/** 反向：把当前配置导出成 .env 文本，用来搬到另一台机器。 */
const toEnvFile = ({ daemon, policy, site, downloaders }, { includeSecrets = true } = {}) => {
  const lines = [
    "# PT Agent 守护进程配置",
    `# 由 ptagent config export-env 生成于 ${new Date().toISOString()}`,
    "#",
    "# 这个文件里有下载器密码和站点 API Key，不要提交到仓库、不要发给别人。",
    "# 放在数据目录（默认 ~/.ptagent/.env）或运行目录下即可自动读取。",
    "# 写在这里的项目每次启动都会覆盖 config.json 中的对应字段。",
    ""
  ];
  const secret = (value) => (includeSecrets ? value : "");
  // 含空格、# 或引号的值必须加引号，否则导出的文件自己再读回来就变样了
  // （密码里带 # 很常见，不加引号会被当成注释截断）。
  const quote = (value) => {
    const text = String(value);
    if (!/[\s#'"]/.test(text)) return text;
    return `"${text.replace(/(["\\])/g, "\\$1")}"`;
  };
  const push = (comment, entries) => {
    lines.push(`# ---- ${comment} ----`);
    entries.forEach(([key, value]) => {
      lines.push(`${key}=${value === undefined || value === null || value === "" ? "" : quote(value)}`);
    });
    lines.push("");
  };

  if (site) {
    push("站点", [
      ["PTAGENT_SITE_NAME", site.name],
      ["PTAGENT_SITE_TYPE", site.type],
      ["PTAGENT_SITE_URL", site.siteUrl],
      ["PTAGENT_SITE_API_URL", site.apiUrl],
      ["PTAGENT_SITE_API_KEY", secret(site.apiKey)]
    ]);
  }

  (downloaders || []).forEach((item, index) => {
    push(`下载器 ${index + 1}（顺序即探测优先级，内网放前面）`, [
      [`PTAGENT_DOWNLOADER_${index + 1}_NAME`, item.name],
      [`PTAGENT_DOWNLOADER_${index + 1}_TYPE`, item.type],
      [`PTAGENT_DOWNLOADER_${index + 1}_ADDRESS`, item.address],
      [`PTAGENT_DOWNLOADER_${index + 1}_USERNAME`, item.username],
      [`PTAGENT_DOWNLOADER_${index + 1}_PASSWORD`, secret(item.password)],
      [`PTAGENT_DOWNLOADER_${index + 1}_SAVE_PATH`, item.savePath],
      [`PTAGENT_DOWNLOADER_${index + 1}_CATEGORY`, item.category],
      [`PTAGENT_DOWNLOADER_${index + 1}_ENABLED`, item.enabled ? "true" : "false"]
    ]);
  });

  push("定时扫描", [
    ["PTAGENT_SCAN_MIN_MINUTES", daemon.scanIntervalMinMinutes],
    ["PTAGENT_SCAN_MAX_MINUTES", daemon.scanIntervalMaxMinutes],
    ["PTAGENT_MAX_PUSH_PER_SCAN", daemon.maxPushPerScan],
    ["PTAGENT_AUTO_DOWNLOAD", daemon.autoDownload ? "true" : "false"],
    ["PTAGENT_SCAN_ON_START", daemon.scanOnStart ? "true" : "false"]
  ]);

  push("下载策略", [
    ["PTAGENT_MIN_SCORE", policy.minimumScore],
    ["PTAGENT_MAX_SIZE_GB", policy.maxTorrentSizeGB],
    ["PTAGENT_MIN_FREE_HOURS", policy.minFreeHoursForAutoDownload],
    ["PTAGENT_MIN_RATIO", policy.minimumRatio],
    ["PTAGENT_MAX_ACTIVE_DOWNLOADS", policy.maxActiveDownloads],
    ["PTAGENT_REJECT_HR", policy.rejectHr ? "true" : "false"],
    ["PTAGENT_REJECT_MISSING_FREE_END", policy.rejectMissingFreeEnd ? "true" : "false"]
  ]);

  push("Free 到期保护", [
    ["PTAGENT_GUARD_MONITOR", policy.guardMonitorEnabled ? "true" : "false"],
    ["PTAGENT_GUARD_MINUTES", policy.guardMinutes],
    ["PTAGENT_GUARD_INTERVAL_SECONDS", daemon.guardIntervalSeconds],
    ["PTAGENT_AUTO_DELETE_EXPIRED", policy.autoDeleteExpired ? "true" : "false"]
  ]);

  push("WebUI（绑定非回环地址时必须同时设置 TOKEN，否则启动会被拒绝）", [
    ["PTAGENT_WEB_ENABLED", daemon.webEnabled ? "true" : "false"],
    ["PTAGENT_WEB_HOST", daemon.webHost],
    ["PTAGENT_WEB_PORT", daemon.webPort],
    ["PTAGENT_WEB_TOKEN", secret(daemon.webToken)]
  ]);

  return `${lines.join("\n").trimEnd()}\n`;
};

module.exports = {
  applyEnv, findEnvFile, mapEnv, parseEnvFile, processOverrides, toEnvFile,
  DAEMON_KEYS, POLICY_KEYS, SITE_KEYS, DOWNLOADER_KEYS
};
