"use strict";

// 下载策略：和插件的 ptAgentSettings 同名同义，两边配置可以互相拷贝。
// 唯一的差别是 autoDeleteExpired 默认开启——终端版就是为了无人值守跑，
// Free 到期还没下完的任务留着只会白占盘并可能计入 HR。
const DEFAULT_POLICY = {
  guardMinutes: 10,
  minFreeHoursForAutoDownload: 12,
  maxTorrentSizeGB: 50,
  minimumScore: 80,
  maxActiveDownloads: 3,
  minimumRatio: 1,
  scarceOpportunityMinFreeHours: 6,
  scarceOpportunityMaxRequiredSpeedBps: 524288,
  scarceOpportunityMinLeechers: 20,
  scarceOpportunityMinDemandRatio: 10,
  guardMonitorEnabled: true,
  autoDeleteExpired: true,
  guardExecutor: "daemon",
  rejectHr: true,
  rejectMissingFreeEnd: true
};

// 守护进程自身的运行参数。
const DEFAULT_DAEMON = {
  // 扫描间隔取 [min, max] 之间的随机值，每轮重新抽。
  // 固定周期在 PT 站点上是很明显的机器人特征，随机化同时也能错开抢种高峰。
  scanIntervalMinMinutes: 40,
  scanIntervalMaxMinutes: 90,
  scanOnStart: true,
  // 关掉就只扫描和记录，不真的推送，用来先观察一段时间决策是否合意。
  autoDownload: true,
  // 每轮最多推送几个；0 表示不限。默认给个上限，避免一次放行几十个把带宽打满。
  maxPushPerScan: 5,
  guardIntervalSeconds: 60,
  // 入队后下载器要解析元数据才会把任务列出来。默认等 4 轮 × 1.5 秒；
  // 慢一点的 NAS 或超大种子解析更久，把轮数调高即可，不会影响下载本身。
  verifyAttempts: 4,
  verifyDelayMs: 1500,
  webEnabled: true,
  webHost: "127.0.0.1",
  webPort: 7788,
  // 只在需要从别的机器打开 WebUI 时才填。配置里存着下载器密码和站点 API Key，
  // 绑到非回环地址而不设令牌等于把它们挂在局域网上，启动时会直接拒绝。
  webToken: "",
  // 日志保留条数，超出后从最旧的开始丢。
  logRetention: 5000,
  auditRetention: 2000
};

const clampNumber = (value, fallback, { min = -Infinity, max = Infinity } = {}) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const normalizeDaemon = (value = {}) => {
  const merged = { ...DEFAULT_DAEMON, ...value };
  const min = clampNumber(merged.scanIntervalMinMinutes, DEFAULT_DAEMON.scanIntervalMinMinutes, { min: 1, max: 10080 });
  const max = clampNumber(merged.scanIntervalMaxMinutes, DEFAULT_DAEMON.scanIntervalMaxMinutes, { min: 1, max: 10080 });
  return {
    ...merged,
    scanIntervalMinMinutes: Math.min(min, max),
    scanIntervalMaxMinutes: Math.max(min, max),
    scanOnStart: merged.scanOnStart !== false,
    autoDownload: merged.autoDownload !== false,
    maxPushPerScan: Math.round(clampNumber(merged.maxPushPerScan, DEFAULT_DAEMON.maxPushPerScan, { min: 0, max: 500 })),
    guardIntervalSeconds: Math.round(clampNumber(merged.guardIntervalSeconds, DEFAULT_DAEMON.guardIntervalSeconds, { min: 15, max: 3600 })),
    verifyAttempts: Math.round(clampNumber(merged.verifyAttempts, DEFAULT_DAEMON.verifyAttempts, { min: 0, max: 30 })),
    verifyDelayMs: Math.round(clampNumber(merged.verifyDelayMs, DEFAULT_DAEMON.verifyDelayMs, { min: 0, max: 60000 })),
    webEnabled: merged.webEnabled !== false,
    webHost: String(merged.webHost || DEFAULT_DAEMON.webHost),
    webPort: Math.round(clampNumber(merged.webPort, DEFAULT_DAEMON.webPort, { min: 1, max: 65535 })),
    webToken: String(merged.webToken || ""),
    logRetention: Math.round(clampNumber(merged.logRetention, DEFAULT_DAEMON.logRetention, { min: 100, max: 200000 })),
    auditRetention: Math.round(clampNumber(merged.auditRetention, DEFAULT_DAEMON.auditRetention, { min: 100, max: 200000 }))
  };
};

const normalizePolicy = (value = {}) => ({ ...DEFAULT_POLICY, ...value, guardExecutor: "daemon" });

/**
 * 抽取本轮的扫描间隔（毫秒）。
 * 闭区间 [min, max]，min === max 时退化成固定周期。
 */
const nextIntervalMs = (daemon, random = Math.random) => {
  const { scanIntervalMinMinutes: min, scanIntervalMaxMinutes: max } = normalizeDaemon(daemon);
  const minutes = min + random() * (max - min);
  return Math.round(minutes * 60000);
};

const createConfig = (storage) => {
  const readPolicy = async () => {
    const data = await storage.get("ptAgentSettings");
    return normalizePolicy(data?.ptAgentSettings);
  };

  const savePolicy = async (patch) => {
    const next = normalizePolicy({ ...(await readPolicy()), ...patch });
    await storage.set({ ptAgentSettings: next });
    return next;
  };

  const readDaemon = async () => {
    const data = await storage.get("ptAgentDaemon");
    return normalizeDaemon(data?.ptAgentDaemon);
  };

  const saveDaemon = async (patch) => {
    const next = normalizeDaemon({ ...(await readDaemon()), ...patch });
    await storage.set({ ptAgentDaemon: next });
    return next;
  };

  const readAll = async () => ({
    policy: await readPolicy(),
    daemon: await readDaemon()
  });

  return { readPolicy, savePolicy, readDaemon, saveDaemon, readAll };
};

module.exports = {
  DEFAULT_POLICY,
  DEFAULT_DAEMON,
  createConfig,
  nextIntervalMs,
  normalizeDaemon,
  normalizePolicy
};
