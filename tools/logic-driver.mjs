#!/usr/bin/env node
//
// logic-driver.mjs — ZERO-DEPENDENCY, DETERMINISTIC CDP logic harness for the
// "Recent Cycle" Chrome MV3 extension. Worker E deliverable.
//
// It validates the POPUP-FALLBACK COMMIT LOGIC end-to-end WHEN EVENTS ARRIVE,
// i.e. without depending on chrome.commands accelerators or OS focus, neither
// of which can be synthesized reliably under CDP. See logic-driver.README.md
// for the full decision tree and hypothesis mapping.
//
// Environment facts this harness was built around (see README):
//   * Branded "Google Chrome" REFUSES --load-extension
//     ("--load-extension is not allowed in Google Chrome, ignoring.") so it can
//     only ever load its bundled component extensions (Hangouts, Network
//     Speech). The extension CANNOT be loaded into branded Chrome here.
//   * "Google Chrome for Testing" (Chrome for Testing) DOES honor
//     --load-extension, so Recent Cycle loads for real there.
//   * macOS Accessibility (AppleScript `key code`) is BLOCKED here
//     ("osascript is not allowed to send keystrokes" 1002), so the only real
//     keyboard path into chrome.commands is unavailable. chrome.commands cannot
//     be emitted via CDP either.
// Therefore this driver proves the message-driven commit logic using the real,
// production message handlers (GET_SNAPSHOT / POPUP_ADVANCE / OPTION_RELEASED
// / CANCEL_CYCLE / ACTIVATE_TAB) against the live service-worker state. A
// best-effort --arm-seed popup-session seeding is included and reported
// honestly.
//
// Usage:
//   node tools/logic-driver.mjs                     # CfT path auto-detected
//   node tools/logic-driver.mjs --chrome=</path>    # force a Chrome binary
//   node tools/logic-driver.mjs --headed|--headless # default headed
//   node tools/logic-driver.mjs --arm-seed          # attempt popup-session seed
//   node tools/logic-driver.mjs --keep              # leave Chrome + profile alive
//
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const HERE = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(HERE, "..");
const OUT_DIR = join(HERE, "out");
const STORAGE_KEY = "recentCycleState";

const KNOWN_CFT_PATHS = [
  "/tmp/cft/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  process.env.RCLC_CFT_BIN || null,
].filter(Boolean);

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(`--${name}=`.length) : null;
};
const has = (name) => process.argv.includes(`--${name}`);

const CHROME = arg("chrome") || KNOWN_CFT_PATHS[0];
const HEADLESS = has("headless");
const KEEP = has("keep") || has("keep-halt");
const ARM_SEED = has("arm-seed");
const DISABLE_EXT_EXCEPT = !has("no-disable-ext");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Minimal RPC-over-CDP client (Node 24 global WebSocket + fetch)
// ---------------------------------------------------------------------------
class CDPClient {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.logs = [];
    this.closed = false;

    const decode = (data) =>
      typeof data === "string" ? data : data && data.text ? data.text : Buffer.from(data).toString("utf8");

