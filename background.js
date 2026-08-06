import {
  advanceCycle,
  commitCycle,
  createCycle,
  moveToFront,
  reconcileOrder,
  removeId,
} from "./mru.js";
import {
  applyNativeGestureMessage,
  createGestureState,
  currentInputIdentity,
  markGestureConnected,
  markGestureDisconnected,
} from "./gesture-state.js";

const STORAGE_KEY = "recentCycleState";
const STATE_VERSION = 2;
const MAX_VISIBLE_TABS = 32;
const DECISION_WINDOW_MS =
  globalThis.__RC_TEST_DECISION_WINDOW_MS ?? globalThis.__RC_TEST_HOLD_MS ?? 300;
const HOLD_RELEASE_GRACE_MS =
  globalThis.__RC_TEST_HOLD_RELEASE_GRACE_MS ?? 100;
const GHOST_SUPPRESS_MS = globalThis.__RC_TEST_GHOST_MS ?? 300;
const NATIVE_HOST_NAME = "com.recentcycle.keyboard";
const NATIVE_PROTOCOL_VERSION = 1;
const NATIVE_STATE_SETTLE_MS = 40;

// Task 0 micro-check 2026-08-05 (real macOS Chrome): discrete-only. Re-fire
// intervals measured 271-3320ms, physically holding Tab for ~2-3.3s produced
// zero fires, and no ~20-35ms OS key-repeat clusters appeared. 60ms serves
// two purposes: guard against duplicate event dispatch, and coalesce the
// popup-session double path, where one physical Tab press can arrive as both
// a command re-fire and a POPUP_ADVANCE message up to ~40ms apart. Human
// taps are ~100ms+, so 60ms never swallows a real press.
const ADVANCE_DEBOUNCE_MS = 60;

function advanceDebounceMs() {
  return globalThis.__RC_TEST_ADVANCE_DEBOUNCE_MS ?? ADVANCE_DEBOUNCE_MS;
}

// Gesture hint only — never the decision authority. Injection failure in
// armCycleOverlay is what actually triggers the fallback; this list lets the
// popup pre-open synchronously inside the command's user gesture, which the
// async fallback path may have lost by the time it runs.
const PROTECTED_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "edge:",
  "devtools:",
  "about:",
  "view-source:",
];

function isProtectedScheme(url) {
  if (typeof url !== "string") {
    return false;
  }

  return PROTECTED_SCHEMES.some((scheme) => url.startsWith(scheme));
}

function isDiagnosticsEnabled() {
  return Boolean(globalThis.__RC_TEST_DIAGNOSTICS);
}

let state = null;
let stateLoadPromise = null;
let operationQueue = Promise.resolve();
let releaseTokenSequence = 0;
let diagSequence = 0;
const pendingHoldTimers = new Map();
const recentAdvanceAt = new Map();
const pendingNativeReconnect = { timer: null, delayMs: 250 };
let nativePort = null;
let nativeReconnectScheduled = false;
const gestureState = createGestureState();

function writeDiag(event, fields = {}) {
  if (!isDiagnosticsEnabled()) {
    return;
  }
  const details = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");
  console.log(`[RC-diag] ${event}${details ? ` ${details}` : ""}`);
}

function cycleMatchesSession(cycle, sessionId) {
  return cycle && sessionId !== null && cycle.sessionId === sessionId;
}

function hasLivePhysicalHold(cycle) {
  return cycleMatchesSession(cycle, gestureState.activeSession?.sessionId ?? null)
    && gestureState.connected
    && gestureState.ready
    && gestureState.optionDown;
}

function isNormalOverlaySession(cycle) {
  return cycle?.sessionId === null
    && cycle.inputSource === "degraded"
    && cycle.renderTarget === "overlay";
}

function canConfirmHold(cycle) {
  return hasLivePhysicalHold(cycle) || isNormalOverlaySession(cycle);
}

function scheduleHoldConfirmation(windowId, win, delayMs = DECISION_WINDOW_MS) {
  cancelHoldConfirmation(windowId);
  const expectedSessionId = win.cycle?.sessionId ?? null;
  const timer = setTimeout(() => {
    pendingHoldTimers.delete(windowId);
    void enqueue(() => confirmHold(windowId, expectedSessionId));
  }, delayMs);
  pendingHoldTimers.set(windowId, timer);
}

function cancelHoldConfirmation(windowId) {
  const timer = pendingHoldTimers.get(windowId);
  if (timer) {
    clearTimeout(timer);
  }
  pendingHoldTimers.delete(windowId);
}

function createState() {
  return {
    version: STATE_VERSION,
    windows: {},
  };
}

function createWindowState() {
  return {
    order: [],
    cycle: null,
    suppressUntil: 0,
  };
}

function normalizeState(value) {
  if (!value || value.version !== STATE_VERSION || !value.windows) {
    return createState();
  }

  return value;
}

function clearEphemeralCycles(nextState) {
  for (const win of Object.values(nextState.windows)) {
    win.cycle = null;
    win.suppressUntil = 0;
  }
  return nextState;
}

async function getState() {
  if (state) {
    return state;
  }

  if (!stateLoadPromise) {
    stateLoadPromise = chrome.storage.session
      .get(STORAGE_KEY)
      .then((stored) => {
        state = clearEphemeralCycles(normalizeState(stored[STORAGE_KEY]));
        return state;
      })
      .finally(() => {
        stateLoadPromise = null;
      });
  }

  return stateLoadPromise;
}

async function persistState() {
  await chrome.storage.session.set({
    [STORAGE_KEY]: state,
  });
}

function enqueue(task) {
  const next = operationQueue.then(task, task);
  operationQueue = next.catch(() => undefined);
  return next;
}

function scheduleNativeReconnect() {
  if (nativeReconnectScheduled || !chrome.runtime?.connectNative) {
    return;
  }
  nativeReconnectScheduled = true;
  pendingNativeReconnect.timer = setTimeout(() => {
    nativeReconnectScheduled = false;
    pendingNativeReconnect.timer = null;
    connectNativeCompanion();
  }, pendingNativeReconnect.delayMs);
  pendingNativeReconnect.delayMs = Math.min(pendingNativeReconnect.delayMs * 2, 30_000);
}

