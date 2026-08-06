const configView = document.querySelector("#config-view");
const recentView = document.querySelector("#recent-section");
const tabList = document.querySelector("#tab-list");
const emptyState = document.querySelector("#empty-state");
const shortcutWarning = document.querySelector("#shortcut-warning");
const companionPanel = document.querySelector("#companion-panel");
const companionWarning = document.querySelector("#companion-warning");
const companionCopy = document.querySelector("#companion-copy");
const companionState = document.querySelector("#companion-state");
const warningCopy = document.querySelector("#warning-copy");
const howto = document.querySelector("#howto");
const openShortcuts = document.querySelector("#open-shortcuts");
const openCompanionGuide = document.querySelector("#open-companion-guide");
const fallbackHint = document.querySelector("#fallback-hint");
const showRecent = document.querySelector("#show-recent");
const closeRecent = document.querySelector("#close-recent");
const activePageTitle = document.querySelector("#active-page-title");
const activePageHost = document.querySelector("#active-page-host");
const pageBadge = document.querySelector("#page-badge");
const tabCount = document.querySelector("#tab-count");
const platformLabel = document.querySelector("#platform-label");
const resetShortcutsBtn = document.querySelector("#reset-shortcuts");
const shortcutForward = document.querySelector("#shortcut-forward");
const shortcutReverse = document.querySelector("#shortcut-reverse");
const footerForward = document.querySelector("#footer-forward");
let releaseSent = false;
let fallbackToken = null;
let fallbackWindowId = null;
let fallbackInteracted = false;
let selectedTabId = null;
let settleAttempts = 0;
let recentVisible = false;
let latestSnapshot = null;
let isEditingShortcuts = false;
let customShortcuts = {};

const themeOptions = document.querySelectorAll(".theme-option");

function applyTheme(mode) {
  document.documentElement.dataset.theme = mode;
  themeOptions.forEach((el) => {
    const active = el.dataset.themeChoice === mode;
    el.classList.toggle("is-active", active);
    el.setAttribute("aria-checked", String(active));
  });
}

if (typeof chrome !== "undefined" && chrome.storage?.local) {
  chrome.storage.local.get(["customShortcuts"], (res) => {
    if (res?.customShortcuts) {
      customShortcuts = res.customShortcuts;
      if (latestSnapshot) render(latestSnapshot);
    }
  });

  chrome.storage.local.get(["theme"], (res) => {
    const mode = res?.theme === "light" || res?.theme === "dark" ? res.theme : "system";
    applyTheme(mode);
  });

  themeOptions.forEach((el) => {
    el.addEventListener("click", () => {
      const mode = el.dataset.themeChoice;
      applyTheme(mode);
      chrome.storage.local.set({ theme: mode });
    });
  });

  chrome.storage.onChanged?.addListener((changes, area) => {
    if (area === "local" && changes.theme) {
      const next = changes.theme.newValue;
      const mode = next === "light" || next === "dark" ? next : "system";
      applyTheme(mode);
    }
  });
}

function setShortcutValue(kbdEl, inputEl, text) {
  if (kbdEl) kbdEl.textContent = text;
  if (inputEl) {
    inputEl.value = text;
    inputEl.dataset.committed = text;
  }
}

function updateShortcutDisplayMode() {
  const kbdEls = document.querySelectorAll(".shortcut-keys");
  const inputEls = document.querySelectorAll(".shortcut-input");
  kbdEls.forEach((el) => { el.hidden = isEditingShortcuts; });
  inputEls.forEach((el) => { el.hidden = !isEditingShortcuts; });
  if (openShortcuts) {
    openShortcuts.textContent = isEditingShortcuts ? "Done" : "Edit ↗";
  }
  if (resetShortcutsBtn) {
    resetShortcutsBtn.hidden = !isEditingShortcuts;
  }
  if (platformLabel) {
    platformLabel.hidden = isEditingShortcuts;
  }
}

