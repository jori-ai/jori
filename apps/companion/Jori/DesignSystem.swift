//
//  DesignSystem.swift
//  Jori
//
//  The app's visual vocabulary, taken from the icon rather than from the stock
//  iMessage palette it used to borrow:
//
//    cobalt  — the hat band. The user's own voice: their bubbles, the tint.
//    staff   — the light at the top of the staff. Reserved for one meaning:
//              "Jori is waiting on you" (open questions, decisions, cards
//              that need Face ID, the thinking indicator). Because nothing
//              else is gold, gold always means "look here".
//    slate   — the hat itself. Jori's voice: the assistant bubble.
//    icon*, eye — the Jori icon's blue background and the cyan of its eyes, used
//              only by the opening screens (launch, splash, sign-in, lock)
//              so the app opens on the icon itself.
//
//  Surfaces float on Liquid Glass where the OS has it (iOS 26 / macOS 26) and
//  fall back to system materials on older systems, through `glassSurface`.
//

import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

enum JoriTheme {
    static let cobalt = dynamic(light: 0x2F5BD3, dark: 0x4D7CF2)
    static let staff = dynamic(light: 0xD98E12, dark: 0xF5B63D)
    static let staffWash = dynamic(light: 0xFFF3D9, dark: 0x3A2D11)
    /// Gold dark enough to read as text on `staffWash` and on white.
    static let staffInk = dynamic(light: 0x8F5600, dark: 0xF5B63D)
    static let slate = dynamic(light: 0xEEF0F4, dark: 0x22252B)
    static let slateRaised = dynamic(light: 0xE3E6EC, dark: 0x2E323A)
    static let hairline = dynamic(light: 0xD7DBE3, dark: 0x3A3F49)
    static let confirmed = dynamic(light: 0x1F8F4E, dark: 0x3CCB7A)
    static let confirmedWash = dynamic(light: 0xDDF5E4, dark: 0x163D26)
    static let deny = dynamic(light: 0xD93A33, dark: 0xFF5F57)

    // The Jori icon's own colours, the same in light and dark: the diagonal
    // blue it sits on (cyan top-left, deep blue bottom-right) and the cyan of
    // its eyes. Only the opening screens (splash, sign-in, lock) use them, so
    // they open on the icon itself.
    static let iconCyan = Color(red: 0x00 / 255, green: 0xDE / 255, blue: 0xFE / 255)
    static let iconBlue = Color(red: 0x00 / 255, green: 0x44 / 255, blue: 0xF6 / 255)   // = JoriBlue, the launch screen
    static let iconDeep = Color(red: 0x01 / 255, green: 0x0A / 255, blue: 0x6D / 255)
    static let eye = Color(red: 0x00 / 255, green: 0xD8 / 255, blue: 0xFA / 255)

    static var canvas: Color {
        #if os(macOS)
        Color(nsColor: .textBackgroundColor)
        #else
        Color(UIColor.systemBackground)
        #endif
    }

    static var groupedCanvas: Color {
        #if os(macOS)
        Color(nsColor: .windowBackgroundColor)
        #else
        Color(UIColor.systemGroupedBackground)
        #endif
    }

    static var card: Color {
        #if os(macOS)
        Color(nsColor: .controlBackgroundColor)
        #else
        Color(UIColor.secondarySystemGroupedBackground)
        #endif
    }

    /// The wordmark and the few display moments (sign-in, lock, empty states)
    /// set in New York — the only serif in the app, so it reads as the name. kernel-guard-ok: New York is Apple's system serif typeface
    static func display(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        #if os(macOS)
        Color(nsColor: NSColor(name: nil) { appearance in
            let hex = appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: rgb(hex).0, green: rgb(hex).1, blue: rgb(hex).2, alpha: 1)
        })
        #else
        Color(UIColor { traits in
            let hex = traits.userInterfaceStyle == .dark ? dark : light
            return UIColor(red: rgb(hex).0, green: rgb(hex).1, blue: rgb(hex).2, alpha: 1)
        })
        #endif
    }

    private static func rgb(_ hex: UInt32) -> (CGFloat, CGFloat, CGFloat) {
        (CGFloat((hex >> 16) & 0xFF) / 255, CGFloat((hex >> 8) & 0xFF) / 255, CGFloat(hex & 0xFF) / 255)
    }
}

