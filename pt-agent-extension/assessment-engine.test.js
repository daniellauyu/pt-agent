const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const loadEngine = () => {
  const source = fs.readFileSync(path.join(__dirname, "assessment-engine.js"), "utf8");
  const context = vm.createContext({});
  vm.runInContext(source, context);
  return context.PT_AGENT_ASSESSMENT;
};

test("calculates the rate and scale needed to reach 6000 within a 30-day estimate", () => {
  const engine = loadEngine();
  const result = engine.calculate({
    bonus: 836.7,
    bonusPerHour: 2.223,
    createdDate: "2026-07-17T00:00:00+08:00",
    uploadedBytes: 10 * 1024 ** 3,
    downloadedBytes: 5 * 1024 ** 3,
    seedingCount: 3,
    seedingSizeBytes: 150 * 1024 ** 3,
    target: 6000,
    assessmentDays: 30,
    nowMs: Date.parse("2026-07-24T00:00:00+08:00")
  });

  assert.ok(Math.abs(result.remaining - 5163.3) < 0.001);
  assert.equal(result.hoursLeft, 23 * 24);
  assert.ok(Math.abs(result.requiredRate - 5163.3 / (23 * 24)) < 0.001);
  assert.ok(Math.abs(result.etaHours - 5163.3 / 2.223) < 0.001);
  assert.ok(Math.abs(result.rateMultiplier - result.requiredRate / 2.223) < 0.001);
  assert.equal(result.remainingUploadedBytes, 20 * 1024 ** 3);
  assert.equal(result.remainingDownloadedBytes, 10 * 1024 ** 3);
  assert.equal(result.recommendedPlan.bufferDays, 5);
  assert.ok(result.recommendedPlan.targetRate > result.requiredRate);
  assert.ok(result.recommendedPlan.estimatedAdditionalSeedBytesHigh >
    result.recommendedPlan.estimatedAdditionalSeedBytesLow);
  assert.equal(result.achieved, false);
});

test("marks the assessment achieved without requiring more hourly output", () => {
  const engine = loadEngine();
  const result = engine.calculate({
    bonus: 6200,
    bonusPerHour: 0,
    uploadedBytes: 30 * 1024 ** 3,
    downloadedBytes: 15 * 1024 ** 3,
    createdDate: "2026-07-17T00:00:00+08:00",
    nowMs: Date.parse("2026-07-24T00:00:00+08:00")
  });

  assert.equal(result.remaining, 0);
  assert.equal(result.progress, 100);
  assert.equal(result.requiredRate, 0);
  assert.equal(result.etaHours, 0);
  assert.equal(result.achieved, true);
  assert.equal(result.status, "achieved");
});
