import Cocoa
import UniformTypeIdentifiers
import WebKit

final class App: NSObject, NSApplicationDelegate, WKScriptMessageHandler {
    private let window: NSWindow
    private let web: WKWebView
    private var server: Process?

    override init() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        let config = WKWebViewConfiguration()
        web = WKWebView(frame: .zero, configuration: config)
        super.init()
        config.userContentController.add(self, name: "saveFile")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "saveFile",
              let body = message.body as? [String: Any],
              let urlString = body["url"] as? String,
              let remote = URL(string: urlString),
              remote.host == "127.0.0.1" || remote.host == "localhost" else { return }
        let suggested = (body["name"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? "audio.wav"
        save(from: remote, suggestedName: suggested)
    }

    private func save(from remote: URL, suggestedName: String) {
        let panel = NSSavePanel()
        panel.title = "Save"
        panel.nameFieldStringValue = suggestedName
        panel.canCreateDirectories = true
        let ext = (suggestedName as NSString).pathExtension
        if !ext.isEmpty, let type = UTType(filenameExtension: ext) {
            panel.allowedContentTypes = [type]
        }
        panel.beginSheetModal(for: window) { [weak self] response in
            guard response == .OK, let destination = panel.url else { return }
            URLSession.shared.downloadTask(with: remote) { temp, _, error in
                if let temp, error == nil {
                    do {
                        if FileManager.default.fileExists(atPath: destination.path) {
                            try FileManager.default.removeItem(at: destination)
                        }
                        try FileManager.default.moveItem(at: temp, to: destination)
                    } catch {
                        self?.showError(redact(error.localizedDescription))
                    }
                } else {
                    self?.showError(redact(error?.localizedDescription ?? "The file could not be saved."))
                }
            }.resume()
        }
    }

    private func showError(_ message: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let alert = NSAlert()
            alert.messageText = "Could not save the file"
            alert.informativeText = message
            alert.beginSheetModal(for: self.window)
        }
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        window.title = "forma"
        window.backgroundColor = .white
        window.isMovable = true
        window.minSize = NSSize(width: 980, height: 720)
        window.setFrameAutosaveName("forma-main")
        window.center()

        web.frame = window.contentView?.bounds ?? .zero
        web.autoresizingMask = [.width, .height]
        window.contentView = web
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        do {
            let page = try launchServer()
            web.load(URLRequest(url: page))
        } catch {
            let alert = NSAlert()
            alert.messageText = "forma could not start"
            alert.informativeText = redact(error.localizedDescription)
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
    }

    private func launchServer() throws -> URL {
        let root = projectRoot()
        let server = root.appendingPathComponent("server.js")
        guard FileManager.default.fileExists(atPath: server.path) else {
            throw Failure("server.js is not next to the app. Keep forma.app inside the converter folder.")
        }
        guard let node = nodeBinary() else {
            throw Failure("Node.js was not found. Install it in /opt/homebrew/bin or /usr/local/bin.")
        }

        let process = Process()
        process.executableURL = node
        process.arguments = [server.path]
        process.currentDirectoryURL = root
        var env = ProcessInfo.processInfo.environment
        let path = env["PATH"] ?? ""
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:\(path)"
        env["PORT"] = "0"
        process.environment = env

        let output = Pipe()
        process.standardOutput = output
        process.standardError = output
        try process.run()
        self.server = process

        let text = try waitForURL(from: output, process: process)
        guard let raw = text.split(whereSeparator: { $0.isWhitespace }).first(where: { $0.hasPrefix("http://127.0.0.1:") }) else {
            throw Failure("The server did not answer. \(redact(text))")
        }
        guard var parts = URLComponents(string: String(raw)) else {
            throw Failure("Could not read the server address.")
        }
        parts.query = "shell=app"
        guard let page = parts.url else {
            throw Failure("Could not read the server address.")
        }
        return page
    }
}

private struct Failure: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}

private func redact(_ text: String) -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    guard home.count > 1 else { return text }
    return text.replacingOccurrences(of: home, with: "~")
}

private func projectRoot() -> URL {
    let bundle = Bundle.main.bundleURL
    if bundle.pathExtension == "app" {
        return bundle.deletingLastPathComponent()
    }
    return URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
}

private func nodeBinary() -> URL? {
    let candidates = [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ]
    return candidates
        .map { URL(fileURLWithPath: $0) }
        .first { FileManager.default.isExecutableFile(atPath: $0.path) }
}

private func waitForURL(from pipe: Pipe, process: Process) throws -> String {
    let handle = pipe.fileHandleForReading
    let group = DispatchGroup()
    group.enter()
    var buffer = ""
    var done = false
    handle.readabilityHandler = { file in
        let data = file.availableData
        if !data.isEmpty, let chunk = String(data: data, encoding: .utf8) {
            buffer += chunk
        }
        if buffer.contains("http://127.0.0.1:") || !process.isRunning {
            if !done {
                done = true
                group.leave()
            }
        }
    }
    let result = group.wait(timeout: .now() + 12)
    handle.readabilityHandler = nil
    if result == .timedOut {
        process.terminate()
        throw Failure("The server did not start in time.")
    }
    if !buffer.contains("http://127.0.0.1:") {
        throw Failure(redact(buffer.isEmpty ? "The server quit immediately." : buffer))
    }
    return buffer
}

let app = NSApplication.shared
let delegate = App()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