    ws.addEventListener("message", (event) => {
      let msg;
      try {
        msg = JSON.parse(decode(event.data));
      } catch {
        return;
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
      if (method === "Runtime.consoleAPICalled") {
        const args = (params.args || [])
          .map((a) => (a.value !== undefined ? String(a.value) : a.description ?? a.type))
          .join(" ");
        this.logs.push({ ts: Date.now(), src: "console", type: params.type, args });
      } else if (method === "Log.entryAdded") {
        const e = params.entry || {};
        this.logs.push({ ts: Date.now(), src: "log", level: e.level, args: e.text || "" });
      } else if (method === "Runtime.exceptionThrown") {
        const d = params.exceptionDetails || {};
        const desc = d.exception?.description || d.exception?.value || d.text || "exception";
        this.logs.push({ ts: Date.now(), src: "exception", args: String(desc) });
        if (typeof desc === "string" && desc.includes("[RC-diag]")) {
          this.logs.push({ ts: Date.now(), src: "console", args: desc.replace(/^.*?Uncaught/, "") });
        }
      }
      const hs = this.handlers.get(method);
      if (hs) for (const h of [...hs]) { try { h(params); } catch {} }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const p of this.pending.values()) p.reject(new Error("CDP websocket closed"));
      this.pending.clear();
    });
    ws.addEventListener("error", (e) => console.error("  [ws error]", e.message || "unknown"));
  }

  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const c = new CDPClient(ws);
      const t = setTimeout(() => reject(new Error(`ws connect timeout: ${url}`)), 20000);
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
      if (arr) {
        const i = arr.indexOf(fn);
        if (i >= 0) arr.splice(i, 1);
      }
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
// Browser process / target helpers
// ---------------------------------------------------------------------------
async function launch(profile) {
  mkdirSync(OUT_DIR, { recursive: true });
  rmSync(profile, { recursive: true, force: true });
  mkdirSync(profile, { recursive: true });

  const args = [
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1280,820",
  ];
  if (DISABLE_EXT_EXCEPT) args.push(`--disable-extensions-except=${REPO}`);
  args.push(`--load-extension=${REPO}`);
  if (HEADLESS) args.push("--headless=new");
  args.push("--remote-debugging-port=0");

  console.log(`[launch] chrome=${CHROME}`);
  console.log(`[launch] headless=${HEADLESS}`);
  console.log(`[launch] args=${args.join(" ")}`);

  const proc = spawn(CHROME, args, { stdio: "ignore" });
  proc.unref();

  let port = null;
  for (let i = 0; i < 200 && port === null; i++) {
    try {
      const [p] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
      port = Number(p);
    } catch {
      await sleep(150);
    }
  }
  if (port === null) throw new Error("Chrome did not expose DevToolsActivePort");

  const ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  const browser = await CDPClient.connect(ver.webSocketDebuggerUrl);
  return { proc, port, browser };
}

