//
//  SelfImproveApprovalView.swift
//  Jori
//
//  An improvement card, drawn inside its message in the conversation feed —
//  the way a question is drawn. The owner, 2026-11-15: "Fixes should behave
//  like questions in the way they're presented to the user - not in a
//  separate Improvements tab."
//
//  The card is a message (self-improve-request posts it with metadata
//  card=improvement, approval_id=<row>); the bubble reads the LIVE approval
//  row (ImprovementCards) and shows it:
//    - needs approval → question-gold bubble, Implement (Face ID) and Skip
//    - in progress    → "Applying…"
//    - done           → green "In and running" — the host only records
//                       `applied` once the change runs (lib/self-improve-live.mjs)
//    - failed         → orange "Didn't go in" with the host's reason, and Retry
//                       when the failure was mechanical
//    - skipped        → grey "Skipped", Unskip
//  The summary and rationale come from the row (what is signed), not from the
//  message text, which is the plain copy for the push and older builds.
//  Talking about a card is replying to its message, like answering a question
//  in your own words; the host resolves the card from the reply
//  (chat_message_id, lib/improvement-reply-target.mjs).
//

import SwiftUI

/// What a card's buttons ask for.
enum ImprovementCardAction { case implement, skip, unskip, retry }

/// The approval rows behind the improvement cards on screen, refreshed while
/// the conversation is open so Applying → In and running (or → Didn't go in)
/// shows without leaving it.
@MainActor
final class ImprovementCards: ObservableObject {
    @Published private(set) var byId: [String: SelfImproveApproval.Improvement] = [:]
    @Published private(set) var workingId: String?
    @Published var errorText: String?
    /// Bumped when an approval signs, for the success haptic.
    @Published private(set) var approvedTick = 0

    func refresh(ids: Set<String>) async {
        guard !ids.isEmpty else { return }
        do {
            let rows = try await SelfImproveApproval.fetch(ids: Array(ids))
            // Don't clobber an optimistic local status mid-action.
            for r in rows where r.id != workingId { byId[r.id] = r }
            if !SelfImproveApproval.isRegistered,
               rows.contains(where: { $0.needsApproval }) {
                try? await SelfImproveApproval.registerDeviceKey()
            }
        } catch {
            print("[SelfImprove] card refresh failed: \(error)")
        }
    }

    func perform(_ action: ImprovementCardAction, _ item: SelfImproveApproval.Improvement) async {
        workingId = item.id
        do {
            switch action {
            case .implement:
                try await SelfImproveApproval.approve(item)
                byId[item.id] = item.withStatus("signed")
                approvedTick &+= 1
            case .skip, .unskip:
                let skip = action == .skip
                try await SelfImproveApproval.setSkipped(item, skip)
                byId[item.id] = item.withSkipped(skip)
            case .retry:
                try await SelfImproveApproval.retry(item)
                byId[item.id] = item.withStatus("retry_requested")
            }
        } catch {
            if !Self.isUserCancel(error) { errorText = error.localizedDescription }
        }
        workingId = nil
        if let fresh = try? await SelfImproveApproval.fetchOne(item.id) { byId[item.id] = fresh }
    }

    private static func isUserCancel(_ error: Error) -> Bool {
        // LAError.userCancel == -2; Security userCanceled == errSecUserCanceled.
        (error as NSError).localizedDescription.lowercased().contains("cancel")
    }
}