function resetShortcuts() {
  customShortcuts = {};
  if (typeof chrome !== "undefined" && chrome.storage?.local) {
    void chrome.storage.local.set({ customShortcuts });
  }
  isEditingShortcuts = false;
  if (latestSnapshot) {
    render(latestSnapshot);
  }
  updateShortcutDisplayMode();
}

function isOptionKey(event) {
  return event.key === "Alt"
    || event.key === "Option"
    || event.code === "AltLeft"
    || event.code === "AltRight";
}

function focusLabel() {
  return `focused=${document.hasFocus() ? 1 : 0}/visible=${document.visibilityState}`;
}

function endCycleAndClose() {
  console.log(
    `[RC-popup] endCycleAndClose entry releaseSent=${releaseSent} ${focusLabel()}`,
  );
  if (releaseSent) {
    return;
  }

  releaseSent = true;
  fallbackInteracted = true;
  if (Number.isInteger(selectedTabId)) {
    // Release behaves exactly like Enter/click: activate the visible
    // selection directly. ACTIVATE_TAB needs no cycle token, so it survives
    // a mid-session token/cycle invalidation (e.g. the origin new-tab page
    // reloading) that would otherwise make the release a silent no-op.
    console.log(`[RC-popup] keyup Option -> ACTIVATE_TAB ${selectedTabId}`);
    void chrome.runtime.sendMessage({ type: "ACTIVATE_TAB", tabId: selectedTabId })
      .finally(() => window.close());
    return;
  }

  // No visible selection yet (render race): fall back to the session commit.
  const message = fallbackToken
    ? { type: "OPTION_RELEASED", releaseToken: fallbackToken, windowId: fallbackWindowId }
    : { type: "END_CYCLE", windowId: fallbackWindowId };
  console.log(
    `[RC-popup] endCycleAndClose send ${message.type} token=${fallbackToken} ` +
      `windowId=${fallbackWindowId} selectedTabId=${selectedTabId}`,
  );
  void chrome.runtime.sendMessage(message)
    .finally(() => window.close());
}

function cancelFallbackAndClose() {
  const releaseToken = fallbackToken;
  const windowId = fallbackWindowId;
  fallbackToken = null;
  fallbackInteracted = false;
  console.log(
    `[RC-popup] cancelFallbackAndClose send CANCEL_CYCLE releaseToken=${releaseToken} ` +
      `windowId=${windowId} ${focusLabel()}`,
  );
  void chrome.runtime.sendMessage({ type: "CANCEL_CYCLE", releaseToken, windowId })
    .finally(() => window.close());
}

function escapeText(value) {
  return String(value ?? "");
}

function platformInfo() {
  const platform = [
    navigator.userAgentData?.platform,
    navigator.platform,
    navigator.userAgent,
  ].filter(Boolean).join(" ");

  if (/mac/i.test(platform)) {
    return {
      key: "mac",
      label: "macOS",
      forward: "Option+Tab",
      reverse: "Option+Shift+Tab",
    };
  }

  if (/win/i.test(platform)) {
    return {
      key: "windows",
      label: "Windows",
      forward: "Ctrl+Shift+9",
      reverse: "Ctrl+Shift+0",
    };
  }

  return {
    key: "linux",
    label: "Linux",
    forward: "Ctrl+Shift+9",
    reverse: "Ctrl+Shift+0",
  };
}

