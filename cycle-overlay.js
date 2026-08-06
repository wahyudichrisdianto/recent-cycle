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
        top: 20px;
        right: 20px;
        width: min(390px, calc(100vw - 40px));
        pointer-events: none;
        color: #f1f5f9;
        font-family: "JetBrains Mono", "SF Mono", "Fira Code", "Roboto Mono", "Consolas", ui-monospace, monospace;
      }
      * { box-sizing: border-box; }
      .panel {
        overflow: hidden;
        border: 1px solid rgba(34, 197, 94, .3);
        border-radius: 22px;
        background: rgba(11, 17, 20, .96);
        box-shadow: 0 20px 48px -12px rgba(0, 0, 0, .8), 0 0 20px rgba(34, 197, 94, .12);
        backdrop-filter: blur(20px);
        -webkit-backdrop-filter: blur(20px);
        padding: 4px;
      }
      .header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 12px 14px 10px;
      }
      .title {
        color: #22c55e;
        font-size: 14px;
        font-weight: 800;
        letter-spacing: -.02em;
        text-transform: uppercase;
      }
      .hint {
        color: #64748b;
        font-size: 10px;
        font-weight: 500;
      }
      .list {
        display: grid;
        gap: 6px;
        max-height: min(440px, 58vh);
        margin: 0;
        overflow-y: auto;
        padding: 0 8px 10px;
        scrollbar-width: none;
        list-style: none;
      }
      .list::-webkit-scrollbar { display: none; }
      .row {
        display: grid;
        grid-template-columns: 30px minmax(0, 1fr) auto;
        align-items: center;
        gap: 10px;
        min-height: 48px;
        border: 1px solid #1e2a30;
        border-radius: 12px;
        background: #11171a;
        padding: 8px 10px;
        transition: all 180ms cubic-bezier(.16, 1, .3, 1);
      }
      .row.selected {
        border-color: #22c55e;
        background: #052e16;
        box-shadow: 0 0 12px rgba(34, 197, 94, .25);
      }
      .badge {
        display: grid;
        width: 30px;
        height: 30px;
        place-items: center;
        border-radius: 8px;
        background: #052e16;
        border: 1px solid #14532d;
        color: #22c55e;
        font-size: 11px;
        font-weight: 800;
      }
      .row.selected .badge {
        background: #22c55e;
        color: #041f0e;
        border-color: #22c55e;
      }
      .copy { min-width: 0; }
      .tab-title,
      .tab-host {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
      }
      .tab-title {
        color: #f1f5f9;
        font-size: 12px;
        font-weight: 600;
      }
      .row.selected .tab-title {
        color: #22c55e;
        font-weight: 700;
      }
      .tab-host {
        margin-top: 1px;
        color: #64748b;
        font-size: 10px;
      }
      .selected-label {
        border-radius: 5px;
        background: #052e16;
        border: 1px solid #14532d;
        color: #22c55e;
        font-size: 9px;
        font-weight: 800;
        letter-spacing: .06em;
        padding: 2px 6px;
        text-transform: uppercase;
      }
    `;

    const panel = document.createElement("section");
    panel.className = "panel";
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-label", "Recent tabs");

    const header = document.createElement("header");
    header.className = "header";

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = "Recent tabs";

    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = "Tab next · ⇧Tab back · release ⌥ to switch";

    const list = document.createElement("ol");
    list.className = "list";

    header.append(title, hint);
    panel.append(header, list);
    root.append(style, panel);
    (document.documentElement || document.body).append(host);
    instance.host = host;

    return list;
  }

  function render(snapshot) {
    instance.host?.remove();
    instance.host = null;
    const list = createOverlay();
    let selectedRow = null;

    for (const tab of snapshot.tabs ?? []) {
      const row = document.createElement("li");
      row.className = "row";
      row.classList.toggle("selected", Boolean(tab.selected));
      if (tab.selected) {
        selectedRow = row;
      }

      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = String(tab.initial || "?");

      const copy = document.createElement("span");
      copy.className = "copy";

      const title = document.createElement("span");
      title.className = "tab-title";
      title.textContent = String(tab.title || "Untitled tab");

      const host = document.createElement("span");
      host.className = "tab-host";
      host.textContent = String(tab.host || "Local tab");

      const selected = document.createElement("span");
      selected.className = "selected-label";
      selected.textContent = tab.selected ? "Selected" : "";

      copy.append(title, host);
      row.append(badge, copy, selected);
      list.append(row);
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
