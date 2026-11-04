//
//  PurchaseApprovalReviewView.swift
//  Jori
//
//  Blocking purchase-approval bottom sheet (Face ID on iPhone, Touch ID on Mac).
//  Shows the agent's recommendation ("Why these": a note and e.g. a marked seat
//  map, tap to zoom) above what the signature covers. Shows exactly what the signature will cover — items, total breakdown, card, delivery address — plus the
//  screenshot of the merchant's real review page. The only ways out are
//  Approve (Face ID) or Deny. See PurchaseApproval.swift for the trust model.
//

import SwiftUI

#if os(iOS)
import UIKit
typealias PurchasePlatformImage = UIImage
private extension Image { init(platform i: UIImage) { self.init(uiImage: i) } }
#else
import AppKit
typealias PurchasePlatformImage = NSImage
private extension Image { init(platform i: NSImage) { self.init(nsImage: i) } }
#endif

struct PurchaseApprovalReviewView: View {
    let purchaseId: String
    let onDone: () -> Void

    @State private var request: PurchaseApproval.Request?
    @State private var screenshot: PurchasePlatformImage?
    @State private var showShot = false
    @State private var loadError: String?
    @State private var working = false
    @State private var error: String?
    @State private var now = Date()
    @State private var mapURL: URL?
    @Environment(\.openURL) private var openURL

    private func openMap(_ url: URL) {
        #if os(iOS)
        mapURL = url
        #else
        openURL(url)
        #endif
    }

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if let r = request {
                review(r)
            } else if let loadError {
                VStack(spacing: 16) {
                    Image(systemName: "cart.badge.minus")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(loadError).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Close") { onDone() }
                        .controlSize(.large)
                        .prominentButtonStyle()
                        .keyboardShortcut(.defaultAction)
                }.padding(32)
            } else {
                ProgressView("Loading purchase…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .interactiveDismissDisabled(true)
        #if os(iOS)
        .fullScreenCover(item: Binding(get: { mapURL.map(IdentifiedURL.init) }, set: { mapURL = $0?.url })) { item in
            ImageViewer(url: item.url)
        }
        #endif
        .onReceive(ticker) { now = $0 }
        .task { await load() }
    }

    private func load() async {
        do {
            guard let r = try await PurchaseApproval.fetch(purchaseId) else {
                loadError = "This purchase request no longer exists."; return
            }
            guard r.status == "pending" else {
                loadError = "This purchase was already \(r.status)."; return
            }
            request = r
            if let data = try? await PurchaseApproval.screenshot(for: r) { screenshot = PurchasePlatformImage(data: data) }
        } catch {
            loadError = error.localizedDescription
        }
    }

    private func money(_ c: Int?, _ r: PurchaseApproval.Request) -> String {
        c.map { PurchaseApproval.money($0, r.item.currency) } ?? "—"
    }

    @ViewBuilder
    private func review(_ r: PurchaseApproval.Request) -> some View {
        let secondsLeft = max(0, Int(r.expiresAt.timeIntervalSince(now)))
        let expired = secondsLeft <= 0
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Image(systemName: "cart.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(JoriTheme.staffInk)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(JoriTheme.staff.opacity(0.18)))
                    .symbolEffect(.bounce, value: request?.id)
                Text("Approve purchase").font(.title3.weight(.semibold))
                Text("\(r.item.merchant), \(r.item.site)")
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(PurchaseApproval.money(r.item.totalCents, r.item.currency))
                    .font(.system(size: 44, weight: .bold, design: .rounded)).monospacedDigit()
                    .contentTransition(.numericText())
                ExpiryCapsule(secondsLeft: secondsLeft)
            }
            .padding(.top, 28).padding(.horizontal, 20).padding(.bottom, 8)

            List {
                if let c = r.context, (c.note?.isEmpty == false) || c.image != nil {
                    Section("Why these") {
                        if let note = c.note, !note.isEmpty { Text(note) }
                        if let url = c.image {
                            // A link, not an inline picture, to save space. Opens full screen
                            // with zoom on iPhone, in the browser on the Mac.
                            Button { openMap(url) } label: {
                                Label("See where the seats are", systemImage: "map")
                            }
                        }
                    }
                }
                Section("What you're buying") {
                    ForEach(Array(r.item.items.enumerated()), id: \.offset) { _, line in
                        HStack(alignment: .firstTextBaseline) {
                            Text("\(line.qty)×").monospacedDigit().foregroundStyle(.secondary)
                            Text(line.title)
                            Spacer()
                            if let c = line.lineCents { Text(money(c, r)).monospacedDigit() }
                        }
                    }
                }
                Section("Cost") {
                    if r.item.subtotalCents != nil { row("Subtotal", money(r.item.subtotalCents, r)) }
                    if r.item.shippingCents != nil { row("Shipping", money(r.item.shippingCents, r)) }
                    if r.item.taxCents != nil { row("Tax", money(r.item.taxCents, r)) }
                    if r.item.discountCents != nil { row("Discount", money(r.item.discountCents, r)) }
                    row("Total", PurchaseApproval.money(r.item.totalCents, r.item.currency), bold: true)
                }
                Section("Paid with") {
                    Label("\(r.item.card.label) ••\(r.item.card.last4)", systemImage: "creditcard.fill")
                }
                Section("Delivered to") {
                    if let ship = r.item.shipTo {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ship.name).bold()
                            Text(ship.address).foregroundStyle(.secondary)
                        }
                    } else {
                        Text("No physical delivery").foregroundStyle(.secondary)
                    }
                }
                Section {
                    if let screenshot {
                        Button { showShot = true } label: {
                            Image(platform: screenshot).resizable().scaledToFit()
                                .frame(maxHeight: 220)
                                .clipShape(RoundedRectangle(cornerRadius: Radius.thumb, style: .continuous))
                                .overlay(alignment: .bottomTrailing) {
                                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                                        .font(.caption.weight(.bold))
                                        .padding(7)
                                        .glassSurface(in: Circle())
                                        .padding(6)
                                }
                        }
                    } else {
                        Text("Screenshot unavailable").foregroundStyle(.secondary)
                    }
                } header: {
                    Text("\(r.item.merchant)'s review page")
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let asked = r.requestText, !asked.isEmpty { Text("You asked: “\(asked)”") }
                        Text(expired
                             ? "This request has expired. Deny to dismiss it."
                             : "Approving places this order with \(PurchaseApproval.biometryName).")
                    }
                }
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(JoriTheme.deny).font(.footnote)
                    .multilineTextAlignment(.center).padding(.horizontal, 20).padding(.top, 8)
                    .transition(.opacity)
            }

            ApprovalButtons(
                approveTitle: "Buy with \(PurchaseApproval.biometryName)",
                approveSymbol: PurchaseApproval.biometryName == "Touch ID" ? "touchid" : "faceid",
                working: working,
                expired: expired,
                onDeny: { Task { await resolve(r, approve: false) } },
                onApprove: { Task { await resolve(r, approve: true) } }
            )
            .padding(20)
        }
        .animation(.snappy, value: error)
        .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
        .sheet(isPresented: $showShot) {
            if let screenshot {
                ScrollView([.vertical, .horizontal]) { Image(platform: screenshot) }
                    #if os(macOS)
                    .frame(minWidth: 700, minHeight: 600)
                    .toolbar { ToolbarItem { Button("Close") { showShot = false } } }
                    #endif
            }
        }
    }

    private func row(_ label: String, _ value: String, bold: Bool = false) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text(value).monospacedDigit()
        }
        .font(bold ? .body.bold() : .body)
    }

    private func resolve(_ r: PurchaseApproval.Request, approve: Bool) async {
        working = true
        error = nil
        do {
            if approve { try await PurchaseApproval.approve(r) } else { try await PurchaseApproval.deny(r) }
            onDone()
        } catch {
            self.error = error.localizedDescription
            working = false
        }
    }
}

