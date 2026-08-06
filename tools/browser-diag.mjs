#!/usr/bin/env node
//
// browser-diag.mjs — ZERO-DEPENDENCY CDP harness for the "Recent Cycle"
// Chrome MV3 extension.
//
// Node v24 global `fetch` + `WebSocket` only. No npm install.
//
// It:
//   1. launches a throwaway "Google Chrome" with the unpacked extension,
//   2. discovers the extension id from the CDP target list,
//   3. enables service-worker diagnostics (__RC_TEST_DIAGNOSTICS) and
//      collects every console/log/exception event from the SW + any popup,
//   4. opens several tabs (chrome://newtab + a couple of web pages),
//   5. activates a chrome://newtab tab and fires Option+Tab via
//      Input.dispatchKeyEvent, with AppleScript / direct-popup fallbacks,
//   6. screenshots the active tab and any popup that appears,
//   7. dumps all [RC-diag] / [RC-popup] lines, then cleans up.
//
// Usage:
//   node tools/browser-diag.mjs            # run demo + cleanup
//   node tools/browser-diag.mjs --keep     # leave Chrome + profile dir alive
//
// Caveat switch: `--headless` (default) uses --headless=new. If chrome://newtab
// or chrome.action.openPopup() misbehave under headless, drop it and re-run
// with a real (headed) window — see HEADED comment below.
//

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const REPO = new URL("..", import.meta.url).pathname; // .../recent-cycle/
const OUT_DIR = join(REPO, "tools", "out");
const HEADLESS = !process.argv.includes("--headed"); // default headless=new

