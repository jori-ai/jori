// Jori for Mac — a menu bar app that installs Jori, opens its setup page and
// then shows whether it is running, with the few things worth one click.
//
// The agent itself still runs as the ai.jori.session launch agent; quitting
// this app never stops it.

import AppKit
import SwiftUI

@main
struct JoriMacApp: App {
    @StateObject private var model = JoriModel()

    var body: some Scene {
        MenuBarExtra {
            MenuContent(model: model)
        } label: {
            Image(nsImage: FaceIcon.image(awake: model.state == .running, busy: model.busy != nil || model.state == .starting || model.state == .installing))
                .accessibilityLabel(model.state.label)
        }
        .menuBarExtraStyle(.menu)

        Window("Welcome to Jori", id: "welcome") {
            WelcomeView(model: model)
        }
        .windowResizability(.contentSize)
        .defaultPosition(.center)
        // Shown by itself on the first launch, before Jori is installed.
        .defaultLaunchBehavior(model.installed ? .suppressed : .presented)
    }
}

extension JoriState {
    var label: String {
        switch self {
        case .notInstalled: return "Jori isn’t installed yet"
        case .installing: return "Installing Jori…"
        case .stopped: return "Jori isn’t running"
        case .starting: return "Jori is starting…"
        case .running: return "Jori is running"
        }
    }
}

struct MenuContent: View {
    @ObservedObject var model: JoriModel
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Text(model.busy ?? model.state.label)
        if let e = model.lastError { Text(e) }
        Divider()
        switch model.state {
        case .notInstalled, .installing:
            Button("Install Jori…") { open() }
        case .stopped:
            Button("Start Jori") { model.start() }.disabled(model.busy != nil)
            Button("Finish setup…") { model.openSetup() }
        case .starting, .running:
            Button("Open control room") { model.openControlRoom() }.keyboardShortcut("o")
            Button("Setup page…") { model.openSetup() }
        }
        if model.installed {
            Divider()
            if model.updatesAvailable > 0 {
                Button("Update now (\(model.updatesAvailable) new)") { model.update() }.disabled(model.busy != nil)
            } else {
                Button("Check for updates") { model.checkForUpdates() }
            }
            Button("Restart Jori") { model.restart() }.disabled(model.busy != nil || model.state == .stopped)
            Button("Show logs") { model.showLogs() }
        }
        Divider()
        Toggle("Open at login", isOn: Binding(get: { model.openAtLogin }, set: { model.setOpenAtLogin($0) }))
        Button("Quit menu bar app") { NSApp.terminate(nil) }.keyboardShortcut("q")
            .help("Jori keeps running in the background")
            .onAppear { model.checkForUpdates() }
    }

    private func open() {
        openWindow(id: "welcome")
        NSApp.activate(ignoringOtherApps: true)
    }
}

struct WelcomeView: View {
    @ObservedObject var model: JoriModel

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(spacing: 16) {
                Image(nsImage: NSApp.applicationIconImage).resizable().frame(width: 64, height: 64)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title).font(.system(size: 24, weight: .semibold, design: .serif))
                    Text(subtitle).foregroundStyle(.secondary)
                }
            }
            if model.state == .installing || !model.log.isEmpty {
                ScrollViewReader { proxy in
                    ScrollView {
                        Text(model.log.isEmpty ? "Starting…" : model.log)
                            .font(.system(size: 11, design: .monospaced))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                            .id("end")
                    }
                    .frame(height: 220)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color(nsColor: .textBackgroundColor)))
                    .onChange(of: model.log) { proxy.scrollTo("end", anchor: .bottom) }
                }
            }
            if let e = model.lastError { Text(e).foregroundStyle(.red) }
            HStack {
                Spacer()
                switch model.state {
                case .notInstalled where !model.hasHomebrew:
                    Button("Install in Terminal") { model.installInTerminal() }.keyboardShortcut(.defaultAction)
                case .notInstalled:
                    Button("Install Jori") { model.install() }.keyboardShortcut(.defaultAction)
                case .installing:
                    ProgressView().controlSize(.small)
                default:
                    Button("Open the setup page") { model.openSetup() }.keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(24)
        .frame(width: 520)
    }

    private var title: String {
        switch model.state {
        case .notInstalled: return "Let’s set up Jori."
        case .installing: return "Installing…"
        default: return "Jori is installed."
        }
    }

    private var subtitle: String {
        switch model.state {
        case .notInstalled where !model.hasHomebrew:
            return "First Homebrew, which asks for your Mac password, so this part runs in Terminal. It takes about five minutes."
        case .notInstalled:
            return "I’ll install what’s missing (Node.js, Claude Code, local memory search) and put Jori in \(model.home.path.replacingOccurrences(of: NSHomeDirectory(), with: "~")). About three minutes."
        case .installing:
            return "This takes a few minutes. You can close this window; Jori opens the setup page when it’s done."
        default:
            return "The setup page in your browser signs you in to Claude and starts Jori."
        }
    }
}

/// The robot head as a template image for the menu bar: eyes open while
/// Jori runs, closed while it doesn't, half-open while it is busy.
enum FaceIcon {
    static func image(awake: Bool, busy: Bool) -> NSImage {
        let size = NSSize(width: 20, height: 18)
        let img = NSImage(size: size, flipped: false) { _ in
            NSColor.black.setFill()
            let head = NSBezierPath(roundedRect: NSRect(x: 2, y: 1, width: 16, height: 16), xRadius: 5, yRadius: 5)
            let visor = NSBezierPath(roundedRect: NSRect(x: 4, y: 3, width: 12, height: 11.5), xRadius: 3.5, yRadius: 3.5)
            head.append(visor.reversed)
            head.fill()
            NSBezierPath(roundedRect: NSRect(x: 0, y: 6, width: 2, height: 6), xRadius: 1, yRadius: 1).fill()
            NSBezierPath(roundedRect: NSRect(x: 18, y: 6, width: 2, height: 6), xRadius: 1, yRadius: 1).fill()
            let eyeH: CGFloat = awake ? 4.5 : busy ? 2.4 : 1.2
            let eyeY: CGFloat = 8.6 - eyeH / 2 + 0.6
            for x in [6.6, 11.4] as [CGFloat] {
                NSBezierPath(roundedRect: NSRect(x: x, y: eyeY, width: 2, height: eyeH), xRadius: 1, yRadius: min(1, eyeH / 2)).fill()
            }
            return true
        }
        img.isTemplate = true
        return img
    }
}