const KEY_GLYPHS = {
  Tab: "⇥",
  Space: "Space",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function formatShortcut(shortcut, platform = platformInfo()) {
  if (!shortcut) {
    return "Not set";
  }

  return String(shortcut)
    .split("+")
    .map((part) => {
      const value = part.trim();
      if (value === "Option" || (value === "Alt" && platform.key === "mac")) return "⌥";
      if (value === "Shift") return "⇧";
      if (value === "Command") return "⌘";
      if (value === "MacCtrl") return "⌃";
      if (value === "Control") return "Ctrl";
      return KEY_GLYPHS[value] ?? value;
    })
    .join(" ");
}

function commandShortcut(status, name, fallback, platform) {
  if (customShortcuts && customShortcuts[name]) {
    return customShortcuts[name];
  }
  const command = status.find((entry) => entry.name === name);
  if (command && command.shortcut) {
    return formatShortcut(command.shortcut, platform);
  }
  return status.length === 0 ? formatShortcut(fallback, platform) : "Not set";
}

function renderContext(snapshot) {
  const page = snapshot.activePage ?? {};
  const kind = page.kind === "standard" ? "ready" : "restricted";
  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const count = Number.isInteger(snapshot.tabCount) ? snapshot.tabCount : tabs.length;
  const activeTabObj = tabs.find((t) => t.selected || t.active);
  const targetPage = {
    ...page,
    url: page.url || activeTabObj?.url,
    favIconUrl: page.favIconUrl || activeTabObj?.favIconUrl,
    host: page.host || activeTabObj?.host,
  };

  if (activePageTitle) activePageTitle.textContent = page.title || "Current tab";
  if (activePageHost) activePageHost.textContent = page.host || "Local browser context";

  const fallbackSymbol = page.kind === "newtab" ? "⌂" : (kind === "ready" ? "↯" : "◇");
  const faviconUrl = resolveFaviconUrl(targetPage);

  if (pageBadge) {
    pageBadge.replaceChildren();
    if (faviconUrl) {
      const img = document.createElement("img");
      img.className = "context-favicon";
      img.src = faviconUrl;
      img.alt = "";
      img.onerror = () => {
        const domainFallback = (targetPage.host && targetPage.host !== "Local browser context" && !targetPage.host.includes(":"))
          ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(targetPage.host)}&sz=64`
          : null;
        if (domainFallback && img.src !== domainFallback) {
          img.src = domainFallback;
        } else {
          pageBadge.replaceChildren(document.createTextNode(fallbackSymbol));
        }
      };
      pageBadge.append(img);
    } else {
      pageBadge.textContent = fallbackSymbol;
    }
  }

  if (tabCount) tabCount.textContent = String(count);
}

function renderShortcuts(snapshot) {
  const platform = platformInfo();
  const status = snapshot.shortcutStatus ?? [];
  const forward = commandShortcut(status, "cycle-forward", platform.forward, platform);
  const reverse = commandShortcut(status, "cycle-reverse", platform.reverse, platform);

  const forwardInput = document.querySelector("#shortcut-forward-input");
  const reverseInput = document.querySelector("#shortcut-reverse-input");

  if (platformLabel) platformLabel.textContent = platform.label;
  setShortcutValue(shortcutForward, forwardInput, forward);
  setShortcutValue(shortcutReverse, reverseInput, reverse);
  if (footerForward) footerForward.textContent = forward;
}

function renderWarnings(snapshot) {
  const status = snapshot.shortcutStatus ?? [];
  const inactive = status.filter((command) => !command.active);
  const messages = [];

  if (status.length === 0) {
    messages.push("Chrome did not report the Recent Cycle shortcuts. Open shortcut settings to verify the bindings.");
  } else if (inactive.length > 0) {
    messages.push("One or more Recent Cycle shortcuts are not active. Chrome may have reserved or unassigned the combination.");
  }

  if (messages.length === 0) {
    if (shortcutWarning) shortcutWarning.hidden = true;
    if (openShortcuts) openShortcuts.hidden = false;
    return;
  }

  if (shortcutWarning) shortcutWarning.hidden = false;
  if (openShortcuts) openShortcuts.hidden = false;
  if (warningCopy) warningCopy.textContent = messages.join(" ");
}

function renderHowto(snapshot) {
  if (howto) howto.hidden = !snapshot.cycling;
}

function renderCompanion(snapshot) {
  const companion = snapshot.companion ?? {};
  const ready = Boolean(companion.ready);
  const connected = Boolean(companion.connected);

  const shortcutHoldRow = document.querySelector("#shortcut-hold-row");
  const shortcutHoldHelp = document.querySelector("#shortcut-hold-help");
  const shortcutHold = document.querySelector("#shortcut-hold");

  if (shortcutHoldRow) {
    shortcutHoldRow.classList.toggle("is-disabled", !ready);
    if (shortcutHoldHelp) {
      shortcutHoldHelp.textContent = ready
        ? "Preserves hold state on protected Chrome pages"
        : "Standard pages only · Requires local companion setup for protected pages";
    }
    const shortcutHoldInput = document.querySelector("#shortcut-hold-input");
    const holdText = ready ? "⌥ Hold" : "Standard only";
    setShortcutValue(shortcutHold, shortcutHoldInput, holdText);
  }

  const page = snapshot.activePage ?? {};
  const isProtectedPage = Boolean(page.kind && page.kind !== "standard");
  if (companionPanel) companionPanel.hidden = Boolean(snapshot.cycling) || !isProtectedPage;
  if (openCompanionGuide) openCompanionGuide.hidden = ready;
  if (companionState) {
    companionState.textContent = ready ? "Connected" : connected ? "Permission needed" : "Browser-only";
    companionState.classList.toggle("is-ready", ready);
  }
  if (companionCopy) {
    companionCopy.textContent = ready
      ? "The local companion is active and preserving modifier hold state across protected Chrome pages."
      : "All Tabs Cycle cannot hold state on this protected Chrome page. Run curl -fsSL https://elph.space/install.sh | bash to set up.";
  }
  if (companionWarning) {
    companionWarning.hidden = ready || Boolean(snapshot.cycling) || !isProtectedPage;
    companionWarning.textContent = connected
      ? "Allow Accessibility access in macOS settings for exact protected-page hold behavior."
      : "Run 'curl -fsSL https://elph.space/install.sh | bash' in Terminal to set up.";
  }
}

function render(snapshot) {
  latestSnapshot = snapshot;
  if (!snapshot || snapshot.error) {
    configView.hidden = false;
    recentView.hidden = true;
    if (activePageTitle) activePageTitle.textContent = "Unable to read the active tab";
    if (activePageHost) activePageHost.textContent = "Reload the extension and try again";
    if (tabCount) tabCount.textContent = "—";
    if (emptyState) emptyState.hidden = false;
    tabList.replaceChildren();
    return;
  }

  const tabs = Array.isArray(snapshot.tabs) ? snapshot.tabs : [];
  const cycling = Boolean(snapshot.cycling);
  if (cycling) {
    recentVisible = true;
  }


  if (snapshot.cycling && snapshot.fallbackSession) {
    fallbackToken = snapshot.releaseToken ?? fallbackToken;
    fallbackWindowId = snapshot.windowId ?? fallbackWindowId;
  } else if (!snapshot.cycling) {
    releaseSent = false;
    fallbackToken = null;
    fallbackWindowId = null;
    fallbackInteracted = false;
  }
  selectedTabId = tabs.find((tab) => tab.selected)?.id ?? null;
  console.log(
    `[RC-popup] render cycling=${snapshot.cycling} fallback=${snapshot.fallbackSession} `
      + `selected=${selectedTabId} token=${fallbackToken} ${focusLabel()}`,
  );
  const isRecentView = cycling || recentVisible;
  configView.hidden = isRecentView;
  recentView.hidden = !isRecentView;
  showRecent.setAttribute("aria-expanded", String(isRecentView));
  showRecent.setAttribute("aria-selected", String(isRecentView));
  showRecent.classList.toggle("is-active", isRecentView);
  closeRecent.setAttribute("aria-selected", String(!isRecentView));
  closeRecent.classList.toggle("is-active", !isRecentView);

  if (fallbackHint) fallbackHint.hidden = !(cycling && snapshot.fallbackSession);
  renderContext(snapshot);
  renderShortcuts(snapshot);
  renderWarnings(snapshot);
  renderHowto(snapshot);
  renderCompanion(snapshot);
  renderTabs(snapshot, tabs);
}

let currentActiveButton = null;

tabList.addEventListener("mouseleave", () => {
  currentActiveButton = null;
  updateTabIndicator(null);
});
tabList.addEventListener("scroll", () => {
  if (currentActiveButton) {
    updateTabIndicator(currentActiveButton);
  }
});

function updateTabIndicator(targetButton) {
  const indicator = document.querySelector("#tab-indicator");
  if (!indicator) return;

  if (!targetButton || !tabList.contains(targetButton) || targetButton.offsetParent === null) {
    indicator.style.opacity = "0";
    document.querySelectorAll(".tab-row").forEach((b) => b.classList.remove("is-active-indicator"));
    return;
  }

  const wrapper = document.querySelector(".tab-list-wrapper");
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : tabList.getBoundingClientRect();
  const buttonRect = targetButton.getBoundingClientRect();
  const top = buttonRect.top - wrapperRect.top;
  const left = buttonRect.left - wrapperRect.left;

  indicator.style.transform = `translate(${left}px, ${top}px)`;
  indicator.style.width = `${buttonRect.width}px`;
  indicator.style.height = `${buttonRect.height}px`;
  indicator.style.opacity = "1";
  document.querySelectorAll(".tab-row").forEach((b) => b.classList.remove("is-active-indicator"));
  targetButton.classList.add("is-active-indicator");
}

function resolveFaviconUrl(tab) {
  if (tab.favIconUrl && /^https?:\/\//i.test(tab.favIconUrl)) {
    return tab.favIconUrl;
  }
  if (tab.url && /^https?:\/\//i.test(tab.url) && typeof chrome !== "undefined" && chrome.runtime?.id) {
    return `chrome-extension://${chrome.runtime.id}/_favicon/?pageUrl=${encodeURIComponent(tab.url)}&size=64`;
  }
  if (tab.host && tab.host !== "Local tab" && !tab.host.includes(":")) {
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(tab.host)}&sz=64`;
  }
  return null;
}

function renderTabs(snapshot, tabs) {
  tabList.replaceChildren();
  emptyState.hidden = tabs.length > 0 || !(snapshot.cycling || recentVisible);

  let selectedButton = null;

  for (const tab of tabs) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab-row";
    button.classList.toggle("is-selected", tab.selected);
    button.setAttribute("aria-label", `Switch to ${escapeText(tab.title)}`);

    if (tab.selected) {
      selectedButton = button;
    }

    const badge = document.createElement("span");
    badge.className = "tab-badge";
    badge.textContent = escapeText(tab.initial);
    badge.setAttribute("aria-hidden", "true");

    let iconElement = badge;
    const initialFavicon = resolveFaviconUrl(tab);
    if (initialFavicon) {
      const img = document.createElement("img");
      img.className = "tab-favicon";
      img.src = initialFavicon;
      img.alt = "";
      img.onerror = () => {
        const fallbackUrl = (tab.host && tab.host !== "Local tab" && !tab.host.includes(":"))
          ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(tab.host)}&sz=64`
          : null;
        if (fallbackUrl && img.src !== fallbackUrl) {
          img.src = fallbackUrl;
        } else {
          img.replaceWith(badge);
        }
      };
      iconElement = img;
    }

    const copy = document.createElement("span");
    copy.className = "tab-copy";

    const title = document.createElement("span");
    title.className = "tab-title";
    title.textContent = escapeText(tab.title);

    const host = document.createElement("span");
    host.className = "tab-host";
    host.textContent = escapeText(tab.host || "Local tab");

    copy.append(title, host);
    button.append(iconElement, copy);

    button.addEventListener("mouseenter", () => {
      currentActiveButton = button;
      updateTabIndicator(button);
    });
    button.addEventListener("focusin", () => {
      currentActiveButton = button;
      updateTabIndicator(button);
    });
    button.addEventListener("click", () => {
      fallbackInteracted = true;
      void chrome.runtime.sendMessage({
        type: "ACTIVATE_TAB",
        tabId: tab.id,
      }).then(render).catch(() => undefined);
    });
    item.append(button);
    tabList.append(item);
  }

  currentActiveButton = selectedButton;

  if (selectedButton) {
    requestAnimationFrame(() => updateTabIndicator(selectedButton));
  } else {
    updateTabIndicator(null);
  }
}

