//
//  SelfImproveApprovalView.swift
//  Jori
//
//  The "Improvements" channel — a card feed, not a chat log. Each card is one
//  self-improvement Jori proposed or applied. Everything you can do to a card
//  lives in ONE right-click (macOS) / long-press (iOS) menu:
//
//    1. Implement   — the default action, listed first. Face ID → signs the
//                     approval (see SelfImproveApproval.swift), after which the
//                     host verifies and applies it.
//    2. Skip/Unskip — "we're not implementing this", and its reversal.
//    3. Chat        — jump to the chat channel with a reply composer already
//                     open on this improvement, to ask questions or push back.
//    4. Retry       — only on a card whose apply mechanically failed.
//
//  Replaced tap-to-approve on 2026-07-28: Implement is now the first, bold,
//  default item of the card's menu. Tap-anywhere-to-approve was the only gesture on the
//  card, so every new action would have had to become another inline button
//  competing with it; worse, the single most consequential thing in the app —
//  authorizing Jori to modify its own source — was one stray tap away while
//  scrolling. A menu makes the destructive-adjacent action deliberate and gives
//  the other three somewhere to live.
//
//  Status drives the trailing accessory:
//    - needs approval → a gold "Needs approval" pill
//    - in progress    → a spinning recycle glyph ("Applying…")
//    - done           → a green checkmark
//    - failed         → an amber warning
//    - skipped        → a grey "Skipped" pill, card dimmed, sorted to the bottom
//

import SwiftUI

struct SelfImproveFeedView: View {
    /// Open a chat thread about this improvement. ContentView owns the channel
    /// switch + reply composer, so the feed hands the card up rather than
    /// reaching across into the chat view model itself.
    var onChat: (SelfImproveApproval.Improvement) -> Void = { _ in }

    @State private var items: [SelfImproveApproval.Improvement] = []
    @State private var workingId: String?
    @State private var errorText: String?
    @State private var loaded = false
    /// Bumped when an approval signs, for the success haptic.
    @State private var approvedTick = 0

