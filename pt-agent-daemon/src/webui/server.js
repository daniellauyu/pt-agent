"use strict";

const http = require("node:http");
const fsp = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

const { runScan, pushSelected } = require("../runner");
const { runGuard, backfillDeadlines } = require("../guard");
const { connect } = require("../downloader");

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const isLoopback = (host) => /^(127\.|::1$|localhost$)/i.test(
  String(host || "").replace(/^\[|\]$/g, "")
);

const hostnameFromAuthority = (authority) => {
  try {
    return new URL(`http://${String(authority || "")}`).hostname;
  } catch (_) {
    return "";
  }
};

// 本机无令牌模式只接受真正来自 loopback 名称的请求。
// 浏览器访问恶意域名后若通过 DNS rebinding 指到 127.0.0.1，Host/Origin 仍是恶意域名，
// 会在这里被拒绝，不能借用户浏览器读取或修改本机 WebUI。
const isTrustedLoopbackRequest = (request) => {
  const host = hostnameFromAuthority(request.headers.host);
  if (!isLoopback(host)) return false;
  const origin = String(request.headers.origin || "");
  if (!origin) return true;
  try {
    return isLoopback(new URL(origin).hostname);
  } catch (_) {
    return false;
  }
};

// 配置里存着下载器密码和站点 API Key。它们只需要写入，永远不该再读回浏览器，
// 所以出站一律脱敏，只告诉前端"填过没有"。
const maskDownloader = (item) => ({ ...item, password: "", hasPassword: Boolean(item.password) });
const maskSite = (item) => ({ ...item, apiKey: "", hasApiKey: Boolean(item.apiKey) });
const maskDaemon = (item) => ({ ...item, webToken: "", hasWebToken: Boolean(item.webToken) });

const publicHttpError = (status, publicMessage) => Object.assign(
  new Error("WebUI request rejected"),
  { status, publicMessage: String(publicMessage) }
);

const readBody = (request, limitBytes = 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  request.on("data", (chunk) => {
    size += chunk.length;
    if (size > limitBytes) {
      reject(publicHttpError(413, "请求体过大"));
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return resolve({});
    try {
      resolve(JSON.parse(raw));
    } catch (_) {
      reject(publicHttpError(400, "请求体不是合法 JSON"));
    }
  });
  request.on("error", reject);
});

