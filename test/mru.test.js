import test from "node:test";
import assert from "node:assert/strict";
import {
  advanceCycle,
  commitCycle,
  createCycle,
  moveToFront,
  reconcileOrder,
} from "../mru.js";

test("moveToFront removes duplicate tab ids", () => {
  assert.deepEqual(moveToFront([1, 2, 3, 2], 2), [2, 1, 3]);
});

test("reconcileOrder removes closed tabs and adds new tabs", () => {
  assert.deepEqual(reconcileOrder([3, 1, 99], [1, 2, 3], 1), [3, 1, 2]);
});

test("forward cycle starts with the most recent candidate and wraps", () => {
  const cycle = createCycle([1, 2, 3], 1, 10);
  const first = advanceCycle(cycle, "forward", 20);
  const second = advanceCycle(first.cycle, "forward", 30);
  const third = advanceCycle(second.cycle, "forward", 40);

  assert.equal(first.targetId, 2);
  assert.equal(second.targetId, 3);
  assert.equal(third.targetId, 1);
});

test("reverse cycle starts at the oldest candidate and wraps", () => {
  const cycle = createCycle([1, 2, 3], 1, 10);
  const first = advanceCycle(cycle, "reverse", 20);
  const second = advanceCycle(first.cycle, "reverse", 30);

  assert.equal(first.targetId, 3);
  assert.equal(second.targetId, 2);
});

test("commitCycle promotes the selected tab", () => {
  const cycle = createCycle([1, 2, 3], 1, 10);
  const advanced = advanceCycle(cycle, "forward", 20);

  assert.deepEqual(commitCycle([1, 2, 3], advanced.cycle), [2, 1, 3]);
});

test("a two-tab cycle returns to the origin tab", () => {
  const cycle = createCycle([1, 2], 1, 10);
  const first = advanceCycle(cycle, "forward", 20);
  const second = advanceCycle(first.cycle, "forward", 30);

  assert.equal(first.targetId, 2);
  assert.equal(second.targetId, 1);
});