let KEEP = process.argv.includes("--keep");
if (process.argv.includes("--keep-halt")) {
  // --keep-halt: keep chrome, but the script still exits (we never terminate
  // the child, so it lingers). Useful for manual inspection.
  KEEP = true;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Minimal RPC-over-cdp client
// ---------------------------------------------------------------------------
class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map(); // method -> [fn, ...]
    this.logs = []; // unified console/log/exception records
    this.closed = false;

    ws.addEventListener("message", (event) => {
      let msg;
      const data = event.data;
      if (typeof data === "string") {
        msg = JSON.parse(data);
      } else if (data && data.text) {
        msg = JSON.parse(data.text);
      } else {
        msg = JSON.parse(Buffer.from(data).toString("utf8"));
      }

      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.message} (${msg.error.code})`));
          else p.resolve(msg.result);
        }
        return;
      }

      const method = msg.method;
      const params = msg.params || {};
      // ---- capture console / log / exceptions ---------------------------------
      if (method === "Runtime.consoleAPICalled") {
        const args = (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
          .join(" ");
        const type = params.type;
        this.logs.push({ ts: Date.now(), src: "console", type, args });
      } else if (method === "Log.entryAdded") {
        const e = params.entry || {};
        this.logs.push({ ts: Date.now(), src: "log", level: e.level, args: e.text || "" });
      } else if (method === "Runtime.executionContextCreated") {
        // ignore
      } else if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails || {};
        const desc =
          d.exception?.description || d.exception?.value || d.text || "exception";
        this.logs.push({ ts: Date.now(), src: "exception", args: desc });

        // console.log from a service worker appears as exceptionThrown with a
        // recognizable "console" wrapper — surface it too, in case some Chrome
        // builds route SW console.log exclusively through the exception path.
        if (typeof desc === "string" && desc.includes("[RC-diag]")) {
          this.logs.push({ ts: Date.now(), src: "console", args: desc.replace(/^.*?Uncaught/, "") });
        }
      }

      const hs = this.handlers.get(method);
      if (hs) {
        for (const h of [...hs]) {
          try {
            h(params);
          } catch (err) {
            console.error("  [handler error]", err);
          }
        }
      }
    });

    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
    ws.addEventListener("error", (e) => {
      console.error("  [ws error]", e.message || e);
    });
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new CDPClient(ws);
      const t = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), 15000);
      ws.addEventListener("open", () => {
        clearTimeout(t);
        resolve(c);
      });
      ws.addEventListener("error", (e) => {
        clearTimeout(t);
        reject(new Error(`ws error: ${e.message || "unknown"}`));
      });
    });
  }

  on(method, fn) {
    const hs = this.handlers.get(method) || [];
    hs.push(fn);
    this.handlers.set(method, hs);
    return () => {
      const arr = this.handlers.get(method);
      const i = arr ? arr.indexOf(fn) : -1;
      if (i >= 0) arr.splice(i, 1);
    };
  }

  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error("CDP client closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }

  close() {
    try {
      this.closed = true;
      this.ws.close();
    } catch {}
  }
}

// ---------------------------------------------------------------------------
// Browser setup / teardown
// ---------------------------------------------------------------------------
async function launch() {
  mkdirSync(OUT_DIR, { recursive: true });
  const profile = join(tmpdir(), `rc-diag-profile-${process.pid}`);
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const args = [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions-except=" + REPO,
    "--load-extension=" + REPO,
  ];
  if (HEADLESS) {
    args.push("--headless=new");
  }
  // We use --remote-debugging-port=0 and read the actual port from
  // DevToolsActivePort (robust against collisions). NOTE: if we ever need a
  // *fixed* browsable port, swap port=0 for a free port from a probe socket.
  args.push("--remote-debugging-port=0");

  console.log(`[launch] chrome=${CHROME}`);
  console.log(`[launch] args=${args.join(" ")}`);
  console.log(`[launch] headless=${HEADLESS}  profile=${profile}`);

  const proc = spawn(CHROME, args, { stdio: "ignore" });
  proc.unref();

  // Poll for DevToolsActivePort (line 1 = port, line 2 = browser ws path).
  let port = null;
  for (let i = 0; i < 100 && port === null; i++) {
    try {
      const txt = readFileSync(join(profile, "DevToolsActivePort"), "utf8");
      const [p] = txt.trim().split("\n");
      port = Number(p);
    } catch {
      await sleep(100);
    }
  }
  if (port === null) {
    cleanup(proc, profile);
    throw new Error("Chrome did not expose DevToolsActivePort (did it crash on launch?)");
  }

  console.log(`[launch] CDP port=${port}`);

  // Browser-level websocket (needed for Target.createTarget/activateTarget).
  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browserWsUrl = ver.webSocketDebuggerUrl;
  console.log(`[launch] browser ws=${browserWsUrl}`);
  const browser = await CDPClient.connect(browserWsUrl);

  return { proc, profile, port, browser };
}

function cleanup(proc, profile) {
  if (KEEP) {
    console.log(`[cleanup] --keep => leaving chrome running, profile at ${profile}`);
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch {}
  // Give Chrome a moment to die, then force-kill if needed.
  setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  }, 1500).unref();
  setTimeout(() => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  }, 2500).unref();
  console.log("[cleanup] chrome killed, profile removed");
}

// ---------------------------------------------------------------------------
// Target iteration
// ---------------------------------------------------------------------------
async function iterateTargets(port) {
  const res = await fetch(`http://127.0.0.1:${port}/json`);
  const list = await res.json();
  return list.map((t) => ({
    id: t.id,
    type: t.type,
    title: t.title || "",
    url: t.url || "",
    ws: t.webSocketDebuggerUrl || null,
  }));
}

async function discoverExtensionId(port) {
  const targets = await iterateTargets(port);
  const ext = targets.find((t) => /^chrome-extension:\/\/([a-z]{32})\//.test(t.url));
  if (!ext) return null;
  const id = /^chrome-extension:\/\/([a-z]{32})\//.exec(ext.url)[1];
  console.log(`[ext] discovered id=${id} via ${ext.url}`);
  return { id, target: ext };
}

// ---------------------------------------------------------------------------
// Console capture helpers
// ---------------------------------------------------------------------------
function listConsoles(client) {
  return [...client.logs];
}

function printDiagLogs(label, client) {
  const diag = client.logs.filter(
    (l) => typeof l.args === "string" && l.args.includes("[RC-diag]"),
  );
  const popup = client.logs.filter(
    (l) => typeof l.args === "string" && l.args.includes("[RC-popup]"),
  );
  const other = client.logs.filter((l) => {
    const s = String(l.args);
    return !s.includes("[RC-diag]") && !s.includes("[RC-popup]");
  });
  const dump = (rows) =>
    rows.map((l) => `      ${l.ts} [${l.src}/${l.type || l.level}] ${l.args}`).join("\n");
  console.log(`\n  === ${label} ===`);
  console.log(`  -- [RC-diag] (${diag.length}) --`);
  if (diag.length) console.log(dump(diag));
  else console.log("      (none)");
  console.log(`  -- [RC-popup] (${popup.length}) --`);
  if (popup.length) console.log(dump(popup));
  else console.log("      (none)");
  if (other.length) {
    console.log(`  -- other console (${other.length}) --`);
    console.log(dump(other));
  }
}

async function enableConsoleCaps(client, label) {
  await client.send("Runtime.enable");
  await client.send("Log.enable");
  console.log(`[cdn] ${label}: Runtime+Log enabled (capturing console/exceptions)`);
}

// ---------------------------------------------------------------------------
// Extension-level helpers (service worker + popup)
// ---------------------------------------------------------------------------
async function findServiceWorker(port, extId) {
  const targets = await iterateTargets(port);
  return targets.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}`)) || null;
}

async function findPopup(port, extId) {
  const targets = await iterateTargets(port);
  return targets.find((t) => t.url && t.url.startsWith(`chrome-extension://${extId}/popup.html`)) || null;
}

async function setDiagFlag(swClient) {
  const r = await swClient.send("Runtime.evaluate", {
    expression:
      "window.__RC_TEST_DIAGNOSTICS = true; window.__RC_TEST_DIAGNOSTICS",
    returnByValue: true,
  });
  console.log(`[diag] __RC_TEST_DIAGNOSTICS set => ${JSON.stringify(r?.result?.value)}`);
}

// ---------------------------------------------------------------------------
// Tab creation / activation
// ---------------------------------------------------------------------------
async function openTabs(browser, port, { newtabs = 3, web = 2 } = {}) {
  const made = [];
  for (let i = 0; i < newtabs; i++) {
    const t = await browser.send("Target.createTarget", { url: "chrome://newtab" });
    made.push({ targetId: t.targetId, url: "chrome://newtab" });
  }
  for (let i = 0; i < web; i++) {
    const t = await browser.send("Target.createTarget", { url: `https://example.com/?rc=${i}` });
    made.push({ targetId: t.targetId, url: `https://example.com/?rc=${i}` });
  }
  console.log(`[tabs] created ${made.length} targets (${newtabs} newtab, ${web} web)`);

  // wait a beat and reconcile with the /json list (which includes a default tab)
  await sleep(500);
  const live = await iterateTargets(port);
  const pages = live.filter((t) => t.type === "page");
  console.log(`[tabs] page targets now visible: ${pages.length}`);
  return { made, pages };
}

async function activateTargetById(browser, port, targetId, label) {
  // Prefer browser-level activateTarget, then fall back to Page.bringToFront.
  try {
    await browser.send("Target.activateTarget", { targetId });
    console.log(`[activate] Target.activateTarget(${label}) ok`);
    return true;
  } catch (e) {
    console.log(`[activate] Target.activateTarget failed (${e.message}); trying bringToFront`);
  }
  try {
    const page = await CDPClient.connect(
      (await iterateTargets(port)).find((t) => t.id === targetId).ws,
    );
    await page.send("Page.enable");
    await page.send("Page.bringToFront");
    page.close();
    console.log(`[activate] Page.bringToFront(${label}) ok`);
    return true;
  } catch (e) {
    console.log(`[activate] bringToFront failed: ${e.message}`);
    return false;
  }
}

async function activateTab(browser, port, label) {
  // Activate the most recent page target (the MRU head typically).
  const live = await iterateTargets(port);
  // Prefer a chrome://newtab page since that's our protected target.
  let page = live.find((t) => t.type === "page" && /^chrome:\/\/newtab/.test(t.url));
  if (!page) page = live.find((t) => t.type === "page");
  if (!page) return null;
  await activateTargetById(browser, port, page.id, label);
  return page;
}

// ---------------------------------------------------------------------------
// Trigger method 1: CDP synthetic Option+Tab
// ---------------------------------------------------------------------------
async function triggerShortcut(port, targetId, label) {
  const t = (await iterateTargets(port)).find((x) => x.id === targetId);
  if (!t) throw new Error(`no target ${targetId}`);
  const page = await CDPClient.connect(t.ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  // Give focus to the page so keyboard events land somewhere real.
  try {
    await page.send("Runtime.evaluate", { expression: "document.body && document.body.focus()" });
  } catch {}

  // Note the modifier bit: 1 == Alt / Option (alternate). We send:
  //   rawKeyDown Tab (mod=Alt)  -> keyUp Tab (mod=Alt) -> keyUp Alt
  const ALT = 1;
  await page.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown",
    key: "\t",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 48,
    modifiers: ALT,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "\t",
    code: "Tab",
    windowsVirtualKeyCode: 9,
    nativeVirtualKeyCode: 48,
    modifiers: ALT,
  });
  await page.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Alt",
    code: "AltLeft",
    windowsVirtualKeyCode: 18,
    nativeVirtualKeyCode: 58,
    modifiers: ALT,
  });

  console.log(`[trigger] ${label}: sent synthetic Option+Tab via Input.dispatchKeyEvent`);
  page.close();
}

