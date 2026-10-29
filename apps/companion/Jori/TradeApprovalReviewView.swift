//
//  TradeApprovalReviewView.swift
//  Jori
//
//  Blocking trade-approval screen. Presented full-screen when a trade-approval
//  push is opened; the user CANNOT do anything else in the app until they
//  explicitly tap Approve (Face ID) or Deny. Approving signs the request with
//  the Secure Enclave key and only then are the trades placed.
//

import SwiftUI

struct TradeApprovalReviewView: View {
    let request: TradeApproval.Request
    /// Called once the request is resolved (approved or denied) to dismiss.
    let onDone: () -> Void

    @State private var working = false
    @State private var error: String?
    @State private var now = Date()

    private let ticker = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var secondsLeft: Int { max(0, request.expiresAt - Int(now.timeIntervalSince1970)) }
    private var expired: Bool { secondsLeft <= 0 }

    var body: some View {
        VStack(spacing: 0) {
            // Header
            VStack(spacing: 8) {
                Image(systemName: "chart.line.uptrend.xyaxis")
                    .font(.system(size: 22, weight: .semibold))
                    .foregroundStyle(JoriTheme.staffInk)
                    .frame(width: 52, height: 52)
                    .background(Circle().fill(JoriTheme.staff.opacity(0.18)))
                Text("Approve trades")
                    .font(.title3.weight(.semibold))
                Text(request.summary)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                ExpiryCapsule(secondsLeft: secondsLeft)
                    .padding(.top, 2)
            }
            .padding(.top, 32)
            .padding(.horizontal, 20)
            .padding(.bottom, 8)

            // Itemized transactions
            List {
                Section {
                    ForEach(request.orders) { o in
                        HStack(spacing: 10) {
                            Text(o.side)
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(o.side == "BUY" ? JoriTheme.confirmed : JoriTheme.deny)
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(Capsule().fill((o.side == "BUY" ? JoriTheme.confirmed : JoriTheme.deny).opacity(0.14)))
                                .frame(width: 48, alignment: .leading)
                            Text(o.ticker).bold()
                            Spacer()
                            Text("\(o.shares) sh")
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                            Text("$\(o.amount.formatted())")
                                .frame(width: 92, alignment: .trailing)
                                .monospacedDigit()
                        }
                    }
                    if request.moreCount > 0 {
                        Text("+ \(request.moreCount) more — review the full list on the dashboard")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                } footer: {
                    Text(expired
                         ? "This request has expired. Deny to dismiss it."
                         : "Approving places these trades. It needs Face ID or Touch ID.")
                }
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .foregroundStyle(JoriTheme.deny)
                    .font(.footnote)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 20)
                    .padding(.top, 8)
                    .transition(.opacity)
            }

            // The only way out of this screen.
            ApprovalButtons(
                approveTitle: "Approve",
                approveSymbol: "faceid",
                working: working,
                expired: expired,
                onDeny: { Task { await resolve(approve: false) } },
                onApprove: { Task { await resolve(approve: true) } }
            )
            .padding(20)
        }
        .animation(.snappy, value: error)
        .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
        .interactiveDismissDisabled(true)
        .onReceive(ticker) { now = $0 }
    }

    private func resolve(approve: Bool) async {
        working = true
        error = nil
        do {
            if approve {
                try await TradeApproval.approve(request)   // presents Face ID
            } else {
                try await TradeApproval.deny(request)
            }
            onDone()
        } catch {
            self.error = error.localizedDescription
            working = false
        }
    }
}
