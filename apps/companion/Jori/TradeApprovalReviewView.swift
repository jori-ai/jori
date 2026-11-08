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

/// Approvals › Pending approvals: every trade and purchase waiting for a
/// decision, by title, fetched by the app itself so a push that never arrived
/// doesn't strand one. Seeing the list needs no Face ID; tapping an entry opens
/// its usual review screen, where approving does.
struct PendingApprovalsView: View {
    /// Called with the new count whenever the list reloads (sidebar badge).
    var onCount: (Int) -> Void = { _ in }

    @Environment(\.dismiss) private var dismiss

    private enum Entry: Identifiable {
        case trade(TradeApproval.Request)
        case purchase(PurchaseApproval.Waiting)

        var id: String {
            switch self {
            case .trade(let r): return "trade-\(r.executionId)"
            case .purchase(let p): return "purchase-\(p.id)"
            }
        }
        var title: String {
            switch self {
            case .trade(let r): return r.summary
            case .purchase(let p): return p.title
            }
        }
        var kind: String {
            switch self {
            case .trade: return "Trade"
            case .purchase: return "Purchase"
            }
        }
        var expiresAt: Date {
            switch self {
            case .trade(let r): return Date(timeIntervalSince1970: TimeInterval(r.expiresAt))
            case .purchase(let p): return p.expiresAt
            }
        }
    }

    @State private var entries: [Entry] = []
    @State private var loading = true
    @State private var tradesLocked = false
    @State private var errors: [String] = []
    @State private var trade: TradeApproval.Request?
    @State private var purchase: PurchaseApproval.Ref?

    var body: some View {
        NavigationStack {
            List {
                if loading && entries.isEmpty {
                    HStack { Spacer(); ProgressView(); Spacer() }
                } else if entries.isEmpty && errors.isEmpty && !tradesLocked {
                    Text("Nothing is waiting for approval.")
                        .foregroundStyle(.secondary)
                }
                ForEach(entries) { e in
                    Button { open(e) } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(e.title).font(.subheadline)
                            Text("\(e.kind) · expires \(e.expiresAt, style: .relative)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
                if tradesLocked {
                    Button { Task { await load(unlockTrades: true) } } label: {
                        Label("Show trade approvals (Face ID once)", systemImage: "faceid")
                    }
                }
                ForEach(errors, id: \.self) { message in
                    Label(message, systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(JoriTheme.deny)
                        .font(.footnote)
                }
            }
            .navigationTitle("Pending approvals")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .automatic) {
                    Button { Task { await load() } } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .disabled(loading)
                }
            }
            .refreshable { await load() }
            .task { await load() }
        }
        #if os(iOS)
        .fullScreenCover(item: $trade) { r in
            TradeApprovalReviewView(request: r) {
                trade = nil
                Task { await load() }
            }
        }
        #else
        .sheet(item: $trade) { r in
            TradeApprovalReviewView(request: r) {
                trade = nil
                Task { await load() }
            }
            .frame(minWidth: 420, idealWidth: 480, minHeight: 520, idealHeight: 620)
        }
        #endif
        .sheet(item: $purchase) { ref in
            PurchaseApprovalReviewView(purchaseId: ref.id) {
                purchase = nil
                Task { await load() }
            }
            #if os(macOS)
            .frame(minWidth: 460, idealWidth: 520, minHeight: 560, idealHeight: 680)
            #endif
        }
    }

    private func open(_ e: Entry) {
        switch e {
        case .trade(let r): trade = r
        case .purchase(let p): purchase = PurchaseApproval.Ref(id: p.id)
        }
    }

    private func load(unlockTrades: Bool = false) async {
        loading = true
        var next: [Entry] = []
        var problems: [String] = []
        var locked = false
        if TradeApproval.isRegistered {
            do {
                next += try await TradeApproval.fetchPending(interactive: unlockTrades).map(Entry.trade)
            } catch let error as NSError where error == TradeApproval.needsUnlock {
                locked = true
            } catch {
                problems.append("Trades: \(error.localizedDescription)")
            }
        }
        if PurchaseApproval.isRegistered {
            do {
                next += try await PurchaseApproval.fetchWaiting().map(Entry.purchase)
            } catch {
                problems.append("Purchases: \(error.localizedDescription)")
            }
        }
        entries = next.sorted { $0.expiresAt > $1.expiresAt }
        errors = problems
        tradesLocked = locked
        loading = false
        onCount(entries.count)
    }
}

/// How many approvals are waiting, for the Pending approvals badge. Silent
/// (no Face ID); a source that can't be read counts as zero.
enum PendingApprovals {
    static func count() async -> Int {
        var n = 0
        if TradeApproval.isRegistered, let t = try? await TradeApproval.fetchPending(interactive: false) { n += t.count }
        if PurchaseApproval.isRegistered, let p = try? await PurchaseApproval.fetchWaiting() { n += p.count }
        return n
    }
}
