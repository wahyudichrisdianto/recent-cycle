# Browser automation — environment findings (2026-08-05)

Host probe: macOS 26.5.2, Google Chrome 150.0.7871.184, arm64. No headed
shortcut QA was completed; Accessibility-backed real-key injection was not
available to this session.

Goal: reproduce the protected-page popup "release Option -> switch" bug under CDP
automation against real Chrome. Verified obstacles (probe evidence below), in the
order they surfaced:

1. **Branded Google Chrome refuses `--load-extension`**
   `"/Applications/Google Chrome.app/.../Google Chrome"` prints
   `--load-extension is not allowed in Google Chrome, ignoring.` The extension
   can therefore NOT be loaded into the branded binary.

2. **Chrome for Testing (CfT) does load the extension.** Downloaded CfT
   151.0.7922.76 (mac-arm64) to `tools/.chrome4test/`. With
   `--load-extension=<repo> --disable-extensions-except=<repo> --headless=new`,
   the MV3 service worker runs, `globalThis.__RC_TEST_DIAGNOSTICS=true` works,
   and SW console logs (`[RC-diag]`) are captured. So: SW logic IS testable.

3. **`chrome.commands` cannot be triggered by CDP synthetic keys.**
   `Input.dispatchKeyEvent` (Alt -> Tab) injects at the renderer level; the
   accelerator chord is handled by the browser-level router, so `onCommand`
   never fires. Real OS keys (AppleScript `key code`/System Events) are
   required, but that needs **macOS Accessibility permission**, which is
   blocked here (`osascript is not allowed to send keystrokes`).

4. **The action popup cannot be opened under automation.**
   - From the SW: `chrome.action.openPopup()` is **undefined** in this headless
     CfT context (`Cannot read properties of undefined (reading 'openPopup')`).
   - Navigating a tab to `chrome-extension://<id>/popup.html` yields
     `chrome-error://chromewebdata/` (extension pages are not loadable as
     navigated targets here), so `chrome.runtime` is absent there.

5. **The SW cannot message itself.** `chrome.runtime.sendMessage(...)` evaluated
   on the service-worker target fails: `Could not establish connection.
   Receiving end does not exist.` The `onMessage` handler only receives
   messages from extension PAGES / content scripts, and no extension page is
   reachable (see 4), so the popup message contract cannot be driven
   end-to-end from outside without an injectable extension page.

**Conclusion:** a fully-automated *reproduction* of the OS-focus / modifier-keyup
bug is not achievable in this sandbox — it needs a real focused popup window and
real OS key input. Global scope remains useful for popup-focus command delivery,
but it cannot expose physical Option-up or prove that two commands share one
hold. The former protected-page timestamp heuristic was therefore a real code
defect, not merely configuration: a released-and-repressed Option+Tab could be
treated as continuation inside 2500ms.

The implementation now has a Swift Native Messaging companion path. Unit tests
cover the reducer and worker behavior with a deterministic native-event mock;
the actual headed Chrome/macOS focus matrix remains manual work. Without the
companion, the worker deliberately stays in safe degraded mode and does not
open a protected-page list from a time window.
