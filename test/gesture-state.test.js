import test from "node:test";
import assert from "node:assert/strict";
import {
  applyNativeGestureMessage,
  createGestureState,
  currentInputIdentity,
  markGestureConnected,
  markGestureDisconnected,
} from "../gesture-state.js";

function connectedState() {
  const state = createGestureState();
  markGestureConnected(state, { optionLifecycle: true, shiftState: true, tabState: true });
  return state;
}

function event(sequence, optionDown, key = "option", phase = optionDown ? "down" : "up") {
  return {
    version: 1,
    type: "key-event",
    sequence,
    timestampMs: sequence,
    key,
    phase,
    optionDown,
    shiftDown: false,
    tabDown: key === "tab" && phase === "down",
  };
}

test("rapid complete taps create distinct sessions at every required interval", () => {
  for (const interval of [30, 100, 250, 500, 1000, 2400]) {
    const state = connectedState();
    const firstDown = applyNativeGestureMessage(state, event(1, true));
    const firstSession = firstDown.sessionId;
    applyNativeGestureMessage(state, event(2, true, "tab", "down"));
    applyNativeGestureMessage(state, event(3, true, "tab", "up"));
    const firstUp = applyNativeGestureMessage(state, event(4, false));
    const secondDown = applyNativeGestureMessage(state, event(5, true));
    assert.equal(firstUp.sessionEvent.kind, "option-up", `${interval}ms closes first session`);
    assert.notEqual(secondDown.sessionId, firstSession, `${interval}ms creates a new session`);
    assert.equal(currentInputIdentity(state).sessionId, secondDown.sessionId);
  }
});

test("one continuous hold keeps identity through Tab and Shift+Tab", () => {
  const state = connectedState();
  const start = applyNativeGestureMessage(state, event(1, true));
  applyNativeGestureMessage(state, event(2, true, "tab", "down"));
  const reverse = applyNativeGestureMessage(state, {
    ...event(3, true, "tab", "down"),
    shiftDown: true,
  });
  assert.equal(reverse.sessionId, start.sessionId);
  assert.equal(currentInputIdentity(state).sessionId, start.sessionId);
  assert.equal(state.optionDown, true);
});

test("old Option-up and Tab events cannot mutate a newer session", () => {
  const state = connectedState();
  const first = applyNativeGestureMessage(state, event(1, true));
  applyNativeGestureMessage(state, event(2, false));
  const second = applyNativeGestureMessage(state, event(3, true));
  const staleUp = applyNativeGestureMessage(state, event(2, false));
  const staleTab = applyNativeGestureMessage(state, event(2, true, "tab", "down"));
  assert.equal(staleUp.kind, "stale");
  assert.equal(staleTab.kind, "stale");
  assert.equal(state.activeSession.sessionId, second.sessionId);
  assert.notEqual(first.sessionId, second.sessionId);
});

test("duplicate sequence numbers are ignored", () => {
  const state = connectedState();
  applyNativeGestureMessage(state, event(1, true));
  const duplicate = applyNativeGestureMessage(state, event(1, false));
  assert.equal(duplicate.kind, "stale");
  assert.equal(state.optionDown, true);
});

test("disconnect clears option state and active session", () => {
  const state = connectedState();
  applyNativeGestureMessage(state, event(1, true));
  const ended = markGestureDisconnected(state);
  assert.equal(ended.sessionId, 1);
  assert.equal(state.optionDown, false);
  assert.equal(state.activeSession, null);
  assert.equal(currentInputIdentity(state).sessionId, null);
});