/// Corner radii, largest for the outermost thing. A bubble holds cards, a card
/// holds rows — each step in is a step smaller, so nesting never looks pinched.
enum Radius {
    static let bubble: CGFloat = 20
    /// The corner where consecutive bubbles from the same sender meet.
    static let joined: CGFloat = 6
    static let card: CGFloat = 16
    static let row: CGFloat = 12
    static let thumb: CGFloat = 8
}

// MARK: - Glass

extension View {
    /// Liquid Glass on iOS 26 / macOS 26, a system material elsewhere.
    @ViewBuilder
    func glassSurface<S: Shape>(in shape: S, tint: Color? = nil, interactive: Bool = false) -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.glassEffect(GlassRecipe.make(tint: tint, interactive: interactive), in: shape)
        } else {
            self
                .background {
                    shape.fill(.regularMaterial)
                    if let tint { shape.fill(tint.opacity(0.18)) }
                }
                .overlay(shape.stroke(Color.primary.opacity(0.08), lineWidth: 0.5))
        }
    }

    /// The prominent action style: glass on new systems, bordered-prominent
    /// before — both pick up `.tint`.
    @ViewBuilder
    func prominentButtonStyle() -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.buttonStyle(.glassProminent)
        } else {
            self.buttonStyle(.borderedProminent)
        }
    }

    @ViewBuilder
    func secondaryButtonStyle() -> some View {
        if #available(iOS 26.0, macOS 26.0, *) {
            self.buttonStyle(.glass)
        } else {
            self.buttonStyle(.bordered)
        }
    }
}

@available(iOS 26.0, macOS 26.0, *)
private enum GlassRecipe {
    static func make(tint: Color?, interactive: Bool) -> Glass {
        var glass = Glass.regular
        if let tint { glass = glass.tint(tint) }
        #if os(iOS)
        if interactive { glass = glass.interactive() }
        #endif
        return glass
    }
}

// MARK: - Pressable

/// Rows and cards you can tap: they give under the finger and lift under the
/// pointer, so every tappable surface answers before the action lands.
struct PressableStyle: ButtonStyle {
    var pressedScale: CGFloat = 0.97

    func makeBody(configuration: Configuration) -> some View {
        PressableBody(configuration: configuration, pressedScale: pressedScale)
    }
}

private struct PressableBody: View {
    let configuration: ButtonStyleConfiguration
    let pressedScale: CGFloat
    @State private var hovering = false
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        configuration.label
            .overlay {
                Color.primary
                    .opacity(configuration.isPressed ? 0.08 : (hovering && isEnabled ? 0.04 : 0))
                    .allowsHitTesting(false)
            }
            .scaleEffect(configuration.isPressed && !reduceMotion ? pressedScale : 1)
            .animation(.spring(response: 0.22, dampingFraction: 0.7), value: configuration.isPressed)
            .animation(.easeOut(duration: 0.12), value: hovering)
            .onHover { hovering = $0 }
    }
}

// MARK: - Staff light (thinking indicator)

/// Three dots that take the staff's gold in turn — Jori is working on it.
/// Static under Reduce Motion.
struct StaffLightDots: View {
    var dotSize: CGFloat = 7
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if reduceMotion {
            dots(at: nil)
        } else {
            TimelineView(.animation(minimumInterval: 1 / 30)) { ctx in
                dots(at: ctx.date.timeIntervalSinceReferenceDate)
            }
        }
    }

    private func dots(at t: TimeInterval?) -> some View {
        HStack(spacing: dotSize * 0.6) {
            ForEach(0..<3, id: \.self) { i in
                let wave = t.map { max(0, sin(($0 * 4.2) - Double(i) * 0.9)) } ?? 0.35
                Circle()
                    .fill(Color.secondary.opacity(0.55))
                    .overlay(Circle().fill(JoriTheme.staff).opacity(wave))
                    .frame(width: dotSize, height: dotSize)
                    .scaleEffect(1 + 0.25 * wave)
                    .offset(y: -2.5 * wave)
            }
        }
        .accessibilityElement()
        .accessibilityLabel("Jori is thinking")
    }
}