async function refresh() {
  try {
    const snapshot = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
    render(snapshot);
    // The popup can open a hair before the worker finishes creating the
    // fallback session; poll briefly until the session state lands.
    if (!snapshot?.cycling && settleAttempts < 8) {
      settleAttempts += 1;
      setTimeout(() => void refresh(), 150);
      return;
    }
    settleAttempts = 0;
  } catch {
    render({ error: "Unable to read tab state" });
  }
}

if (openShortcuts) {
  openShortcuts.addEventListener("click", () => {
    isEditingShortcuts = !isEditingShortcuts;
    updateShortcutDisplayMode();
  });
}

if (resetShortcutsBtn) {
  resetShortcutsBtn.addEventListener("click", resetShortcuts);
}

const MODIFIER_KEYS = new Set(["Alt", "Control", "Shift", "Meta"]);

function modifierSymbols(event) {
  const platform = platformInfo();
  const opts = platform.key === "mac"
    ? { meta: "⌘", ctrl: "⌃", alt: "⌥", shift: "⇧" }
    : { meta: "Win", ctrl: "Ctrl", alt: "Alt", shift: "⇧" };
  const parts = [];
  if (event.metaKey) parts.push(opts.meta);
  if (event.ctrlKey) parts.push(opts.ctrl);
  if (event.altKey) parts.push(opts.alt);
  if (event.shiftKey) parts.push(opts.shift);
  return parts;
}

