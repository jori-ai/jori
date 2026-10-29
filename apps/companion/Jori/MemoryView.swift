import SwiftUI
import WebKit

/// Embedded browser for the Jori memory wiki served from the host at the
/// build's JORI_WIKI_URL (reachable over Tailscale or the home LAN).
/// Designed to swap into the chat window's main content area — the parent
/// owns the surrounding NavigationStack/title/toolbar so the user can switch
/// back to a chat channel from the same menu that opened Memory.
struct MemoryView: View {
    let url: URL?
    @ObservedObject var state: WebViewState

    var body: some View {
        if let url {
            browser(url)
        } else {
            VStack(spacing: 12) {
                Image(systemName: "book.closed")
                    .font(.system(size: 34, weight: .light))
                    .foregroundStyle(.secondary)
                Text("No wiki configured")
                    .font(JoriTheme.display(22))
                Text("This build has no wiki address (JORI_WIKI_URL in the installation's build configuration).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 360)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func browser(_ url: URL) -> some View {
        ZStack(alignment: .top) {
            WebView(initialURL: url, state: state)
            if state.isLoading {
                ProgressView()
                    .progressViewStyle(.linear)
                    .tint(JoriTheme.cobalt)
                    .frame(maxWidth: .infinity)
                    .transition(.opacity)
            }
            if let err = state.loadError {
                errorOverlay(err)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.2), value: state.isLoading)
        .animation(.easeOut(duration: 0.25), value: state.loadError)
    }

    @ViewBuilder
    private func errorOverlay(_ message: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(.secondary)
                .symbolEffect(.pulse, options: .repeating)
            Text("Can’t reach the wiki")
                .font(JoriTheme.display(22))
            Text("Connect Tailscale or join the home network, then try again.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
            Text(message)
                .font(.caption)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 360)
            Button {
                state.reload()
            } label: {
                Label("Try Again", systemImage: "arrow.clockwise")
                    .padding(.horizontal, 6)
            }
            .controlSize(.large)
            .prominentButtonStyle()
            .buttonBorderShape(.capsule)
            .keyboardShortcut(.defaultAction)
            .padding(.top, 6)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial)
    }
}

@MainActor
final class WebViewState: ObservableObject {
    @Published var canGoBack: Bool = false
    @Published var canGoForward: Bool = false
    @Published var isLoading: Bool = false
    @Published var loadError: String?

    fileprivate weak var webView: WKWebView?

    func goBack() { webView?.goBack() }
    func goForward() { webView?.goForward() }
    func reload() {
        loadError = nil
        if webView?.url == nil, let pending = pendingInitialURL {
            webView?.load(URLRequest(url: pending))
        } else {
            webView?.reload()
        }
    }

    fileprivate var pendingInitialURL: URL?
}

#if os(iOS)
private struct WebView: UIViewRepresentable {
    let initialURL: URL
    let state: WebViewState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeUIView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        state.webView = webView
        state.pendingInitialURL = initialURL
        context.coordinator.attach(webView)
        webView.load(URLRequest(url: initialURL))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: WebViewCoordinator {}
}
#else
private struct WebView: NSViewRepresentable {
    let initialURL: URL
    let state: WebViewState

    func makeCoordinator() -> Coordinator { Coordinator(state: state) }

    func makeNSView(context: Context) -> WKWebView {
        let webView = WKWebView(frame: .zero, configuration: WKWebViewConfiguration())
        webView.navigationDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        state.webView = webView
        state.pendingInitialURL = initialURL
        context.coordinator.attach(webView)
        webView.load(URLRequest(url: initialURL))
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {}

    final class Coordinator: WebViewCoordinator {}
}
#endif

private class WebViewCoordinator: NSObject, WKNavigationDelegate {
    let state: WebViewState
    private var observers: [NSKeyValueObservation] = []

    init(state: WebViewState) {
        self.state = state
    }

    func attach(_ webView: WKWebView) {
        observers.append(webView.observe(\.canGoBack, options: [.initial, .new]) { [weak self] wv, _ in
            Task { @MainActor in self?.state.canGoBack = wv.canGoBack }
        })
        observers.append(webView.observe(\.canGoForward, options: [.initial, .new]) { [weak self] wv, _ in
            Task { @MainActor in self?.state.canGoForward = wv.canGoForward }
        })
        observers.append(webView.observe(\.isLoading, options: [.initial, .new]) { [weak self] wv, _ in
            Task { @MainActor in self?.state.isLoading = wv.isLoading }
        })
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor in state.loadError = nil }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in state.loadError = error.localizedDescription }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        Task { @MainActor in state.loadError = error.localizedDescription }
    }

    /// The out-of-process WebKit renderer was killed (iOS reaps it under
    /// memory pressure, or after the app sits backgrounded for a while).
    /// None of the other delegate methods above fire when this happens, so
    /// without an explicit reload the view is left permanently blank —
    /// no error card, no spinner, nothing — because `loadError`/`isLoading`
    /// just keep whatever value they had before the process died.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        Task { @MainActor in webView.reload() }
    }
}
