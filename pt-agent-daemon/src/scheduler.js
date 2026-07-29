"use strict";

const { runScan } = require("./runner");
const { runGuard } = require("./guard");
const { nextIntervalMs } = require("./config");

/**
 * 调度器：随机间隔跑扫描，固定间隔跑 Free 保护。
 *
 * 用 setTimeout 逐轮重排而不是 setInterval，因为间隔每轮都要重新抽随机数；
 * 顺带也避免了上一轮还没跑完就被下一轮叠上来。
 */
const createScheduler = (ctx) => {
  const { logger } = ctx;
  let scanTimer = null;
  let guardTimer = null;
  let running = false;
  let stopped = false;
  let scanning = false;
  let nextScanAt = null;

  const scheduleNextScan = async (reason) => {
    if (stopped) return;
    const daemon = await ctx.config.readDaemon();
    const delayMs = nextIntervalMs(daemon);
    nextScanAt = new Date(Date.now() + delayMs).toISOString();
    await ctx.state.merge({ nextScanAt, scanIntervalMinutes: Math.round(delayMs / 60000) });
    logger.info("scheduler:next-scan", {
      reason,
      inMinutes: Math.round(delayMs / 60000),
      at: nextScanAt,
      range: `${daemon.scanIntervalMinMinutes}-${daemon.scanIntervalMaxMinutes} 分钟`
    });
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => { void cycle(); }, delayMs);
    if (scanTimer.unref) scanTimer.unref();
  };

  const cycle = async () => {
    if (stopped) return;
    // 一轮扫描可能跑几分钟（回查 + 逐个入队），期间绝不能再起一轮。
    if (scanning) {
      logger.warn("scheduler:scan-overlap", { hint: "上一轮扫描还没结束，跳过本次触发" });
      return;
    }
    scanning = true;
    try {
      await runScan(ctx);
    } catch (error) {
      logger.error("scheduler:scan-error", { error: String(error?.message || error) });
    } finally {
      scanning = false;
      await scheduleNextScan("完成上一轮").catch((error) => {
        logger.error("scheduler:reschedule-error", { error: String(error?.message || error) });
      });
    }
  };

  const guardTick = async () => {
    if (stopped) return;
    try {
      await runGuard(ctx);
    } catch (error) {
      // runGuard 内部已经记过日志并按需退避，这里不再重复刷屏。
      logger.debug("scheduler:guard-error", { error: String(error?.message || error) });
    }
  };

  const start = async () => {
    if (running) return;
    running = true;
    stopped = false;
    const daemon = await ctx.config.readDaemon();
    logger.info("scheduler:start", {
      scanRange: `${daemon.scanIntervalMinMinutes}-${daemon.scanIntervalMaxMinutes} 分钟`,
      autoDownload: daemon.autoDownload,
      maxPushPerScan: daemon.maxPushPerScan,
      guardIntervalSeconds: daemon.guardIntervalSeconds
    });

    guardTimer = setInterval(() => { void guardTick(); }, daemon.guardIntervalSeconds * 1000);
    if (guardTimer.unref) guardTimer.unref();
    void guardTick();

    if (daemon.scanOnStart) {
      void cycle();
    } else {
      await scheduleNextScan("启动");
    }
  };

  const stop = () => {
    stopped = true;
    running = false;
    if (scanTimer) clearTimeout(scanTimer);
    if (guardTimer) clearInterval(guardTimer);
    scanTimer = null;
    guardTimer = null;
    logger.info("scheduler:stop", {});
  };

  /** WebUI / CLI 的「立即扫描」：不打乱既定节奏，跑完照常重排下一轮。 */
  const triggerScan = async (options = {}) => {
    if (scanning) throw new Error("已有扫描正在进行，请稍后再试");
    scanning = true;
    try {
      return await runScan(ctx, options);
    } finally {
      scanning = false;
      if (running) await scheduleNextScan("手动触发后重排").catch(() => {});
    }
  };

  const status = () => ({ running, scanning, nextScanAt });

  return { start, stop, triggerScan, status, guardTick };
};

module.exports = { createScheduler };