document.querySelectorAll(".shortcut-input").forEach((input) => {
  input.addEventListener("keydown", (event) => {
    event.preventDefault();
    event.stopPropagation();

    const mods = modifierSymbols(event);

    if (MODIFIER_KEYS.has(event.key)) {
      input.dataset.pending = "1";
      input.value = mods.join(" ");
      return;
    }

    const key = normalizeKeyName(event.key);
    const recorded = mods.concat([key]).join(" ");
    input.value = recorded;
    input.dataset.committed = recorded;
    delete input.dataset.pending;

    const cmd = input.dataset.commandName;
    if (cmd) {
      customShortcuts[cmd] = recorded;
      if (typeof chrome !== "undefined" && chrome.storage?.local) {
        void chrome.storage.local.set({ customShortcuts });
      }
      const kbdEl = input.previousElementSibling;
      if (kbdEl && kbdEl.classList.contains("shortcut-keys")) {
        kbdEl.textContent = recorded;
      }
      if (cmd === "cycle-forward" && footerForward) {
        footerForward.textContent = recorded;
      }
    }
  });

  input.addEventListener("keyup", (event) => {
    if (modifierSymbols(event).length === 0) {
      input.value = input.dataset.committed ?? "";
      delete input.dataset.pending;
    }
  });

  input.addEventListener("blur", () => {
    input.value = input.dataset.committed ?? "";
    delete input.dataset.pending;
  });
});