async function finishPhysicalSession(sessionId, reason = "option-up") {
  if (!Number.isInteger(sessionId)) {
    return;
  }
  await getState();
  for (const [key, win] of Object.entries(state.windows)) {
    if (!cycleMatchesSession(win.cycle, sessionId)) {
      continue;
    }
    writeDiag("commit", { reason, sessionId, windowId: key });
    await endCycle({ windowId: Number(key) }, win.cycle.releaseToken, { suppress: false, reason });
  }
}

async function handleNativeMessage(message) {
  if (!message || message.version !== NATIVE_PROTOCOL_VERSION) {
    writeDiag("stale event drop", { reason: "invalid-version" });
    return;
  }

  if (message.type === "handshake-ack") {
    markGestureConnected(gestureState, message.capabilities);
    pendingNativeReconnect.delayMs = 250;
    writeDiag("helper reconnect", {
      capability: gestureState.ready ? "option-lifecycle" : "unavailable",
    });
    if (!gestureState.ready) {
      await handleNativeDisconnect("capability-unavailable");
    }
    return;
  }

  if (message.type === "error" || message.type === "helper-status") {
    writeDiag("helper status", { status: message.status ?? message.code ?? "error" });
    if (message.status === "event-tap-disabled" || message.code === "accessibility-denied") {
      await handleNativeDisconnect(message.status ?? message.code);
    }
    return;
  }

  const result = applyNativeGestureMessage(gestureState, message);
  if (result.kind === "stale") {
    writeDiag("stale event drop", {
      sequence: result.sequence,
      lastSequence: result.lastSequence,
    });
    return;
  }
  if (result.kind === "invalid") {
    writeDiag("native message drop", { reason: result.reason });
    return;
  }

  writeDiag("native event", {
    type: message.type,
    sequence: result.sequence,
    optionDown: result.optionDown,
    shiftDown: result.shiftDown,
    tabDown: result.tabDown,
    sessionId: result.sessionId,
  });

  if (
    result.kind === "key-event"
    && result.key === "tab"
    && result.phase === "up"
    && result.optionDown
  ) {
    await armNativeHoldCandidate(result);
  }

  if (result.sessionEvent?.kind === "option-up") {
    writeDiag("Option up", { sessionId: result.sessionEvent.sessionId, sequence: result.sequence });
    await finishPhysicalSession(result.sessionEvent.sessionId);
  }
}

async function armNativeHoldCandidate(result) {
  if (!result.optionDown || !Number.isInteger(result.sessionId)) {
    return;
  }

  const windowId = await resolveWindowId();
  if (!Number.isInteger(windowId)) {
    writeDiag("pending hold stale", {
      reason: "active-window-unavailable",
      sessionId: result.sessionId,
      sequence: result.sequence,
    });
    return;
  }

  await getState();
  const win = getWindowState(windowId);
  const cycle = win.cycle;
  if (
    !cycleMatchesSession(cycle, result.sessionId)
    || !cycle.holdPending
    || cycle.heldConfirmed
  ) {
    writeDiag("pending hold stale", {
      reason: "cycle-session-mismatch",
      windowId,
      cycleSessionId: cycle?.sessionId ?? "none",
      inputSessionId: result.sessionId,
      sequence: result.sequence,
    });
    return;
  }

  cycle.holdCandidateSequence = result.sequence;
  cycle.holdCandidateAt = Date.now();
  writeDiag("pending hold armed", {
    windowId,
    sessionId: result.sessionId,
    sequence: result.sequence,
    graceMs: HOLD_RELEASE_GRACE_MS,
  });
  scheduleHoldConfirmation(windowId, win, HOLD_RELEASE_GRACE_MS);
  await persistState();
}

async function handleNativeDisconnect(reason = "disconnect") {
  const endedSession = markGestureDisconnected(gestureState);
  nativePort = null;
  writeDiag("helper disconnect", {
    reason,
    sessionId: endedSession?.sessionId ?? "none",
  });
  if (endedSession) {
    await finishPhysicalSession(endedSession.sessionId, "helper-disconnect");
  }
  scheduleNativeReconnect();
}

function connectNativeCompanion() {
  if (nativePort || !chrome.runtime?.connectNative) {
    if (!chrome.runtime?.connectNative) {
      writeDiag("helper unavailable", { reason: "nativeMessaging-api-missing" });
    }
    return;
  }

  try {
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    nativePort = port;
    nativePort.onMessage.addListener((message) => {
      void enqueue(() => handleNativeMessage(message));
    });
    nativePort.onDisconnect.addListener(() => {
      // Chrome reports a missing native host through runtime.lastError on the
      // disconnect callback. Read it here so the optional-companion degraded
      // mode does not produce an unchecked runtime.lastError warning.
      const disconnectError = chrome.runtime?.lastError;
      const reason = disconnectError?.message || "port-disconnect";
      void enqueue(() => handleNativeDisconnect(reason));
    });
    nativePort.postMessage({
      version: NATIVE_PROTOCOL_VERSION,
      type: "handshake",
      capabilities: ["option-lifecycle", "shift-state", "tab-state"],
    });
    writeDiag("helper connect", { host: NATIVE_HOST_NAME });
  } catch (error) {
    nativePort = null;
    markGestureDisconnected(gestureState);
    writeDiag("helper unavailable", {
      reason: error instanceof Error ? error.message : String(error),
    });
    scheduleNativeReconnect();
  }
}

async function waitForNativeInput() {
  if (!chrome.runtime?.connectNative || (gestureState.ready && gestureState.optionDown)) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, NATIVE_STATE_SETTLE_MS));
}

function windowKey(windowId) {
  return String(windowId);
}

function getWindowState(windowId) {
  const key = windowKey(windowId);
  state.windows[key] ??= createWindowState();
  state.windows[key].suppressUntil ??= 0;
  return state.windows[key];
}

async function getTabsForWindow(windowId) {
  return chrome.tabs.query({ windowId });
}

function getActiveTab(tabs) {
  return tabs.find((tab) => tab.active) ?? tabs[0] ?? null;
}