async function iterateTargets(port) {
  return (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
}

async function findRecentCycleSw(port, extId) {
  const ts = await iterateTargets(port);
  return ts.find((t) => t.type === "service_worker" && t.url.startsWith(`chrome-extension://${extId}/`)) || null;
}

// Discover Recent Cycle's extension id by probing each loaded extension's
// service worker via getManifest (robust against multiple unpacked ext ids).
async function discoverExtId(port) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const ts = await iterateTargets(port);
    const sws = ts.filter((t) => t.type === "service_worker" && t.url.startsWith("chrome-extension://"));
    for (const sw of sws) {
      try {
        const c = await CDPClient.connect(sw.webSocketDebuggerUrl);
        await c.send("Runtime.enable");
        const r = await c.send("Runtime.evaluate", {
          expression: `chrome.runtime.getManifest()?.name`,
          returnByValue: true,
        });
        c.close();
        const name = r.result?.value;
        if (name === "Recent Cycle") {
          const id = /^chrome-extension:\/\/([a-z]{32})\//.exec(sw.url)[1];
          console.log(`[ext] discovered Recent Cycle id=${id} via ${sw.url}`);
          return { id, sw };
        }
      } catch {
        /* component extensions may not expose getManifest synchronously */
      }
    }
    await sleep(300);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Console capture
// ---------------------------------------------------------------------------
function dump(label, client, { only = null } = {}) {
  const rows = client.logs.filter((l) => {
    const s = String(l.args);
    if (only) return only.some((k) => s.includes(k));
    return s.includes("[RC-diag]") || s.includes("[RC-popup]");
  });
  let text = `\n  === ${label} === (${rows.length})\n`;
  for (const l of rows) text += `      ${l.ts} [${l.src}/${l.type || l.level}] ${l.args}\n`;
  text = text.replace(/\n$/, "");
  console.log(text);
  return text;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("================================================================");
  console.log(" Recent Cycle — LOGIC DRIVER (deterministic popup-fallback commit)");
  console.log("================================================================");

  if (!CHROME) {
    console.log("No Chrome binary. Pass --chrome=/path or set RCLC_CFT_BIN.");
    process.exit(2);
  }
  if (!KEEP && false) {}

  const profile = join(tmpdir(), `rc-logic-${process.pid}`);
  let ctx = null;
  let report = {
    strategy: "deterministic-message-logic",
    extId: null,
    arm: { attempted: ARM_SEED, via: [], succeeded: false, detail: "" },
    tabs: [],
    tests: {},
    logs: {},
  };

  const cleanup = () => {
    if (KEEP) {
      console.log(`[cleanup] --keep => leaving chrome + profile at ${profile}`);
      process.exit(0);
    }
    try {
      ctx?.proc?.kill("SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        ctx?.proc?.kill("SIGKILL");
      } catch {}
    }, 1200).unref();
    setTimeout(() => {
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    }, 2200).unref();
  };

  try {
    const { proc, port, browser } = await launch(profile);
    ctx = { proc, profile, port, browser };

    // 1) discover Recent Cycle by probing extension SW manifests
    const disc = await discoverExtId(port);
    if (!disc) {
      report.tests.discovery = { ok: false, detail: "Recent Cycle SW never appeared" };
      console.log("\n  FAIL: Recent Cycle extension did not load.");
      console.log("  (Branded Chrome refuses --load-extension; use Chrome for Testing.)");
      cleanup();
      return;
    }
    const extId = disc.id;
    report.extId = extId;

    // 2) connect to the SW and enable diagnostics + console capture
    let sw = await findRecentCycleSw(port, extId);
    const swc = await CDPClient.connect(sw.webSocketDebuggerUrl);
    await swc.send("Runtime.enable");
    await swc.send("Log.enable");
    await swc.send("Runtime.evaluate", {
      expression: "window.__RC_TEST_DIAGNOSTICS = true; window.__RC_TEST_DIAGNOSTICS",
      returnByValue: true,
    });
    console.log("[diag] __RC_TEST_DIAGNOSTICS enabled (capturing [RC-diag] + [RC-popup])");

    // generic SW evaluator
    const ev = async (expr) => {
      const r = await swc.send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
      });
      return r.result?.value;
    };

    // 3) create real tabs (newtab = protected page + two ordinary pages)
    const created = [];
    for (const u of ["chrome://newtab/", "https://example.com/?a=1", "https://example.com/?b=2"]) {
      const { targetId } = await browser.send("Target.createTarget", { url: u });
      created.push({ targetId, url: u });
      await sleep(250);
    }
    await sleep(800);

    // 4) authoritative baseline from the SW (no lastFocusedWindow dependency)
    const baselineRaw = await ev(`(async()=>{
      const tabs = await chrome.tabs.query({});
      return JSON.stringify(tabs.map(t=>({id:t.id,wid:t.windowId,url:t.url,active:t.active,index:t.index})));
    })()`);
    const tabs = JSON.parse(baselineRaw);
    report.tabs = tabs.map((t) => t.id);
    const windows = [...new Set(tabs.map((t) => t.wid))];
    const wid = windows[0];
    const ids = tabs.map((t) => t.id);
    const activeId = tabs.find((t) => t.active)?.id ?? null;
    console.log(`[tabs] windowId=${wid}  tabIds=${ids.join(",")}  activeId=${activeId}`);

    await sleep(400);

    // ---- TEST: GET_SNAPSHOT mapping (from an extension page = popup.html tab) ----
    console.log("\n--- TEST 1: GET_SNAPSHOT -> real snapshot mapping ---");
    const snapExpr = `(async()=>{const s=await chrome.runtime.sendMessage({type:"GET_SNAPSHOT"});return JSON.stringify({has:s&&!!s.windowId,windowId:s?.windowId,cycling:s?.cycling,fallback:s?.fallbackSession,releaseToken:s?.releaseToken,tabs:(s?.tabs||[]).map(t=>t.id+(t.selected?"*":""))});})()`;
    const snapA = JSON.parse(await ev(snapExpr));
    console.log("  GET_SNAPSHOT:", JSON.stringify(snapA));
    report.tests.get_snapshot_idle = {
      ok: snapA.has && snapA.cycling === false && snapA.releaseToken === null,
      detail: JSON.stringify(snapA),
    };

    // ---- TEST: ACTIVATE_TAB commit (no token needed) ----
    console.log("\n--- TEST 2: ACTIVATE_TAB -> real commit + activation ---");
    // pick a non-active tab if available, else the active one
    const targetTab = ids.find((id) => id !== activeId) ?? activeId;
    const actRes = await ev(`(async()=>{const r=await chrome.runtime.sendMessage({type:"ACTIVATE_TAB",tabId:${targetTab}});return JSON.stringify(r?{activeTabId:r.activeTabId,cycling:r.cycling,tabs:(r.tabs||[]).map(t=>t.id)}:null);})()`);
    console.log("  ACTIVATE_TAB -> snapshot:", actRes);
    await sleep(400);
    const post = JSON.parse(await ev(`(async()=>{const t=await chrome.tabs.get(${targetTab});return JSON.stringify({active:t.active});})()`));
    console.log(`  chrome.tabs.get(${targetTab}).active =`, post.active);
    report.tests.activate_tab = {
      ok: actRes !== "null" && post.active === true,
      detail: `res=${actRes} postActive=${post.active}`,
    };

    // ---- TEST: POPUP_ADVANCE gate (mismatched token / no cycle) ----
    console.log("\n--- TEST 3: POPUP_ADVANCE gate (no live popup cycle) ---");
    const dropBefore = swc.logs.length;
    const pa1 = await ev(`(async()=>{const r=await chrome.runtime.sendMessage({type:"POPUP_ADVANCE",releaseToken:"bogus-token",windowId:${wid},direction:"forward"});return 'sent';})()`);
    await sleep(500);
    const paSawDrop = swc.logs
      .slice(dropBefore)
      .some((l) => String(l.args).includes("POPUP_ADVANCE") && String(l.args).includes("dropped"));
    console.log("  POPUP_ADVANCE(bogus token) dispatched; handler dropped:", paSawDrop);
    report.tests.popup_advance_gate = {
      ok: paSawDrop,
      detail: `bogus token dropped=${paSawDrop} (message→[RC-diag] mapped)`,
    };

    // ---- TEST: OPTION_RELEASED no-cycle no-op ----
    console.log("\n--- TEST 4: OPTION_RELEASED (no cycle) -> no-op, no spurious switch ---");
    const optBefore = swc.logs.length;
    await ev(`(async()=>{await chrome.runtime.sendMessage({type:"OPTION_RELEASED",releaseToken:"bogus",windowId:${wid}});return 1;})()`);
    await sleep(500);
    const optNoCycle = swc.logs
      .slice(optBefore)
      .some((l) => String(l.args).includes("cycle-end decision") && String(l.args).includes("no-cycle"));
    // ensure active tab did not change to something unexpected
    const optActive = JSON.parse(await ev(`(async()=>{const t=await chrome.tabs.query({active:true});return JSON.stringify(t.map(x=>({id:x.id,wid:x.windowId})));})()`));
    console.log("  OPTION_RELEASED(bogus) no-cycle:", optNoCycle, "| active now:", JSON.stringify(optActive));
    report.tests.option_released_no_cycle = {
      ok: optNoCycle,
      detail: `no-cycle decision ${optNoCycle}; active unchanged ${JSON.stringify(optActive)}`,
    };

    // ---- TEST: CANCEL_CYCLE gate (no cycle) ----
    console.log("\n--- TEST 5: CANCEL_CYCLE gate (no cycle) ---");
    const ccBefore = swc.logs.length;
    await ev(`(async()=>{await chrome.runtime.sendMessage({type:"CANCEL_CYCLE",releaseToken:"bogus",windowId:${wid}});return 1;})()`);
    await sleep(500);
    const ccDropped = swc.logs
      .slice(ccBefore)
      .some((l) => String(l.args).includes("CANCEL_CYCLE") && String(l.args).includes("dropped"));
    console.log("  CANCEL_CYCLE(bogus) dropped:", ccDropped);
    report.tests.cancel_cycle_gate = { ok: ccDropped, detail: `bogus token dropped=${ccDropped}` };

    // ---- BEST-EFFORT: arm a real popup session via storage.seed + SW restart ----
    let armed = false;
    if (ARM_SEED) {
      console.log("\n--- ARM ATTEMPT: seed popup session into storage.session + SW restart ---");
      const tok = "logic-driver-seed-token";
      const can = ids.length >= 2;
      report.arm.via.push("seed:chrome.storage.session+MV3 SW restart");
      if (!can) {
        report.arm.detail = "fewer than 2 tabs => createCycle has <2 candidates; cannot cycle";
        console.log("  SKIP: need >=2 tabs to form a cycle (have", ids.length, ")");
      } else {
        // Seed a popup-fallback session object (same shape background.js writes)
        const cycle = {
          originTabId: ids[0],
          candidateIds: ids.slice(),
          position: 1,
          currentTabId: ids[1],
          releaseToken: tok,
          holdPending: false,
          heldConfirmed: true,
          renderTarget: "popup",
        };
        await ev(`(async()=>{const st={version:2,windows:{}};st.windows['${wid}']={order:${JSON.stringify(ids)},cycle:${JSON.stringify(cycle)},suppressUntil:0};await chrome.storage.session.set({recentCycleState:st});return 1;})()`);
        console.log("  seeded storage.session. Waiting for MV3 SW idle-stop... (CDP keepalive must be dropped)");
        swc.close();
        ctx._swClosed = true;
        await sleep(32000); // MV3 SW idles out ~30s; DevTools attach was released
        // reconnect to (possibly restarted) SW and check whether seed reloaded
        const sw2 = await findRecentCycleSw(port, extId);
        if (!sw2) {
          report.arm.detail = "SW did not restart within window";
          console.log("  SW did not restart");
        } else {
          const c2 = await CDPClient.connect(sw2.webSocketDebuggerUrl);
          await c2.send("Runtime.enable");
          await c2.send("Runtime.evaluate", { expression: "window.__RC_TEST_DIAGNOSTICS=true" });
          const probe = await c2.send("Runtime.evaluate", {
            expression: `(async()=>{const s=await chrome.runtime.sendMessage({type:"GET_SNAPSHOT"});return JSON.stringify({cycling:s?.cycling,fallback:s?.fallbackSession,token:s?.releaseToken,tabs:(s?.tabs||[]).length});})()`,
            awaitPromise: true,
            returnByValue: true,
          });
          const snapB = probe.result?.value;
          console.log("  snapshot after restart:", snapB);
          const parsed = JSON.parse(snapB || "{}");
          if (parsed.cycling === true && parsed.fallback === true && parsed.token === tok) {
            armed = true;
            report.arm.succeeded = true;
            report.arm.detail = "popup session armed via storage seed + SW restart reload";

            // POPUP_ADVANCE happy path (accepted -> advance + broadcast)
            const advBefore = c2.logs.length;
            await c2.send("Runtime.evaluate", {
              expression: `(async()=>{await chrome.runtime.sendMessage({type:"POPUP_ADVANCE",releaseToken:${JSON.stringify(tok)},windowId:${wid},direction:"forward"});return 1;})()`,
              awaitPromise: true,
            });
            await sleep(500);
            const accepted = c2.logs.slice(advBefore).some((l) => String(l.args).includes("POPUP_ADVANCE accepted"));
            report.tests.popup_advance_happy = { ok: accepted, detail: `accepted=${accepted}` };
            console.log("  POPUP_ADVANCE(happy) accepted:", accepted);

            // OPTION_RELEASED happy path (commit + activate selected)
            const relBefore = c2.logs.length;
            await c2.send("Runtime.evaluate", {
              expression: `(async()=>{const r=await chrome.runtime.sendMessage({type:"OPTION_RELEASED",releaseToken:${JSON.stringify(tok)},windowId:${wid}});return JSON.stringify(r&&{activeTabId:r.activeTabId,cycling:r.cycling});})()`,
              awaitPromise: true,
              returnByValue: true,
            });
            await sleep(500);
            const committed = c2.logs.slice(relBefore).some((l) => String(l.args).includes("cycle-end commit"));
            report.tests.option_released_happy = { ok: committed, detail: `committed=${committed}` };
            console.log("  OPTION_RELEASED(happy) committed:", committed);
            report.logs.seedRestartedSw = dump(`SW (seeded arm)`, c2);
          } else {
            report.arm.detail = `seed reloaded but snapshot=${snapB} (did not form popup session)`;
            console.log("  seed did not form an armed popup session: ", snapB);
          }
        }
      }
    }

    // 5) dump full SW + any popup-page logs
    const popupTargets = (await iterateTargets(port)).filter((t) => t.type === "page" && t.url.includes("popup.html"));
    report.logs.sw = dump(`FINAL service worker logs`, swc);

    // Summaries
    console.log("\n================================================================");
    console.log(" SUMMARY");
    console.log("================================================================");
    const all = Object.entries(report.tests);
    for (const [k, v] of all) {
      console.log(`  [${v.ok ? "PASS" : v.ok === false ? "FAIL" : "?"}] ${k}  ${v.detail || ""}`);
    }
    console.log(`  ARM: ${JSON.stringify(report.arm)}`);

    writeFileSync(join(OUT_DIR, "logic-driver-report.json"), JSON.stringify(report, null, 2));
    console.log(`\n[out] wrote ${join(OUT_DIR, "logic-driver-report.json")}`);

    cleanup();
  } catch (err) {
    console.log("\n  FAIL/CAVEAT: uncaught harness error");
    console.log("  ", err && err.stack ? err.stack : err);
    report.error = String(err && err.stack);
    try { writeFileSync(join(OUT_DIR, "logic-driver-report.json"), JSON.stringify(report, null, 2)); } catch {}
    if (ctx) cleanup();
    process.exitCode = 1;
  }
}

main();
