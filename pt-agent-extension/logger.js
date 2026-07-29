globalThis.PT_AGENT_LOGGER = (() => {
  "use strict";

  const LOG_KEY = "ptAgentDebugLog";
  const AUDIT_KEY = "ptAgentAuditLog";
  const LOG_CAP = 2000;
  const AUDIT_CAP = 2000;
  const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_LOG_BYTES = 5 * 1024 * 1024;
  const SENSITIVE_KEY = /(authorization|cookie|password|passwd|secret|token|api[-_]?key|passkey|download[-_]?url)/i;
  let ownerWrite = null;

  const id = (prefix) => {
    if (globalThis.crypto?.randomUUID) return `${prefix}_${globalThis.crypto.randomUUID().replaceAll("-", "")}`;
    return `${prefix}_${Date.now().toString(36)}${Math.random().toString(16).slice(2)}`;
  };

  const redactUrl = (value) => {
    try {
      const parsed = new URL(value);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.toString();
    } catch (_) {
      return "[REDACTED_URL]";
    }
  };

  const redactString = (value) => String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      /\b(token|api[-_]?key|passkey|password|secret)\b(["']?\s*[:=]\s*["']?)[^&,\s"'}]+/gi,
      "$1$2[REDACTED]"
    )
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url));

  const redact = (value, key = "", seen = new WeakSet()) => {
    if (key && SENSITIVE_KEY.test(key)) return "[REDACTED]";
    if (typeof value === "string") return redactString(value);
    if (value === null || value === undefined || typeof value !== "object") return value;
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
    if (Array.isArray(value)) return value.map((item) => redact(item, "", seen));
    const result = {};
    for (const [itemKey, item] of Object.entries(value)) {
      result[itemKey] = redact(item, itemKey, seen);
    }
    return result;
  };

  const inferLevel = (event) => {
    const value = String(event);
    if (/error|failed|suspect|enqueue-error/i.test(value)) return "error";
    if (/verify|refresh-failed|warn|rejected/i.test(value)) return "warn";
    return "info";
  };

  const createEntry = ({
    level = "info",
    event,
    message = "",
    data = null,
    service = "extension",
    component,
    operationId = null,
    requestId = null
  }) => {
    const timestamp = new Date().toISOString();
    const safeEvent = String(event || "runtime.event");
    return redact({
      id: id("log"),
      timestamp,
      ts: timestamp,
      level,
      service,
      component: component || safeEvent.split(/[:.]/)[0] || "extension",
      event: safeEvent,
      tag: safeEvent,
      message: message || "",
      request_id: requestId,
      operation_id: operationId,
      outcome: /error|failed|rejected/i.test(safeEvent) ? "failed" : undefined,
      data: data === undefined ? null : data,
      schema_version: 1
    });
  };

  const normalizeEntry = (entry) => {
    if (!entry || typeof entry !== "object") return null;
    const event = entry.event || entry.tag || "legacy.event";
    return redact({
      ...entry,
      id: entry.id || id("legacy"),
      timestamp: entry.timestamp || entry.ts || new Date().toISOString(),
      ts: entry.ts || entry.timestamp || new Date().toISOString(),
      level: entry.level || inferLevel(event),
      service: entry.service || "extension",
      component: entry.component || String(event).split(/[:.]/)[0],
      event,
      tag: entry.tag || event,
      schema_version: entry.schema_version || 1
    });
  };

  const trimLogs = (entries) => {
    const cutoff = Date.now() - LOG_TTL_MS;
    const kept = [];
    let bytes = 2;
    for (const raw of entries) {
      const entry = normalizeEntry(raw);
      if (!entry) continue;
      const timestamp = new Date(entry.timestamp).getTime();
      if (Number.isFinite(timestamp) && timestamp < cutoff) continue;
      const size = JSON.stringify(entry).length + 1;
      if (kept.length >= LOG_CAP || bytes + size > MAX_LOG_BYTES) break;
      kept.push(entry);
      bytes += size;
    }
    return kept;
  };

  const storageGet = async (key) => {
    const stored = await chrome.storage.local.get(key);
    return Array.isArray(stored?.[key]) ? stored[key] : [];
  };

  const storageSet = (key, value) => chrome.storage.local.set({ [key]: value });

  const persistLog = async (entry) => {
    const entries = await storageGet(LOG_KEY);
    const next = trimLogs([normalizeEntry(entry), ...entries]);
    await storageSet(LOG_KEY, next);
    return next;
  };

  const createAuditEvent = (event) => redact({
    ...event,
    id: event.id || id("audit"),
    timestamp: event.timestamp || new Date().toISOString(),
    actor: event.actor || "extension",
    source: event.source || "chrome-extension",
    action: event.action || "unknown",
    status: event.status || "unknown",
    reason: event.reason || null,
    operation_id: event.operation_id || event.operationId || null,
    schema_version: event.schema_version || 1
  });

  const persistAudit = async (event) => {
    const entries = await storageGet(AUDIT_KEY);
    const next = [createAuditEvent(event), ...entries.map(createAuditEvent)].slice(0, AUDIT_CAP);
    await storageSet(AUDIT_KEY, next);
    return next;
  };

  // 存储操作的唯一实现，background 的串行队列和本地兜底都复用它。
  const handleStorageOp = async (type, payload = {}) => {
    if (type === "pt-agent:log:append") return { ok: true, items: await persistLog(payload.entry) };
    if (type === "pt-agent:log:list") return { ok: true, items: trimLogs(await storageGet(LOG_KEY)) };
    if (type === "pt-agent:log:clear") {
      await storageSet(LOG_KEY, []);
      return { ok: true };
    }
    if (type === "pt-agent:audit:append") return { ok: true, items: await persistAudit(payload.event) };
    if (type === "pt-agent:audit:list") {
      return { ok: true, items: (await storageGet(AUDIT_KEY)).map(createAuditEvent) };
    }
    return null;
  };

  const dispatch = async (type, payload = {}) => {
    if (ownerWrite) return ownerWrite(type, payload);
    try {
      const response = await chrome.runtime.sendMessage({ type, ...payload });
      if (response) return response;
    } catch (_) {}
    // Service Worker 休眠或重启时 sendMessage 会失败。此前直接返回 null，
    // 日志就这么静默丢了；改为自己落本地，保证错误记录不会消失。
    try {
      return await handleStorageOp(type, payload);
    } catch (_) {
      return null;
    }
  };

  // Chrome 的扩展「错误」页只把第二个参数 stringify 成 [object Object]，
  // 详情必须拼进消息字符串里，否则截图过来完全看不出原因。
  const consoleSummary = (data) => {
    if (data === null || data === undefined) return "";
    try {
      const text = typeof data === "string" ? data : JSON.stringify(data);
      if (!text || text === "{}") return "";
      return text.length > 500 ? `${text.slice(0, 500)}…` : text;
    } catch (_) {
      return "[unserializable]";
    }
  };

  const write = (entry) => {
    const normalized = normalizeEntry(entry);
    try {
      const method = normalized.level === "error" ? "error" : normalized.level === "warn" ? "warn" : "log";
      const summary = consoleSummary(normalized.data);
      console[method](`[PT] ${normalized.event}${summary ? ` ${summary}` : ""}`);
    } catch (_) {}
    void dispatch("pt-agent:log:append", { entry: normalized });
    return normalized;
  };

  const legacy = (event, data, context = {}) => write(createEntry({
    level: inferLevel(event),
    event,
    data,
    operationId: context.operationId,
    requestId: context.requestId
  }));

  const list = async () => {
    const response = await dispatch("pt-agent:log:list");
    if (Array.isArray(response?.items)) return response.items.map(normalizeEntry).filter(Boolean);
    try {
      return trimLogs(await storageGet(LOG_KEY));
    } catch (_) {
      return [];
    }
  };

  const clear = async () => {
    const response = await dispatch("pt-agent:log:clear");
    if (response?.ok) return;
    try { await storageSet(LOG_KEY, []); } catch (_) {}
  };

  const appendAudit = async (event) => {
    const response = await dispatch("pt-agent:audit:append", {
      event: createAuditEvent(event)
    });
    return response?.items || [];
  };

  const listAudit = async () => {
    const response = await dispatch("pt-agent:audit:list");
    if (Array.isArray(response?.items)) return response.items.map(createAuditEvent);
    try {
      return (await storageGet(AUDIT_KEY)).map(createAuditEvent);
    } catch (_) {
      return [];
    }
  };

  const installStorageOwner = () => {
    let queue = Promise.resolve();
    ownerWrite = (type, payload) => {
      queue = queue.then(() => handleStorageOp(type, payload));
      return queue;
    };
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!String(message?.type || "").startsWith("pt-agent:")) return false;
      ownerWrite(message.type, message)
        .then(sendResponse)
        .catch((error) => sendResponse({ ok: false, error: redactString(error?.message || error) }));
      return true;
    });
  };

  // 未捕获异常和未处理的 Promise 拒绝此前只出现在 Chrome 的扩展「错误」页，
  // 从来没进过插件日志——排查时看到的和记录下来的是两批东西。
  let errorCaptureInstalled = false;
  const installErrorCapture = (scope = globalThis, sink = null) => {
    if (errorCaptureInstalled || !scope?.addEventListener) return false;
    errorCaptureInstalled = true;
    // 记录日志本身若再抛错会形成环，这里用标志位挡住重入。
    let inside = false;
    const record = (event, data) => {
      if (inside) return;
      inside = true;
      try {
        if (sink) sink(event, data);
        else write(createEntry({ level: "error", event, data }));
      } catch (_) {
      } finally {
        inside = false;
      }
    };
    const shortStack = (stack) => String(stack || "").split("\n").slice(0, 6).join("\n");

    scope.addEventListener("error", (event) => {
      record("runtime.uncaught-error", {
        message: String(event?.message || event?.error?.message || "未捕获异常"),
        source: event?.filename ? `${event.filename}:${event.lineno}:${event.colno}` : undefined,
        stack: shortStack(event?.error?.stack)
      });
    });
    scope.addEventListener("unhandledrejection", (event) => {
      const reason = event?.reason;
      record("runtime.unhandled-rejection", {
        message: String(reason?.message || reason || "未处理的 Promise 拒绝"),
        stack: shortStack(reason?.stack)
      });
    });
    return true;
  };

  // 兜底网：任何绕过 logger 直接 console.error/warn 的代码（包括将来引入的第三方）
  // 也会进日志。带 [PT] 前缀的是 logger 自己打的，跳过以免递归。
  let consoleCaptureInstalled = false;
  const installConsoleCapture = (scope = globalThis, sink = null) => {
    const target = scope?.console;
    if (consoleCaptureInstalled || !target) return false;
    consoleCaptureInstalled = true;
    let inside = false;
    for (const level of ["error", "warn"]) {
      const original = typeof target[level] === "function" ? target[level].bind(target) : null;
      if (!original) continue;
      target[level] = (...args) => {
        original(...args);
        if (inside) return;
        const text = args
          .map((arg) => {
            if (typeof arg === "string") return arg;
            try { return JSON.stringify(arg); } catch (_) { return String(arg); }
          })
          .join(" ")
          .trim();
        if (!text || text.startsWith("[PT] ")) return;
        inside = true;
        try {
          const event = level === "error" ? "runtime.console-error" : "runtime.console-warn";
          const data = { message: text.slice(0, 500) };
          if (sink) sink(event, data);
          else write(createEntry({ level, event, data }));
        } catch (_) {
        } finally {
          inside = false;
        }
      };
    }
    return true;
  };

  return {
    LOG_KEY,
    AUDIT_KEY,
    installConsoleCapture,
    installErrorCapture,
    redact,
    redactUrl,
    createEntry,
    createAuditEvent,
    newOperationId: () => id("op"),
    inferLevel,
    legacy,
    write,
    list,
    clear,
    appendAudit,
    listAudit,
    installStorageOwner
  };
})();
