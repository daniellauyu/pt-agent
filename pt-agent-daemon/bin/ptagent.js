#!/usr/bin/env node
"use strict";

// PT Agent 终端入口。
// 设计原则：每条命令都能加 --json 输出机器可读结果，方便 agent 直接消费；
// 不加 --json 时给人看的摘要，不打印原始 JSON 刷屏。

const HELP = `PT Agent 守护进程

用法：ptagent <命令> [参数]

守护
  start                      启动守护进程（定时扫描 + Free 保护 + WebUI），前台运行
  web                        只启动 WebUI，不跑定时任务

一次性动作
  scan [--dry-run]           立刻扫描一轮。--dry-run 只评估不推送
  guard [--dry-run]          立刻跑一次 Free 到期保护
  backfill                   给下载器里缺 Free 截止标签的任务回查并补上
  push <种子ID...> [--force] 手动推送指定资源（--force 跳过本地安全准入）

查看
  status                     调度状态与上一轮扫描结果
  resources [--filter X]     最近一次扫描的评估结果（X = recommend|risk|reject）
  tasks                      下载器当前任务与 Free 保护状态
  logs [-n N] [--level L] [--prefix P]
  audit [-n N]               生命周期审计记录

配置
  config list                打印全部配置
  config set <键> <值>       修改调度或策略配置，如 config set scanIntervalMinMinutes 30
  config export-env [文件]   把当前配置导出成 .env，用于搬到另一台机器
    --no-secrets             导出时移除密码、API Key 和 WebUI 令牌
  import <文件.json>         导入浏览器插件「导出配置」生成的 JSON
  downloader list|add|rm|test
  site list|add|rm
  doctor                     体检：配置完整性、站点与下载器连通性

通用参数
  --json                     输出 JSON（供 agent 消费）
  --home <目录>              指定数据目录（默认 ~/.ptagent，也可用 PTAGENT_HOME）
  --env <文件>               指定 .env（默认依次找 $PTAGENT_HOME/.env、./.env、项目根目录）
  --no-env                   本次忽略 .env
  --quiet                    不把日志镜像到终端
  -h, --help                 显示本帮助
`;

const parseArgs = (argv) => {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--") && !/^-[a-zA-Z]$/.test(token)) {
      positional.push(token);
      continue;
    }
    const name = token.replace(/^--?/, "");
    const next = argv[index + 1];
    // 布尔开关和带值参数在这里区分：下一个 token 以 - 开头就当成布尔。
    if (["json", "quiet", "dry-run", "force", "help", "h", "yes", "new", "no-env", "no-secrets"].includes(name)) {
      flags[name] = true;
    } else if (next !== undefined && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
};

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command = "", ...rest] = positional;

if (flags.help || flags.h || !command || command === "help") {
  process.stdout.write(HELP);
  process.exit(command && command !== "help" ? 1 : 0);
}

if (flags.home) process.env.PTAGENT_HOME = String(flags.home);
if (flags.env) process.env.PTAGENT_ENV_FILE = String(flags.env);

// 先解决「数据目录写在 .env 里」这个先有鸡还是先有蛋的问题：
// 找 .env 需要知道数据目录，而数据目录本身可能就定义在 .env 里。
// 所以这里只用不依赖数据目录的那几个位置先探一次，拿到 PTAGENT_HOME 就够了。
if (!process.env.PTAGENT_HOME && !flags["no-env"]) {
  const fs = require("node:fs");
  const nodePath = require("node:path");
  const { parseEnvFile } = require("../src/env");
  const early = [
    process.env.PTAGENT_ENV_FILE,
    nodePath.join(process.cwd(), ".env"),
    nodePath.resolve(__dirname, "..", ".env")
  ].filter(Boolean).find((file) => fs.existsSync(file));
  if (early) {
    const home = parseEnvFile(fs.readFileSync(early, "utf8")).PTAGENT_HOME;
    if (home) process.env.PTAGENT_HOME = home.replace(/^~(?=\/|$)/, require("node:os").homedir());
  }
}

const fsSync = require("node:fs");
const { createContext } = require("../src/context");
const { runScan, pushSelected } = require("../src/runner");
const { runGuard, backfillDeadlines } = require("../src/guard");
const { createScheduler } = require("../src/scheduler");
const { createServer, isLoopback } = require("../src/webui/server");
const { DEFAULT_DAEMON, DEFAULT_POLICY } = require("../src/config");
const { applyEnv, findEnvFile, toEnvFile } = require("../src/env");

