// Bookmark for macOS — a native window around the Bookmark web app.
//
// It loads the live GitHub Pages site, so every deploy reaches the Mac app
// automatically. The persistent WebKit data store keeps the Supabase session
// and offline copy between launches. The delegates below add the browser
// features a bare WKWebView lacks: JS alert/confirm, <input type=file>
// (Import backup), downloads (Export backup) and opening outside links in
// the default browser.

import Cocoa
import WebKit

let appURL = URL(string: "https://dasunpubudumal.github.io/bookmark/")!

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var showingOfflinePage = false

    // MARK: - Launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default() // persistent: stay signed in across launches
        config.applicationNameForUserAgent = "BookmarkMac/1.0"

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.setValue(false, forKey: "drawsBackground") // no white flash; page paints its own bg

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 460, height: 860),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Bookmark"
        window.minSize = NSSize(width: 360, height: 520)
        window.contentView = webView
        window.delegate = self
        window.center()
        window.setFrameAutosaveName("BookmarkMainWindow") // remember size/position
        window.makeKeyAndOrderFront(nil)

        webView.load(URLRequest(url: appURL))
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // MARK: - Menu (Edit menu is required for ⌘C / ⌘V / ⌘A in text fields)

    func buildMenu() {
        let main = NSMenu()

        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Bookmark", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Bookmark", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        let hideOthers = appMenu.addItem(withTitle: "Hide Others", action: #selector(NSApplication.hideOtherApplications(_:)), keyEquivalent: "h")
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Bookmark", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r")
        viewMenu.addItem(.separator())
        viewMenu.addItem(withTitle: "Actual Size", action: #selector(zoomReset), keyEquivalent: "0")
        viewMenu.addItem(withTitle: "Zoom In", action: #selector(zoomIn), keyEquivalent: "+")
        viewMenu.addItem(withTitle: "Zoom Out", action: #selector(zoomOut), keyEquivalent: "-")
        viewItem.submenu = viewMenu
        main.addItem(viewItem)

        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        windowItem.submenu = windowMenu
        main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }

    @objc func reload() {
        if showingOfflinePage { webView.load(URLRequest(url: appURL)) } else { webView.reload() }
    }
    @objc func zoomIn() { webView.pageZoom = min(webView.pageZoom + 0.1, 2.0) }
    @objc func zoomOut() { webView.pageZoom = max(webView.pageZoom - 0.1, 0.6) }
    @objc func zoomReset() { webView.pageZoom = 1.0 }

    // MARK: - Navigation

    func isAppURL(_ url: URL) -> Bool {
        url.host == appURL.host && url.path.hasPrefix(appURL.path)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { // <a download> — "Export backup"
            decisionHandler(.download)
            return
        }
        if let url = action.request.url,
           action.navigationType == .linkActivated,
           ["http", "https", "mailto"].contains(url.scheme ?? ""),
           !isAppURL(url) {
            NSWorkspace.shared.open(url) // outside links open in the default browser
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView,
                 decidePolicyFor response: WKNavigationResponse,
                 decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        decisionHandler(response.canShowMIMEType ? .allow : .download)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        if webView.url?.scheme != "about" { showingOfflinePage = false }

        // `BOOKMARK_SMOKE_TEST=1 Bookmark.app/Contents/MacOS/Bookmark` prints what
        // the page is showing and quits — used to check a build actually works.
        if ProcessInfo.processInfo.environment["BOOKMARK_SMOKE_TEST"] != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                let probe = """
                JSON.stringify({
                  url: location.href,
                  title: document.title,
                  screen: ['bootView','setupView','authView','libraryView','addView']
                    .filter(id => { const el = document.getElementById(id); return el && !el.hidden; }),
                  supabaseLoaded: !!(window.supabase && window.supabase.createClient),
                  configured: !!(window.BOOKMARK_CONFIG && window.BOOKMARK_CONFIG.supabaseUrl)
                })
                """
                webView.evaluateJavaScript(probe) { result, error in
                    print("SMOKE \(result ?? error ?? "nil")")
                    exit(0)
                }
            }
        }
    }

    // Shown when the site can't be reached (e.g. offline at launch).
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let nsError = error as NSError
        if nsError.code == NSURLErrorCancelled { return }
        showingOfflinePage = true
        let message = nsError.localizedDescription
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
        webView.loadHTMLString("""
        <!doctype html><meta charset="utf-8">
        <style>
          :root { color-scheme: light dark; }
          body { font: 15px -apple-system, sans-serif; display: grid; place-items: center;
                 height: 100vh; margin: 0; background: #f7f3ec; color: #2a2520; text-align: center; }
          @media (prefers-color-scheme: dark) { body { background: #171513; color: #efe8de; } }
          h1 { font: 600 22px Georgia, serif; margin: 0 0 8px; }
          p { opacity: .7; margin: 0 0 20px; padding: 0 24px; }
          a { background: #b4532a; color: #fff; padding: 10px 22px; border-radius: 999px;
              text-decoration: none; font-weight: 600; }
        </style>
        <div><h1>Can't reach Bookmark</h1><p>\(message)</p>
        <a href="\(appURL.absoluteString)">Try again</a></div>
        """, baseURL: nil)
    }

    // MARK: - Pop-ups, dialogs and file pickers

    // target=_blank / window.open → default browser
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // <input type="file"> — "Import backup"
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // MARK: - Downloads ("Export backup")

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { return completionHandler(nil) }
            try? FileManager.default.removeItem(at: url) // user already confirmed replacing
            completionHandler(url)
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        let alert = NSAlert(error: error)
        alert.beginSheetModal(for: window)
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
