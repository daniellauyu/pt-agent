// 下载器地址是用户可改的，不可能预先写死在 manifest 的 host_permissions 里。
// 这里统一处理「按地址申请 / 校验可选主机权限」，避免改了地址之后 fetch 被静默拦截。
globalThis.PT_AGENT_HOST_PERMISSIONS = (() => {
  "use strict";

  const originPattern = (address) => {
    try {
      const url = new URL(String(address || ""));
      if (!/^https?:$/.test(url.protocol)) return "";
      return `${url.origin}/*`;
    } catch (_) {
      return "";
    }
  };

  const originPatterns = (addresses) => {
    return Array.from(new Set(
      (addresses || []).map(originPattern).filter(Boolean)
    ));
  };

  const createManager = (permissionsApi = globalThis.chrome?.permissions) => {
    const requireApi = () => {
      if (!permissionsApi) throw new Error("当前环境不支持 chrome.permissions");
      return permissionsApi;
    };

    const has = async (address) => {
      const origins = originPatterns([address]);
      if (!origins.length) return false;
      try {
        return await requireApi().contains({ origins });
      } catch (_) {
        return false;
      }
    };

    // 必须由用户手势触发（保存 / 测试连接按钮），Service Worker 里只能用 has()。
    const request = async (address) => {
      const origins = originPatterns([address]);
      if (!origins.length) throw new Error("下载器地址无效，无法申请访问权限");
      return requireApi().request({ origins });
    };

    const ensure = async (address) => {
      if (await has(address)) return { granted: true, requested: false };
      const granted = await request(address);
      return { granted: Boolean(granted), requested: true };
    };

    const missing = async (addresses) => {
      const results = await Promise.all(
        originPatterns(addresses).map(async (origin) => ({
          origin,
          ok: await has(origin.replace(/\/\*$/, "/"))
        }))
      );
      return results.filter((item) => !item.ok).map((item) => item.origin);
    };

    return { has, request, ensure, missing };
  };

  return { originPattern, originPatterns, createManager };
})();