    // Poll while the feed is on screen so pending → applying → done transitions
    // appear without the user leaving the channel.
    private let refresh = Timer.publish(every: 8, on: .main, in: .common).autoconnect()

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                if items.isEmpty && loaded {
                    emptyState
                } else if !loaded {
                    ProgressView()
                        .padding(.top, 80)
                }
                ForEach(items) { item in
                    card(item)
                        .transition(.opacity.combined(with: .scale(scale: 0.97)))
                }
            }
            .frame(maxWidth: 720)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 28)
            .animation(.snappy(duration: 0.3), value: items.map { "\($0.id)|\($0.status)|\($0.skipped)" })
        }
        .refreshable { await reload() }
        .task { await reload() }
        .onReceive(refresh) { _ in Task { await reload() } }
        .sensoryFeedback(.success, trigger: approvedTick)
        .alert("Couldn’t complete", isPresented: Binding(
            get: { errorText != nil }, set: { if !$0 { errorText = nil } })
        ) {
            Button("OK") { errorText = nil }
        } message: {
            Text(errorText ?? "")
        }
    }

    // MARK: - Cards

    @ViewBuilder
    private func card(_ item: SelfImproveApproval.Improvement) -> some View {
        cardBody(item)
            // contentShape so the menu opens from anywhere on the card, not just
            // where the text happens to be.
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .contextMenu { menu(item) }
    }

    /// The card's whole action surface. Order is deliberate: Implement is first
    /// and bold because it is the default — the thing you came here to do.
    ///
    /// (`.fontWeight(.bold)` on a menu label is honoured by AppKit's NSMenu on
    /// macOS; UIKit renders context-menu items in the system style and will
    /// ignore it. Position and the filled Face ID glyph carry the "this is the
    /// default" signal on iOS, where the styling can't.)
    @ViewBuilder
    private func menu(_ item: SelfImproveApproval.Improvement) -> some View {
        if item.isImplementable {
            Button { Task { await approve(item) } } label: {
                Label {
                    Text("Implement").fontWeight(.bold)
                } icon: {
                    Image(systemName: "faceid")
                }
            }
        }

        if item.skipped {
            Button { Task { await setSkipped(item, false) } } label: {
                Label("Unskip", systemImage: "arrow.uturn.backward")
            }
        } else if item.isSkippable {
            Button { Task { await setSkipped(item, true) } } label: {
                Label("Skip", systemImage: "xmark.circle")
            }
        }

        Button { onChat(item) } label: {
            Label("Chat", systemImage: "bubble.left.and.bubble.right")
        }

        if item.isRetryable {
            Divider()
            Button { Task { await retry(item) } } label: {
                Label("Retry", systemImage: "arrow.clockwise")
            }
        }
    }

    @ViewBuilder
    private func cardBody(_ item: SelfImproveApproval.Improvement) -> some View {
        let shape = RoundedRectangle(cornerRadius: Radius.card, style: .continuous)
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Label(item.itemType == "new-capability" ? "New capability" : "Code fix",
                      systemImage: item.itemType == "new-capability" ? "sparkles" : "wrench.and.screwdriver")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                accessory(item)
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .id(item.phase)
                actionsButton(item)
            }

            Text(item.summary)
                .font(.body.weight(.semibold))
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let rationale = item.rationale, !rationale.isEmpty {
                Text(rationale)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            footer(item)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(JoriTheme.card, in: shape)
        .overlay(
            shape.strokeBorder(item.needsApproval ? JoriTheme.staff.opacity(0.6) : JoriTheme.hairline.opacity(0.7),
                               lineWidth: item.needsApproval ? 1.5 : 0.5))
        // Gold means "waiting on you" everywhere in the app.
        .shadow(color: item.needsApproval ? JoriTheme.staff.opacity(0.22) : Color.black.opacity(0.04),
                radius: item.needsApproval ? 14 : 4, y: 2)
        // A skipped card is kept legible but visibly out of the running — it is
        // still there to be un-skipped, it just isn't asking for anything.
        .opacity(item.skipped ? 0.55 : 1)
    }

    /// A visible handle on the card's menu — the same items as the long-press
    /// / right-click menu, for anyone who doesn't know to hold the card.
    private func actionsButton(_ item: SelfImproveApproval.Improvement) -> some View {
        Menu { menu(item) } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 30, height: 30)
                .background(Circle().fill(Color.primary.opacity(0.06)))
                .contentShape(Circle())
        }
        .menuIndicator(.hidden)
        .fixedSize()
        #if os(macOS)
        .menuStyle(.borderlessButton)
        #endif
        .accessibilityLabel("Actions")
    }

    /// The line under the card: what's happening right now, or what the card
    /// is waiting for.
    @ViewBuilder
    private func footer(_ item: SelfImproveApproval.Improvement) -> some View {
        if workingId == item.id {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Working…")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.top, 2)
        } else if item.needsApproval {
            Label("Implement from the menu", systemImage: "faceid")
                .font(.caption.weight(.semibold))
                .foregroundStyle(JoriTheme.staffInk)
                .padding(.top, 2)
        } else if item.isRetryable {
            Label("Didn’t apply. Retry from the menu.", systemImage: "arrow.clockwise")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.orange)
                .padding(.top, 2)
        }
    }

    @ViewBuilder
    private func accessory(_ item: SelfImproveApproval.Improvement) -> some View {
        switch item.phase {
        case .needsApproval:
            Text("Needs approval")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(JoriTheme.staff.opacity(0.2), in: Capsule())
                .foregroundStyle(JoriTheme.staffInk)
        case .inProgress:
            HStack(spacing: 4) {
                SpinningGlyph()
                Text("Applying")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(JoriTheme.cobalt)
            }
        case .done:
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(JoriTheme.confirmed)
                .accessibilityLabel("Done")
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .accessibilityLabel("Failed")
        case .skipped:
            Text("Skipped")
                .font(.caption2.weight(.semibold))
                .padding(.horizontal, 8).padding(.vertical, 3)
                .background(Color.secondary.opacity(0.18), in: Capsule())
                .foregroundStyle(.secondary)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 10) {
            Image(systemName: "wand.and.stars")
                .font(.system(size: 34, weight: .light))
                .foregroundStyle(JoriTheme.staff)
            Text("Nothing to improve yet")
                .font(JoriTheme.display(22))
            Text("When Jori proposes or applies a change to itself, it appears here. Open a card’s menu to implement, skip, or talk it through.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 380)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 80)
        .padding(.horizontal, 24)
    }

    // MARK: - Actions

    private func reload() async {
        do {
            let rows = try await SelfImproveApproval.fetchFeed()
            await MainActor.run {
                // Don't clobber an optimistic local status mid-approval.
                if workingId == nil { items = rows }
                loaded = true
            }
            if !SelfImproveApproval.isRegistered {
                try? await SelfImproveApproval.registerDeviceKey()
            }
        } catch {
            await MainActor.run { loaded = true }
            print("[SelfImprove] fetch feed failed: \(error)")
        }
    }

    private func approve(_ item: SelfImproveApproval.Improvement) async {
        await MainActor.run { workingId = item.id }
        do {
            try await SelfImproveApproval.approve(item)
            // Optimistically flip to in-progress so the card animates immediately;
            // the next poll confirms applied.
            await MainActor.run {
                if let idx = items.firstIndex(where: { $0.id == item.id }) {
                    items[idx] = item.withStatus("signed")
                }
                workingId = nil
                approvedTick &+= 1
            }
        } catch {
            await MainActor.run {
                workingId = nil
                // A user-cancelled Face ID isn't an error worth an alert.
                if !isUserCancel(error) { errorText = error.localizedDescription }
            }
        }
    }

    private func setSkipped(_ item: SelfImproveApproval.Improvement, _ skipped: Bool) async {
        await MainActor.run { workingId = item.id }
        do {
            try await SelfImproveApproval.setSkipped(item, skipped)
            await MainActor.run {
                if let idx = items.firstIndex(where: { $0.id == item.id }) {
                    items[idx] = item.withSkipped(skipped)
                }
                workingId = nil
            }
            // Re-sort immediately (skipped cards drop to the bottom) rather than
            // leaving the card sitting where it was until the next 8s poll.
            await reload()
        } catch {
            await MainActor.run {
                workingId = nil
                errorText = error.localizedDescription
            }
        }
    }

    private func retry(_ item: SelfImproveApproval.Improvement) async {
        await MainActor.run { workingId = item.id }
        do {
            try await SelfImproveApproval.retry(item)
            // Optimistically flip to in-progress; the next poll confirms
            // applied or reports it's still failing.
            await MainActor.run {
                if let idx = items.firstIndex(where: { $0.id == item.id }) {
                    items[idx] = item.withStatus("retry_requested")
                }
                workingId = nil
            }
        } catch {
            await MainActor.run {
                workingId = nil
                errorText = error.localizedDescription
            }
        }
    }

    private func isUserCancel(_ error: Error) -> Bool {
        let ns = error as NSError
        // LAError.userCancel == -2; Security userCanceled == errSecUserCanceled.
        return ns.localizedDescription.lowercased().contains("cancel")
    }
}

/// A recycle glyph that spins to signal "applying now".
private struct SpinningGlyph: View {
    @State private var spin = false
    var body: some View {
        Image(systemName: "arrow.triangle.2.circlepath")
            .font(.caption.weight(.semibold))
            .foregroundStyle(JoriTheme.cobalt)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .animation(.linear(duration: 1.1).repeatForever(autoreverses: false), value: spin)
            .onAppear { spin = true }
    }
}

private extension SelfImproveApproval.Improvement {
    func withStatus(_ s: String) -> SelfImproveApproval.Improvement {
        SelfImproveApproval.Improvement(
            id: id, itemType: itemType, summary: summary, rationale: rationale,
            itemHash: itemHash, nonce: nonce, status: s, risk: risk,
            skipped: false, chatMessageId: chatMessageId, expiresAtMs: expiresAtMs)
    }

    func withSkipped(_ v: Bool) -> SelfImproveApproval.Improvement {
        SelfImproveApproval.Improvement(
            id: id, itemType: itemType, summary: summary, rationale: rationale,
            itemHash: itemHash, nonce: nonce, status: status, risk: risk,
            skipped: v, chatMessageId: chatMessageId, expiresAtMs: expiresAtMs)
    }
}
