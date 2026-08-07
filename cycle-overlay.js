(() => {
  const INSTANCE_KEY = "__recentCycleOverlayInstance";
  if (globalThis[INSTANCE_KEY]) {
    return;
  }

  const instance = {
    host: null,
    releaseToken: null,
    diagListeners: null,
  };

  const diag = globalThis.__RC_DIAG_CORRELATION;
  if (diag && typeof diag.correlationId === "string") {
    const onDiagKey = (event) => {
      // Tab events were proven unreachable by the page (spike 2026-08-05);
      // only Option key events are worth reporting. Alt keyup stays because
      // it is the commit signal itself.
      if (!isOptionKey(event)) {
        return;
      }
      void chrome.runtime.sendMessage({
        type: "DIAG_KEY",
        correlationId: diag.correlationId,
        eventType: event.type,
        key: event.key,
        code: event.code,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        ts: performance.now(),
        wallTs: Date.now(),
      }).catch(() => undefined);
    };
    window.addEventListener("keydown", onDiagKey, true);
    window.addEventListener("keyup", onDiagKey, true);
    instance.diagListeners = [onDiagKey];

    void chrome.runtime.sendMessage({
      type: "OVERLAY_READY",
      correlationId: diag.correlationId,
      initTs: Date.now(),
      commandFireTs: diag.commandFireTs,
      initPerfTs: performance.now(),
    }).catch(() => undefined);
  }

  function isOptionKey(event) {
    return event.key === "Alt"
      || event.key === "Option"
      || event.code === "AltLeft"
      || event.code === "AltRight";
  }

  function destroy() {
    instance.host?.remove();
    instance.host = null;
    instance.releaseToken = null;
    window.removeEventListener("keyup", onKeyUp, true);
    if (instance.diagListeners) {
      for (const listener of instance.diagListeners) {
        window.removeEventListener("keydown", listener, true);
        window.removeEventListener("keyup", listener, true);
      }
      instance.diagListeners = null;
      delete globalThis.__RC_DIAG_CORRELATION;
    }
    chrome.runtime.onMessage.removeListener(onMessage);
    delete globalThis[INSTANCE_KEY];
  }

  function onKeyUp(event) {
    if (!isOptionKey(event)) {
      return;
    }

    if (!instance.releaseToken) {
      return;
    }

    const releaseToken = instance.releaseToken;
    destroy();
    void chrome.runtime.sendMessage({
      type: "OPTION_RELEASED",
      releaseToken,
    }).catch(() => undefined);
  }

  function createOverlay() {
    const host = document.createElement("div");
    host.setAttribute("data-recent-cycle-overlay", "");
    const root = host.attachShadow({ mode: "closed" });

    const style = document.createElement("style");
    style.textContent = `
      :host {
        all: initial;
        position: fixed;
        z-index: 2147483647;
        top: 50%;
        left: 50%;
        width: min(380px, calc(100vw - 32px));
        transform: translate(-50%, -50%);
        pointer-events: auto;
        color-scheme: light dark;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI Variable", system-ui, sans-serif;
        --canvas: light-dark(oklch(96% .012 145), oklch(17% .012 175));
        --panel: light-dark(oklch(99% .004 145), oklch(22% .014 175));
        --panel-strong: light-dark(oklch(93.5% .018 145), oklch(26% .018 175));
        --ink: light-dark(oklch(26% .022 150), oklch(96% .01 150));
        --ink-soft: light-dark(oklch(39% .025 150), oklch(83% .018 150));
        --muted: light-dark(oklch(52% .022 150), oklch(68% .018 175));
        --line: light-dark(oklch(35% .015 150 / .14), oklch(90% .01 150 / .14));
        --line-strong: light-dark(oklch(35% .015 150 / .22), oklch(90% .01 150 / .22));
        --green: light-dark(oklch(49% .16 150), oklch(76% .19 150));
        --green-soft: light-dark(oklch(92% .045 150), oklch(30% .07 150));
        --green-border: light-dark(oklch(72% .10 150), oklch(54% .13 150));
        --green-ink: light-dark(oklch(31% .10 150), oklch(92% .08 150));
        --radius-card: 16px;
        --radius-sm: 10px;
        --ease-out: cubic-bezier(.16, 1, .3, 1);
      }
      :host([data-theme="light"]) { color-scheme: light; }
      :host([data-theme="dark"]) { color-scheme: dark; }
      *, *::before, *::after { box-sizing: border-box; }
      .overlay-root {
        color: var(--ink);
        font-family: inherit;
      }
      .section-kicker {
        display: inline-flex;
        align-items: center;
        color: var(--muted);
        font-family: "JetBrains Mono", "SF Mono", "Fira Code", "Roboto Mono", "Consolas", ui-monospace, monospace;
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .08em;
        line-height: 1.3;
        text-transform: uppercase;
        white-space: nowrap;
      }
      .section-kicker::before { content: "[ "; color: var(--green); }
      .section-kicker::after { content: " ]"; color: var(--green); }
      .panel {
        overflow: hidden;
        border: 1px solid var(--line-strong);
        border-radius: var(--radius-card);
        background: var(--panel);
        padding: 14px 16px 10px;
      }
      .panel-heading {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        margin-bottom: 10px;
      }
      .tab-list {
        display: grid;
        gap: 2px;
        max-height: min(380px, 58vh);
        margin: 0;
        overflow-y: auto;
        padding: 0;
        scrollbar-width: none;
        list-style: none;
      }
      .tab-list::-webkit-scrollbar { display: none; }
      .tab-row {
        display: grid;
        grid-template-columns: 26px minmax(0, 1fr);
        align-items: center;
        gap: 12px;
        min-height: 52px;
        border: 0;
        border-radius: var(--radius-sm);
        background: transparent;
        padding: 9px 10px;
        width: 100%;
        color: var(--ink);
        cursor: pointer;
        font: inherit;
        text-align: left;
        transition: background 160ms var(--ease-out), color 160ms var(--ease-out);
      }
      .tab-row:hover,
      .tab-row:focus-visible {
        outline: none;
        background: color-mix(in oklch, var(--green) 12%, transparent);
      }
      .tab-row.is-selected {
        background: var(--green);
      }
      .tab-badge {
        display: grid;
        width: 26px;
        height: 26px;
        place-items: center;
        border-radius: 7px;
        background: var(--panel-strong);
        color: var(--green-ink);
        font-family: "JetBrains Mono", "SF Mono", "Fira Code", "Roboto Mono", "Consolas", ui-monospace, monospace;
        font-size: 12px;
        font-weight: 800;
      }
      .tab-row.is-selected .tab-badge {
        background: color-mix(in oklch, var(--green-ink) 20%, transparent);
        color: var(--green-ink);
      }
      .tab-copy { min-width: 0; }
      .tab-title,
      .tab-host {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      }
      .tab-title {
        color: var(--ink);
        font-size: 14px;
        font-weight: 650;
      }
      .tab-row.is-selected .tab-title {
        color: var(--green-ink);
        font-weight: 800;
      }
      .tab-host {
        margin-top: 2px;
        color: var(--muted);
        font-size: 12px;
      }
      .tab-row.is-selected .tab-host {
        color: var(--green-ink);
      }
      .footer {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        margin: 10px -16px -10px;
        border-top: 1px solid var(--line);
        padding: 10px 16px 10px;
        background: var(--panel-strong);
        color: var(--muted);
        font-size: 12px;
      }
      kbd {
        display: inline-flex;
        align-items: center;
        min-height: 24px;
        border: 1px solid var(--line-strong);
        border-radius: 6px;
        padding: 3px 7px;
        background: var(--panel-strong);
        color: var(--green-ink);
        font-family: "JetBrains Mono", "SF Mono", "Fira Code", "Roboto Mono", "Consolas", ui-monospace, monospace;
        font-size: 12px;
        font-weight: 800;
        line-height: 1;
      }
    `;

    const overlayRoot = document.createElement("div");
    overlayRoot.className = "overlay-root";

    const panel = document.createElement("section");
    panel.className = "panel recent-panel";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-label", "Recent tabs");

    const panelHeading = document.createElement("div");
    panelHeading.className = "panel-heading";

    const title = document.createElement("span");
    title.className = "section-kicker";
    title.textContent = "Recent tabs";

    const list = document.createElement("ol");
    list.className = "tab-list";

    const footer = document.createElement("footer");
    footer.className = "footer";
    footer.append(
      document.createTextNode("Tap"),
      Object.assign(document.createElement("kbd"), { textContent: "⌥ ⇥" }),
      document.createTextNode("·"),
      document.createTextNode("Hold"),
      Object.assign(document.createElement("kbd"), { textContent: "⌥" }),
      document.createTextNode("then"),
      Object.assign(document.createElement("kbd"), { textContent: "⇥" }),
      document.createTextNode("/"),
      Object.assign(document.createElement("kbd"), { textContent: "⇧ ⇥" }),
    );

    panelHeading.append(title);
    panel.append(panelHeading, list, footer);
    overlayRoot.append(panel);
    root.append(style, overlayRoot);
    (document.documentElement || document.body).append(host);
    instance.host = host;

    if (typeof chrome !== "undefined" && chrome.storage?.local) {
      chrome.storage.local.get(["theme"], (res) => {
        if (res?.theme === "light" || res?.theme === "dark") {
          host.dataset.theme = res.theme;
        }
      });
    }

    return list;
  }

  function render(snapshot) {
    instance.host?.remove();
    instance.host = null;
    const list = createOverlay();
    let selectedRow = null;

    for (const tab of snapshot.tabs ?? []) {
      const item = document.createElement("li");
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tab-row";
      row.classList.toggle("is-selected", Boolean(tab.selected));
      if (tab.selected) {
        selectedRow = row;
      }

      const badge = document.createElement("span");
      badge.className = "tab-badge";
      badge.textContent = String(tab.initial || "?");

      const copy = document.createElement("span");
      copy.className = "tab-copy";

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = String(tab.title || "Untitled tab");

      const host = document.createElement("span");
      host.className = "tab-host";
      host.textContent = String(tab.host || "Local tab");

      copy.append(title, host);
      row.append(badge, copy);
      row.setAttribute("aria-label", `Switch to ${String(tab.title || "Untitled tab")}`);
      row.addEventListener("click", () => {
        destroy();
        void chrome.runtime.sendMessage({
          type: "ACTIVATE_TAB",
          tabId: tab.id,
        }).catch(() => undefined);
      });
      item.append(row);
      list.append(item);
    }

    if (selectedRow) {
      list.scrollTop = Math.max(
        0,
        selectedRow.offsetTop - list.clientHeight / 2 + selectedRow.clientHeight / 2,
      );
    }
  }

  function onMessage(message) {
    if (message?.type === "CYCLE_ARM" && typeof message.releaseToken === "string") {
      instance.releaseToken = message.releaseToken;
      return;
    }

    if (message?.type === "SHOW_CYCLE_OVERLAY" && typeof message.releaseToken === "string") {
      instance.releaseToken = message.releaseToken;
      render(message.snapshot ?? { tabs: [] });
    }

    if (
      message?.type === "HIDE_CYCLE_OVERLAY"
      && (!message.releaseToken || message.releaseToken === instance.releaseToken)
    ) {
      destroy();
    }
  }

  globalThis[INSTANCE_KEY] = instance;
  window.addEventListener("keyup", onKeyUp, true);
  chrome.runtime.onMessage.addListener(onMessage);
})();
