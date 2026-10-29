//
//  ChannelBadges.swift
//  Jori
//
//  Unread/actionable counts for the channel menu badges.
//
//  The problem this solves: the channel list lives behind the hamburger menu, so
//  a pending high-risk improvement — the one thing in the app that actually
//  blocks on the user — was invisible until they happened to open the menu and
//  switch to that channel. Now the count rides on the hamburger button itself,
//  and each channel carries its own count inside the menu.
//
//  "Unread" is not the same thing in every channel, and pretending otherwise
//  would make the badge lie:
//    - chat / questions / system
//                       → assistant messages the app hasn't marked read yet
//                         (ChatViewModel marks them on load, but only for the
//                         channel you are actually looking at, so the others
//                         accumulate exactly as you'd want).
//    - improvements     → cards WAITING ON FACE ID, not unread cards. Reading a
//                         pending approval doesn't discharge it, so this badge
//                         stays lit until the work is actually approved.
//
//  Counts are best-effort: a failed refresh keeps the last known value rather
//  than flashing zero, since a transient network blip should never read as
//  "nothing needs you".
//

import Foundation
import SwiftUI

@MainActor
final class ChannelBadges: ObservableObject {

    /// Per-channel counts. Absent key == zero.
    @Published private(set) var counts: [ChatChannel: Int] = [:]

    /// The channel currently on screen. Message channels zero out while you're
    /// reading them (loadMessages marks them read server-side a beat later —
    /// this just avoids showing a badge for the screen you're looking at).
    /// `improvements` is exempt: being on the channel doesn't approve anything.
    var activeChannel: ChatChannel = .chat

    private var loop: Task<Void, Never>?
    private static let activePollInterval: Duration = .seconds(15)
    /// macOS only: the window is frequently open-but-unfocused (another app has
    /// focus, Mission Control, etc.) rather than actually closed, so a pending
    /// Improvements card would otherwise sit stale for however long the host
    /// goes unfocused. Slower than fully stopping, faster than never.
    private static let backgroundPollInterval: Duration = .seconds(120)
    private var pollInterval: Duration = ChannelBadges.activePollInterval

    func count(for channel: ChatChannel) -> Int { counts[channel] ?? 0 }

    var total: Int {
        ChatChannel.allCases.reduce(0) { $0 + count(for: $1) }
    }

    /// Badge text, capped so a runaway count can't blow out the toolbar.
    static func label(_ n: Int) -> String { n > 99 ? "99+" : "\(n)" }

    // MARK: - Lifecycle

    /// Start polling. Idempotent — calling it twice keeps one loop.
    func start() {
        guard loop == nil else { return }
        loop = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                let interval = self?.pollInterval ?? Self.activePollInterval
                try? await Task.sleep(for: interval)
            }
        }
    }

    func stop() {
        loop?.cancel()
        loop = nil
        pollInterval = Self.activePollInterval
    }

    /// macOS: called on scenePhase focus changes to slow (not stop) polling
    /// while the window is open but unfocused, so a pending Improvements card
    /// doesn't go invisible until the host happens to be refocused. iOS keeps
    /// using stop()/start() around real backgrounding — see ContentView's
    /// scenePhase handler.
    func setBackgroundPolling(_ slow: Bool) {
        pollInterval = slow ? Self.backgroundPollInterval : Self.activePollInterval
    }

    // MARK: - Refresh

    func refresh() async {
        var next: [ChatChannel: Int] = [:]

        for channel in ChatChannel.allCases {
            switch channel {
            case .improvements:
                next[channel] = (try? await SelfImproveApproval.pendingApprovalCount())
                    ?? count(for: channel)
            case .chat, .questions, .system:
                if channel == activeChannel {
                    next[channel] = 0
                } else {
                    next[channel] = await unreadMessages(in: channel)
                }
            }
        }

        // Publishing an unchanged dictionary still redraws every observer —
        // the whole window — once per poll.
        if next != counts { counts = next }
    }

    private func unreadMessages(in channel: ChatChannel) async -> Int {
        do {
            try await SupabaseManager.ensureAuthenticated()
            let response = try await SupabaseManager.shared
                .from(DBTables.messages)
                .select("id", head: true, count: .exact)
                .eq("channel", value: channel.rawValue)
                .eq("role", value: "assistant")
                .eq("read", value: false)
                .execute()
            return response.count ?? 0
        } catch {
            // Keep the last known count — see the note at the top of the file.
            return count(for: channel)
        }
    }
}

