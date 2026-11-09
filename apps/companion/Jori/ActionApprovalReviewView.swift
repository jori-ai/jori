//
//  ActionApprovalReviewView.swift
//  Jori
//
//  Blocking review sheet for a plugin action (Face ID on iPhone, Touch ID on
//  Mac). Shows everything the signature covers: the title, which plugin asks,
//  every field and every param the action will run with. The only ways out
//  are Approve or Deny. Trust model: ActionApproval.swift.
//

import SwiftUI

struct ActionApprovalReviewView: View {
    let approvalId: String
    let onDone: () -> Void

    @State private var request: ActionApproval.Request?
    @State private var loadError: String?
    @State private var working = false
    @State private var error: String?
    @State private var now = Date()

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if let r = request {
                review(r)
            } else if let loadError {
                VStack(spacing: 16) {
                    Image(systemName: "checkmark.shield")
                        .font(.system(size: 34, weight: .light))
                        .foregroundStyle(.secondary)
                    Text(loadError).multilineTextAlignment(.center).foregroundStyle(.secondary)
                    Button("Close") { onDone() }
                        .controlSize(.large)
                        .prominentButtonStyle()
                        .keyboardShortcut(.defaultAction)
                }.padding(32)
            } else {
                ProgressView("Loading request…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .interactiveDismissDisabled(true)
        .onReceive(ticker) { now = $0 }
        .task { await load() }
    }

    private func load() async {
        do {
            guard let r = try await ActionApproval.fetch(approvalId) else {
                loadError = "This request no longer exists."; return
            }
            guard r.status == "pending" else {
                loadError = "This request was already \(r.status)."; return
            }
            request = r
        } catch {
            // A param the card can't show (a decimal, a nested value) fails to
            // decode here: nothing is shown, so nothing can be signed.
            loadError = "This request can't be shown, so it can't be approved. (\(error.localizedDescription))"
        }
    }

    @ViewBuilder
    private func review(_ r: ActionApproval.Request) -> some View {
        let secondsLeft = max(0, Int(r.expiresAt.timeIntervalSince(now)))
        let expired = secondsLeft <= 0
        VStack(spacing: 0) {
            VStack(spacing: 8) {
                Image(systemName: "checkmark.shield.fill")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(JoriTheme.staffInk)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(JoriTheme.staff.opacity(0.18)))
                    .symbolEffect(.bounce, value: request?.id)
                Text("Approve action").font(.title3.weight(.semibold))
                Text(r.item.title)
                    .font(.headline).multilineTextAlignment(.center)
                Text("Asked by the \(r.item.plugin) plugin")
                    .font(.subheadline).foregroundStyle(.secondary)
                ExpiryCapsule(secondsLeft: secondsLeft)
            }
            .padding(.top, 28).padding(.horizontal, 20).padding(.bottom, 8)

            List {
                if !r.item.fields.isEmpty {
                    Section("What will happen") {
                        ForEach(Array(r.item.fields.enumerated()), id: \.offset) { _, f in
                            row(f.label, f.value)
                        }
                    }
                }
                if !r.item.params.isEmpty {
                    Section {
                        ForEach(r.item.sortedParams, id: \.key) { p in
                            row(p.key, p.value.display, mono: true)
                        }
                    } header: {
                        Text("Exactly what it runs with")
                    }
                }
                Section {
                    EmptyView()
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        if let asked = r.requestText, !asked.isEmpty { Text("You asked: “\(asked)”") }
                        Text("Action: \(r.item.plugin) / \(r.item.action)")
                        Text(expired
                             ? "This request has expired. Deny to dismiss it."
                             : "Approving runs this once, with exactly these values.")
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
                approveTitle: "Approve with \(PurchaseApproval.biometryName)",
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
    }

    private func row(_ label: String, _ value: String, mono: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value)
                .font(mono ? .body.monospaced() : .body)
                .textSelection(.enabled)
        }
    }

    private func resolve(_ r: ActionApproval.Request, approve: Bool) async {
        working = true
        error = nil
        do {
            if approve { try await ActionApproval.approve(r) } else { try await ActionApproval.deny(r) }
            onDone()
        } catch {
            self.error = error.localizedDescription
            working = false
        }
    }
}
