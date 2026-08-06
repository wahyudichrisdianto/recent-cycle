import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

private let protocolVersion = 1

private final class NativeMessagingIO {
    private let outputLock = NSLock()

    func readMessage() -> [String: Any]? {
        guard let header = readExactly(4) else { return nil }
        let length = header.withUnsafeBytes { bytes in
            bytes.load(as: UInt32.self).littleEndian
        }
        guard length > 0, length <= 1_048_576,
              let payload = readExactly(Int(length)),
              let object = try? JSONSerialization.jsonObject(with: payload),
              let message = object as? [String: Any] else {
            return nil
        }
        return message
    }

    func write(_ message: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(message),
              let payload = try? JSONSerialization.data(withJSONObject: message),
              let length = UInt32(exactly: payload.count) else { return }

        var littleEndianLength = length.littleEndian
        let header = Data(bytes: &littleEndianLength, count: 4)
        outputLock.lock()
        FileHandle.standardOutput.write(header)
        FileHandle.standardOutput.write(payload)
        outputLock.unlock()
    }

    private func readExactly(_ count: Int) -> Data? {
        var data = Data()
        while data.count < count {
            guard let chunk = try? FileHandle.standardInput.read(upToCount: count - data.count),
                  !chunk.isEmpty else { return nil }
            data.append(chunk)
        }
        return data
    }
}

private final class RecentCycleHost {
    private let io = NativeMessagingIO()
    private var sequence: UInt64 = 0
    private var optionDown = false
    private var shiftDown = false
    private var tabDown = false
    private var eventTap: CFMachPort?
    private var eventSource: CFRunLoopSource?

    func run() {
        DispatchQueue.global(qos: .utility).async { [weak self] in
            guard let self else { return }
            while let message = self.io.readMessage() {
                DispatchQueue.main.async {
                    self.handleExtensionMessage(message)
                }
            }
            DispatchQueue.main.async {
                self.stopEventTap()
                CFRunLoopStop(CFRunLoopGetMain())
            }
        }

        RunLoop.main.run()
    }

    private func handleExtensionMessage(_ message: [String: Any]) {
        guard let version = message["version"] as? Int, version == protocolVersion,
              let type = message["type"] as? String else {
            return
        }

        guard type == "handshake" else { return }
        let trusted = AXIsProcessTrustedWithOptions([
            kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true,
        ] as CFDictionary)
        let capabilities: [String: Any] = [
            "optionLifecycle": trusted,
            "shiftState": trusted,
            "tabState": trusted,
            "nativeOverlay": false,
        ]
        io.write([
            "version": protocolVersion,
            "type": "handshake-ack",
            "capabilities": capabilities,
        ])

        guard trusted else {
            io.write([
                "version": protocolVersion,
                "type": "error",
                "code": "accessibility-denied",
            ])
            return
        }
        startEventTap()
        sendKeyboardState()
    }

    private func startEventTap() {
        guard eventTap == nil else { return }
        let mask = (CGEventMask(1) << CGEventType.flagsChanged.rawValue)
            | (CGEventMask(1) << CGEventType.keyDown.rawValue)
            | (CGEventMask(1) << CGEventType.keyUp.rawValue)
            | (CGEventMask(1) << CGEventType.tapDisabledByTimeout.rawValue)
            | (CGEventMask(1) << CGEventType.tapDisabledByUserInput.rawValue)

        let callback: CGEventTapCallBack = { _, type, event, refcon in
            guard let refcon else { return Unmanaged.passUnretained(event) }
            let host = Unmanaged<RecentCycleHost>.fromOpaque(refcon).takeUnretainedValue()
            return host.handle(eventType: type, event: event)
        }

        eventTap = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .headInsertEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque(),
        )
        guard let eventTap else {
            io.write([
                "version": protocolVersion,
                "type": "error",
                "code": "event-tap-unavailable",
            ])
            return
        }

        eventSource = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, eventTap, 0)
        if let eventSource {
            CFRunLoopAddSource(CFRunLoopGetMain(), eventSource, .commonModes)
        }
        CGEvent.tapEnable(tap: eventTap, enable: true)
    }

    private func stopEventTap() {
        if let eventSource {
            CFRunLoopRemoveSource(CFRunLoopGetMain(), eventSource, .commonModes)
        }
        if let eventTap {
            CGEvent.tapEnable(tap: eventTap, enable: false)
        }
        eventSource = nil
        eventTap = nil
    }

    private func handle(eventType: CGEventType, event: CGEvent) -> Unmanaged<CGEvent>? {
        if eventType == .tapDisabledByTimeout || eventType == .tapDisabledByUserInput {
            io.write([
                "version": protocolVersion,
                "type": "helper-status",
                "status": "event-tap-disabled",
            ])
            if let eventTap { CGEvent.tapEnable(tap: eventTap, enable: true) }
            return Unmanaged.passUnretained(event)
        }

        let flags = event.flags
        let nextOptionDown = flags.contains(.maskAlternate)
        let nextShiftDown = flags.contains(.maskShift)

        if eventType == .flagsChanged {
            if nextOptionDown != optionDown {
                optionDown = nextOptionDown
                sendKeyEvent(key: "option", phase: nextOptionDown ? "down" : "up")
            }
            if nextShiftDown != shiftDown {
                shiftDown = nextShiftDown
                sendKeyEvent(key: "shift", phase: nextShiftDown ? "down" : "up")
            }
        } else if event.getIntegerValueField(.keyboardEventKeycode) == 48 {
            let nextTabDown = eventType == .keyDown
            if nextTabDown != tabDown {
                tabDown = nextTabDown
                sendKeyEvent(key: "tab", phase: nextTabDown ? "down" : "up")
            }
        }

        return Unmanaged.passUnretained(event)
    }

    private func sendKeyboardState() {
        send(type: "keyboard-state")
    }

    private func sendKeyEvent(key: String, phase: String) {
        send(type: "key-event", key: key, phase: phase)
    }

    private func send(type: String, key: String? = nil, phase: String? = nil) {
        sequence += 1
        var message: [String: Any] = [
            "version": protocolVersion,
            "type": type,
            "sequence": sequence,
            "timestampMs": Int64(ProcessInfo.processInfo.systemUptime * 1000),
            "optionDown": optionDown,
            "shiftDown": shiftDown,
            "tabDown": tabDown,
        ]
        if let key { message["key"] = key }
        if let phase { message["phase"] = phase }
        io.write(message)
    }
}

private let host = RecentCycleHost()
host.run()