function reconcileWindow(windowId, tabs, activeTabId, { moveActive = false } = {}) {
  const win = getWindowState(windowId);
  const tabIds = tabs
    .map((tab) => tab.id)
    .filter((tabId) => Number.isInteger(tabId));

  win.order = reconcileOrder(win.order, tabIds, activeTabId);
  if (moveActive && Number.isInteger(activeTabId)) {
    win.order = moveToFront(win.order, activeTabId);
  }

  if (win.cycle) {
    const validIds = new Set(tabIds);
    if (!validIds.has(win.cycle.originTabId)) {
      win.cycle = null;
    } else {
      win.cycle.candidateIds = win.cycle.candidateIds.filter((id) => validIds.has(id));
      if (!validIds.has(win.cycle.currentTabId)) {
        win.cycle.currentTabId = win.cycle.originTabId;
      }
    }
  }

  return win;
}

function commitWindowCycle(win) {
  if (!win.cycle) {
    return;
  }

  win.order = commitCycle(win.order, win.cycle);
  win.cycle = null;
}

function createReleaseToken(windowId) {
  releaseTokenSequence += 1;
  return `${windowId}:${Date.now()}:${releaseTokenSequence}`;
}

async function resolveWindowId(commandTab) {
  if (Number.isInteger(commandTab?.windowId)) {
    return commandTab.windowId;
  }

  const activeTabs = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });

  return activeTabs[0]?.windowId ?? null;
}

async function getShortcutStatus() {
  const commands = await chrome.commands.getAll();
  return commands
    .filter(({ name }) => name === "cycle-forward" || name === "cycle-reverse")
    .map(({ name, shortcut }) => ({
      name,
      shortcut: shortcut || "",
      active: Boolean(shortcut),
    }));
}

function formatHost(url) {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      return parsed.hostname.replace(/^www\./, "");
    }

    if (parsed.hostname) {
      return `${parsed.protocol}//${parsed.hostname}`;
    }

    return parsed.protocol.replace(":", "");
  } catch {
    return "";
  }
}

function describeActivePage(tab) {
  const url = typeof tab?.url === "string" ? tab.url : "";
  const title = typeof tab?.title === "string" && tab.title.trim()
    ? tab.title.trim()
    : "Current tab";

  const favIconUrl = tab?.favIconUrl || null;

  if (url.startsWith("chrome://newtab")) {
    return {
      kind: "newtab",
      label: "Chrome New Tab",
      title,
      host: "chrome://newtab",
      url,
      favIconUrl,
      overlaySupported: false,
    };
  }

  if (isProtectedScheme(url)) {
    return {
      kind: "protected",
      label: "Protected page",
      title,
      host: formatHost(url) || "Chrome browser UI",
      url,
      favIconUrl,
      overlaySupported: false,
    };
  }

  if (url.startsWith("http://") || url.startsWith("https://")) {
    return {
      kind: "standard",
      label: "Overlay ready",
      title,
      host: formatHost(url) || "Web page",
      url,
      favIconUrl,
      overlaySupported: true,
    };
  }

  return {
    kind: "limited",
    label: "Limited access",
    title,
    host: formatHost(url) || "Browser context",
    url,
    favIconUrl,
    overlaySupported: false,
  };
}

function initialFor(title) {
  const clean = title.replace(/^[\(\[\{][0-9+\s\-]+[\)\]\}]\s*/, "").trim();
  const initial = (clean || title).trim().charAt(0).toUpperCase();
  return initial || "?";
}

function serializeTab(tab, selected) {
  const title = typeof tab.title === "string" && tab.title.trim()
    ? tab.title.trim()
    : "Untitled tab";

  return {
    id: tab.id,
    title,
    host: formatHost(tab.url),
    url: tab.url || "",
    initial: initialFor(title),
    favIconUrl: tab.favIconUrl || null,
    pinned: Boolean(tab.pinned),
    selected,
    active: Boolean(tab.active),
  };
}

function serializeWindowSnapshot(windowId, tabs, activeTab, win) {
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  const displayIds = win.cycle
    ? win.cycle.candidateIds
    : win.order;
  const selectedId = win.cycle?.currentTabId ?? activeTab.id;
  const visibleIds = displayIds.slice(0, MAX_VISIBLE_TABS);
  if (Number.isInteger(selectedId) && !visibleIds.includes(selectedId)) {
    visibleIds[visibleIds.length - 1] = selectedId;
  }

  return {
    windowId,
    activeTabId: activeTab.id,
    activePage: describeActivePage(activeTab),
    tabCount: tabs.length,
    cycling: Boolean(win.cycle),
    fallbackSession: win.cycle?.renderTarget === "popup",
    companion: {
      connected: gestureState.connected,
      ready: gestureState.ready,
    },
    releaseToken: win.cycle?.releaseToken ?? null,
    tabs: visibleIds
      .map((id) => tabById.get(id))
      .filter(Boolean)
      .map((tab) => serializeTab(tab, tab.id === selectedId)),
  };
}

async function createSnapshot(windowId) {
  await getState();
  const tabs = await getTabsForWindow(windowId);
  const activeTab = getActiveTab(tabs);
  if (!activeTab) {
      return {
        windowId,
        activePage: null,
        tabCount: 0,
        cycling: false,
        tabs: [],
        companion: {
          connected: gestureState.connected,
          ready: gestureState.ready,
        },
        shortcutStatus: await getShortcutStatus(),
    };
  }

  const win = reconcileWindow(windowId, tabs, activeTab.id);
  return {
    ...serializeWindowSnapshot(windowId, tabs, activeTab, win),
    shortcutStatus: await getShortcutStatus(),
  };
}

async function broadcastSnapshot(windowId) {
  if (!Number.isInteger(windowId)) {
    return;
  }

  try {
    const snapshot = await createSnapshot(windowId);
    await chrome.runtime.sendMessage({
      type: "SNAPSHOT",
      snapshot,
    });
  } catch {
    // No popup is open, or it closed while the message was in flight.
  }
}