struct PurchaseApprovalPairingView: View {
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var working = false
    @State private var registered = PurchaseApproval.isRegistered
    @State private var message: String?
    @State private var isError = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if registered {
                        Label("This \(PurchaseApproval.deviceNoun) can approve purchases", systemImage: "checkmark.seal.fill").foregroundStyle(.green)
                    } else {
                        Label("Not paired", systemImage: "exclamationmark.triangle").foregroundStyle(.secondary)
                    }
                } footer: {
                    Text("Jori never places an order until you approve it with \(PurchaseApproval.biometryName). The approval key lives in this \(PurchaseApproval.deviceNoun)'s Secure Enclave and works only here — pair each device you want to approve from.")
                }
                Section {
                    // An explicit prompt with the label hidden: on the Mac a Form puts a
                    // TextField's title in a clipped label column ("XXX-XXXX" cut off).
                    TextField("Pairing code", text: $code, prompt: Text("XXXX-XXXX"))
                        .labelsHidden()
                        #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        #endif
                        .autocorrectionDisabled()
                        .font(.system(.body, design: .monospaced))
                    Button {
                        Task { await pair() }
                    } label: {
                        if working { ProgressView() } else { Text(registered ? "Re-pair this \(PurchaseApproval.deviceNoun)" : "Pair this \(PurchaseApproval.deviceNoun)") }
                    }
                    .disabled(working || code.filter { $0.isLetter || $0.isNumber }.count < 8)
                } header: {
                    Text("Pairing code")
                } footer: {
                    Text("Ask Jori for a purchase pairing code (it runs `purchase pair` on the host). Codes expire after 15 minutes and work once.")
                }
                if let message {
                    Section { Text(message).foregroundStyle(isError ? .red : .green) }
                }
            }
            .formStyle(.grouped)   // the Mac's default columns style clips the long footers
            .navigationTitle("Purchase Approval")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func pair() async {
        working = true
        message = nil
        defer { working = false }
        do {
            try await PurchaseApproval.pair(code: code)
            registered = true
            isError = false
            message = "Paired. Purchases now come to this \(PurchaseApproval.deviceNoun) for \(PurchaseApproval.biometryName)."
            code = ""
        } catch {
            isError = true
            message = error.localizedDescription
        }
    }
}

private struct IdentifiedURL: Identifiable {
    let url: URL
    var id: String { url.absoluteString }
}