const createServer = (ctx, { scheduler = null } = {}) => {
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, pattern, handler });

  // ---------- 只读状态 ----------
  route("GET", /^\/api\/status$/, async () => {
    const daemon = await ctx.config.readDaemon();
    const policy = await ctx.config.readPolicy();
    const state = await ctx.state.read();
    const downloaders = await ctx.downloaders.list();
    const sites = await ctx.sites.list();
    return {
      version: require("../../package.json").version,
      startedAt: ctx.startedAt || null,
      scheduler: scheduler ? scheduler.status() : { running: false, scanning: false, nextScanAt: null },
      daemon: maskDaemon(daemon),
      policy,
      lastScan: state.lastScan || null,
      lastScanAt: state.lastScanAt || null,
      lastGuardAt: state.lastGuardAt || null,
      nextScanAt: state.nextScanAt || null,
      downloaderCount: downloaders.length,
      siteCount: sites.length,
      home: ctx.paths.root
    };
  });

  route("GET", /^\/api\/resources$/, async () => {
    const state = await ctx.state.read();
    return { evaluated: state.lastEvaluated || [], scannedAt: state.lastScanAt || null };
  });

  route("GET", /^\/api\/tasks$/, async () => {
    const { client, downloader } = await connect(ctx);
    const tasks = await client.listTorrents("all");
    const index = ctx.engines.links.createIndex(await ctx.links.list());
    return {
      downloader: downloader.name,
      slots: ctx.engines.qb.summarizeDownloadSlots(tasks),
      tasks: tasks.map((task) => ({
        hash: task.hash,
        name: task.name,
        size: task.size,
        progress: task.progress,
        state: task.state,
        dlspeed: task.dlspeed,
        tags: task.tags,
        category: task.category,
        deadline: ctx.engines.qb.deadlineFromTags(task.tags),
        resource: index.forHash(task.hash)
      }))
    };
  });

  route("GET", /^\/api\/logs$/, async (_body, _params, url) => {
    return ctx.logger.readLogs({
      limit: Number(url.searchParams.get("limit") || 200),
      level: url.searchParams.get("level") || null,
      prefix: url.searchParams.get("prefix") || null
    });
  });

  route("DELETE", /^\/api\/logs$/, async () => {
    await ctx.logger.clearLogs();
    return { cleared: true };
  });

  route("GET", /^\/api\/audit$/, async (_body, _params, url) => {
    return ctx.logger.readAudit({ limit: Number(url.searchParams.get("limit") || 200) });
  });

  // ---------- 配置 ----------
  route("GET", /^\/api\/settings$/, async () => ({
    policy: await ctx.config.readPolicy(),
    daemon: maskDaemon(await ctx.config.readDaemon()),
    downloaders: (await ctx.downloaders.list()).map(maskDownloader),
    sites: (await ctx.sites.list()).map(maskSite),
    downloaderTypes: ctx.engines.downloaderTypes.list(),
    siteTypes: Object.values(ctx.engines.siteStore.SITE_TYPES)
  }));

  route("PUT", /^\/api\/settings\/policy$/, async (body) => ctx.config.savePolicy(body));

  route("PUT", /^\/api\/settings\/daemon$/, async (body) => {
    // 令牌留空表示"不修改"，否则每次在页面上保存调度设置都会把它清掉。
    const current = await ctx.config.readDaemon();
    const next = await ctx.config.saveDaemon({ ...body, webToken: body.webToken || current.webToken });
    ctx.logger.info("webui:daemon-settings-saved", {
      scanRange: `${next.scanIntervalMinMinutes}-${next.scanIntervalMaxMinutes} 分钟`,
      autoDownload: next.autoDownload
    });
    return maskDaemon(next);
  });

  route("POST", /^\/api\/downloaders$/, async (body) => {
    const existing = (await ctx.downloaders.list()).find((item) => item.id === body.id);
    // 前端拿不到密码，提交时留空就意味着"不改"，不能当成清空。
    const password = body.password || existing?.password || "";
    const errors = ctx.engines.downloaderStore.validate(
      ctx.engines.downloaderStore.normalize({ ...body, password })
    );
    if (errors.length) throw publicHttpError(400, errors.join("；"));
    return maskDownloader(await ctx.downloaders.upsert({ ...body, password }));
  });

  route("DELETE", /^\/api\/downloaders\/([^/]+)$/, async (_body, params) => {
    await ctx.downloaders.remove(decodeURIComponent(params[0]));
    return { removed: true };
  });

  route("POST", /^\/api\/downloaders\/([^/]+)\/move$/, async (body, params) => {
    const next = await ctx.downloaders.move(decodeURIComponent(params[0]), Number(body.offset || 0));
    return next.map(maskDownloader);
  });

  route("POST", /^\/api\/downloaders\/([^/]+)\/test$/, async (_body, params) => {
    const id = decodeURIComponent(params[0]);
    const downloader = (await ctx.downloaders.list()).find((item) => item.id === id);
    if (!downloader) throw publicHttpError(404, "下载器不存在");
    const client = ctx.engines.downloaderTypes.createAdapter(downloader, {
      onLog: (event, data) => ctx.logger.debug(event, data)
    });
    return client.diagnose();
  });

  route("POST", /^\/api\/sites$/, async (body) => {
    const existing = (await ctx.sites.list()).find((item) => item.id === body.id);
    const apiKey = body.apiKey || existing?.apiKey || "";
    const errors = ctx.engines.siteStore.validate(ctx.engines.siteStore.normalize({ ...body, apiKey }));
    if (errors.length) throw publicHttpError(400, errors.join("；"));
    return maskSite(await ctx.sites.upsert({ ...body, apiKey }));
  });

  route("DELETE", /^\/api\/sites\/([^/]+)$/, async (_body, params) => {
    await ctx.sites.remove(decodeURIComponent(params[0]));
    return { removed: true };
  });

  // ---------- 动作 ----------
  route("POST", /^\/api\/scan$/, async (body) => {
    const options = { dryRun: Boolean(body.dryRun), force: Boolean(body.force) };
    const result = scheduler ? await scheduler.triggerScan(options) : await runScan(ctx, options);
    return result.summary;
  });

  route("POST", /^\/api\/push$/, async (body) => pushSelected(ctx, body.torrentIds || [], {
    manualOverride: Boolean(body.manualOverride)
  }));

  route("POST", /^\/api\/guard\/run$/, async (body) => runGuard(ctx, { dryRun: Boolean(body.dryRun) }));

  route("POST", /^\/api\/backfill$/, async () => backfillDeadlines(ctx));

  route("GET", /^\/api\/exclusions$/, async () => ({ exclusions: await ctx.exclusions.list() }));

  route("POST", /^\/api\/exclusions$/, async (body) => ctx.exclusions.exclude(body));

  route("DELETE", /^\/api\/exclusions\/([^/]+)$/, async (_body, params) => {
    await ctx.exclusions.restore(decodeURIComponent(params[0]));
    return { restored: true };
  });

  const serveStatic = async (url, response) => {
    const requested = url.pathname === "/" ? "/index.html" : url.pathname;
    // 归一化后必须仍落在 public 目录内，挡掉 ../ 穿越。
    const full = path.join(PUBLIC_DIR, path.normalize(requested).replace(/^(\.\.[/\\])+/, ""));
    if (!full.startsWith(PUBLIC_DIR)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const content = await fsp.readFile(full);
      response.writeHead(200, {
        "Content-Type": MIME[path.extname(full)] || "application/octet-stream",
        "Cache-Control": "no-store",
        "Content-Security-Policy": "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY"
      });
      response.end(content);
    } catch (_) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
    }
  };

  const server = http.createServer(async (request, response) => {
    let url = new URL("/", "http://localhost");
    const sendJson = (status, payload) => {
      response.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "X-Content-Type-Options": "nosniff"
      });
      response.end(JSON.stringify(payload));
    };

    try {
      url = new URL(request.url, "http://localhost");
      if (!ctx.webToken && !isTrustedLoopbackRequest(request)) {
        sendJson(403, { error: "无令牌模式只允许通过本机回环地址访问。" });
        return;
      }

      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(url, response);
        return;
      }

      if (ctx.webToken) {
        const header = String(request.headers.authorization || "");
        const supplied = header.replace(/^Bearer\s+/i, "");
        // 定长比较，避免用普通字符串比较泄漏前缀信息。
        const ok = supplied.length === ctx.webToken.length &&
          crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(ctx.webToken));
        if (!ok) {
          sendJson(401, { error: "访问令牌无效，请在页面提示中重新输入。" });
          return;
        }
      }

      const matched = routes
        .map((item) => ({ item, params: item.method === request.method ? url.pathname.match(item.pattern) : null }))
        .find((entry) => entry.params);
      if (!matched) {
        sendJson(404, { error: `未知接口 ${request.method} ${url.pathname}` });
        return;
      }

      const body = ["POST", "PUT", "PATCH"].includes(request.method) ? await readBody(request) : {};
      const result = await matched.item.handler(body, matched.params.slice(1), url);
      sendJson(200, result === undefined ? { ok: true } : result);
    } catch (error) {
      const publicMessage = typeof error?.publicMessage === "string" ? error.publicMessage : "";
      const status = publicMessage ? Number(error?.status) || 400 : 500;
      const message = String(error?.message || error);
      // WebUI 上的每个失败都要进日志：只回给浏览器等于没人看得见。
      ctx.logger.error("webui:error", {
        method: request.method,
        path: url.pathname,
        status,
        error: message
      });
      // 只有代码主动放进 publicMessage 白名单的提示才能返回。
      // 其它异常可能带第三方响应、绝对路径或栈详情，只进已脱敏日志。
      sendJson(status, {
        error: publicMessage || "服务器内部错误，详情已写入运行日志。"
      });
    }
  });

  const listen = ({ host, port }) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve({ host, port, url: `http://${host}:${port}/` });
    });
  });

  return { server, listen, close: () => new Promise((resolve) => server.close(resolve)) };
};

module.exports = {
  createServer,
  isLoopback,
  isTrustedLoopbackRequest,
  maskDownloader,
  maskSite,
  maskDaemon,
  publicHttpError
};