const asJson = Boolean(flags.json);
const out = (text) => process.stdout.write(`${text}\n`);
const emit = (payload, humanRenderer) => {
  if (asJson) {
    out(JSON.stringify(payload, null, 2));
    return;
  }
  humanRenderer(payload);
};

const formatTime = (iso) => (iso ? new Date(iso).toLocaleString("zh-CN", { hour12: false }) : "-");
const formatBytes = (bytes) => {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index === 0 ? 0 : 2)} ${units[index]}`;
};
const formatLeft = (hours) => {
  const value = Number(hours);
  if (!Number.isFinite(value)) return "未知";
  if (value <= 0) return "已到期";
  if (value < 48) return `${value.toFixed(1)}h`;
  return `${(value / 24).toFixed(1)}d`;
};
// 中日韩字符在等宽终端里占两格。用 String.padEnd 排出来的表在中文行上会错位，
// 所以按显示宽度而不是字符数来补空格。
const CJK = /[ᄀ-ᅟ⺀-꓏ꥠ-꥿가-힣豈-﫿︰-﹯＀-｠￠-￦]/;
const displayWidth = (text) => Array.from(String(text ?? ""))
  .reduce((total, char) => total + (CJK.test(char) ? 2 : 1), 0);
const pad = (value, width) => {
  const text = String(value ?? "");
  return text + " ".repeat(Math.max(1, width - displayWidth(text)));
};
const truncate = (value, width) => {
  const text = String(value ?? "");
  if (displayWidth(text) <= width) return text;
  let result = "";
  for (const char of text) {
    if (displayWidth(result) + displayWidth(char) > width - 1) break;
    result += char;
  }
  return `${result}…`;
};

// 只在真正跑守护进程时把日志镜像到终端；单次命令用摘要输出，避免被 debug 日志淹没。
const makeContext = ({ mirror = false } = {}) => createContext({
  mirrorToConsole: mirror && !flags.quiet && !asJson,
  minLevel: mirror ? "info" : "debug"
});

const startWebUi = async (ctx, { scheduler = null } = {}) => {
  const daemon = await ctx.config.readDaemon();
  if (!daemon.webEnabled) return null;
  if (!isLoopback(daemon.webHost) && !daemon.webToken) {
    // 配置里有下载器密码和站点 API Key，绑到局域网还不设令牌等于直接公开它们。
    throw new Error(
      `WebUI 绑定到 ${daemon.webHost} 但没有设置访问令牌。` +
      `先执行 ptagent config set webToken <一段随机字符串>，或把 webHost 改回 127.0.0.1。`
    );
  }
  ctx.webToken = daemon.webToken;
  const web = createServer(ctx, { scheduler });
  const info = await web.listen({ host: daemon.webHost, port: daemon.webPort });
  out(`WebUI: ${info.url}`);
  if (daemon.webToken) out("页面打开后请输入 WebUI 访问令牌；令牌不会写进 URL 或启动日志。");
  return web;
};

const commands = {
  async start(ctx) {
    ctx.startedAt = new Date().toISOString();
    ctx.logger.installProcessCapture();
    const scheduler = createScheduler(ctx);
    const web = await startWebUi(ctx, { scheduler });
    await scheduler.start();
    out("守护进程已启动，Ctrl+C 停止。");

    const shutdown = async (signal) => {
      out(`\n收到 ${signal}，正在停止…`);
      scheduler.stop();
      if (web) await web.close();
      await ctx.logger.flush();
      process.exit(0);
    };
    process.on("SIGINT", () => void shutdown("SIGINT"));
    process.on("SIGTERM", () => void shutdown("SIGTERM"));
    // 定时器都 unref 过，这里需要一个永不结束的句柄把进程挂住。
    await new Promise(() => {});
  },

  async web(ctx) {
    ctx.startedAt = new Date().toISOString();
    ctx.logger.installProcessCapture();
    const web = await startWebUi(ctx);
    if (!web) throw new Error("WebUI 已在配置里关闭（webEnabled=false）");
    out("只启动了 WebUI，没有定时扫描。Ctrl+C 停止。");
    process.on("SIGINT", async () => {
      await web.close();
      process.exit(0);
    });
    await new Promise(() => {});
  },

  async scan(ctx) {
    const { summary } = await runScan(ctx, { dryRun: Boolean(flags["dry-run"]) });
    emit(summary, (data) => {
      out(`站点 ${data.site} → 下载器 ${data.downloader}，耗时 ${(data.durationMs / 1000).toFixed(1)}s`);
      out(`Free 资源 ${data.counts.total}：推荐 ${data.counts.recommend} / 风险 ${data.counts.risk} / 拒绝 ${data.counts.reject}`);
      out(`候选 ${data.candidates}，推送 ${data.pushed.length}，准入拦下 ${data.skipped.length}，失败 ${data.failed.length}`);
      data.pushed.forEach((item) => out(`  ✔ ${item.duplicate ? "已存在" : "已发送"} ${item.title}`));
      data.skipped.forEach((item) => out(`  ○ 拦下 ${item.title} —— ${item.reasons.join("；")}`));
      data.failed.forEach((item) => out(`  ✘ 失败 ${item.title} —— ${item.error}`));
    });
  },

  async guard(ctx) {
    const result = await runGuard(ctx, { dryRun: Boolean(flags["dry-run"]) });
    emit(result, (data) => {
      if (data.skipped) {
        out(`已跳过：${data.skipped}`);
        return;
      }
      out(`检查 ${data.checked} 个任务：警告 ${data.warnings.length}，删除 ${data.deleted.length}`);
      data.warnings.forEach((item) => out(`  ⚠ ${item.status} ${item.title} —— ${item.reason}`));
      data.deleted.forEach((item) => out(`  ✘ 已删除 ${item.title}（${item.status}）`));
    });
  },

  async backfill(ctx) {
    const result = await backfillDeadlines(ctx);
    emit(result, (data) => {
      out(`检查 ${data.checked} 个任务，缺标签 ${data.candidates} 个，补上 ${data.updated.length} 个。`);
      data.updated.forEach((item) => out(`  + ${item.name} → ${item.deadline}`));
    });
  },

  async push(ctx) {
    if (!rest.length) throw new Error("用法：ptagent push <种子ID> [种子ID...] [--force]");
    const result = await pushSelected(ctx, rest, { manualOverride: Boolean(flags.force) });
    emit(result, (data) => {
      data.pushed.forEach((item) => out(`  ✔ ${item.duplicate ? "已存在" : "已发送"} ${item.title}`));
      data.failed.forEach((item) => out(`  ✘ 失败 ${item.title} —— ${item.error}`));
    });
  },

  async status(ctx) {
    const daemon = await ctx.config.readDaemon();
    const policy = await ctx.config.readPolicy();
    const state = await ctx.state.read();
    const payload = {
      home: ctx.paths.root,
      daemon: { ...daemon, webToken: daemon.webToken ? "***" : "" },
      policy,
      nextScanAt: state.nextScanAt || null,
      lastScanAt: state.lastScanAt || null,
      lastGuardAt: state.lastGuardAt || null,
      lastScan: state.lastScan || null,
      downloaders: (await ctx.downloaders.list()).map((item) => ({
        name: item.name, address: item.address, enabled: item.enabled, isPrivate: item.isPrivate
      })),
      sites: (await ctx.sites.list()).map((item) => ({
        name: item.name, type: item.type, enabled: item.enabled, hasApiKey: Boolean(item.apiKey)
      }))
    };
    emit(payload, (data) => {
      out(`数据目录       ${data.home}`);
      out(`扫描间隔       ${data.daemon.scanIntervalMinMinutes}–${data.daemon.scanIntervalMaxMinutes} 分钟（随机）`);
      out(`自动下载       ${data.daemon.autoDownload ? "开启" : "关闭（只评估）"}，每轮最多 ${data.daemon.maxPushPerScan || "不限"}`);
      out(`到期自动删除   ${data.policy.autoDeleteExpired ? "开启" : "关闭"}，保护窗口 ${data.policy.guardMinutes} 分钟`);
      out(`下次扫描       ${formatTime(data.nextScanAt)}`);
      out(`上次扫描       ${formatTime(data.lastScanAt)}`);
      out(`上次保护检查   ${formatTime(data.lastGuardAt)}`);
      out(`下载器         ${data.downloaders.map((item) => `${item.name}(${item.enabled ? "启用" : "停用"})`).join("、") || "未配置"}`);
      out(`站点           ${data.sites.map((item) => `${item.name}(${item.hasApiKey ? "已设 Key" : "缺 Key"})`).join("、") || "未配置"}`);
      if (data.lastScan) {
        const last = data.lastScan;
        out("");
        out(`上一轮：Free ${last.counts.total}，推荐 ${last.counts.recommend}，推送 ${last.pushed.length}，失败 ${last.failed.length}`);
      }
    });
  },

  async resources(ctx) {
    const state = await ctx.state.read();
    const all = state.lastEvaluated || [];
    const rows = flags.filter ? all.filter((item) => item.decision === flags.filter) : all;
    emit({ scannedAt: state.lastScanAt || null, total: all.length, resources: rows }, (data) => {
      if (!data.resources.length) {
        out("没有匹配的资源。先跑一次 ptagent scan。");
        return;
      }
      out(`扫描于 ${formatTime(data.scannedAt)}，共 ${data.total} 个，显示 ${data.resources.length} 个`);
      out(`${pad("决策", 7)}${pad("分", 5)}${pad("剩余", 8)}${pad("大小", 11)}${pad("种/下", 10)}标题`);
      data.resources.forEach((item) => {
        const mark = item.existingHash ? "●" : item.excluded ? "×" : " ";
        out(
          `${pad(item.decision, 10)}${pad(item.score, 4)}${pad(formatLeft(item.leftHours), 8)}` +
          `${pad(formatBytes(item.sizeBytes), 11)}${pad(`${item.seeders}/${item.leechers}`, 10)}${mark} ${truncate(item.title, 60)}`
        );
      });
      out("");
      out("● 已在下载器中   × 已排除");
    });
  },

  async tasks(ctx) {
    const { connect } = require("../src/downloader");
    const { client, downloader } = await connect(ctx);
    const raw = await client.listTorrents("all");
    const policy = await ctx.config.readPolicy();
    const tasks = raw.map((task) => {
      const guard = ctx.engines.guard.evaluate(task, { guardMinutes: policy.guardMinutes });
      return {
        hash: task.hash,
        name: task.name,
        state: task.state,
        progress: Number(task.progress || 0),
        dlspeed: Number(task.dlspeed || 0),
        size: Number(task.size || 0),
        deadline: ctx.engines.qb.deadlineFromTags(task.tags),
        guard: guard.status,
        managed: guard.managed
      };
    });
    const slots = ctx.engines.qb.summarizeDownloadSlots(raw);
    emit({ downloader: downloader.name, slots, tasks }, (data) => {
      out(`下载器 ${data.downloader}：占用 ${data.slots.occupying} 槽，挂起 ${data.slots.held}`);
      const active = data.tasks.filter((task) => task.progress < 1);
      if (!active.length) {
        out("没有未完成的任务。");
        return;
      }
      out(`${pad("进度", 8)}${pad("状态", 14)}${pad("保护", 18)}${pad("速度", 12)}标题`);
      active.forEach((task) => {
        out(
          `${pad(`${(task.progress * 100).toFixed(1)}%`, 8)}${pad(task.state, 14)}` +
          `${pad(task.managed ? task.guard : "-", 18)}${pad(formatBytes(task.dlspeed), 12)}${truncate(task.name, 50)}`
        );
      });
    });
  },

  async logs(ctx) {
    const result = await ctx.logger.readLogs({
      limit: Number(flags.n || flags.limit || 60),
      level: flags.level || null,
      prefix: flags.prefix || null
    });
    emit(result, (data) => {
      if (!data.records.length) {
        out("没有匹配的日志。");
        return;
      }
      data.records.forEach((record) => {
        const detail = record.data === null ? "" : JSON.stringify(record.data);
        out(`${record.at.slice(0, 19).replace("T", " ")} ${pad(record.level, 6)}${pad(record.event, 28)}${truncate(detail, 110)}`);
      });
      out(`\n共 ${data.total} 条，显示最近 ${data.records.length} 条。日志文件：${ctx.logger.files.logFile}`);
    });
  },

  async audit(ctx) {
    const result = await ctx.logger.readAudit({ limit: Number(flags.n || flags.limit || 40) });
    emit(result, (data) => {
      if (!data.records.length) {
        out("没有审计记录。");
        return;
      }
      data.records.forEach((record) => {
        out(
          `${record.at.slice(0, 19).replace("T", " ")} ${pad(record.action, 24)}${pad(record.status, 16)}` +
          `${truncate(record.title || record.hash, 40)}  ${truncate(record.reason, 60)}`
        );
      });
      out(`\n共 ${data.total} 条。审计文件：${ctx.logger.files.auditFile}`);
    });
  },

  async config(ctx) {
    const [action, key, ...values] = rest;
    if (!action || action === "list") {
      const { policy, daemon } = await ctx.config.readAll();
      emit({ daemon: { ...daemon, webToken: daemon.webToken ? "***" : "" }, policy }, (data) => {
        out("调度配置：");
        Object.entries(data.daemon).forEach(([name, value]) => out(`  ${pad(name, 30)}${value}`));
        out("\n下载策略：");
        Object.entries(data.policy).forEach(([name, value]) => out(`  ${pad(name, 30)}${value}`));
        out(`\n配置文件：${ctx.paths.config}`);
      });
      return;
    }
    if (action === "export-env") {
      const { policy, daemon } = await ctx.config.readAll();
      const text = toEnvFile({
        daemon,
        policy,
        // 用 activeSite（优先挑真的填了 Key 的那条），不能用 sites.active()——
        // 后者取第一条启用的，会挑中初始化时那条空的 M-Team 占位记录，导出一个没有 Key 的 .env。
        site: await ctx.activeSite().catch(() => ctx.sites.active()),
        downloaders: await ctx.downloaders.list()
      }, { includeSecrets: flags["no-secrets"] !== true });
      const target = key || values[0];
      if (target) {
        fsSync.writeFileSync(target, text, { mode: 0o600 });
        fsSync.chmodSync(target, 0o600);
        out(`已导出到 ${target}（权限 600）。`);
        if (flags["no-secrets"]) {
          out("已按 --no-secrets 移除密码、API Key 和 WebUI 令牌。");
        } else {
          out("⚠ 这个文件里有密码、API Key 和 WebUI 令牌，不要发到聊天、网盘或公开 Issue。");
        }
        return;
      }
      if (!flags["no-secrets"]) {
        throw new Error(
          "拒绝把密码和 API Key 直接打印到终端。请指定目标文件，或加 --no-secrets 导出脱敏模板。"
        );
      }
      process.stdout.write(text);
      return;
    }
    if (action !== "set") throw new Error("用法：ptagent config list / set <键> <值> / export-env [文件]");
    if (!key) throw new Error("缺少配置键名");

    const raw = values.join(" ");
    const coerce = (previous) => {
      if (typeof previous === "boolean") return /^(1|true|on|yes|开)$/i.test(raw);
      if (typeof previous === "number") {
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) throw new Error(`${key} 需要一个数字，收到「${raw}」`);
        return parsed;
      }
      return raw;
    };

    // 被 .env 托管的键，在这里改了下次启动就会被 .env 覆盖回去——必须当场说清楚。
    const envManagedFields = new Set();
    if (ctx.envManaged) {
      const { DAEMON_KEYS, POLICY_KEYS } = require("../src/env");
      [...DAEMON_KEYS, ...POLICY_KEYS]
        .filter(([envKey]) => ctx.envManaged.managed.includes(envKey))
        .forEach(([envKey, field]) => envManagedFields.add(`${field}\u0000${envKey}`));
    }
    const envKeyFor = (field) => [...envManagedFields]
      .map((entry) => entry.split("\u0000"))
      .find(([name]) => name === field)?.[1];

    if (key in DEFAULT_DAEMON) {
      const next = await ctx.config.saveDaemon({ [key]: coerce(DEFAULT_DAEMON[key]) });
      const owner = envKeyFor(key);
      if (owner && !asJson) {
        out(`⚠ ${key} 由 .env 的 ${owner} 托管，下次启动会被覆盖回去。要永久改请改 .env。`);
      }
      emit({ scope: "daemon", key, value: next[key] }, (data) => out(`已设置 ${data.key} = ${data.value}`));
      return;
    }
    if (key in DEFAULT_POLICY) {
      const next = await ctx.config.savePolicy({ [key]: coerce(DEFAULT_POLICY[key]) });
      const owner = envKeyFor(key);
      if (owner && !asJson) {
        out(`⚠ ${key} 由 .env 的 ${owner} 托管，下次启动会被覆盖回去。要永久改请改 .env。`);
      }
      emit({ scope: "policy", key, value: next[key] }, (data) => out(`已设置 ${data.key} = ${data.value}`));
      return;
    }
    throw new Error(
      `未知配置键「${key}」。可用键见 ptagent config list。`
    );
  },

  async downloader(ctx) {
    const [action = "list", ...args] = rest;
    if (action === "list") {
      const items = await ctx.downloaders.list();
      emit({ downloaders: items.map((item) => ({ ...item, password: item.password ? "***" : "" })) }, (data) => {
        if (!data.downloaders.length) {
          out("还没有下载器。用 ptagent downloader add --address <URL> --username <用户> --password <密码>");
          return;
        }
        data.downloaders.forEach((item, index) => {
          out(`${index + 1}. ${item.name}  [${item.id}]`);
          out(`   ${item.address}  ${item.enabled ? "启用" : "停用"}  ${item.isPrivate ? "内网" : "公网"}  分类 ${item.category}`);
        });
        out("\n探测顺序即列表顺序：连得上的第一台会被使用。");
      });
      return;
    }
    if (action === "add" || action === "set") {
      const record = {
        id: flags.id || args[0],
        name: flags.name,
        type: flags.type || "qbittorrent",
        address: flags.address,
        username: flags.username,
        password: flags.password,
        savePath: flags.savepath || flags.savePath,
        category: flags.category,
        enabled: flags.enabled === undefined ? true : /^(1|true|on|yes)$/i.test(String(flags.enabled))
      };
      const existing = record.id ? (await ctx.downloaders.list()).find((item) => item.id === record.id) : null;
      const merged = { ...(existing || {}), ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) };
      const errors = ctx.engines.downloaderStore.validate(ctx.engines.downloaderStore.normalize(merged));
      if (errors.length) throw new Error(errors.join("；"));
      const saved = await ctx.downloaders.upsert(merged);
      emit({ ...saved, password: "***" }, (data) => out(`已保存下载器 ${data.name} [${data.id}]`));
      return;
    }
    if (action === "rm") {
      if (!args[0]) throw new Error("用法：ptagent downloader rm <id>");
      await ctx.downloaders.remove(args[0]);
      emit({ removed: args[0] }, () => out(`已删除 ${args[0]}`));
      return;
    }
    if (action === "test") {
      const items = await ctx.downloaders.list();
      const target = args[0] ? items.find((item) => item.id === args[0] || item.name === args[0]) : items[0];
      if (!target) throw new Error("找不到指定的下载器");
      const client = ctx.engines.downloaderTypes.createAdapter(target, {
        onLog: (event, data) => ctx.logger.debug(event, data)
      });
      const result = await client.diagnose();
      emit(result, (data) => {
        data.stages.forEach((stage) => out(`${stage.status === "ok" ? "✔" : "✘"} ${stage.label}：${stage.detail}`));
      });
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("用法：ptagent downloader list|add|set|rm|test");
  },

  async site(ctx) {
    const [action = "list", ...args] = rest;
    if (action === "list") {
      const items = await ctx.sites.list();
      emit({ sites: items.map((item) => ({ ...item, apiKey: item.apiKey ? "***" : "" })) }, (data) => {
        if (!data.sites.length) {
          out("还没有站点。用 ptagent site add --api-key <KEY>");
          return;
        }
        data.sites.forEach((item) => {
          out(`- ${item.name} [${item.id}] ${item.type}  ${item.enabled ? "启用" : "停用"}  ${item.apiKey ? "已设 Key" : "缺 Key"}`);
          out(`  站点 ${item.siteUrl}  API ${item.apiUrl}`);
        });
      });
      return;
    }
    if (action === "add" || action === "set") {
      const type = flags.type || "mteam";
      const record = {
        id: flags.id || args[0],
        name: flags.name,
        type,
        siteUrl: flags["site-url"] || flags.siteUrl,
        apiUrl: flags["api-url"] || flags.apiUrl,
        apiKey: flags["api-key"] || flags.apiKey,
        enabled: flags.enabled === undefined ? true : /^(1|true|on|yes)$/i.test(String(flags.enabled))
      };
      const all = await ctx.sites.list();
      // 站点列表初始化时会预置一条没填 API Key 的 M-Team 占位记录。
      // 不指定 id 时默认更新同类型的已有记录，否则 add 会新建第二条，
      // 而选站点是取第一条启用的——用户填的 Key 会被那条空占位记录挡住。
      const existing = record.id
        ? all.find((item) => item.id === record.id)
        : (flags.new ? null : all.find((item) => item.type === type));
      if (!record.id && existing) record.id = existing.id;
      const merged = { ...(existing || {}), ...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) };
      const errors = ctx.engines.siteStore.validate(ctx.engines.siteStore.normalize(merged));
      if (errors.length) throw new Error(errors.join("；"));
      const saved = await ctx.sites.upsert(merged);
      emit({ ...saved, apiKey: "***" }, (data) => out(`已保存站点 ${data.name} [${data.id}]`));
      return;
    }
    if (action === "rm") {
      if (!args[0]) throw new Error("用法：ptagent site rm <id>");
      await ctx.sites.remove(args[0]);
      emit({ removed: args[0] }, () => out(`已删除 ${args[0]}`));
      return;
    }
    throw new Error("用法：ptagent site list|add|set|rm");
  },

  // 导入浏览器插件「导出配置」生成的 JSON，把插件那边调好的配置整体搬过来。
  async import(ctx) {
    const file = rest[0];
    if (!file) throw new Error("用法：ptagent import <插件导出的.json>");
    const payload = JSON.parse(fsSync.readFileSync(file, "utf8"));
    const applied = { downloaders: 0, sites: 0, policy: false, exclusions: 0 };

    const downloaders = payload.ptAgentDownloaders || payload.downloaders;
    if (Array.isArray(downloaders) && downloaders.length) {
      await ctx.downloaders.save(downloaders);
      applied.downloaders = downloaders.length;
    }
    const sites = payload.ptAgentSites || payload.sites;
    if (Array.isArray(sites) && sites.length) {
      await ctx.sites.save(sites);
      applied.sites = sites.length;
    }
    const settings = payload.ptAgentSettings || payload.settings;
    if (settings && typeof settings === "object") {
      // 插件的 guardExecutor 是 "extension"，导进来必须改成 daemon，否则保护不会执行。
      await ctx.config.savePolicy({ ...settings, guardExecutor: "daemon" });
      applied.policy = true;
    }
    const exclusions = payload.ptAgentExcludedTorrents || payload.exclusions;
    if (Array.isArray(exclusions) && exclusions.length) {
      await ctx.storage.set({ ptAgentExcludedTorrents: exclusions });
      applied.exclusions = exclusions.length;
    }
    const links = payload.ptAgentTorrentLinks || payload.torrentLinks;
    if (Array.isArray(links) && links.length) await ctx.storage.set({ ptAgentTorrentLinks: links });

    // 插件的老版单下载器配置里带着 M-Team API Key，站点列表为空时用它兜底。
    const legacy = payload.ptAgentQbSettings;
    if (legacy?.mteamApiKey && !applied.sites) {
      await ctx.sites.upsert({
        id: "site_mteam", name: "M-Team", type: "mteam",
        siteUrl: "https://kp.m-team.cc/", apiUrl: "https://api.m-team.cc/",
        apiKey: legacy.mteamApiKey, enabled: true
      });
      applied.sites = 1;
    }

    emit(applied, (data) => {
      out(`已导入：下载器 ${data.downloaders} 台，站点 ${data.sites} 个，` +
        `下载策略${data.policy ? "已覆盖" : "未提供"}，排除记录 ${data.exclusions} 条。`);
      out("接着跑 ptagent doctor 确认连通性，再用 ptagent config export-env .env 生成便携配置。");
    });
  },

  async doctor(ctx) {
    const checks = [];
    const check = async (label, task) => {
      try {
        checks.push({ label, ok: true, detail: await task() });
      } catch (error) {
        checks.push({ label, ok: false, detail: String(error?.message || error) });
      }
    };

    const daemon = await ctx.config.readDaemon();
    const policy = await ctx.config.readPolicy();
    await check("数据目录", async () => ctx.paths.root);
    await check("配置来源", async () => {
      // 被环境托管的项在 WebUI 里改了会被下次启动覆盖，必须说清楚有多少、来自哪。
      const managed = ctx.envManaged?.managed || [];
      if (!managed.length) return `${ctx.paths.config}（没有 .env，也没有 PTAGENT_* 环境变量）`;
      const envFile = flags["no-env"] ? null : findEnvFile(ctx.paths.root);
      const { processOverrides } = require("../src/env");
      const fromProcess = Object.keys(processOverrides()).length;
      const sources = [
        envFile ? envFile : null,
        fromProcess ? `${fromProcess} 个 PTAGENT_* 环境变量（优先级更高）` : null
      ].filter(Boolean).join(" + ");
      return `${sources} 托管 ${managed.length} 项，其余来自 ${ctx.paths.config}`;
    });
    await check("决策引擎", async () => {
      const { provenance } = require("../src/engines");
      const info = provenance();
      if (!info) throw new Error("vendor/engines/MANIFEST.json 缺失或损坏，执行 npm run sync-engines");
      // 顺带报一下有没有跑偏：完整仓库里能比对插件源文件，单独发布的副本只校验自身完整性。
      const { check: checkVendor } = require("../scripts/sync-engines");
      const result = checkVendor();
      if (!result.ok) throw new Error(result.problems.join("；"));
      return `${info.moduleCount} 个模块，同步自 ${info.source}（${info.syncedAt.slice(0, 10)}）`;
    });
    await check("调度参数", async () => {
      if (daemon.scanIntervalMinMinutes > daemon.scanIntervalMaxMinutes) throw new Error("最短间隔大于最长间隔");
      return `${daemon.scanIntervalMinMinutes}–${daemon.scanIntervalMaxMinutes} 分钟，自动下载${daemon.autoDownload ? "开启" : "关闭"}`;
    });
    await check("站点配置", async () => {
      const site = await ctx.activeSite();
      if (!site.apiKey) throw new Error(`站点 ${site.name} 缺少 API Key`);
      return `${site.name}（${site.apiUrl}）`;
    });
    await check("站点连通性", async () => {
      const { createSiteClient } = require("../src/mteam");
      const site = await ctx.activeSite();
      const account = await createSiteClient(site, { logger: ctx.logger }).fetchAccount();
      return `${account.username}，分享率 ${account.ratio === null ? "-" : account.ratio.toFixed(3)}，魔力 ${account.bonus}`;
    });
    await check("下载器配置", async () => {
      const items = (await ctx.downloaders.list()).filter((item) => item.enabled);
      if (!items.length) throw new Error("没有启用的下载器");
      return items.map((item) => item.name).join("、");
    });
    await check("下载器连通性", async () => {
      const { connect } = require("../src/downloader");
      const { client, downloader } = await connect(ctx, { force: true });
      return `${downloader.name} · qBittorrent ${await client.getVersion()}`;
    });
    await check("Free 到期保护", async () => {
      if (!policy.guardMonitorEnabled) throw new Error("保护监控已关闭，到期任务不会被处理");
      return policy.autoDeleteExpired
        ? `开启，到期前 ${policy.guardMinutes} 分钟删除未完成任务`
        : `开启但只告警不删除（autoDeleteExpired=false）`;
    });

    const ok = checks.every((item) => item.ok);
    emit({ ok, checks }, (data) => {
      data.checks.forEach((item) => out(`${item.ok ? "✔" : "✘"} ${pad(item.label, 16)}${item.detail}`));
      out(data.ok ? "\n一切正常，可以 ptagent start 了。" : "\n有检查未通过，修好后再启动守护进程。");
    });
    if (!ok) process.exitCode = 1;
  }
};

const main = async () => {
  const handler = commands[command];
  if (!handler) {
    process.stderr.write(`未知命令「${command}」。执行 ptagent --help 查看用法。\n`);
    process.exit(1);
  }
  const ctx = makeContext({ mirror: ["start", "web"].includes(command) });

  // .env 在任何命令读配置之前生效：写在里面的项以它为准，覆盖 config.json。
  // config list 也要走这一步，否则用户看到的和实际跑的不是一回事。
  if (!flags["no-env"]) {
    const applied = await applyEnv(ctx);
    if (applied.applied) {
      ctx.envManaged = applied;
      ctx.logger.info("config:env-applied", {
        file: applied.file,
        keys: applied.managed.length,
        downloaders: applied.downloaderCount || 0
      });
      if (applied.droppedDownloaders?.length || applied.droppedSites?.length) {
        ctx.logger.warn("config:env-replaced-lists", {
          downloaders: applied.droppedDownloaders || [],
          sites: applied.droppedSites || [],
          hint: ".env 一旦定义了下载器或站点就会整份接管对应列表；这些不在 .env 里的记录已被顶掉"
        });
      }
    }
  }

  await handler(ctx);
  await ctx.logger.flush();
};

main().catch(async (error) => {
  if (asJson) {
    process.stdout.write(`${JSON.stringify({ error: String(error?.message || error) }, null, 2)}\n`);
  } else {
    process.stderr.write(`✘ ${String(error?.message || error)}\n`);
  }
  process.exit(1);
});
