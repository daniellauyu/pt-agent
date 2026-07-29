"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { DEFAULT_DAEMON, nextIntervalMs, normalizeDaemon, normalizePolicy } = require("../src/config");

test("随机间隔始终落在配置区间内", () => {
  const daemon = { scanIntervalMinMinutes: 40, scanIntervalMaxMinutes: 90 };
  for (const random of [() => 0, () => 0.5, () => 0.999999]) {
    const minutes = nextIntervalMs(daemon, random) / 60000;
    assert.ok(minutes >= 40 && minutes <= 90, `${minutes} 超出 40–90`);
  }
  assert.equal(nextIntervalMs(daemon, () => 0) / 60000, 40);
  assert.equal(Math.round(nextIntervalMs(daemon, () => 1) / 60000), 90);
});

test("最短和最长填反了会自动纠正，而不是排出一个负间隔", () => {
  const daemon = normalizeDaemon({ scanIntervalMinMinutes: 120, scanIntervalMaxMinutes: 30 });
  assert.equal(daemon.scanIntervalMinMinutes, 30);
  assert.equal(daemon.scanIntervalMaxMinutes, 120);
  assert.ok(nextIntervalMs(daemon, () => 0.5) > 0);
});

test("两端相等时退化成固定周期", () => {
  const minutes = nextIntervalMs({ scanIntervalMinMinutes: 60, scanIntervalMaxMinutes: 60 }, Math.random) / 60000;
  assert.equal(minutes, 60);
});

test("非法数值回落到默认值，不会把调度器搞成 0 秒空转", () => {
  const daemon = normalizeDaemon({
    scanIntervalMinMinutes: "abc",
    guardIntervalSeconds: -5,
    maxPushPerScan: "x",
    webPort: 999999
  });
  assert.equal(daemon.scanIntervalMinMinutes, DEFAULT_DAEMON.scanIntervalMinMinutes);
  assert.equal(daemon.guardIntervalSeconds, 15, "低于下限时收敛到下限而不是 0");
  assert.equal(daemon.maxPushPerScan, DEFAULT_DAEMON.maxPushPerScan);
  assert.equal(daemon.webPort, 65535);
});

test("守护进程默认开启到期自动删除——这正是无人值守要解决的问题", () => {
  assert.equal(normalizePolicy({}).autoDeleteExpired, true);
  assert.equal(normalizePolicy({}).guardExecutor, "daemon");
});

test("策略字段沿用插件的同名默认值，两边配置可以互抄", () => {
  const policy = normalizePolicy({});
  assert.equal(policy.minimumScore, 80);
  assert.equal(policy.minFreeHoursForAutoDownload, 12);
  assert.equal(policy.maxTorrentSizeGB, 50);
  assert.equal(policy.rejectHr, true);
});

test("guardExecutor 不可被覆盖：终端版的保护只能由终端版执行", () => {
  assert.equal(normalizePolicy({ guardExecutor: "extension" }).guardExecutor, "daemon");
});
