import SwiftUI
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// Share-sheet entry point: "Jori" in the iOS share sheet and the macOS Share
// menu. Hosts the SwiftUI composer; the platform split is only the controller
// base class.

#if os(iOS)
final class ShareViewController: UIViewController {
    override func viewDidLoad() {
        super.viewDidLoad()
        embed(ShareComposeView(model: makeModel()))
    }

    private func makeModel() -> ShareComposeModel {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        return ShareComposeModel(items: items) { [weak self] done in
            if done {
                self?.extensionContext?.completeRequest(returningItems: nil)
            } else {
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            }
        }
    }

    private func embed<V: View>(_ root: V) {
        let host = UIHostingController(rootView: root)
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)
    }
}
#else
final class ShareViewController: NSViewController {
    override func loadView() {
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        let model = ShareComposeModel(items: items) { [weak self] done in
            if done {
                self?.extensionContext?.completeRequest(returningItems: nil)
            } else {
                self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled))
            }
        }
        let host = NSHostingView(rootView: ShareComposeView(model: model))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 320)
        view = host
        preferredContentSize = host.frame.size
    }
}
#endif
