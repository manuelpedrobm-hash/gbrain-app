// Cerebro.app — ventana propia para el panel (http://127.0.0.1:3140), sin navegador.
// Al abrir pide un código de un solo uso con el secreto de ~/.gbrain-panel/secret (como
// «Abrir panel.command») y entra por /login?n=…. WKWebView guarda cookies y localStorage
// entre aperturas: la sesión y los borradores sin enviar sobreviven a cerrar la app.
// Los enlaces que salen de 127.0.0.1:3140 se abren en el navegador por defecto.
// Compilar: panel/app-mac/build.sh
import Cocoa
import WebKit

let BASE = URL(string: "http://127.0.0.1:3140")!

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate {
    var window: NSWindow!
    var web: WKWebView!

    func applicationDidFinishLaunching(_ n: Notification) {
        buildMenu()
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()          // persistente: cookies + localStorage
        web = WKWebView(frame: .zero, configuration: cfg)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1200, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Cerebro"
        window.contentView = web
        window.setFrameAutosaveName("CerebroMain")
        if !window.setFrameUsingName("CerebroMain") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        open(path: "/")
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ s: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ s: NSApplication, hasVisibleWindows f: Bool) -> Bool {
        window.makeKeyAndOrderFront(nil); return true
    }

    /// Pide un nonce y entra; si el panel no responde, enseña un aviso con reintento.
    func open(path: String) {
        let secretURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".gbrain-panel/secret")
        guard let secret = try? String(contentsOf: secretURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines),
              !secret.isEmpty else { fail("No encuentro ~/.gbrain-panel/secret."); return }
        var req = URLRequest(url: BASE.appendingPathComponent("api/login-nonce"))
        req.httpMethod = "POST"
        req.setValue(secret, forHTTPHeaderField: "X-Panel-Secret")
        req.timeoutInterval = 5
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            DispatchQueue.main.async {
                guard let data = data, (resp as? HTTPURLResponse)?.statusCode == 200,
                      let nonce = String(data: data, encoding: .utf8)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !nonce.isEmpty,
                      var c = URLComponents(url: BASE.appendingPathComponent("login"), resolvingAgainstBaseURL: false)
                else { self.fail("El panel no está en marcha (127.0.0.1:3140)."); return }
                c.queryItems = [URLQueryItem(name: "n", value: nonce)]
                self.web.load(URLRequest(url: c.url!))
            }
        }.resume()
    }

    func fail(_ msg: String) {
        let a = NSAlert()
        a.messageText = msg
        a.informativeText = "Arráncalo con: launchctl kickstart -k gui/__UID__/com.__USER__.gbrain-panel"
        a.addButton(withTitle: "Reintentar"); a.addButton(withTitle: "Salir")
        if a.runModal() == .alertFirstButtonReturn { open(path: "/") } else { NSApp.terminate(nil) }
    }

    // Fuera del panel → navegador por defecto.
    func webView(_ w: WKWebView, decidePolicyFor a: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = a.request.url, u.scheme?.hasPrefix("http") == true, u.host != "127.0.0.1" || u.port != 3140 {
            NSWorkspace.shared.open(u); decisionHandler(.cancel); return
        }
        decisionHandler(.allow)
    }
    // target=_blank
    func webView(_ w: WKWebView, createWebViewWith c: WKWebViewConfiguration, for a: WKNavigationAction, windowFeatures f: WKWindowFeatures) -> WKWebView? {
        if let u = a.request.url { if u.host == "127.0.0.1" && u.port == 3140 { w.load(a.request) } else { NSWorkspace.shared.open(u) } }
        return nil
    }
    // alert()/confirm() de la página
    func webView(_ w: WKWebView, runJavaScriptAlertPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert(); a.messageText = m; a.runModal(); completionHandler()
    }
    func webView(_ w: WKWebView, runJavaScriptConfirmPanelWithMessage m: String, initiatedByFrame f: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert(); a.messageText = m; a.addButton(withTitle: "Aceptar"); a.addButton(withTitle: "Cancelar")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    @objc func reload() { web.reload() }
    @objc func relogin() { open(path: "/") }
    @objc func back() { web.goBack() }

    func buildMenu() {
        let main = NSMenu()
        func add(_ title: String, _ items: [NSMenuItem]) {
            let it = NSMenuItem(); let m = NSMenu(title: title); items.forEach { m.addItem($0) }; it.submenu = m; main.addItem(it)
        }
        add("Cerebro", [NSMenuItem(title: "Ocultar Cerebro", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h"),
                        .separator(),
                        NSMenuItem(title: "Salir de Cerebro", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")])
        add("Edición", [NSMenuItem(title: "Deshacer", action: Selector(("undo:")), keyEquivalent: "z"),
                        NSMenuItem(title: "Rehacer", action: Selector(("redo:")), keyEquivalent: "Z"),
                        .separator(),
                        NSMenuItem(title: "Cortar", action: #selector(NSText.cut(_:)), keyEquivalent: "x"),
                        NSMenuItem(title: "Copiar", action: #selector(NSText.copy(_:)), keyEquivalent: "c"),
                        NSMenuItem(title: "Pegar", action: #selector(NSText.paste(_:)), keyEquivalent: "v"),
                        NSMenuItem(title: "Seleccionar todo", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")])
        let r = NSMenuItem(title: "Recargar", action: #selector(reload), keyEquivalent: "r"); r.target = self
        let l = NSMenuItem(title: "Volver a entrar", action: #selector(relogin), keyEquivalent: "R"); l.target = self
        let b = NSMenuItem(title: "Atrás", action: #selector(back), keyEquivalent: "["); b.target = self
        add("Ver", [r, l, b])
        add("Ventana", [NSMenuItem(title: "Minimizar", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m"),
                        NSMenuItem(title: "Cerrar", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")])
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
