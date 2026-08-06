const KEY_EVENTS = new Set(["option", "shift", "tab"]);
const PHASES = new Set(["down", "up"]);

export function createGestureState() {
  return {
    connected: false,
    ready: false,
    capability: null,
    lastSequence: 0,
    optionDown: false,
    shiftDown: false,
    tabDown: false,
    nextSessionId: 1,
    activeSession: null,
  };
}

export function markGestureConnected(state, capability = null) {
  state.connected = true;
  state.ready = Boolean(capability?.optionLifecycle);
  state.capability = capability;
  return state;
}

export function markGestureDisconnected(state) {
  const endedSession = state.activeSession;
  state.connected = false;
  state.ready = false;
  state.capability = null;
  state.optionDown = false;
  state.shiftDown = false;
  state.tabDown = false;
  state.activeSession = null;
  return endedSession;
}

function beginSession(state, timestampMs, sequence) {
  const session = {
    sessionId: state.nextSessionId++,
    startedAt: timestampMs,
    firstInputAt: null,
    lastInputSequence: null,
  };
  state.activeSession = session;
  return session;
}

function normalizeTimestamp(value) {
  return Number.isFinite(value) ? value : Date.now();
}

export function applyNativeGestureMessage(state, message) {
  if (!message || message.version !== 1) {
    return { kind: "invalid", reason: "version" };
  }

  if (message.type !== "key-event" && message.type !== "keyboard-state") {
    return { kind: "ignored", reason: "message-type" };
  }

  if (!Number.isSafeInteger(message.sequence) || message.sequence <= 0) {
    return { kind: "invalid", reason: "sequence" };
  }

  if (!["optionDown", "shiftDown", "tabDown"].every((field) => typeof message[field] === "boolean")) {
    return { kind: "invalid", reason: "modifier-state" };
  }

  if (
    (message.type === "key-event" && (!KEY_EVENTS.has(message.key) || !PHASES.has(message.phase)))
    || (message.type === "keyboard-state" && (message.key !== undefined || message.phase !== undefined))
  ) {
    return { kind: "invalid", reason: "key-event" };
  }

  if (message.sequence <= state.lastSequence) {
    return { kind: "stale", sequence: message.sequence, lastSequence: state.lastSequence };
  }

  const timestampMs = normalizeTimestamp(message.timestampMs);
  const previousOptionDown = state.optionDown;
  state.lastSequence = message.sequence;
  state.optionDown = message.optionDown === true;
  state.shiftDown = message.shiftDown === true;
  state.tabDown = message.tabDown === true;

  let sessionEvent = null;
  if (!previousOptionDown && state.optionDown) {
    const session = beginSession(state, timestampMs, message.sequence);
    sessionEvent = { kind: "option-down", sessionId: session.sessionId, sequence: message.sequence };
  } else if (previousOptionDown && !state.optionDown) {
    const sessionId = state.activeSession?.sessionId ?? null;
    state.activeSession = null;
    sessionEvent = { kind: "option-up", sessionId, sequence: message.sequence };
  }

  if (
    message.type === "key-event"
  ) {
    if (message.key === "tab" && message.phase === "down" && state.activeSession) {
      state.activeSession.lastInputSequence = message.sequence;
      state.activeSession.firstInputAt ??= timestampMs;
    }
    return {
      kind: "key-event",
      key: message.key,
      phase: message.phase,
      sequence: message.sequence,
      sessionId: state.activeSession?.sessionId ?? sessionEvent?.sessionId ?? null,
      optionDown: state.optionDown,
      shiftDown: state.shiftDown,
      tabDown: state.tabDown,
      sessionEvent,
    };
  }

  return {
    kind: "keyboard-state",
    sequence: message.sequence,
    sessionId: state.activeSession?.sessionId ?? sessionEvent?.sessionId ?? null,
    optionDown: state.optionDown,
    shiftDown: state.shiftDown,
    tabDown: state.tabDown,
    sessionEvent,
  };
}

export function currentInputIdentity(state) {
  if (!state.connected || !state.ready || !state.optionDown || !state.activeSession) {
    return {
      sessionId: null,
      inputSequence: null,
      inputSource: "degraded",
      optionDown: state.optionDown,
    };
  }

  return {
    sessionId: state.activeSession.sessionId,
    inputSequence: state.activeSession.lastInputSequence,
    inputSource: "native",
    optionDown: true,
  };
}