/// The card's content inside an assistant bubble (the bubble supplies the
/// background: question-gold while it needs approval).
struct ImprovementCardView: View {
    let item: SelfImproveApproval.Improvement
    let working: Bool
    let onAction: (ImprovementCardAction) -> Void

    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 6) {
                Label(item.itemType == "new-capability" ? "New capability" : "Fix",
                      systemImage: item.itemType == "new-capability" ? "sparkles" : "wrench.and.screwdriver")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 0)
                stateBadge
                    .transition(.scale(scale: 0.6).combined(with: .opacity))
                    .id(item.phase)
            }

            Text(item.summary)
                .font(.body.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let rationale = item.rationale, !rationale.isEmpty {
                Text(rationale)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(expanded ? nil : 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if rationale.count > 280 {
                    Button(expanded ? "Less" : "More") {
                        withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(JoriTheme.cobalt)
                    .buttonStyle(.plain)
                }
            }

            if item.phase == .failed, let why = item.result?.error, !why.isEmpty {
                Text(why)
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if item.phase == .done, let notes = item.result?.notes, !notes.isEmpty {
                Text(notes.joined(separator: " "))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            actions
                .padding(.top, 2)
        }
        .animation(.snappy(duration: 0.3), value: "\(item.status)|\(item.skipped)|\(working)")
    }

    @ViewBuilder
    private var stateBadge: some View {
        switch item.phase {
        case .needsApproval:
            pill("Needs your OK", fg: JoriTheme.staffInk, bg: JoriTheme.staff.opacity(0.2))
        case .inProgress:
            HStack(spacing: 4) {
                SpinningGlyph()
                Text("Applying").font(.caption2.weight(.semibold)).foregroundStyle(JoriTheme.cobalt)
            }
        case .done:
            Label("In and running", systemImage: "checkmark.circle.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(JoriTheme.confirmed)
        case .failed:
            Label(item.result?.notLive == true ? "In, not running" : "Didn’t go in",
                  systemImage: "exclamationmark.triangle.fill")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.orange)
        case .skipped:
            pill("Skipped", fg: .secondary, bg: Color.secondary.opacity(0.18))
        }
    }

    private func pill(_ text: String, fg: Color, bg: Color) -> some View {
        Text(text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 8).padding(.vertical, 3)
            .background(bg, in: Capsule())
            .foregroundStyle(fg)
    }

    @ViewBuilder
    private var actions: some View {
        if working {
            HStack(spacing: 6) {
                ProgressView().controlSize(.mini)
                Text("Working…")
            }
            .font(.caption.weight(.semibold))
            .foregroundStyle(.secondary)
        } else if item.isImplementable {
            HStack(spacing: 10) {
                Button { onAction(.implement) } label: {
                    Label("Implement", systemImage: "faceid")
                        .font(.subheadline.weight(.semibold))
                        .frame(maxWidth: .infinity)
                }
                .prominentButtonStyle()
                .buttonBorderShape(.capsule)
                .tint(JoriTheme.staffInk)
                if item.isSkippable {
                    Button { onAction(.skip) } label: {
                        Text("Skip").font(.subheadline).frame(maxWidth: .infinity)
                    }
                    .secondaryButtonStyle()
                    .buttonBorderShape(.capsule)
                }
            }
        } else if item.isRetryable {
            HStack(spacing: 10) {
                Button { onAction(.retry) } label: {
                    Label("Retry", systemImage: "arrow.clockwise").font(.subheadline.weight(.semibold))
                }
                .secondaryButtonStyle()
                .buttonBorderShape(.capsule)
                Button { onAction(.skip) } label: { Text("Skip").font(.subheadline) }
                    .buttonStyle(.plain)
                    .foregroundStyle(.secondary)
            }
        } else if item.skipped {
            Button { onAction(.unskip) } label: {
                Label("Unskip", systemImage: "arrow.uturn.backward").font(.subheadline)
            }
            .buttonStyle(.plain)
            .foregroundStyle(JoriTheme.cobalt)
        }
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

extension SelfImproveApproval.Improvement {
    func withStatus(_ s: String) -> SelfImproveApproval.Improvement {
        SelfImproveApproval.Improvement(
            id: id, itemType: itemType, summary: summary, rationale: rationale,
            itemHash: itemHash, nonce: nonce, status: s, risk: risk,
            skipped: false, chatMessageId: chatMessageId, expiresAtMs: expiresAtMs,
            result: result)
    }

    func withSkipped(_ v: Bool) -> SelfImproveApproval.Improvement {
        SelfImproveApproval.Improvement(
            id: id, itemType: itemType, summary: summary, rationale: rationale,
            itemHash: itemHash, nonce: nonce, status: status, risk: risk,
            skipped: v, chatMessageId: chatMessageId, expiresAtMs: expiresAtMs,
            result: result)
    }
}
