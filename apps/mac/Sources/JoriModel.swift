// JoriModel — what the menu bar app knows about the Jori on this Mac, and
// the few things it can do. Everything runs the checkout's own `jori` CLI
// (bin/jori), so the app holds no logic of its own that could drift from it.

import AppKit
import Foundation
import ServiceManagement

enum JoriState: Equatable {
    case notInstalled
    case installing
    case stopped
    case starting
    case running
}

@MainActor
final class JoriModel: ObservableObject {
    @Published var state: JoriState = .stopped
    @Published var log: String = ""
    @Published var busy: String? = nil
    @Published var updatesAvailable: Int = 0
    @Published var lastError: String? = nil
    @Published var openAtLogin: Bool = SMAppService.mainApp.status == .enabled

    /// Where Jori lives: JORI_HOME in the app's defaults (`defaults write
    /// <bundle id> JORI_HOME <path>`), else ~/Dev/jori.
    let home: URL = {
        if let p = UserDefaults.standard.string(forKey: "JORI_HOME"), !p.isEmpty { return URL(fileURLWithPath: (p as NSString).expandingTildeInPath) }
        return FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Dev/jori")
    }()

    var cli: URL { home.appendingPathComponent("bin/jori") }
    var installed: Bool { FileManager.default.isExecutableFile(atPath: cli.path) }

    private var timer: Timer?
    private var setupProcess: Process?

    init() {
        refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.refresh() }
        }
    }

    // A GUI app starts with a bare PATH; the CLI needs Homebrew's node, git and claude.
    var environment: [String: String] {
        var env = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        env["PATH"] = ["/opt/homebrew/bin", "/usr/local/bin", "\(home)/.local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin", env["PATH"] ?? ""].joined(separator: ":")
        env["JORI_HOME"] = self.home.path
        env["NO_COLOR"] = "1"
        return env
    }

    // MARK: status

    func refresh() {
        guard state != .installing else { return }
        guard installed else { state = .notInstalled; return }
        Task {
            async let chat = Self.healthy(port: 9094)
            async let ops = Self.healthy(port: 9093)
            let (c, o) = await (chat, ops)
            if c && o { state = .running }
            else if c || o { state = .starting }
            else if state != .starting || busy == nil { state = .stopped }
        }
    }

    nonisolated static func healthy(port: Int) async -> Bool {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/health")!)
        req.timeoutInterval = 2
        guard let (_, resp) = try? await URLSession.shared.data(for: req) else { return false }
        return (resp as? HTTPURLResponse)?.statusCode == 200
    }

    // MARK: running commands

    /// Run a command to completion, appending its output to `log`.
    @discardableResult
    func run(_ exe: URL, _ args: [String], extraEnv: [String: String] = [:]) async -> Int32 {
        let p = Process()
        p.executableURL = exe
        p.arguments = args
        p.environment = environment.merging(extraEnv) { $1 }
        p.currentDirectoryURL = FileManager.default.homeDirectoryForCurrentUser
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = pipe
        p.standardInput = FileHandle.nullDevice
        pipe.fileHandleForReading.readabilityHandler = { h in
            let d = h.availableData
            guard !d.isEmpty, let s = String(data: d, encoding: .utf8) else { return }
            let clean = s.replacingOccurrences(of: "\u{1B}\\[[0-9;]*m", with: "", options: .regularExpression)
            Task { @MainActor in self.log = String((self.log + clean).suffix(20_000)) }
        }
        do { try p.run() } catch {
            log += "\n\(error.localizedDescription)\n"
            return 127
        }
        return await withCheckedContinuation { cont in
            p.terminationHandler = { proc in
                pipe.fileHandleForReading.readabilityHandler = nil
                cont.resume(returning: proc.terminationStatus)
            }
        }
    }

    var hasHomebrew: Bool {
        ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].contains { FileManager.default.isExecutableFile(atPath: $0) }
    }

    // MARK: actions

    /// Install with the bundled copy of site/install.sh, then open setup.
    func install() {
        guard let script = Bundle.main.url(forResource: "install", withExtension: "sh") else {
            lastError = "This copy of the app is missing its installer. Download it again from getjori.ai."
            return
        }
        state = .installing
        log = ""
        lastError = nil
        Task {
            let code = await run(URL(fileURLWithPath: "/bin/bash"), [script.path], extraEnv: ["JORI_NO_SETUP": "1", "JORI_HOME": home.path])
            if code == 0 && installed {
                state = .stopped
                openSetup()
            } else {
                state = installed ? .stopped : .notInstalled
                lastError = "The install stopped before it finished. The last lines below say why."
            }
        }
    }

    /// Homebrew asks for the Mac password, which only Terminal can do.
    func installInTerminal() {
        let cmd = "curl -fsSL https://getjori.ai/install.sh | bash"
        let src = "tell application \"Terminal\" to activate\ntell application \"Terminal\" to do script \"\(cmd)\""
        var err: NSDictionary?
        NSAppleScript(source: src)?.executeAndReturnError(&err)
        if err != nil {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(cmd, forType: .string)
            lastError = "Couldn't open Terminal. The install command is on your clipboard: paste it into Terminal."
        }
    }

    /// `jori setup` serves the setup page and opens it in the browser; it
    /// keeps running until the page is finished, so it is not awaited.
    func openSetup() {
        if let p = setupProcess, p.isRunning {
            // Already serving: run it again only to reopen the browser tab.
            p.terminate()
        }
        let p = Process()
        p.executableURL = cli
        p.arguments = ["setup"]
        p.environment = environment
        p.standardOutput = FileHandle.nullDevice
        p.standardError = FileHandle.nullDevice
        p.standardInput = FileHandle.nullDevice
        do { try p.run(); setupProcess = p } catch { lastError = error.localizedDescription }
    }

    func openControlRoom() {
        NSWorkspace.shared.open(URL(string: "http://127.0.0.1:9096/control")!)
    }

    func showLogs() {
        NSWorkspace.shared.open(home.appendingPathComponent("agent/logs"))
    }

    func start() {
        perform("Starting Jori…", ["setup", "start"]) { self.state = .starting }
    }

    func restart() {
        perform("Restarting Jori…", ["restart", "session"]) { self.state = .starting }
    }

    func checkForUpdates() {
        Task {
            let p = Process()
            p.executableURL = cli
            p.arguments = ["update", "--check", "--json"]
            p.environment = environment
            let out = Pipe()
            p.standardOutput = out
            p.standardError = FileHandle.nullDevice
            guard (try? p.run()) != nil else { return }
            p.waitUntilExit()
            let data = out.fileHandleForReading.readDataToEndOfFile()
            if let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                updatesAvailable = (j["behind"] as? Int) ?? 0
            }
        }
    }

    func update() {
        perform("Updating Jori…", ["update"]) { self.updatesAvailable = 0 }
    }

    private func perform(_ label: String, _ args: [String], after: @escaping () -> Void) {
        busy = label
        lastError = nil
        Task {
            let code = await run(cli, args)
            busy = nil
            if code == 0 { after() } else { lastError = "\(label.replacingOccurrences(of: "…", with: "")) didn't work. Open the log for details." }
            refresh()
        }
    }

    func setOpenAtLogin(_ on: Bool) {
        do {
            if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
        } catch {
            lastError = "Couldn't change Open at login: \(error.localizedDescription)"
        }
        openAtLogin = SMAppService.mainApp.status == .enabled
    }
}