// MARK: - Keyboard commands

/// Where the main window can point. Memory is the wiki, not a channel, but it
/// lives in the same switcher.
enum Destination: Hashable {
    case channel(ChatChannel)
    case memory

    var title: String {
        switch self {
        case .channel(let c): return c.displayName
        case .memory: return "Memory"
        }
    }

    var symbol: String {
        switch self {
        case .channel(let c): return c.symbol
        case .memory: return "book.closed"
        }
    }

    static let all: [Destination] = ChatChannel.allCases.map { .channel($0) } + [.memory]
}

/// What the menu bar (Mac, and iPad with a keyboard) can ask the focused
/// window to do. ContentView publishes it with `focusedSceneValue`.
struct JoriActions {
    var current: Destination
    var go: (Destination) -> Void
    var jumpToLatest: () -> Void
    var replyToLatest: () -> Void
    var loadOlder: () -> Void
    var attachFile: () -> Void
    var focusComposer: () -> Void
    var memoryBack: () -> Void
    var memoryForward: () -> Void
    var memoryReload: () -> Void
}

/// Holds the window's current actions for the menu bar. One object for the
/// window's lifetime, published with `focusedSceneObject`, so the menu bar
/// re-reads it only when `actions` is reassigned (on navigation), not on
/// every redraw of the window.
@MainActor
final class CommandCenter: ObservableObject {
    @Published var actions: JoriActions?
}

struct JoriCommands: Commands {
    @FocusedObject private var commandCenter: CommandCenter?

    private var actions: JoriActions? { commandCenter?.actions }

    var body: some Commands {
        CommandMenu("Go") {
            ForEach(Array(Destination.all.enumerated()), id: \.offset) { index, destination in
                Button(destination.title) { actions?.go(destination) }
                    .keyboardShortcut(KeyEquivalent(Character("\(index + 1)")), modifiers: .command)
                    .disabled(actions == nil)
            }
        }
        CommandMenu("Conversation") {
            let inChat: Bool = {
                if case .channel(let c) = actions?.current { return c != .improvements }
                return false
            }()
            // ⌘L, not ⌘N: ⌘N is File › New Window.
            Button("New Message") { actions?.focusComposer() }
                .keyboardShortcut("l", modifiers: .command)
                .disabled(!inChat)
            Button("Reply to Latest from Jori") { actions?.replyToLatest() }
                .keyboardShortcut("r", modifiers: .command)
                .disabled(!inChat)
            Button("Attach File…") { actions?.attachFile() }
                .keyboardShortcut("o", modifiers: .command)
                .disabled(!inChat)
            Divider()
            Button("Jump to Latest") { actions?.jumpToLatest() }
                .keyboardShortcut("j", modifiers: .command)
                .disabled(!inChat)
            Button("Load Older Messages") { actions?.loadOlder() }
                .keyboardShortcut("j", modifiers: [.command, .shift])
                .disabled(!inChat)
            Divider()
            let inMemory = actions?.current == .memory
            Button("Back") { actions?.memoryBack() }
                .keyboardShortcut("[", modifiers: .command)
                .disabled(!inMemory)
            Button("Forward") { actions?.memoryForward() }
                .keyboardShortcut("]", modifiers: .command)
                .disabled(!inMemory)
            Button("Reload Wiki") { actions?.memoryReload() }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                .disabled(!inMemory)
        }
    }
}

// MARK: - Jori mark and the opening screens

/// The Jori face with the cyan of its eyes glowing behind it — the opening
/// image of the splash, sign-in and lock screens. The glow breathes slowly; it
/// holds still under Reduce Motion.
struct JoriMark: View {
    var size: CGFloat = 132
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var breathe = false