async function armCycleOverlay(tabId, releaseToken, diag = null) {
  try {
    if (diag) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (correlationId, commandFireTs) => {
          globalThis.__RC_DIAG_CORRELATION = { correlationId, commandFireTs };
        },
        args: [diag.correlationId, diag.commandFireTs],
      });
    }
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["cycle-overlay.js"],
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "CYCLE_ARM",
      releaseToken,
    });
    return true;
  } catch (error) {
    if (diag) {
      console.log(
        `[RC-diag] ${diag.correlationId} arm failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return false;
  }
}

async function showCycleOverlay(tabId, releaseToken, snapshot) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["cycle-overlay.js"],
    });
    await chrome.tabs.sendMessage(tabId, {
      type: "SHOW_CYCLE_OVERLAY",
      releaseToken,
      snapshot,
    });
    return true;
  } catch {
    return false;
  }
}

async function hideCycleOverlay(tabId, releaseToken) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: "HIDE_CYCLE_OVERLAY",
      releaseToken,
    });
  } catch {
    // The origin page may have navigated or discarded its isolated world.
  }
}

async function silentCommit(windowId, win, activeTab, selectedTabId, { suppress = true } = {}) {
  commitWindowCycle(win);
  cancelHoldConfirmation(windowId);
  recentAdvanceAt.delete(windowKey(windowId));
  if (suppress) {
    win.suppressUntil = Date.now() + GHOST_SUPPRESS_MS;
  } else {
    // A physical Option lifecycle (or degraded protected-page mode) is the
    // identity boundary. Do not turn elapsed time into a session marker.
    win.suppressUntil = 0;
  }
  await persistState();

  if (Number.isInteger(selectedTabId) && selectedTabId !== activeTab.id) {
    try {
      await chrome.tabs.update(selectedTabId, { active: true });
    } catch {
      win.order = removeId(win.order, selectedTabId);
      await persistState();
    }
  }

  await broadcastSnapshot(windowId);
}

async function handleCycle(direction, commandTab, fireTs = 0) {
  await getState();
  await waitForNativeInput();
  const windowId = await resolveWindowId(commandTab);
  if (!Number.isInteger(windowId)) {
    return;
  }

  const diag = isDiagnosticsEnabled()
    ? {
        correlationId: `diag-${++diagSequence}`,
        commandFireTs: fireTs,
        perfFireTs: performance.now(),
      }
    : null;
  if (diag) {
    writeDiag("command received", {
      correlationId: diag.correlationId,
      direction,
      nativeSequence: gestureState.lastSequence,
      optionDown: gestureState.optionDown,
      shiftDown: gestureState.shiftDown,
      tabDown: gestureState.tabDown,
      sessionId: gestureState.activeSession?.sessionId ?? "none",
      wallTs: fireTs,
    });
  }

  const tabs = await getTabsForWindow(windowId);
  const activeTab = getActiveTab(tabs);
  if (!activeTab) {
    return;
  }

  const win = reconcileWindow(windowId, tabs, activeTab.id);

  const input = currentInputIdentity(gestureState);

  if (!win.cycle) {
    if (direction === "reverse") {
      // cycle-reverse is hold-only: with no live cycle it is a pure no-op —
      // no state mutation, no suppressUntil change, no commit.
      if (diag) {
        console.log(`[RC-diag] ${diag.correlationId} cycle-reverse no-op (no active cycle)`);
      }
      return;
    }

    if (diag) {
      console.log(`[RC-diag] ${diag.correlationId} starting new cycle (no live cycle)`);
    }
    await startCycle(windowId, win, tabs, activeTab, input, diag);
    return;
  }

  const sameNormalOverlaySession = input.sessionId === null && isNormalOverlaySession(win.cycle);
  if (
    (!sameNormalOverlaySession && input.sessionId === null)
    || (win.cycle.sessionId !== null && win.cycle.sessionId !== input.sessionId)
  ) {
    writeDiag("stale event drop", {
      reason: input.sessionId === null ? "physical-state-unknown" : "new-session-boundary",
      cycleSessionId: win.cycle.sessionId ?? "none",
      inputSessionId: input.sessionId ?? "none",
    });
    if (input.sessionId !== null) {
      await endCycle({ windowId }, win.cycle.releaseToken, {
        suppress: false,
        reason: "new-session-boundary",
      });
      const refreshedTabs = await getTabsForWindow(windowId);
      const refreshedActiveTab = getActiveTab(refreshedTabs);
      if (refreshedActiveTab) {
        const refreshedWin = reconcileWindow(windowId, refreshedTabs, refreshedActiveTab.id);
        await startCycle(windowId, refreshedWin, refreshedTabs, refreshedActiveTab, input, diag);
      }
    }
    return;
  }

  if (
    input.inputSequence !== null
    && win.cycle.lastInputSequence === input.inputSequence
  ) {
    writeDiag("stale event drop", {
      reason: "duplicate-sequence",
      sequence: input.inputSequence,
      sessionId: input.sessionId,
    });
    return;
  }

  win.cycle.lastInputSequence = input.inputSequence;

  if (diag) {
    console.log(
      `[RC-diag] ${diag.correlationId} re-fire on live cycle `
        + `renderTarget=${win.cycle.renderTarget ?? "overlay"} position=${win.cycle.position}`,
    );
  }
  // Native Tab sequence numbers already distinguish real presses. Do not use
  // wall-clock debounce to merge two valid physical presses in one hold.
  await advanceLiveCycle(direction, windowId, win, tabs, activeTab, diag, { timeDebounce: false });
}

async function startCycle(windowId, win, tabs, activeTab, input, diag) {
  win.order = moveToFront(win.order, activeTab.id);
  win.suppressUntil = 0;
  win.cycle = {
    ...createCycle(win.order, activeTab.id),
    releaseToken: createReleaseToken(windowId),
    holdPending: true,
    heldConfirmed: false,
    sessionId: input.sessionId,
    optionDown: input.optionDown,
    startedAt: Date.now(),
    firstCommandAt: Date.now(),
    inputSource: input.inputSource,
    lastInputSequence: input.inputSequence,
    renderTarget: "overlay",
  };
  writeDiag("cycle start", {
    windowId,
    sessionId: input.sessionId ?? "none",
    inputSource: input.inputSource,
    nativeSequence: input.inputSequence ?? "none",
  });

  const advanced = advanceCycle(win.cycle, "forward");
  win.cycle = advanced.cycle;

  if (!Number.isInteger(advanced.targetId)) {
    win.cycle = null;
    await persistState();
    await broadcastSnapshot(windowId);
    return;
  }

  const armed = await armCycleOverlay(win.cycle.originTabId, win.cycle.releaseToken, diag);
  if (diag) {
    console.log(
      `[RC-diag] ${diag.correlationId} executeScript resolved armed=${armed} `
        + `workerElapsedMs=${(performance.now() - diag.perfFireTs).toFixed(2)} wallTs=${Date.now()}`,
    );
  }
  if (!armed) {
    await protectedFallback(windowId, win, tabs, activeTab, advanced.targetId, diag);
    return;
  }

  // A native session waits for the physical Tab-up event before starting the
  // hold decision. Degraded ordinary-page overlay sessions retain their
  // existing timer because they do not have a reliable global Tab-up source.
  if (win.cycle.sessionId === null && win.cycle.renderTarget === "overlay") {
    scheduleHoldConfirmation(windowId, win);
  }
  await persistState();
  await broadcastSnapshot(windowId);
}

async function protectedFallback(windowId, win, tabs, activeTab, selectedTabId, diag) {
  if (!hasLivePhysicalHold(win.cycle)) {
    // Without a physical Option lifecycle, protected pages stay in safe
    // degraded mode: every command is an independent silent switch.
    writeDiag("protected degraded", { reason: "helper-unavailable", windowId });
    await silentCommit(windowId, win, activeTab, selectedTabId, { suppress: false });
    return;
  }

  // Keep the cycle alive across the first immediate protected-page switch.
  // A physical Option session, not a re-fire deadline, controls reveal.
  win.cycle.holdPending = true;
  win.cycle.heldConfirmed = false;
  win.cycle.renderTarget = "popup";
  win.cycle.preserveOnActivation = true;

  try {
    await chrome.tabs.update(selectedTabId, { active: true });
  } catch {
    await silentCommit(windowId, win, activeTab, selectedTabId, { suppress: false });
    return;
  }
  if (diag) {
    writeDiag("fast commit", {
      correlationId: diag.correlationId,
      sessionId: win.cycle.sessionId,
      windowId,
      selectedTabId,
      renderTarget: "popup",
    });
  }

  await persistState();
  await broadcastSnapshot(windowId);
}

async function advanceLiveCycle(
  direction,
  windowId,
  win,
  tabs,
  activeTab,
  diag,
  { timeDebounce = true } = {},
) {
  const now = Date.now();
  const key = windowKey(windowId);
  if (timeDebounce && now - (recentAdvanceAt.get(key) ?? 0) < advanceDebounceMs()) {
    if (diag) {
      console.log(`[RC-diag] ${diag.correlationId} advance debounced`);
    }
    return;
  }
  if (timeDebounce) {
    recentAdvanceAt.set(key, now);
  }

  // A re-fire while the list is still hidden is unambiguous evidence of
  // intentional cycling: cancel the fallback timer and reveal immediately.
  const shouldReveal = !win.cycle.heldConfirmed;
  if (shouldReveal) {
    win.cycle.holdPending = false;
    win.cycle.heldConfirmed = true;
    cancelHoldConfirmation(windowId);
  }

  const advanced = advanceCycle(win.cycle, direction);
  win.cycle = advanced.cycle;
  writeDiag(direction === "reverse" ? "reverse" : "advance", {
    windowId,
    sessionId: win.cycle.sessionId ?? "none",
    selectedTabId: win.cycle.currentTabId,
    inputSequence: win.cycle.lastInputSequence ?? "none",
  });

  if (!Number.isInteger(advanced.targetId)) {
    win.cycle = null;
    cancelHoldConfirmation(windowId);
    recentAdvanceAt.delete(key);
    await persistState();
    await broadcastSnapshot(windowId);
    return;
  }

  if (win.cycle.renderTarget === "popup") {
    // Popup fallback session: no injected overlay exists; the popup
    // re-renders from the SNAPSHOT broadcast.
    if (shouldReveal) {
      try {
        await chrome.action.openPopup();
        writeDiag("list reveal", {
          windowId,
          sessionId: win.cycle.sessionId,
          renderTarget: "popup",
          trigger: "command",
        });
      } catch {
        writeDiag("list reveal", {
          windowId,
          sessionId: win.cycle.sessionId,
          renderTarget: "popup",
          trigger: "command",
          result: "unavailable",
        });
      }
    }
    if (diag) {
      console.log(`[RC-diag] ${diag.correlationId} popup session advanced to ${win.cycle.currentTabId}`);
    }
    await persistState();
    await broadcastSnapshot(windowId);
    return;
  }

  const snapshot = serializeWindowSnapshot(windowId, tabs, activeTab, win);
  const visible = await showCycleOverlay(
    win.cycle.originTabId,
    win.cycle.releaseToken,
    snapshot,
  );

  if (!visible) {
    await silentCommit(windowId, win, activeTab, win.cycle.currentTabId);
    return;
  }

  await persistState();
  await broadcastSnapshot(windowId);
}

async function showCycleList(windowId, win, tabs, activeTab) {
  if (!win.cycle || win.cycle.heldConfirmed) {
    return false;
  }

  win.cycle.holdPending = false;
  win.cycle.heldConfirmed = true;
  cancelHoldConfirmation(windowId);
  writeDiag("hold confirmed", {
    windowId,
    sessionId: win.cycle.sessionId ?? "none",
    renderTarget: win.cycle.renderTarget ?? "overlay",
  });

  const snapshot = serializeWindowSnapshot(windowId, tabs, activeTab, win);
  if (win.cycle.renderTarget === "popup") {
    try {
      await chrome.action.openPopup();
      writeDiag("list reveal", {
        windowId,
        sessionId: win.cycle.sessionId,
        renderTarget: "popup",
      });
    } catch {
      // A popup failure must not turn a timer into a false UI claim. The
      // physical session remains live and Option-up still commits safely.
      writeDiag("list reveal", {
        windowId,
        sessionId: win.cycle.sessionId,
        renderTarget: "popup",
        result: "unavailable",
      });
      win.cycle.holdPending = false;
      win.cycle.heldConfirmed = false;
      await persistState();
      return true;
    }
    await persistState();
    await broadcastSnapshot(windowId);
    return true;
  }

  const visible = await showCycleOverlay(
    win.cycle.originTabId,
    win.cycle.releaseToken,
    snapshot,
  );

  if (!visible) {
    await silentCommit(windowId, win, activeTab, win.cycle.currentTabId);
    return true;
  }

  await persistState();
  await broadcastSnapshot(windowId);
  return true;
}

async function confirmHold(windowId, expectedSessionId) {
  await getState();
  const win = getWindowState(windowId);
  const cycle = win.cycle;
  if (!cycle || !cycle.holdPending) {
    return;
  }

  if (cycle.sessionId !== expectedSessionId) {
    writeDiag("pending hold stale", {
      reason: "timer-session-mismatch",
      windowId,
      expectedSessionId: expectedSessionId ?? "none",
      cycleSessionId: cycle.sessionId ?? "none",
    });
    return;
  }
  if (!canConfirmHold(cycle)) {
    writeDiag("hold confirmed", {
      windowId,
      sessionId: cycle.sessionId ?? "none",
      result: "skipped-physical-state-unknown",
    });
    cancelHoldConfirmation(windowId);
    return;
  }

  const tabs = await getTabsForWindow(windowId);
  const activeTab = getActiveTab(tabs);
  if (!activeTab) {
    return;
  }

  await showCycleList(windowId, win, tabs, activeTab);
}

async function recordActivation(windowId, tabId) {
  await getState();
  const tabs = await getTabsForWindow(windowId);
  const win = reconcileWindow(windowId, tabs, tabId);

  if (win.cycle?.preserveOnActivation) {
    win.cycle.preserveOnActivation = false;
    writeDiag("tab activation preserved cycle", {
      windowId,
      sessionId: win.cycle.sessionId,
      tabId,
    });
  } else {
    commitWindowCycle(win);
  }
  win.order = moveToFront(win.order, tabId);

  await persistState();
  await broadcastSnapshot(windowId);
}

async function removeTab(tabId) {
  await getState();

  for (const [key, win] of Object.entries(state.windows)) {
    win.order = removeId(win.order, tabId);
    if (!win.cycle) {
      continue;
    }

    win.cycle.candidateIds = removeId(win.cycle.candidateIds, tabId);
    if (
      win.cycle.originTabId === tabId
      || win.cycle.currentTabId === tabId
    ) {
      win.cycle = null;
      cancelHoldConfirmation(Number(key));
    }
  }

  await persistState();
}

async function endCycle(
  commandTab,
  releaseToken = null,
  { suppress = true, reason = "option-release" } = {},
) {
  await getState();
  const hadMsgWindowId = Number.isInteger(commandTab?.windowId);
  const windowId = await resolveWindowId(commandTab);
  if (isDiagnosticsEnabled()) {
    console.log(
      `[RC-diag] cycle-end HANDLED window=${windowId} hadMsgWindowId=${hadMsgWindowId} `
        + `releaseToken=${typeof releaseToken === "string" ? "yes" : "no"}`,
    );
  }
  if (!Number.isInteger(windowId)) {
    return { windowId: null, tabs: [], shortcutStatus: await getShortcutStatus() };
  }

  const tabs = await getTabsForWindow(windowId);
  const activeTab = getActiveTab(tabs);
  if (isDiagnosticsEnabled()) {
    console.log(
      `[RC-diag] cycle-end resolve src=${hadMsgWindowId ? "message.windowId" : "lastFocusedWindow"} `
        + `window=${windowId} activeTab=${activeTab?.id ?? "none"}`,
    );
  }
  if (!activeTab) {
    return { windowId, tabs: [], shortcutStatus: await getShortcutStatus() };
  }

  const win = reconcileWindow(windowId, tabs, activeTab.id);
  const cycle = win.cycle;
  if (isDiagnosticsEnabled()) {
    const suppressUntilDelta = win.suppressUntil - Date.now();
    const tokenOk = !releaseToken || (cycle && cycle.releaseToken === releaseToken);
    console.log(
      `[RC-diag] cycle-end state cycle=${Boolean(cycle)} releaseToken=${cycle?.releaseToken ?? "null"} `
        + `renderTarget=${cycle?.renderTarget ?? "null"} currentTabId=${cycle?.currentTabId ?? "null"} `
        + `activeTab=${activeTab.id} suppressUntilDelta=${suppressUntilDelta}`,
    );
    console.log(
      `[RC-diag] cycle-end decision token=${!cycle ? "no-cycle" : (tokenOk ? "matched" : "MISMATCHED")} `
        + `releaseTokenSupplied=${typeof releaseToken === "string" ? "yes" : "no"} window=${windowId}`,
    );
  }
  if (!cycle || (releaseToken && cycle.releaseToken !== releaseToken)) {
    return createSnapshot(windowId);
  }

  const selectedTabId = cycle.currentTabId;
  const originTabId = cycle.originTabId;
  const activeReleaseToken = cycle.releaseToken;
  if (isDiagnosticsEnabled()) {
    console.log(
      `[RC-diag] cycle-end commit selected=${selectedTabId} `
        + `selectedIsActive=${selectedTabId === activeTab.id ? "yes-noop" : "no"} activeTab=${activeTab.id} window=${windowId}`,
    );
  }
  commitWindowCycle(win);
  cancelHoldConfirmation(windowId);
  recentAdvanceAt.delete(windowKey(windowId));
  win.suppressUntil = suppress ? Date.now() + GHOST_SUPPRESS_MS : 0;
  writeDiag("commit", {
    reason,
    windowId,
    sessionId: cycle.sessionId ?? "none",
    suppress: suppress ? "ghost-only" : "none",
  });
  if (!cycle.heldConfirmed) {
    writeDiag("fast commit", {
      reason,
      windowId,
      sessionId: cycle.sessionId ?? "none",
      selectedTabId,
    });
  }
  await persistState();
  await hideCycleOverlay(originTabId, activeReleaseToken);

  if (Number.isInteger(selectedTabId) && selectedTabId !== activeTab.id) {
    try {
      await chrome.tabs.update(selectedTabId, { active: true });
    } catch {
      win.order = removeId(win.order, selectedTabId);
      await persistState();
    }
  }

  const snapshot = await createSnapshot(windowId);
  try {
    await chrome.runtime.sendMessage({
      type: "CYCLE_ENDED",
      snapshot,
    });
  } catch {
    // No extension page is listening.
  }
  return snapshot;
}

async function reconcileAllWindows() {
  await getState();
  const tabs = await chrome.tabs.query({});
  const byWindow = new Map();

  for (const tab of tabs) {
    if (!Number.isInteger(tab.windowId)) {
      continue;
    }
    const list = byWindow.get(tab.windowId) ?? [];
    list.push(tab);
    byWindow.set(tab.windowId, list);
  }

  for (const [windowId, windowTabs] of byWindow) {
    reconcileWindow(windowId, windowTabs, getActiveTab(windowTabs)?.id);
  }

  for (const key of Object.keys(state.windows)) {
    if (!byWindow.has(Number(key))) {
      delete state.windows[key];
    }
  }

  await persistState();
}

chrome.commands.onCommand.addListener((command, tab) => {
  if (command !== "cycle-forward" && command !== "cycle-reverse") {
    return;
  }

  const direction = command === "cycle-forward" ? "forward" : "reverse";
  const fireTs = Date.now();
  void enqueue(() => handleCycle(direction, tab, fireTs));
});

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  void enqueue(() => recordActivation(windowId, tabId));
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueue(() => removeTab(tabId));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "loading" || !Number.isInteger(tab?.windowId)) {
    return;
  }

  void enqueue(async () => {
    await getState();
    const win = getWindowState(tab.windowId);
    if (win.cycle?.originTabId !== tabId) {
      return;
    }

    win.cycle = null;
    cancelHoldConfirmation(tab.windowId);
    await persistState();
    await broadcastSnapshot(tab.windowId);
  });
});

chrome.runtime.onStartup.addListener(() => {
  void enqueue(reconcileAllWindows);
});

chrome.runtime.onInstalled.addListener(() => {
  void enqueue(async () => {
    await getState();
    await reconcileAllWindows();
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (isDiagnosticsEnabled() && message?.type === "OVERLAY_READY") {
    console.log(
      `[RC-diag] ${message.correlationId} overlay init wallTs=${message.initTs} `
        + `injectionLatencyMs=${message.initTs - message.commandFireTs} `
        + `initPerfTs=${Number(message.initPerfTs).toFixed(2)}`,
    );
    return false;
  }

  if (isDiagnosticsEnabled() && message?.type === "DIAG_KEY") {
    console.log(
      `[RC-diag] ${message.correlationId} ${message.eventType} key=${message.key} code=${message.code} `
        + `altKey=${message.altKey} shiftKey=${message.shiftKey} `
        + `perfTs=${Number(message.ts).toFixed(2)} wallTs=${message.wallTs}`,
    );
    return false;
  }

  if (message?.type === "GET_SNAPSHOT") {
    void enqueue(async () => {
      const windowId = await resolveWindowId(sender.tab);
      if (!Number.isInteger(windowId)) {
        return {
          windowId: null,
          tabs: [],
          shortcutStatus: await getShortcutStatus(),
        };
      }

      return createSnapshot(windowId);
    }).then(sendResponse).catch((error) => {
      sendResponse({
        error: error instanceof Error ? error.message : "Unable to read tab state",
      });
    });
    return true;
  }

  if (message?.type === "ACTIVATE_TAB" && Number.isInteger(message.tabId)) {
    const hadMsgWindowId = Number.isInteger(message.windowId);
    const releaseTokenStr = typeof message.releaseToken === "string";
    if (isDiagnosticsEnabled()) {
      console.log(
        `[RC-diag] ACTIVATE_TAB HANDLED window=${message.windowId ?? "none"} `
          + `hadMsgWindowId=${hadMsgWindowId} releaseToken=${releaseTokenStr ? "yes" : "no"} tabId=${message.tabId}`,
      );
    }
    void enqueue(async () => {
      await getState();
      const tab = await chrome.tabs.get(message.tabId);
      // Guard against a stale/cross-window popup claiming a specific window:
      // if a windowId was supplied on the message it must match the tab's
      // actual window, otherwise the request is stale or malformed — no-op.
      if (
        Number.isInteger(message.windowId)
        && message.windowId !== tab.windowId
      ) {
        if (isDiagnosticsEnabled()) {
          console.log(
            `[RC-diag] popup-message-dropped: window-mismatch tab=${message.tabId} `
              + `msgWindow=${message.windowId} actualWindow=${tab.windowId}`,
          );
        }
        return createSnapshot(tab.windowId);
      }
      const win = getWindowState(tab.windowId);
      if (isDiagnosticsEnabled()) {
        const cycle = win.cycle;
        console.log(
          `[RC-diag] ACTIVATE_TAB resolve src=tabLookup window=${tab.windowId} `
            + `cycle=${Boolean(cycle)} releaseToken=${cycle?.releaseToken ?? "null"} `
            + `renderTarget=${cycle?.renderTarget ?? "null"} currentTabId=${cycle?.currentTabId ?? "null"} `
            + `tabId=${message.tabId} suppressUntilDelta=${win.suppressUntil - Date.now()}`,
        );
      }
      commitWindowCycle(win);
      win.order = moveToFront(win.order, tab.id);
      await chrome.tabs.update(tab.id, { active: true });
      await persistState();
      if (isDiagnosticsEnabled()) {
        console.log(
          `[RC-diag] ACTIVATE_TAB commit window=${tab.windowId} tabId=${message.tabId} `
            + `noTokenValidation=true (popup fallback session committed)`,
        );
      }
      return createSnapshot(tab.windowId);
    }).then(sendResponse).catch((error) => {
      sendResponse({
        error: error instanceof Error ? error.message : "Unable to activate tab",
      });
    });
    return true;
  }

  if (message?.type === "END_CYCLE") {
    const commandTab = Number.isInteger(message.windowId)
      ? { windowId: message.windowId }
      : sender.tab;
    void enqueue(() => endCycle(commandTab))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          error: error instanceof Error ? error.message : "Unable to end cycle",
        });
      });
    return true;
  }

  if (message?.type === "OPTION_RELEASED" && typeof message.releaseToken === "string") {
    if (isDiagnosticsEnabled()) {
      console.log(
        `[RC-diag] OPTION_RELEASED HANDLED window=${message.windowId ?? "none"} `
          + `hadMsgWindowId=${Number.isInteger(message.windowId)} releaseToken=yes`,
      );
    }
    const commandTab = Number.isInteger(message.windowId)
      ? { windowId: message.windowId }
      : sender.tab;
    void enqueue(() => endCycle(commandTab, message.releaseToken, {
      suppress: false,
      reason: "content-option-up",
    }))
      .then(sendResponse)
      .catch((error) => {
        sendResponse({
          error: error instanceof Error ? error.message : "Unable to end cycle",
        });
      });
    return true;
  }

  if (
    message?.type === "POPUP_ADVANCE"
    && typeof message.releaseToken === "string"
    && (message.direction === "forward" || message.direction === "reverse")
  ) {
    if (isDiagnosticsEnabled()) {
      console.log(
        `[RC-diag] POPUP_ADVANCE HANDLED window=${message.windowId ?? "none"} `
          + `hadMsgWindowId=${Number.isInteger(message.windowId)} releaseToken=yes `
          + `direction=${message.direction}`,
      );
    }
    void enqueue(async () => {
      await getState();
      // The popup has no sender.tab, and lastFocusedWindow tab queries are
      // unreliable while the popup is open — the popup ships its windowId.
      const fromMsgWindow = Number.isInteger(message.windowId);
      const windowId = fromMsgWindow
        ? message.windowId
        : await resolveWindowId(sender.tab);
      if (!Number.isInteger(windowId)) {
        if (isDiagnosticsEnabled()) {
          console.log(
            `[RC-diag] POPUP_ADVANCE dropped src=${fromMsgWindow ? "message.windowId" : "lastFocusedWindow"} `
              + `windowId=unresolved direction=${message.direction}`,
          );
        }
        return;
      }

      const tabs = await getTabsForWindow(windowId);
      const activeTab = getActiveTab(tabs);
      if (!activeTab) {
        if (isDiagnosticsEnabled()) {
          console.log(
            `[RC-diag] POPUP_ADVANCE dropped src=${fromMsgWindow ? "message.windowId" : "lastFocusedWindow"} `
              + `window=${windowId} activeTab=none`,
          );
        }
        return;
      }

      const win = reconcileWindow(windowId, tabs, activeTab.id);
      const cycle = win.cycle;
      if (isDiagnosticsEnabled()) {
        const tokenOk = cycle?.releaseToken === message.releaseToken;
        const renderTargetOk = cycle?.renderTarget === "popup";
        console.log(
          `[RC-diag] POPUP_ADVANCE resolve src=${fromMsgWindow ? "message.windowId" : "lastFocusedWindow"} `
            + `window=${windowId} cycle=${Boolean(cycle)} releaseToken=${cycle?.releaseToken ?? "null"} `
            + `renderTarget=${cycle?.renderTarget ?? "null"} currentTabId=${cycle?.currentTabId ?? "null"} `
            + `activeTab=${activeTab.id} suppressUntilDelta=${win.suppressUntil - Date.now()} `
            + `token=${!cycle ? "no-cycle" : (tokenOk ? "matched" : "MISMATCHED")} `
            + `renderTargetCheck=${!cycle ? "no-cycle" : (renderTargetOk ? "passed" : "FAILED")}`,
        );
      }
      if (
        win.cycle?.releaseToken !== message.releaseToken
        || win.cycle.renderTarget !== "popup"
      ) {
        if (isDiagnosticsEnabled()) {
          console.log(`[RC-diag] POPUP_ADVANCE dropped: token/renderTarget mismatch window=${windowId}`);
        }
        return;
      }

      if (isDiagnosticsEnabled()) {
        console.log(
          `[RC-diag] POPUP_ADVANCE accepted direction=${message.direction} window=${windowId} `
            + `currentTabId=${win.cycle.currentTabId}`,
        );
      }
      await advanceLiveCycle(message.direction, windowId, win, tabs, activeTab, null);
    });
    return false;
  }

  if (message?.type === "CANCEL_CYCLE" && typeof message.releaseToken === "string") {
    if (isDiagnosticsEnabled()) {
      console.log(
        `[RC-diag] CANCEL_CYCLE HANDLED window=${message.windowId ?? "none"} `
          + `hadMsgWindowId=${Number.isInteger(message.windowId)} releaseToken=yes`,
      );
    }
    void enqueue(async () => {
      await getState();
      const fromMsgWindow = Number.isInteger(message.windowId);
      const windowId = fromMsgWindow
        ? message.windowId
        : await resolveWindowId(sender.tab);
      if (!Number.isInteger(windowId)) {
        if (isDiagnosticsEnabled()) {
          console.log(
            `[RC-diag] CANCEL_CYCLE dropped src=${fromMsgWindow ? "message.windowId" : "lastFocusedWindow"} `
              + `windowId=unresolved`,
          );
        }
        return;
      }

      const win = getWindowState(windowId);
      const cycle = win.cycle;
      if (isDiagnosticsEnabled()) {
        const tokenOk = cycle?.releaseToken === message.releaseToken;
        console.log(
          `[RC-diag] CANCEL_CYCLE resolve src=${fromMsgWindow ? "message.windowId" : "lastFocusedWindow"} `
            + `window=${windowId} cycle=${Boolean(cycle)} releaseToken=${cycle?.releaseToken ?? "null"} `
            + `renderTarget=${cycle?.renderTarget ?? "null"} currentTabId=${cycle?.currentTabId ?? "null"} `
            + `suppressUntilDelta=${win.suppressUntil - Date.now()} `
            + `token=${!cycle ? "no-cycle" : (tokenOk ? "matched" : "MISMATCHED")}`,
        );
      }
      if (win.cycle?.releaseToken !== message.releaseToken) {
        if (isDiagnosticsEnabled()) {
          console.log(`[RC-diag] CANCEL_CYCLE dropped: token mismatch window=${windowId}`);
        }
        return;
      }

      if (isDiagnosticsEnabled()) {
        console.log(`[RC-diag] CANCEL_CYCLE cleared window=${windowId}`);
      }
      win.cycle = null;
      cancelHoldConfirmation(windowId);
      recentAdvanceAt.delete(windowKey(windowId));
      await persistState();
      await broadcastSnapshot(windowId);
    });
    return false;
  }

  if (message?.type === "OPEN_SHORTCUTS") {
    void chrome.tabs.create({ url: "chrome://extensions/shortcuts" })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "OPEN_COMPANION_GUIDE") {
    void chrome.tabs.create({ url: chrome.runtime.getURL("companion.html") })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});

connectNativeCompanion();
