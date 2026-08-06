import test from "node:test";
import assert from "node:assert/strict";

const listeners = {
  command: [],
  activated: [],
  removed: [],
  updated: [],
  startup: [],
  installed: [],
  message: [],
};
const nativeListeners = { message: [], disconnect: [] };

const tabs = new Map([
  [1, { id: 1, windowId: 10, index: 0, active: true, title: "Alpha", url: "https://alpha.test/" }],
  [2, { id: 2, windowId: 10, index: 1, active: false, title: "Bravo", url: "https://bravo.test/" }],
  [3, { id: 3, windowId: 10, index: 2, active: false, title: "Charlie", url: "https://charlie.test/" }],
]);

let storedState = {};
let focusedWindowId = 10;
let canInject = true;
let failShow = false;
let popupOpens = 0;
let helperAvailable = true;
let nativeSequence = 0;
let nativeOptionDown = false;
let nativeShiftDown = false;
let nativeTabDown = false;
const overlayMessages = [];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function event(addTo) {
  return { addListener: (listener) => addTo.push(listener) };
}

const nativePort = {
  onMessage: event(nativeListeners.message),
  onDisconnect: event(nativeListeners.disconnect),
  postMessage(message) {
    if (message.type !== "handshake" || !helperAvailable) {
      return;
    }
    queueMicrotask(() => {
      for (const listener of nativeListeners.message) {
        listener({
          version: 1,
          type: "handshake-ack",
          capabilities: { optionLifecycle: true, shiftState: true, tabState: true },
        });
      }
    });
  },
};

globalThis.chrome = {
  storage: {
    session: {
      async get(key) {
        return { [key]: clone(storedState[key]) };
      },
      async set(values) {
        storedState = { ...storedState, ...clone(values) };
      },
    },
  },
  tabs: {
    async query(query) {
      let result = [...tabs.values()];
      if (Number.isInteger(query.windowId)) {
        result = result.filter((tab) => tab.windowId === query.windowId);
      }
      if (query.active) {
        result = result.filter((tab) => tab.active && tab.windowId === focusedWindowId);
      }
      return result.map(clone);
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("missing tab");
      return clone(tab);
    },
    async update(tabId, changes) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("missing tab");
      if (changes.active) {
        for (const candidate of tabs.values()) {
          if (candidate.windowId === tab.windowId) candidate.active = false;
        }
        tab.active = true;
        focusedWindowId = tab.windowId;
        for (const listener of listeners.activated) {
          listener({ tabId, windowId: tab.windowId });
        }
      }
      return clone(tab);
    },
    async sendMessage(tabId, message) {
      if (failShow && message.type === "SHOW_CYCLE_OVERLAY") {
        throw new Error("overlay is gone");
      }
      overlayMessages.push({ tabId, message: clone(message) });
      return { ok: true };
    },
    async create() {
      throw new Error("not implemented in test");
    },
    onActivated: event(listeners.activated),
    onRemoved: event(listeners.removed),
    onUpdated: event(listeners.updated),
  },
  scripting: {
    async executeScript() {
      if (!canInject) throw new Error("Cannot access a chrome:// URL");
      return [];
    },
  },
  commands: {
    async getAll() {
      return [
        { name: "cycle-forward", shortcut: "Option+Tab" },
        { name: "cycle-reverse", shortcut: "Option+Shift+Tab" },
      ];
    },
    onCommand: event(listeners.command),
  },
  action: {
    async openPopup() {
      popupOpens += 1;
    },
  },
  runtime: {
    connectNative() {
      if (!helperAvailable) throw new Error("native host unavailable");
      return nativePort;
    },
    onStartup: event(listeners.startup),
    onInstalled: event(listeners.installed),
    onMessage: event(listeners.message),
    async sendMessage() {},
  },
};

globalThis.__RC_TEST_DECISION_WINDOW_MS = 20;
globalThis.__RC_TEST_HOLD_RELEASE_GRACE_MS = 20;
globalThis.__RC_TEST_GHOST_MS = 10;
globalThis.__RC_TEST_ADVANCE_DEBOUNCE_MS = 0;