    var body: some View {
        Image("JoriFace")
            .resizable()
            .scaledToFit()
            .frame(width: size, height: size)
            .background {
                // Centred at eye level, a little below the middle of the artwork.
                Circle()
                    .fill(RadialGradient(colors: [JoriTheme.eye.opacity(0.34), JoriTheme.eye.opacity(0.08), JoriTheme.eye.opacity(0)],
                                         center: UnitPoint(x: 0.5, y: 0.52),
                                         startRadius: 0,
                                         endRadius: size * 0.95))
                    .frame(width: size * 2, height: size * 2)
                    .scaleEffect(breathe ? 1.05 : 0.95)
                    .opacity(breathe ? 1 : 0.65)
            }
            .shadow(color: .black.opacity(0.35), radius: size * 0.08, y: size * 0.04)
            .accessibilityHidden(true)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeInOut(duration: 2.8).repeatForever(autoreverses: true)) {
                    breathe = true
                }
            }
    }
}

/// The icon's background under every opening screen: the same diagonal from
/// cyan at the top-left to deep blue at the bottom-right. Its middle is the
/// launch screen's flat JoriBlue, so the system launch image hands over to the
/// splash without a seam behind the mark.
struct JoriBackdrop: View {
    var body: some View {
        LinearGradient(colors: [JoriTheme.iconCyan, JoriTheme.iconBlue, JoriTheme.iconDeep],
                       startPoint: .topLeading,
                       endPoint: .bottomTrailing)
            .ignoresSafeArea()
    }
}

/// The launch splash, while the session is read from the Keychain. The face
/// sits exactly where the launch screen drew it (centred, 160 pt), so launch,
/// splash and sign-in read as one moment; the name rises in underneath.
struct SplashView: View {
    static let markSize: CGFloat = 160
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        ZStack {
            JoriBackdrop()
            JoriMark(size: Self.markSize)
                .overlay(alignment: .bottom) {
                    Text("Jori")
                        .font(JoriTheme.display(44))
                        .foregroundStyle(.white)
                        .fixedSize()
                        .offset(y: 72)
                        .opacity(shown ? 1 : 0)
                        .offset(y: shown || reduceMotion ? 0 : 8)
                }
        }
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Jori")
        .onAppear {
            withAnimation(.easeOut(duration: 0.5).delay(0.12)) { shown = true }
        }
    }
}

// MARK: - Approval chrome

/// Time left on an approval request, as a capsule that turns gold in the last
/// minute and red when it runs out.
struct ExpiryCapsule: View {
    let secondsLeft: Int

    private var tint: Color {
        secondsLeft <= 0 ? JoriTheme.deny : (secondsLeft <= 60 ? JoriTheme.staffInk : .secondary)
    }

    var body: some View {
        Label {
            Text(secondsLeft <= 0
                 ? "Expired"
                 : "\(secondsLeft / 60):\(String(format: "%02d", secondsLeft % 60)) left")
                .monospacedDigit()
                .contentTransition(.numericText(countsDown: true))
        } icon: {
            Image(systemName: secondsLeft <= 0 ? "clock.badge.xmark" : "clock")
        }
        .font(.footnote.weight(.semibold))
        .foregroundStyle(tint)
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .background(Capsule().fill(tint.opacity(0.12)))
        .animation(.snappy, value: secondsLeft)
        .accessibilityLabel(secondsLeft <= 0 ? "Expired" : "\(secondsLeft / 60) minutes \(secondsLeft % 60) seconds left")
    }
}

/// The two ways out of a blocking approval: Deny, and the biometric approve.
struct ApprovalButtons: View {
    let approveTitle: String
    let approveSymbol: String
    let working: Bool
    let expired: Bool
    let onDeny: () -> Void
    let onApprove: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Button(role: .destructive, action: onDeny) {
                Text("Deny")
                    .font(.headline)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 6)
            }
            .controlSize(.large)
            .secondaryButtonStyle()
            .buttonBorderShape(.capsule)
            .tint(JoriTheme.deny)
            .disabled(working)

            Button(action: onApprove) {
                HStack(spacing: 8) {
                    if working {
                        ProgressView().controlSize(.small).tint(.white)
                    } else {
                        Image(systemName: approveSymbol)
                    }
                    Text(working ? "Approving…" : approveTitle)
                        .font(.headline)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .controlSize(.large)
            .prominentButtonStyle()
            .buttonBorderShape(.capsule)
            .tint(expired ? Color.gray : JoriTheme.confirmed)
            .disabled(working || expired)
            .keyboardShortcut(.defaultAction)
        }
        .animation(.snappy, value: working)
    }
}