function normalizeKeyName(key) {
  return KEY_GLYPHS[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

function setRecentVisible(visible) {
  recentVisible = visible;
  if (latestSnapshot) {
    render(latestSnapshot);
  }
}

showRecent.addEventListener("click", () => {
  setRecentVisible(true);
});

closeRecent.addEventListener("click", () => {
  setRecentVisible(false);
});

if (openCompanionGuide) {
  openCompanionGuide.addEventListener("click", () => {
    void chrome.runtime.sendMessage({ type: "OPEN_COMPANION_GUIDE" });
  });
}

window.addEventListener("keyup", (event) => {
  if (event.key === "Alt" || event.key === "Option" || event.code === "AltLeft" || event.code === "AltRight") {
    console.log(
      `[RC-popup] keyup Option key=${event.key} code=${event.code} which=${event.which} ` +
        `altKey=${event.altKey} metaKey=${event.metaKey} ${focusLabel()} ` +
        `token=${fallbackToken} selectedTabId=${selectedTabId} windowId=${fallbackWindowId}`,
    );
  }
  if (isOptionKey(event)) {
    endCycleAndClose();
  }
}, true);

window.addEventListener("keydown", (event) => {
  if (event.key === "Alt" || event.key === "Option" || event.code === "AltLeft" || event.code === "AltRight") {
    console.log(
      `[RC-popup] keydown Option key=${event.key} code=${event.code} which=${event.which} ` +
        `altKey=${event.altKey} metaKey=${event.metaKey} ${focusLabel()} ` +
        `token=${fallbackToken} selectedTabId=${selectedTabId}`,
    );
    releaseSent = false;
    return;
  }

  if (!fallbackToken) {
    return;
  }

  if (event.key === "Tab") {
    event.preventDefault();
    fallbackInteracted = true;
    console.log(
      `[RC-popup] keydown Tab shift=${event.shiftKey} alt=${event.altKey} -> POPUP_ADVANCE`,
    );
    void chrome.runtime.sendMessage({
      type: "POPUP_ADVANCE",
      releaseToken: fallbackToken,
      windowId: fallbackWindowId,
      direction: event.shiftKey ? "reverse" : "forward",
    }).catch(() => undefined);
    return;
  }

  if (event.key === "Enter" && Number.isInteger(selectedTabId)) {
    event.preventDefault();
    fallbackInteracted = true;
    console.log(`[RC-popup] keydown Enter -> ACTIVATE_TAB ${selectedTabId}`);
    void chrome.runtime.sendMessage({
      type: "ACTIVATE_TAB",
      tabId: selectedTabId,
    }).catch(() => undefined);
    return;
  }

  if (event.key === "Escape") {
    console.log("[RC-popup] keydown Escape -> CANCEL_CYCLE");
    cancelFallbackAndClose();
  }
}, true);

// Closing without any interaction (ghost-triggered open, focus loss, outside
// click) cancels the session instead of switching, so a stray popup never
// moves the user to another tab.
window.addEventListener("unload", () => {
  const willCancel = fallbackToken && !fallbackInteracted;
  console.log(
    `[RC-popup] unload fire token=${fallbackToken} interacted=${fallbackInteracted} ` +
      `selectedTabId=${selectedTabId} ${focusLabel()} willCancel=${willCancel ? 1 : 0}`,
  );
  if (fallbackToken && !fallbackInteracted) {
    const releaseToken = fallbackToken;
    const windowId = fallbackWindowId;
    fallbackToken = null;
    void chrome.runtime.sendMessage({ type: "CANCEL_CYCLE", releaseToken, windowId })
      .catch(() => undefined);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SNAPSHOT") {
    settleAttempts = 0;
    render(message.snapshot);
  }

  if (message?.type === "CYCLE_ENDED") {
    window.close();
  }
});

window.addEventListener("focus", () => {
  console.log(
    `[RC-popup] focus gained ${focusLabel()} token=${fallbackToken} selectedTabId=${selectedTabId}`,
  );
});
window.addEventListener("blur", () => {
  console.log(
    `[RC-popup] focus lost ${focusLabel()} token=${fallbackToken} selectedTabId=${selectedTabId}`,
  );
});

console.log(`[RC-popup] mount ${focusLabel()} token=${fallbackToken} selectedTabId=${selectedTabId}`);

void refresh();
