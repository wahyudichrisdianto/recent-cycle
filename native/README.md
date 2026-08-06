# Recent Cycle macOS companion

The companion is a local Chrome Native Messaging host. It observes only:

- macOS modifier flag changes needed for Option and Shift;
- Tab key down/up (key code 48);
- event-tap health notifications.

It never receives ordinary character events, writes a keystroke stream to disk, uses
the network, runs shell commands from extension messages, or retains tab content.

## Install

Prefer the one-line installer at the repo root — it downloads the release, extracts the
extension, and registers this host automatically:

```sh
curl -fsSL https://raw.githubusercontent.com/wahyudichrisdianto/recent-cycle/main/install.sh | bash
```

Manual steps:

1. Load the repository as an unpacked extension in Chrome.
2. Copy the extension ID from `chrome://extensions`.
3. Run `./native/install.sh <extension-id>`.
4. Reload the extension and approve Accessibility access for the host if macOS asks.
5. Set the forward shortcut to Global in `chrome://extensions/shortcuts`.

The installer registers an exact `chrome-extension://<id>/` origin in
`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`. A different unpacked
path or extension ID requires reinstalling the host manifest with the new ID.

## Remove

Run `./native/uninstall.sh`. This removes only the Recent Cycle host executable and its
Chrome manifest. Accessibility approval is managed by macOS and can be revoked separately.

## Protocol

The extension connects to `com.recentcycle.keyboard` with `runtime.connectNative()` and sends
a versioned handshake. The host responds with capabilities and then sends length-prefixed
JSON messages on Chrome's Native Messaging stdio channel. Every event has a strictly increasing
sequence and monotonic `timestampMs`:

```json
{
  "version": 1,
  "type": "key-event",
  "sequence": 43,
  "timestampMs": 123456789,
  "key": "option",
  "phase": "up",
  "optionDown": false,
  "shiftDown": false,
  "tabDown": false
}
```

The extension drops invalid, duplicate, and out-of-order messages. Option-up ends the current
session immediately. If the host is absent, disconnected, outdated, or denied Accessibility
access, the extension stays in degraded mode: protected-page commands remain independent silent
switches and no timer opens a list.