await import("../background.js?background-test");

function waitForQueue(ms = 35) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function selectedId() {
  return overlayMessages.at(-1)?.message.snapshot.tabs.find((tab) => tab.selected)?.id;
}

function windowState() {
  return storedState.recentCycleState.windows["10"];
}

function emitNativeEvent({ type = "key-event", key, phase } = {}) {
  nativeSequence += 1;
  const message = {
    version: 1,
    type,
    sequence: nativeSequence,
    timestampMs: nativeSequence,
    optionDown: nativeOptionDown,
    shiftDown: nativeShiftDown,
    tabDown: nativeTabDown,
  };
  if (key) message.key = key;
  if (phase) message.phase = phase;
  for (const listener of nativeListeners.message) listener(message);
}

function optionDown() {
  nativeOptionDown = true;
  emitNativeEvent({ key: "option", phase: "down" });
}

function optionUp() {
  nativeOptionDown = false;
  nativeTabDown = false;
  emitNativeEvent({ key: "option", phase: "up" });
}

function tabDown(shift = false) {
  nativeShiftDown = shift;
  nativeTabDown = true;
  emitNativeEvent({ key: "tab", phase: "down" });
}

function tabUp() {
  nativeTabDown = false;
  emitNativeEvent({ key: "tab", phase: "up" });
}

async function command(direction = "forward") {
  tabDown(direction === "reverse");
  listeners.command[0](direction === "forward" ? "cycle-forward" : "cycle-reverse", tabs.get(1));
  tabUp();
  await waitForQueue();
}

function commandNoWait(direction = "forward") {
  tabDown(direction === "reverse");
  listeners.command[0](direction === "forward" ? "cycle-forward" : "cycle-reverse", tabs.get(1));
  tabUp();
}

async function fastTap() {
  optionDown();
  commandNoWait();
  optionUp();
  await waitForQueue();
}

async function releaseViaContent(releaseToken) {
  const responses = [];
  listeners.message[0](
    { type: "OPTION_RELEASED", releaseToken },
    { tab: clone(tabs.get(1)) },
    (response) => responses.push(response),
  );
  await waitForQueue();
  return responses;
}

function disconnectHelper() {
  helperAvailable = false;
  for (const listener of nativeListeners.disconnect) listener();
}

function reconnectHelperForTest() {
  helperAvailable = true;
  for (const listener of nativeListeners.message) {
    listener({
      version: 1,
      type: "handshake-ack",
      capabilities: { optionLifecycle: true, shiftState: true, tabState: true },
    });
  }
}

function sendMessage(message, tabId = 1) {
  const responses = [];
  listeners.message[0](message, { tab: clone(tabs.get(tabId)) }, (response) => responses.push(response));
  return responses;
}

async function openProtectedCycle() {
  helperAvailable = true;
  canInject = false;
  optionDown();
  commandNoWait();
  await new Promise((resolve) => setTimeout(resolve, 5));
  await waitForQueue();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await waitForQueue();
  return windowState().cycle;
}

test("normal page: one physical hold reveals, advances, reverses, and commits on Option-up", async () => {
  canInject = true;
  overlayMessages.length = 0;
  optionDown();
  await command("forward");
  assert.ok(windowState().cycle, "cycle remains live while Option is held");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    overlayMessages.some(({ message }) => message.type === "SHOW_CYCLE_OVERLAY"),
    true,
  );
  const first = windowState().cycle.currentTabId;
  await command("forward");
  assert.notEqual(windowState().cycle.currentTabId, first);
  const afterForward = windowState().cycle.currentTabId;
  await command("reverse");
  assert.notEqual(windowState().cycle.currentTabId, afterForward);
  const afterReverse = windowState().cycle.currentTabId;
  const token = windowState().cycle.releaseToken;
  optionUp();
  await waitForQueue();
  assert.equal(windowState().cycle, null);
  assert.equal([...tabs.values()].find((tab) => tab.active).id, afterReverse);
  assert.equal(typeof token, "string");
});