// ---------------------------------------------------------------------------
// Trigger method 2: AppleScript real key (System Events)
// ---------------------------------------------------------------------------
async function triggerShortcutAppleScript() {
  const script =
    'tell application "System Events" to key code 48 using {option down}';
  try {
    const res = await execFileAsync("/usr/bin/osascript", ["-e", script]);
    console.log(`[trigger] AppleScript Option+Tab ok`);
    return true;
  } catch (e) {
    console.log(`[trigger] AppleScript fallback failed: ${e.message}`);
    return false;
  }
}

function execFileAsync(cmd, args) {
  return new Promise((resolve, reject) => {
    const { execFile } = require("node:child_process");
    // (use spawn to avoid requiring; defined below)
    resolve(promiseSpawn(cmd, args));
  });
}

function promiseSpawn(cmd, args, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const c = spawn(cmd, args);
    const t = setTimeout(() => {
      try { c.kill("SIGKILL"); } catch {}
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    let out = "";
    c.stdout?.on("data", (d) => (out += d));
    c.stderr?.on("data", (d) => (out += d));
    c.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    c.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${out}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Trigger method 3: drive the popup directly (navigate a tab to popup.html)
// ---------------------------------------------------------------------------
async function drivePopupDirectly(port, extId, browser) {
  // navigate an existing target to the popup page, or create one
  let targetId;
  try {
    const created = await browser.send("Target.createTarget", {
      url: `chrome-extension://${extId}/popup.html`,
    });
    targetId = created.targetId;
    console.log(`[popup] created target at popup.html (${targetId})`);
  } catch (e) {
    console.log(`[popup] createTarget for popup failed: ${e.message}`);
    return null;
  }
  await sleep(700);
  const t = (await iterateTargets(port)).find((x) => x.id === targetId);
  if (!t) return null;
  const page = await CDPClient.connect(t.ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");

  // GET_SNAPSHOT -> returns cycle state; print a summary
  const snap = await page.send("Runtime.evaluate", {
    expression: `(async () => {
      const r = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
      return JSON.stringify({ hasSnapshot: !!r && !!r.windowId, windowId: r?.windowId, tabCount: r?.tabs?.length, shortcutStatus: r?.shortcutStatus, snapshotKeys: Object.keys(r || {}) });
    })()`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log(`[popup] GET_SNAPSHOT => ${JSON.stringify(snap?.result?.value)}`);

  // Send a POPUP_ADVANCE + OPTION_RELEASED with the snapshot's token if present
  const detail = snap?.result?.value;
  try {
    const parsed = JSON.parse(detail);
    const token = parsed.hasSnapshot ? undefined : undefined; // token not exposed at top level; fetch via cycle
    // Re-fetch with full cycle token from background state
    const full = await page.send("Runtime.evaluate", {
      expression: `(async () => {
        const r = await chrome.runtime.sendMessage({ type: "GET_SNAPSHOT" });
        return JSON.stringify(r);
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    console.log(`[popup] full snapshot (truncated): ${String(full?.result?.value).slice(0, 400)}`);

    const obj = JSON.parse(full?.result?.value || "{}");
    const token2 = obj?.cycle?.releaseToken;
    const windowId = obj?.windowId;
    if (token2 && windowId !== null) {
      await page.send("Runtime.evaluate", {
        expression: `(async () => await chrome.runtime.sendMessage({ type: "OPTION_RELEASED", releaseToken: ${JSON.stringify(token2)}, windowId: ${windowId} }))()`,
        awaitPromise: true,
        returnByValue: true,
      });
      console.log(`[popup] sent OPTION_RELEASED (token=${String(token2).slice(0, 8)}…)`);
    } else {
      console.log(`[popup] no live cycle token to release (cycle=${JSON.stringify(obj?.cycle)})`);
    }
  } catch (e) {
    console.log(`[popup] direct-drive error: ${e.message}`);
  }
  page.close();
  return true;
}

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------
async function screenshot(port, targetId, filename, label) {
  const t = (await iterateTargets(port)).find((x) => x.id === targetId);
  if (!t) {
    console.log(`[shot] ${label}: target gone, skipped`);
    return null;
  }
  const page = await CDPClient.connect(t.ws);
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  const r = await page.send("Page.captureScreenshot", { format: "png" });
  const buf = Buffer.from(r.data, "base64");
  const file = join(OUT_DIR, filename);
  writeFileSync(file, buf);
  console.log(`[shot] ${label} -> ${file} (${buf.length} bytes)`);
  page.close();
  return file;
}

// ---------------------------------------------------------------------------
// Demo sequence (main)
// ---------------------------------------------------------------------------
async function main() {
  console.log("================================================================");
  console.log(" Recent Cycle — CDP diagnostic harness (zero-dependency)");
  console.log("================================================================");
  const fail = (msg) => {
    console.log(`\n  FAIL/CAVEAT: ${msg}`);
  };

  let ctx = null;
  try {
    const { proc, profile, port, browser } = await launch();
    ctx = { proc, profile, port, browser };
    const { port: P, browser: B } = ctx;

    // 1) discover extension id
    let ext = null;
    for (let i = 0; i < 30 && !ext; i++) {
      ext = await discoverExtensionId(P);
      if (!ext) await sleep(300);
    }
    if (!ext) {
      fail("could not discover extension target in /json — is the extension loaded?");
      return;
    }
    const extId = ext.id;

    // 2) service worker console capture
    let sw = await findServiceWorker(P, extId);
    if (!sw) {
      fail(`service_worker for ${extId} not found (check manifest background.service_worker)`);
      return;
    }
    const swClient = await CDPClient.connect(sw.ws);
    await enableConsoleCaps(swClient, "service worker");
    await setDiagFlag(swClient);
    await swClient.send("Runtime.evaluate", { expression: "void 0" }); // warm

    // 3) open several tabs for MRU
    const { pages } = await openTabs(B, P, { newtabs: 3, web: 2 });

    // 4) activate a chrome://newtab tab
    const active = await activateTab(B, P, "chrome://newtab (active)");
    const activePageId = active?.id || pages[0]?.id;
    if (!activePageId) {
      fail("no page target to activate");
      return;
    }
    await sleep(1200); // let activation + state settle

    // 5) close any pre-existing popup target capture list
    //    connect capture to any popup that appears during the run
    const popupClients = [];

    console.log("\n--- STEP: trigger Option+Tab (method 1: CDP synthetic keys) ---");
    await triggerShortcut(P, activePageId, "Option+Tab synthetic");
    await sleep(1500);
    let pop = await findPopup(P, extId);
    let popupClient = null;
    if (pop) {
      popupClient = await CDPClient.connect(pop.ws);
      await enableConsoleCaps(popupClient, "popup");
      popupClients.push(popupClient);
      console.log(`[popup] popup target appeared: ${pop.url}`);
      await screenshot(P, pop.id, `popup_after_first.png`, "popup after 1st trigger");
    } else {
      console.log("[popup] no popup target after 1st trigger");
    }
    printDiagLogs("SW logs after 1st synthetic Option+Tab", swClient);
    await screenshot(P, activePageId, "newtab_after_first.png", "newtab after 1st trigger");

    // Second Option+Tab — on a protected page this should start the popup
    // fallback session (first press switches silently; second within window
    // opens popup).
    console.log("\n--- STEP: trigger Option+Tab again (within protected window) ---");
    await triggerShortcut(P, activePageId, "Option+Tab synthetic #2");
    await sleep(1500);
    pop = await findPopup(P, extId);
    if (pop) {
      if (!popupClient) {
        popupClient = await CDPClient.connect(pop.ws);
        await enableConsoleCaps(popupClient, "popup");
        popupClients.push(popupClient);
      }
      console.log(`[popup] popup now present: ${pop.url}`);
      await screenshot(P, pop.id, "popup_after_second.png", "popup after 2nd trigger");
      if (popupClient) printDiagLogs("POPUP logs", popupClient);
    } else {
      console.log("[popup] still no popup target after 2nd trigger");
    }
    printDiagLogs("SW logs after 2nd synthetic Option+Tab", swClient);

    // If synthetic keys never fired chrome.commands, fall back.
    const diagFireLines = swClient.logs.filter((l) =>
      typeof l.args === "string" && l.args.includes("command fire"),
    );
    if (diagFireLines.length === 0) {
      console.log(
        "\n--- SYNTHETIC KEY RESULT: NO '[RC-diag] command fire' seen => chrome.commands",
      );
      console.log("    did NOT fire for synthetic Input.dispatchKeyEvent. Trying fallbacks.");
      console.log("--- STEP: AppleScript real Option+Tab (System Events) ---");
      const ok = await triggerShortcutAppleScript();
      if (ok) {
        await sleep(1200);
        // screenshot current newtab
        const cur = await activateTab(B, P, "after apple");
        if (cur) await screenshot(P, cur.id, "newtab_after_applescript.png", "newtab after applescript");
        printDiagLogs("SW logs after AppleScript trigger", swClient);
      } else {
        fail("AppleScript path unavailable (no GUI/accessibility permission).");
      }

      // Still nothing => try driving the popup directly.
      console.log("\n--- STEP: drive popup directly (navigate a target to popup.html) ---");
      const direct = await drivePopupDirectly(P, extId, B);
      if (direct) {
        await sleep(1000);
        printDiagLogs("SW logs after direct popup drive", swClient);
      }
    } else {
      console.log(
        `\n--- SYNTHETIC KEY RESULT: chrome.commands DID fire — ${diagFireLines.length} 'command fire' lines`,
      );
    }

    // Screenshot any popup target still around
    pop = await findPopup(P, extId);
    if (pop && !popupClient) {
      popupClient = await CDPClient.connect(pop.ws);
      await enableConsoleCaps(popupClient, "popup");
      popupClients.push(popupClient);
    }

    console.log("\n================================================================");
    console.log(" FINAL DUMP");
    console.log("================================================================");
    printDiagLogs("final service worker logs", swClient);
    for (const pc of popupClients) printDiagLogs("final popup logs", pc);
    swClient.close();
    for (const pc of popupClients) pc.close();

    cleanup(proc, profile);
  } catch (err) {
    console.log("\n  FAIL/CAVEAT: uncaught harness error");
    console.log("  ", err && err.stack ? err.stack : err);
    if (ctx) cleanup(ctx.proc, ctx.profile);
    process.exitCode = 1;
  }
}

main();
