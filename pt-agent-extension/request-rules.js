// qBittorrent 的 CSRF 保护会比较请求的 Origin/Referer 与自身 Host，不一致就返回 403。
// 插件的 Origin 是 chrome-extension://<id>，必然不一致，于是浏览器能登录、插件却 403。
// qB 的判定是「Origin 和 Referer 都为空 => 不是跨站请求 => 放行」，所以剥掉这两个头即可，
// 用户不必关闭 qB 的 CSRF 保护。
//
// 实现参考 PT-depiler 的 replaceUnsafeHeader / webRequest：
//   1. 用 session rules 而不是 dynamic rules —— 不写盘，浏览器重启即失效，不会留下陈旧规则
//   2. 每次请求现建一条带唯一 id 的规则，请求结束立刻删掉，把生效窗口压到最小
//   3. 用 excludedTabIds 排除所有网页标签页
//
// 第 3 点是安全关键：DNR 规则按「请求目标 URL」匹配，若不排除标签页，
// 任意网页向同一个 qB 地址发起的跨站 XHR 也会被剥掉 Origin，
// 等于替所有网站关掉了 qB 的 CSRF 保护。必须只对插件自己发出的请求生效。
globalThis.PT_AGENT_REQUEST_RULES = (() => {
  "use strict";

  const RULE_ID_MIN = 900000;
  const RULE_ID_MAX = 999999;

  const newRuleId = () => RULE_ID_MIN + Math.floor(Math.random() * (RULE_ID_MAX - RULE_ID_MIN));

  const buildRule = ({ id, url, method = "GET", excludedTabIds = [] }) => {
    const condition = {
      urlFilter: String(url),
      resourceTypes: ["xmlhttprequest"],
      requestMethods: [String(method || "GET").toLowerCase()]
    };
    if (excludedTabIds.length) condition.excludedTabIds = excludedTabIds;
    return {
      id,
      priority: 1,
      action: {
        type: "modifyHeaders",
        requestHeaders: [
          { header: "origin", operation: "remove" },
          { header: "referer", operation: "remove" }
        ]
      },
      condition
    };
  };

  const createManager = ({
    dnr = globalThis.chrome?.declarativeNetRequest,
    tabs = globalThis.chrome?.tabs,
    onLog = () => {}
  } = {}) => {
    // 排除除自己以外的全部标签页。插件从 Service Worker 发请求时 tabId 为 -1，不会被排除；
    // 工作台以标签页打开时要把自己排除在外，否则规则反而对自己不生效。
    const excludedTabIds = async (ownTabId) => {
      if (!tabs?.query) return [];
      try {
        const all = await tabs.query({});
        return all
          .map((tab) => tab.id)
          .filter((id) => Number.isInteger(id) && id >= 0 && id !== ownTabId);
      } catch (_) {
        return [];
      }
    };

    const currentTabId = async () => {
      if (!tabs?.getCurrent) return undefined;
      try {
        return (await tabs.getCurrent())?.id;
      } catch (_) {
        return undefined;
      }
    };

    // 把 fetch 包一层：请求前装规则，请求结束（无论成败）立刻卸掉。
    const wrapFetch = (fetchImpl) => async (url, options = {}) => {
      if (!dnr?.updateSessionRules) return fetchImpl(url, options);
      const id = newRuleId();
      const method = options.method || "GET";
      let installed = false;
      try {
        const rule = buildRule({
          id,
          url,
          method,
          excludedTabIds: await excludedTabIds(await currentTabId())
        });
        await dnr.updateSessionRules({ removeRuleIds: [id], addRules: [rule] });
        installed = true;
        onLog("dnr:rule-applied", { id, method, urlFilter: rule.condition.urlFilter });
      } catch (error) {
        // 装不上规则不代表请求一定失败，继续发出去，让上层拿到真实的 HTTP 结果。
        onLog("dnr:rule-error", { id, error: String(error?.message || error) });
      }
      try {
        return await fetchImpl(url, options);
      } finally {
        if (installed) {
          try {
            await dnr.updateSessionRules({ removeRuleIds: [id] });
          } catch (_) {}
        }
      }
    };

    return { wrapFetch, buildRule, excludedTabIds };
  };

  return { RULE_ID_MIN, RULE_ID_MAX, buildRule, createManager, newRuleId };
})();