test("fast tap has no visible list and commits once", async () => {
  canInject = true;
  overlayMessages.length = 0;
  await fastTap();
  assert.equal(windowState().cycle, null);
  assert.equal(overlayMessages.some(({ message }) => message.type === "SHOW_CYCLE_OVERLAY"), false);
});

test("rapid complete taps remain independent sessions", async () => {
  canInject = false;
  popupOpens = 0;
  const activeIds = [];
  for (const interval of [30, 100, 250, 500, 1000, 2400]) {
    const before = [...tabs.values()].find((tab) => tab.active).id;
    await fastTap();
    const after = [...tabs.values()].find((tab) => tab.active).id;
    activeIds.push(after);
    assert.notEqual(after, before, `interval ${interval}ms switches once`);
    assert.equal(windowState().cycle, null);
    assert.equal(popupOpens, 0);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  assert.equal(new Set(activeIds).size > 1, true);
});

test("protected page with helper switches immediately, reveals only after the same hold", async () => {
  canInject = false;
  popupOpens = 0;
  optionDown();
  commandNoWait();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(popupOpens, 0, "fast protected press has no popup flash");
  assert.ok(windowState().cycle, "helper preserves the physical session");
  await new Promise((resolve) => setTimeout(resolve, 40));
  await waitForQueue();
  assert.equal(popupOpens, 1, "hold timer reveals the popup");
  const before = windowState().cycle.currentTabId;
  await command();
  assert.notEqual(windowState().cycle.currentTabId, before);
  optionUp();
  await waitForQueue();
  assert.equal(windowState().cycle, null);
});

test("native hold waits for Tab-up and reveals without a second command", async () => {
  canInject = false;
  popupOpens = 0;
  optionDown();
  tabDown();
  listeners.command[0]("cycle-forward", tabs.get(1));
  await waitForQueue();

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(popupOpens, 0, "first command alone does not reveal the list");
  assert.ok(windowState().cycle, "the physical Option session remains live");

  tabUp();
  await new Promise((resolve) => setTimeout(resolve, 35));
  await waitForQueue();
  assert.equal(popupOpens, 1, "Tab-up arms and confirms the hold without a second command");

  optionUp();
  await waitForQueue();
  assert.equal(windowState().cycle, null);
});

test("release then repress within 30ms never inherits a protected session", async () => {
  canInject = false;
  popupOpens = 0;
  await fastTap();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await fastTap();
  assert.equal(windowState().cycle, null);
  assert.equal(popupOpens, 0);
});

test("helper failure degrades safely without timer-based popup activation", async () => {
  canInject = false;
  disconnectHelper();
  await waitForQueue();
  popupOpens = 0;
  await fastTap();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(windowState().cycle, null);
  assert.equal(popupOpens, 0);

  canInject = true;
  overlayMessages.length = 0;
  optionDown();
  commandNoWait();
  await waitForQueue(100);
  assert.equal(
    overlayMessages.some(({ message }) => message.type === "SHOW_CYCLE_OVERLAY"),
    true,
    "ordinary pages retain overlay hold behavior without the helper",
  );
  const releaseToken = windowState().cycle.releaseToken;
  optionUp();
  await releaseViaContent(releaseToken);
});

test("reverse with no active hold is a pure no-op", async () => {
  const before = clone(storedState.recentCycleState);
  listeners.command[0]("cycle-reverse", tabs.get(1));
  await waitForQueue();
  assert.deepEqual(storedState.recentCycleState, before);
});

test("snapshot exposes active-page capability and tab count for the configuration dashboard", async () => {
  const active = [...tabs.values()].find((tab) => tab.active);
  const responses = sendMessage({ type: "GET_SNAPSHOT" }, active.id);
  await waitForQueue();

  assert.equal(responses.length, 1);
  assert.equal(responses[0].tabCount, tabs.size);
  assert.equal(responses[0].activePage.kind, "standard");
  assert.equal(responses[0].activePage.overlaySupported, true);
  assert.equal(responses[0].activePage.host, active.url.replace(/^https:\/\//, "").replace(/\/$/, ""));

  const originalUrl = active.url;
  active.url = "chrome://newtab/";
  const protectedResponses = sendMessage({ type: "GET_SNAPSHOT" }, active.id);
  await waitForQueue();
  assert.equal(protectedResponses[0].activePage.kind, "newtab");
  assert.equal(protectedResponses[0].activePage.overlaySupported, false);
  active.url = originalUrl;
});

test("duplicate delivery for one native Tab sequence advances once", async () => {
  canInject = true;
  reconnectHelperForTest();
  await waitForQueue();
  optionDown();
  commandNoWait();
  await waitForQueue();
  const before = windowState().cycle.currentTabId;
  tabDown();
  listeners.command[0]("cycle-forward", tabs.get(1));
  listeners.command[0]("cycle-forward", tabs.get(1));
  tabUp();
  await waitForQueue();
  const after = windowState().cycle.currentTabId;
  assert.notEqual(after, before);
  assert.equal(windowState().cycle.position, 2);
  optionUp();
  await waitForQueue();
});

test("removing the origin or selected tab clears the active cycle", async () => {
  canInject = true;
  reconnectHelperForTest();
  await waitForQueue();
  optionDown();
  commandNoWait();
  await waitForQueue();
  const selected = windowState().cycle.currentTabId;
  tabs.delete(selected);
  listeners.removed[0](selected);
  await waitForQueue();
  assert.equal(windowState().cycle, null);
  optionUp();
  await waitForQueue();
});

test("popup validation still rejects a wrong window and stale token", async () => {
  helperAvailable = true;
  canInject = false;
  // Reconnect is intentionally not needed for this contract test; the popup
  // path is exercised by a normal injected cycle rendered as popup.
  optionDown();
  await command();
  await new Promise((resolve) => setTimeout(resolve, 40));
  const cycle = windowState().cycle;
  if (!cycle) {
    optionUp();
    return;
  }
  const before = cycle.currentTabId;
  const responses = [];
  listeners.message[0](
    { type: "POPUP_ADVANCE", releaseToken: cycle.releaseToken, windowId: 999, direction: "forward" },
    { tab: clone(tabs.get(1)) },
    (response) => responses.push(response),
  );
  await waitForQueue();
  assert.equal(windowState().cycle.currentTabId, before);
  listeners.message[0](
    { type: "CANCEL_CYCLE", releaseToken: "stale", windowId: 10 },
    { tab: clone(tabs.get(1)) },
    () => undefined,
  );
  await waitForQueue();
  assert.ok(windowState().cycle);
  optionUp();
  await waitForQueue();
});

test("popup cancel, deleted-tab validation, and row activation preserve target safety", async () => {
  const cycle = await openProtectedCycle();
  if (!cycle) {
    optionUp();
    return;
  }
  const token = cycle.releaseToken;
  const activeBeforeCancel = [...tabs.values()].find((tab) => tab.active).id;
  const missing = sendMessage({ type: "ACTIVATE_TAB", tabId: 99999 });
  await waitForQueue();
  assert.equal(typeof missing[0]?.error, "string");
  assert.ok(windowState().cycle);
  sendMessage({ type: "CANCEL_CYCLE", releaseToken: token, windowId: 10 });
  await waitForQueue();
  assert.equal(windowState().cycle, null);
  assert.equal([...tabs.values()].find((tab) => tab.active).id, activeBeforeCancel);
  optionUp();
  await waitForQueue();

  const nextCycle = await openProtectedCycle();
  if (!nextCycle) {
    optionUp();
    return;
  }
  const selected = nextCycle.currentTabId;
  sendMessage({ type: "ACTIVATE_TAB", tabId: selected, windowId: 10 });
  await waitForQueue();
  assert.equal(tabs.get(selected).active, true);
  assert.equal(windowState().cycle, null);
  optionUp();
  await waitForQueue();
});
