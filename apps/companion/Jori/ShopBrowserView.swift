import SwiftUI
import WebKit

/// The shop browser: the host's shop Chrome, live, inside the app — for a
/// merchant sign-in or a card field the agent could not finish.
///
/// It is the host's own page (agent/shop-view/server.mjs, the "app" listener),
/// reached straight over Tailscale at the build's JORI_SHOP_VIEW_URL, the way
/// the Memory tab reaches the wiki. No Cloudflare: the way in is a Face ID
/// signature from this device's paired PURCHASE key over a one-time challenge
/// (`<purchase domain>/shop-view`, lib/shop-view.mjs → AppSessions), which the
/// host checks against `purchase_device_keys` and answers with a short-lived
/// session cookie for this web view.
///
/// Opened by tapping a shop-browser link in chat (`ShopBrowser.handles`), or
/// from the menu.
struct ShopBrowserView: View {
    /// The link that opened it (carries the page's `open`/`site` hints), or
    /// the bare address from the menu.
    let link: URL
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .signingIn

    enum Phase: Equatable {
        case signingIn
        case open(URL)
        case failed(String)
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Shop browser")
                #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
                #endif
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { dismiss() }
                    }
                }
        }
        .task { await signIn() }
        #if os(macOS)
        .frame(minWidth: 520, idealWidth: 640, minHeight: 640, idealHeight: 860)
        #endif
    }

    @ViewBuilder
    private var content: some View {
        switch phase {
        case .signingIn:
            VStack(spacing: 14) {
                ProgressView()
                Text("Opening the shop browser…")
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .open(let url):
            ShopWebView(url: url)
                .ignoresSafeArea(edges: .bottom)
        case .failed(let message):
            VStack(spacing: 12) {
                Image(systemName: "cart.badge.questionmark")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.secondary)
                Text("Can’t open the shop browser")
                    .font(JoriTheme.display(22))
                Text(message)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
                Button {
                    Task { await signIn() }
                } label: {
                    Label("Try Again", systemImage: "arrow.clockwise")
                        .padding(.horizontal, 6)
                }
                .controlSize(.large)
                .prominentButtonStyle()
                .buttonBorderShape(.capsule)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    @MainActor
    private func signIn() async {
        phase = .signingIn
        do {
            phase = .open(try await ShopBrowser.sessionURL(for: link))
        } catch {
            phase = .failed(error.localizedDescription)
        }
    }
}

enum ShopBrowser {
    /// The host's app listener (JORI_SHOP_VIEW_URL); nil when the build has none.
    static var base: URL? { Install.shopViewURL }

    /// Ask the main window to present the shop browser for this link.
    static let openRequest = Notification.Name("ShopBrowser.open")
    static func open(_ url: URL) {
        NotificationCenter.default.post(name: openRequest, object: url)
    }

    /// A link to the shop browser: same scheme, host and port as the build's
    /// address. Chat links like that open here instead of in a browser.
    static func handles(_ url: URL) -> Bool {
        guard let base else { return false }
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port
            && (url.path.isEmpty || url.path == "/")
    }

    enum Failure: LocalizedError {
        case notConfigured, notPaired, unreachable(String), refused(String)
        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "This build has no shop browser address (JORI_SHOP_VIEW_URL in the installation's build configuration)."
            case .notPaired:
                return "This \(PurchaseApproval.deviceNoun) isn’t paired for purchase approval yet (menu → Pair Purchase Approval)."
            case .unreachable(let why):
                return "Turn on Tailscale, then try again.\n\n\(why)"
            case .refused(let why):
                return why
            }
        }
    }

    /// Challenge → Face ID signature → the session URL the web view loads
    /// (the host answers it with a cookie and a redirect to the page).
    static func sessionURL(for link: URL) async throws -> URL {
        guard let base else { throw Failure.notConfigured }
        guard PurchaseApproval.isRegistered else { throw Failure.notPaired }

        struct Challenge: Decodable { let nonce: String; let expires_at_ms: Int64 }
        let challengeURL = base.appending(path: "app/challenge")
        var request = URLRequest(url: challengeURL, timeoutInterval: 10)
        request.cachePolicy = .reloadIgnoringLocalCacheData
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw Failure.unreachable(error.localizedDescription)
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 403 { throw Failure.unreachable("The host only opens the shop browser over Tailscale.") }
        guard status == 200, let challenge = try? JSONDecoder().decode(Challenge.self, from: data) else {
            throw Failure.refused("The host didn’t answer the sign-in (HTTP \(status)).")
        }

        let signature = try PurchaseApproval.signShopViewSession(nonce: challenge.nonce, expiresAtMs: challenge.expires_at_ms)

        // Where to land: the link's own query (the page's "Open it" hint).
        let next = "/" + (link.query.map { "?\($0)" } ?? "")
        guard var c = URLComponents(url: base.appending(path: "app/session"), resolvingAgainstBaseURL: false) else {
            throw Failure.notConfigured
        }
        c.queryItems = [
            URLQueryItem(name: "d", value: PurchaseApproval.deviceId),
            URLQueryItem(name: "n", value: challenge.nonce),
            URLQueryItem(name: "s", value: signature),
            URLQueryItem(name: "next", value: next),
        ]
        // "+" and "/" in base64 must survive the query string.
        c.percentEncodedQuery = c.percentEncodedQuery?
            .replacingOccurrences(of: "+", with: "%2B")
        guard let url = c.url else { throw Failure.notConfigured }
        return url
    }
}

/// Opened from a chat link: identifiable so a sheet can present it.
struct ShopBrowserLink: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}

// MARK: - Web view

/// A plain web view with its own non-persistent store: the session cookie
/// lives only as long as this screen.
#if os(iOS)
private struct ShopWebView: UIViewRepresentable {
    let url: URL
    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: ShopWebView.configuration())
        webView.load(URLRequest(url: url))
        return webView
    }
    func updateUIView(_ webView: WKWebView, context: Context) {}
    static func configuration() -> WKWebViewConfiguration {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        return config
    }
}
#else
private struct ShopWebView: NSViewRepresentable {
    let url: URL
    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: config)
        webView.load(URLRequest(url: url))
        return webView
    }
    func updateNSView(_ webView: WKWebView, context: Context) {}
}
#endif
