import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeSlackMinutes,
  deriveDurationMinutesFromEnd,
  deriveEndAtFromDuration,
  evaluateDependencyStatus,
} from "../src/db-worker/scheduleMath.js";

describe("schedule math", () => {
  it("derives end_at from start + duration", () => {
    const start = 1_000_000;
    const duration = 90;
    const end = deriveEndAtFromDuration(start, duration);
    assert.equal(end, start + duration * 60000);
  });

  it("derives duration from start + end", () => {
    const start = 1_000_000;
    const end = start + 2 * 60000;
    const minutes = deriveDurationMinutesFromEnd(start, end);
    assert.equal(minutes, 2);
  });

  it("computes slack from due_at and planned_end", () => {
    const dueAt = 1_000_000 + 3 * 60000;
    const plannedEnd = 1_000_000 + 2 * 60000;
    assert.equal(computeSlackMinutes(dueAt, plannedEnd), 1);
  });

  it("FS dependency satisfied when successor starts after predecessor ends + lag", () => {
    const status = evaluateDependencyStatus({
      predecessorStart: 0,
      predecessorEnd: 60 * 60000,
      successorStart: 90 * 60000,
      successorEnd: 120 * 60000,
      type: "FS",
      lagMinutes: 15,
    });
    assert.equal(status, "satisfied");
  });

  it("SS dependency violated when successor starts before predecessor + lag", () => {
    const status = evaluateDependencyStatus({
      predecessorStart: 30 * 60000,
      predecessorEnd: 60 * 60000,
      successorStart: 20 * 60000,
      successorEnd: 50 * 60000,
      type: "SS",
      lagMinutes: 5,
    });
    assert.equal(status, "violated");
  });

  it("returns unknown when times are missing", () => {
    const status = evaluateDependencyStatus({
      predecessorStart: null,
      predecessorEnd: null,
      successorStart: 10,
      successorEnd: 20,
      type: "FF",
      lagMinutes: 0,
    });
    assert.equal(status, "unknown");
  });
});