/// The red count bubble drawn over the hamburger button.
struct ChannelBadgeBubble: View {
    let count: Int

    var body: some View {
        Text(ChannelBadges.label(count))
            .font(.system(size: 10, weight: .bold))
            .monospacedDigit()
            .contentTransition(.numericText())
            .foregroundStyle(.white)
            .padding(.horizontal, 4)
            .frame(minWidth: 16, minHeight: 16)
            .background(Color.red, in: Capsule())
            .animation(.snappy, value: count)
            // Purely decorative — must never eat the menu button's taps.
            .allowsHitTesting(false)
    }
}

#if os(macOS)
/// Mac only: the conversation channels as tabs in the toolbar, each carrying
/// its own count, so switching is one click and what's waiting is visible
/// without looking at the sidebar. System and Improvements live only in the
/// sidebar (with Memory and the approvals).
///
/// On a destination without a tab no tab is selected; clicking one goes back
/// to that channel.
struct ChannelTabBar: View {
    static let channels: [ChatChannel] = [.chat, .questions]

    let selection: ChatChannel?
    @ObservedObject var badges: ChannelBadges
    let onSelect: (ChatChannel) -> Void

    @Namespace private var pill

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Self.channels) { channel in
                ChannelTab(
                    channel: channel,
                    count: badges.count(for: channel),
                    isSelected: channel == selection,
                    pill: pill,
                    action: { onSelect(channel) }
                )
            }
        }
        .padding(3)
        .background(JoriTheme.slate.opacity(0.8), in: Capsule())
        .overlay(Capsule().strokeBorder(JoriTheme.hairline.opacity(0.6), lineWidth: 0.5))
        .animation(.snappy(duration: 0.28), value: selection)
        .animation(.snappy(duration: 0.25), value: badges.counts)
    }
}

private struct ChannelTab: View {
    let channel: ChatChannel
    let count: Int
    let isSelected: Bool
    let pill: Namespace.ID
    let action: () -> Void

    @State private var isHovered = false

    /// Improvements counts cards waiting on Face ID — the one thing that
    /// blocks on them — so it wears the "waiting on you" gold, like everywhere
    /// else in the app. Unread messages are just cobalt.
    private var badgeColor: Color {
        channel == .improvements ? JoriTheme.staff : JoriTheme.cobalt
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: channel.symbol)
                    .font(.system(size: 11.5, weight: .semibold))
                    .foregroundStyle(isSelected ? JoriTheme.cobalt : .secondary)
                Text(channel.displayName)
                    .font(.system(size: 12.5, weight: isSelected ? .semibold : .medium))
                    .foregroundStyle(isSelected ? .primary : .secondary)
                if count > 0 {
                    Text(ChannelBadges.label(count))
                        .font(.system(size: 10.5, weight: .bold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .foregroundStyle(.white)
                        .padding(.horizontal, 5)
                        .frame(minWidth: 17, minHeight: 17)
                        .background(badgeColor, in: Capsule())
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.horizontal, 12)
            .frame(height: 26)
            .background {
                if isSelected {
                    Capsule()
                        .fill(JoriTheme.card)
                        .shadow(color: .black.opacity(0.12), radius: 1.5, y: 0.5)
                        .matchedGeometryEffect(id: "selected", in: pill)
                } else if isHovered {
                    Capsule().fill(JoriTheme.slateRaised.opacity(0.7))
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .onHover { isHovered = $0 }
        .animation(.easeOut(duration: 0.12), value: isHovered)
        .help(count > 0 ? "\(channel.displayName) — \(count) waiting" : channel.displayName)
        .accessibilityLabel(channel.displayName)
        .accessibilityValue(count > 0 ? "\(count) waiting" : "")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
#endif

#if os(macOS)
/// Drops the window title from the toolbar (macOS 15+) so the channel tabs
/// stand alone and the window can go narrower. On 14 the title stays.
struct HiddenToolbarTitle: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15.0, *) {
            content.toolbar(removing: .title)
        } else {
            content
        }
    }
}
#endif
