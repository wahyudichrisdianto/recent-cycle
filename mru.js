export function uniqueIds(values) {
  const seen = new Set();
  const result = [];

  for (const value of values ?? []) {
    if (!Number.isInteger(value) || seen.has(value)) {
      continue;
    }

    seen.add(value);
    result.push(value);
  }

  return result;
}

export function moveToFront(order, tabId) {
  return [tabId, ...order.filter((id) => id !== tabId)];
}

export function removeId(order, tabId) {
  return order.filter((id) => id !== tabId);
}

export function reconcileOrder(order, tabIds, activeTabId) {
  const validIds = new Set(tabIds);
  const existing = uniqueIds(order).filter((id) => validIds.has(id));
  const existingIds = new Set(existing);
  const missing = tabIds.filter((id) => !existingIds.has(id));
  const next = [...existing, ...missing];

  if (activeTabId !== undefined && validIds.has(activeTabId) && !next.includes(activeTabId)) {
    next.unshift(activeTabId);
  }

  return next;
}

export function createCycle(order, originTabId) {
  const originPosition = Math.max(0, order.indexOf(originTabId));

  return {
    originTabId,
    candidateIds: [...order],
    position: originPosition,
    currentTabId: originTabId,
  };
}

export function advanceCycle(cycle, direction) {
  const length = cycle.candidateIds.length;

  if (length < 2) {
    return {
      cycle,
      targetId: null,
    };
  }

  let position;
  if (direction === "reverse") {
    position = cycle.position < 0
      ? length - 1
      : (cycle.position - 1 + length) % length;
  } else {
    position = cycle.position < 0
      ? 0
      : (cycle.position + 1) % length;
  }

  const targetId = cycle.candidateIds[position];

  return {
    cycle: {
      ...cycle,
      position,
      currentTabId: targetId,
    },
    targetId,
  };
}

export function commitCycle(order, cycle) {
  if (!cycle || cycle.currentTabId === undefined || cycle.currentTabId === null) {
    return order;
  }

  return moveToFront(order, cycle.currentTabId);
}
