import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Copy a string to the system pasteboard (UIKit/AppKit bridge).
private func copyToPasteboard(_ string: String) {
    #if os(macOS)
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(string, forType: .string)
    #else
    UIPasteboard.general.string = string
    #endif
}

/// A Jori attachment URL that is a picture (sent photos come back as one).
private func isAttachmentImage(_ content: String) -> Bool {
    content.contains(Install.attachmentsBucket) &&
        (content.hasSuffix(".jpg") || content.hasSuffix(".jpeg") || content.hasSuffix(".png") || content.hasSuffix(".gif"))
}

/// MIME type for an outgoing attachment, by file extension.
private func attachmentContentType(forExtension ext: String) -> String {
    switch ext.lowercased() {
    case "jpg", "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "gif": return "image/gif"
    case "heic": return "image/heic"
    case "pdf": return "application/pdf"
    case "mp4", "mov": return "video/mp4"
    default: return "application/octet-stream"
    }
}

struct ContentView: View {
    var onSignOut: () -> Void = {}

    @StateObject private var viewModel = ChatViewModel()
    /// The team and its conversations (ChannelBadges.swift).
    @StateObject private var team = TeamStore()
    @Environment(\.scenePhase) private var scenePhase
    #if os(iOS)
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    #endif
    @State private var selectedPhoto: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var showFilePicker = false
    @FocusState private var isInputFocused: Bool
    @State private var inputActive = false
    @State private var pendingScrollId: UUID?
    @State private var activeReactionMessageId: UUID?
    /// Non-nil while the iMessage-style reply composer is open — the message
    /// the next send will be threaded to.
    @State private var replyTarget: Message?
    /// Set when a quote bubble is tapped; scrolls the list to the quoted parent.
    @State private var quoteJumpTarget: UUID?
    /// How many of the newest messages are drawn. Up to 500 are loaded; drawing
    /// them all (Markdown, menus, selectable text each) made every layout pass —
    /// a channel switch, the composer growing while typing — measure 500
    /// bubbles. "Load earlier" widens this before it goes to the server.
    @State private var renderLimit = ContentView.renderPage
    private static let renderPage = 60
    @State private var scrollToBottomTick: Int = 0
    @State private var confirmSignOut = false
    /// Memory on screen instead of a conversation. Kept, with the
    /// conversation (ChatViewModel) and the improvement cards, so the app
    /// reopens on the screen it was left on.
    @AppStorage(ContentView.memoryOpenKey) private var memoryMode = false
    private static let memoryOpenKey = Install.key("memoryOpen")
    @StateObject private var memoryState = WebViewState()
    @StateObject private var commandCenter = CommandCenter()
    @State private var columnVisibility: NavigationSplitViewVisibility
    #if os(macOS)
    /// The user folded the sidebar to the rail themselves (not by narrowing
    /// the window), so it reopens folded.
    @AppStorage(ContentView.sidebarFoldedKey) private var sidebarFolded = false
    private static let sidebarFoldedKey = Install.key("sidebarFolded")
    /// How much the window shrank when the user hid the sidebar themselves, so opening
    /// it again gives that width back — also after a relaunch. 0 when nothing was taken.
    @AppStorage(Install.key("windowShrunkForSidebar")) private var windowShrunkForSidebar: Double = 0
    #endif
    #if os(iOS)
    /// iPhone: the app was left inside a conversation (or Memory), not on the list.
    @AppStorage(ContentView.phoneInDetailKey) private var phoneInDetail = false
    private static let phoneInDetailKey = Install.key("phoneInDetail")
    #endif
    /// True when the sidebar was hidden by narrowing the window, so widening
    /// it again brings the sidebar back. A sidebar the user hid themselves stays hidden.
    @State private var sidebarAutoHidden = false
    /// The conversation column's width, measured while it is free, and the
    /// width it is held at while the sidebar opens or closes. Without the
    /// hold, the column's width changed on every frame of the sidebar's
    /// animation (and, on the Mac, of the window's resize running alongside
    /// it), so the text re-wrapped on every frame and the conversation
    /// jittered. Held, it re-wraps once at the end — or not at all when the
    /// window grows or shrinks by exactly the sidebar.
    @State private var detailWidth: CGFloat = 0
    @State private var detailHeldWidth: CGFloat?
    @State private var lastMeasuredWidth: CGFloat?
    #if os(macOS)
    @State private var hostWindow = WindowBox()
    /// The sidebar column's width while open — the user can drag it — so hiding it
    /// takes exactly that much off the window.
    @State private var sidebarColumnWidth: CGFloat = 230
    #endif
    /// True while the conversation is scrolled away from the latest message
    /// (iOS 18 / macOS 15 and later — older systems never report it, and keep
    /// the old always-follow behaviour). New Jori messages then wait behind
    /// the jump button instead of yanking the scroll position.
    @State private var isScrolledUp = false
    @State private var unseenCount = 0
    /// Open questions whose bubble is on screen right now. The tray leaves
    /// those out — it exists for questions the stream has scrolled away —
    /// and disappears when every open question is already in view.
    @State private var onScreenQuestionIds: Set<UUID> = []
    @State private var isDropTargeted = false
    /// iPhone: the conversation list is the home screen; a conversation (or
    /// Memory) is pushed on top of it.
    @State private var phonePath: [Destination]
    @State private var showNewConversation = false
    @State private var showConversationInfo = false
    /// In the software engineer's conversation: the improvement cards instead
    /// of the messages (the old Improvements channel lives there now).
    @AppStorage(Install.key("improvementCardsOpen")) private var showImprovementCards = false

    init(onSignOut: @escaping () -> Void = {}) {
        self.onSignOut = onSignOut
        let defaults = UserDefaults.standard
        // Reopen where the app was left, set before the first frame so
        // nothing visibly pushes or folds on launch.
        #if os(macOS)
        _columnVisibility = State(initialValue: defaults.bool(forKey: Self.sidebarFoldedKey) ? .detailOnly : .automatic)
        #else
        _columnVisibility = State(initialValue: .automatic)
        #endif
        #if os(iOS)
        if defaults.bool(forKey: Self.phoneInDetailKey) {
            let conversation = defaults.string(forKey: ChatViewModel.conversationKey) ?? ConversationID.coordinator
            let screen: Destination = defaults.bool(forKey: Self.memoryOpenKey) ? .memory : .conversation(conversation)
            _phonePath = State(initialValue: [screen])
        } else {
            _phonePath = State(initialValue: [])
        }
        #else
        _phonePath = State(initialValue: [])
        #endif
    }

    // Trade-approval second factor (only when the build sets a trading app)
    @State private var showApprovalPairing = false
    /// Approvals › Pending approvals (PendingApprovalsView): trades + purchases.
    @State private var showPendingApprovals = false
    /// Badge on Pending approvals: how many are waiting.
    @State private var pendingApprovalCount = 0
    private var hasApprovals: Bool { TradeApproval.isRegistered || PurchaseApproval.isRegistered }
    @State private var showUsageSetup = false
    @State private var pendingApproval: TradeApproval.Request?
    // Face-ID purchase approval (PurchaseApproval.swift)
    @State private var showPurchasePairing = false
    @State private var pendingPurchase: PurchaseApproval.Ref?
    // Face-ID approval for plugin actions (ActionApproval.swift)
    @State private var pendingAction: ActionApproval.Ref?

    /// Wiki HTTP browser served from the host (Tailscale / home LAN), from
    /// the build's JORI_WIKI_URL. Nil: the Memory tab explains it is not set up.
    private static let memoryWikiURL = Install.wikiURL

    // MARK: - Destination

    private var destination: Destination {
        memoryMode ? .memory : .conversation(viewModel.currentConversation)
    }

    /// The software engineer's conversation, where the improvement cards live.
    private var isImprovementsConversation: Bool {
        ConversationID.roleId(viewModel.currentConversation) == TeamStore.improvementsRole
    }

    /// Open a conversation (a notification, a new group, an @mention).
    fileprivate func openConversation(_ id: String) {
        go(.conversation(id))
    }

    private var destinationBinding: Binding<Destination> {
        Binding(get: { destination }, set: { go($0) })
    }

    private func go(_ target: Destination) {
        #if os(iOS)
        // iPhone: the list is the root, the destination is pushed on it.
        if horizontalSizeClass != .regular, phonePath != [target] {
            phonePath = [target]
        }
        #endif
        guard target != destination else { return }
        switch target {
        case .memory:
            memoryMode = true
        case .conversation(let id):
            memoryMode = false
            showImprovementCards = false
            if id != viewModel.currentConversation {
                viewModel.switchConversation(to: id)
            }
        }
        replyTarget = nil
        activeReactionMessageId = nil
        isScrolledUp = false
        unseenCount = 0
        onScreenQuestionIds = []
    }

    private var commandActions: JoriActions {
        JoriActions(
            current: destination,
            go: { go($0) },
            jumpToLatest: { scrollToBottomTick &+= 1 },
            replyToLatest: {
                if let last = viewModel.messages.last(where: { $0.isAssistant }) { beginReply(to: last) }
            },
            loadOlder: {
                let drawnAll = viewModel.messages.count <= renderLimit
                renderLimit += Self.renderPage
                if drawnAll { Task { await viewModel.loadOlderMessages() } }
            },
            attachFile: { showFilePicker = true },
            focusComposer: { focusComposer() },
            memoryBack: { memoryState.goBack() },
            memoryForward: { memoryState.goForward() },
            memoryReload: { memoryState.reload() }
        )
    }

    // MARK: - Body

    var body: some View {
        navigation
            .tint(JoriTheme.cobalt)
            // A stable object, not a fresh value per render: a new focused
            // value on every redraw rebuilt the menu bar on every keystroke.
            .focusedSceneObject(commandCenter)
            .onAppear {
                commandCenter.actions = commandActions
                Responsiveness.setContext(destination.title.lowercased())
            }
            .onChange(of: destination) { _, new in
                commandCenter.actions = commandActions
                // Hangs are filed under the screen they happened on.
                Responsiveness.setContext(new.title.lowercased())
            }
            .confirmationDialog("Sign out of \(Install.displayName)?",
                                isPresented: $confirmSignOut,
                                titleVisibility: .visible) {
                Button("Sign Out", role: .destructive) { onSignOut() }
                Button("Cancel", role: .cancel) { }
            }
            .modifier(lifecycle)
            .modifier(approvals)
    }

    @ViewBuilder
    private var navigation: some View {
        #if os(macOS)
        splitNavigation
        #else
        // iPad (and big iPhones in landscape) get the sidebar; an iPhone in
        // portrait keeps the whole screen for the conversation and switches
        // channel from the title.
        if horizontalSizeClass == .regular {
            splitNavigation
        } else {
            NavigationStack(path: $phonePath) {
                phoneConversationList
                    .navigationDestination(for: Destination.self) { _ in detail }
            }
        }
        #endif
    }

    #if os(macOS)
    /// The Mac: the sidebar and the conversation side by side in our own
    /// layout, not a NavigationSplitView. Hiding the sidebar folds it to the
    /// avatar rail (ConversationRail) and takes the difference off the window
    /// in the same instant, so the conversation keeps its width and nothing
    /// slides, re-wraps or blinks. The split view's own collapse animated the
    /// column away while the rail appeared beside it and the window resized
    /// on its own clock: a gap, then a jump, then a redraw.
    private var splitNavigation: some View {
        HStack(spacing: 0) {
            if isSidebarHidden {
                ConversationRail(team: team, chat: viewModel, inMemory: memoryMode,
                                 open: { go(.conversation($0)) },
                                 onDeleted: { gone in
                                     if viewModel.currentConversation == gone { go(.conversation(team.coordinatorConversation)) }
                                 })
            } else {
                sidebar
                    .scrollContentBackground(.hidden)
                    .background(.bar)
                    .frame(width: Self.sidebarWidth)
            }
            Divider()
            detail
                .frame(minWidth: 0, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
        .toolbar {
            ToolbarItem(placement: .navigation) {
                Button { columnVisibility = isSidebarHidden ? .all : .detailOnly } label: {
                    Label(isSidebarHidden ? "Show Sidebar" : "Hide Sidebar", systemImage: "sidebar.left")
                }
                .help(isSidebarHidden ? "Show the sidebar (⌃⌘S)" : "Fold the sidebar to avatars (⌃⌘S)")
                .keyboardShortcut("s", modifiers: [.control, .command])
            }
        }
        // The Mac reads the WINDOW's width from its resize notifications.
        .background(WindowReader(box: hostWindow) { window in windowResized(to: window.frame.width) })
        .onReceive(NotificationCenter.default.publisher(for: NSWindow.didResizeNotification)) { note in
            guard let window = note.object as? NSWindow, window === hostWindow.window else { return }
            windowResized(to: window.frame.width)
        }
        .onChange(of: columnVisibility) { old, new in
            // Only a fold the user made reopens folded; narrowing the window
            // folds it again by itself on the next launch.
            sidebarFolded = new == .detailOnly && !sidebarAutoHidden
            if new == .detailOnly {
                // The user folded the sidebar: the window gives up the
                // sidebar's width minus the rail's, so the conversation keeps
                // its width. Not when narrowing the window folded it — the
                // user is already sizing the window themselves.
                if old != .detailOnly, !sidebarAutoHidden { shrinkWindowForHiddenSidebar() }
                return
            }
            // Open again, by whatever route: a later fold is their own.
            sidebarAutoHidden = false
            guard old == .detailOnly, let now = currentWindow?.frame else { return }
            // Give back what folding took; a narrow window gets the
            // sidebar's room regardless, so the conversation isn't squeezed.
            let given = CGFloat(windowShrunkForSidebar)
            windowShrunkForSidebar = 0
            let needed = now.width < Self.sidebarRestoreWidth ? Self.sidebarWidth - Self.railWidth : 0
            let grow = max(given, needed)
            if grow > 0 { growWindowForSidebar(from: now, by: grow) }
        }
    }
    #else
    private var splitNavigation: some View {
        NavigationSplitView(columnVisibility: $columnVisibility) {
            sidebar
                .navigationSplitViewColumnWidth(min: 200, ideal: Self.sidebarWidth, max: 320)
        } detail: {
            detail
                .frame(width: detailHeldWidth, alignment: .leading)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .clipped()
                .background {
                    GeometryReader { geo in
                        Color.clear
                            .onAppear { if detailHeldWidth == nil { detailWidth = geo.size.width } }
                            .onChange(of: geo.size.width) { _, w in if detailHeldWidth == nil { detailWidth = w } }
                    }
                }
        }
        .onChange(of: columnVisibility) { _, _ in holdDetailWidthDuringSidebarAnimation() }
        .background {
            GeometryReader { geo in
                Color.clear
                    .onAppear { fitSidebar(to: geo.size.width) }
                    .onChange(of: geo.size.width) { _, width in fitSidebar(to: width) }
            }
        }
    }
    #endif

    /// Hold the conversation at its current width until the sidebar (and, on
    /// the Mac, the window: its resize is re-applied at 0.4 s) has settled.
    private func holdDetailWidthDuringSidebarAnimation() {
        guard detailWidth > 0 else { return }
        detailHeldWidth = detailWidth
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.55) {
            var t = Transaction(); t.disablesAnimations = true
            withTransaction(t) { detailHeldWidth = nil }
        }
    }

    #if os(macOS)
    private func windowResized(to width: CGFloat) {
        fitSidebar(to: width)
    }
    #endif

    #if os(macOS)
    /// This view's own window — not the key window, which is some other app's
    /// (or nil) whenever Jori isn't frontmost.
    private var currentWindow: NSWindow? { hostWindow.window }

    /// Widen the window to the RIGHT by the sidebar's width from `hidden`, its
    /// frame with the sidebar still folded: the window's left edge stays where
    /// it is (the left edge stays anchored), and the
    /// conversation keeps its width. Clamped at the screen's right edge
    /// rather than moved. Applied again once the sidebar's own animation has
    /// settled, in case AppKit resized it meanwhile.
    private func growWindowForSidebar(from hidden: CGRect, by width: CGFloat) {
        guard let window = currentWindow, let visible = window.screen?.visibleFrame else { return }
        var frame = hidden
        frame.size.width += width
        if frame.maxX > visible.maxX { frame.size.width = max(hidden.width, visible.maxX - frame.minX) }
        // Instant and in the same pass as the sidebar's swap, so the
        // conversation never changes width on screen.
        window.setFrame(frame, display: true, animate: false)
    }

    /// The reverse of `growWindowForSidebar`: take the sidebar's width off the
    /// window, left edge anchored, so the conversation keeps its width.
    /// Never below the window's minimum; what was actually taken is
    /// remembered so reopening the sidebar restores the same window.
    private func shrinkWindowForHiddenSidebar() {
        guard let window = currentWindow else { return }
        var frame = window.frame
        let minWidth = max(window.minSize.width, 480)
        // The rail stays, so only the rest of the sidebar's width comes off.
        let target = max(minWidth, frame.width - (Self.sidebarWidth - Self.railWidth))
        let taken = frame.width - target
        guard taken > 0 else { return }
        frame.size.width = target
        windowShrunkForSidebar = Double(taken)
        // Instant, in the same pass as the swap (see growWindowForSidebar).
        window.setFrame(frame, display: true, animate: false)
    }

    /// Only while the sidebar is open: during the hide animation the column
    /// shrinks towards zero, and that isn't the width the user chose.
    private func noteSidebarWidth(_ width: CGFloat) {
        guard !isSidebarHidden, width >= 200 else { return }
        sidebarColumnWidth = min(width, 320)
    }
    #endif

    /// Below this window width the sidebar would squeeze the conversation, so
    /// it folds away; it returns a little above it (the gap keeps a resize
    /// hovering at the edge from flickering it in and out).
    private static let sidebarWidth: CGFloat = 230
    /// The folded sidebar (ConversationRail) that stays when it is hidden.
    private static let railWidth: CGFloat = ConversationRail.width + 1
    private static let sidebarCollapseWidth: CGFloat = 720
    private static let sidebarRestoreWidth: CGFloat = 760

    private var isSidebarHidden: Bool { columnVisibility == .detailOnly }

    /// Acts only when the window CROSSES a threshold. Within the narrow range
    /// nothing happens, so a sidebar the user opens in a narrow window stays open.
    private func fitSidebar(to width: CGFloat) {
        guard width > 0 else { return }   // first layout pass, before the window has a size
        let previous = lastMeasuredWidth
        lastMeasuredWidth = width
        let wasNarrow = previous.map { $0 < Self.sidebarCollapseWidth } ?? false
        #if os(macOS)
        let fold: Animation? = nil   // the Mac swaps sidebar and rail in place
        #else
        let fold: Animation? = .snappy(duration: 0.3)
        #endif
        if width < Self.sidebarCollapseWidth, !wasNarrow {
            guard !isSidebarHidden else { return }
            // Set before the change, so the window isn't shrunk for it.
            sidebarAutoHidden = true
            withAnimation(fold) { columnVisibility = .detailOnly }
        } else if width >= Self.sidebarRestoreWidth, sidebarAutoHidden {
            withAnimation(fold) { columnVisibility = .all }
            sidebarAutoHidden = false
        }
    }

    private var lifecycle: LifecycleModifier {
        LifecycleModifier(view: self)
    }

    private var approvals: ApprovalsModifier {
        ApprovalsModifier(view: self)
    }

    // MARK: - Sidebar (Mac, iPad)

    private var sidebar: some View {
        List(selection: Binding<Destination?>(get: { destination }, set: { if let d = $0 { go(d) } })) {
            if !team.pinnedConversations.isEmpty {
                PinnedConversationsGrid(team: team,
                                        selected: memoryMode ? nil : viewModel.currentConversation,
                                        open: { go(.conversation($0)) },
                                        onDeleted: { gone in
                                            if viewModel.currentConversation == gone { go(.conversation(team.coordinatorConversation)) }
                                        })
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    .selectionDisabled()
            }
            Section {
                ForEach(team.unpinnedConversations) { conversation in
                    ConversationRowView(conversation: conversation, team: team)
                        .tag(Destination.conversation(conversation.id))
                        .modifier(ConversationDeleteActions(conversation: conversation, team: team) { gone in
                            if viewModel.currentConversation == gone { go(.conversation(team.coordinatorConversation)) }
                        })
                }
            } header: {
                HStack {
                    Text("Conversations")
                    Spacer()
                    Button { showNewConversation = true } label: {
                        Image(systemName: "square.and.pencil")
                    }
                    .buttonStyle(.borderless)
                    .help("New conversation or group")
                    .accessibilityLabel("New conversation")
                }
            }
            #if os(iOS)
            // On the Mac, Memory is in the Go menu (⌘2), not the sidebar.
            Section("Library") {
                Label("Memory", systemImage: "book.closed")
                    .tag(Destination.memory)
            }
            #endif
            Section("Approvals") {
                if TradeApproval.isEnabled {
                    Button { showApprovalPairing = true } label: {
                        Label("Trades", systemImage: "checkmark.shield")
                    }
                    .badge(TradeApproval.isRegistered ? Text("Paired") : Text("Set up"))
                }
                Button { showPurchasePairing = true } label: {
                    Label("Purchases", systemImage: "cart.badge.questionmark")
                }
                .badge(PurchaseApproval.isRegistered ? Text("Paired") : Text("Set up"))
                if hasApprovals {
                    Button { showPendingApprovals = true } label: {
                        Label("Pending approvals", systemImage: "clock.badge.checkmark")
                    }
                    .badge(pendingApprovalCount)
                }
                #if os(iOS)
                if Install.has(.screenTime) {
                    Button { showUsageSetup = true } label: {
                        Label("Sleep & wake", systemImage: "bed.double")
                    }
                }
                #endif
            }
            Section {
                Button(role: .destructive) { confirmSignOut = true } label: {
                    Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
                }
            }
        }
        .listStyle(.sidebar)
        #if os(iOS)
        .navigationTitle(Install.displayName)
        #endif
        .sensoryFeedback(.selection, trigger: destination)
    }

    // MARK: - Conversation list (iPhone home screen)

    #if os(iOS)
    private var phoneConversationList: some View {
        List {
            if !team.pinnedConversations.isEmpty {
                PinnedConversationsGrid(team: team, open: { go(.conversation($0)) })
                    .listRowSeparator(.hidden)
            }
            ForEach(team.unpinnedConversations) { conversation in
                Button { go(.conversation(conversation.id)) } label: {
                    ConversationRowView(conversation: conversation, team: team)
                }
                .buttonStyle(.plain)
                .modifier(ConversationDeleteActions(conversation: conversation, team: team))
            }
        }
        .listStyle(.plain)
        .refreshable { await team.refresh() }
        // Back on the list, the conversation just left counts its unread again.
        .onChange(of: phonePath) { _, path in
            phoneInDetail = !path.isEmpty
            let left = team.activeConversation
            team.activeConversation = path.isEmpty ? "" : viewModel.currentConversation
            // Mark the conversation just left read BEFORE recounting, so its
            // badge does not come back.
            if path.isEmpty { Task { await team.markRead(left); await team.loadSummaries() } }
        }
        .navigationTitle(Install.displayName)
        .toolbar {
            ToolbarItem(placement: .topBarLeading) { settingsMenu }
            ToolbarItem(placement: .topBarTrailing) {
                Button { showNewConversation = true } label: {
                    Label("New conversation", systemImage: "square.and.pencil")
                }
            }
        }
    }
    #endif

    /// The conversation's name with its people's roles under it; tapping it
    /// shows who is in it, where anyone can be renamed or added.
    private var conversationHeader: some View {
        let id = viewModel.currentConversation
        return Button { showConversationInfo = true } label: {
            HStack(spacing: 8) {
                TeamAvatar(members: team.members(of: id), size: 26)
                VStack(alignment: .leading, spacing: 0) {
                    Text(team.title(of: id))
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                    let sub = team.subtitle(of: id)
                    if !sub.isEmpty {
                        Text(sub)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
            }
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(team.title(of: id)), \(team.subtitle(of: id)). Show people")
    }

    /// Send into the conversation on screen. An @-handle to someone not in it
    /// brings them into THIS conversation (no new group); the message carries
    /// `mentions`, and the mentioned roles answer here with its recent
    /// messages as context (bin/role-session prepare).
    private func sendWithMentions(_ text: String, replyTo threadParent: UUID?) {
        let current = viewModel.currentConversation
        let mentioned = team.mentioned(in: text)
        Task {
            var target = current
            var extra: [String: String] = [:]
            if !mentioned.isEmpty {
                extra["mentions"] = mentioned.map(\.id).joined(separator: ",")
                let next = await team.add(mentioned.map(\.id), to: current)
                if next != current {
                    target = next
                    go(.conversation(next))
                }
            }
            await viewModel.sendMessage(text, replyTo: target == current ? threadParent : nil,
                                        extraMetadata: extra, conversation: target)
            await team.loadSummaries()
        }
    }

    /// Start the conversation the new-conversation sheet picked: a role's own
    /// for one person, a group for several.
    private func startConversation(with roleIds: [String]) {
        Task {
            if let id = await team.conversation(with: roleIds) { go(.conversation(id)) }
        }
    }

    // MARK: - Detail

    private var detail: some View {
        detailContent
            #if os(macOS)
            // Fixed minimums: without them the column's min size is the
            // content's, and a vertical ScrollView's min width tracks its
            // rows. Ticking a checklist item changed that mid-layout, the
            // split view re-posted a constraint update inside the constraint
            // pass, and AppKit aborted (2026-10-28).
            .frame(minWidth: 0, maxWidth: .infinity, minHeight: 0, maxHeight: .infinity)
            #else
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            #endif
            .background(showImprovementCards && isImprovementsConversation && !memoryMode ? JoriTheme.groupedCanvas : JoriTheme.canvas)
            .overlay(alignment: .top) { offlineBanner }
            .animation(.snappy(duration: 0.3), value: viewModel.isOffline)
            .navigationTitle(memoryMode ? "Memory" : team.title(of: viewModel.currentConversation))
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #else
            // The conversation header is the title. The title stays set for
            // the Window menu and Mission Control, just not drawn in the toolbar.
            .modifier(HiddenToolbarTitle())
            #endif
            .toolbar { detailToolbar }
            .sheet(isPresented: $showConversationInfo) {
                ConversationInfoSheet(team: team, conversationId: viewModel.currentConversation) { ids in
                    Task {
                        let next = await team.add(ids, to: viewModel.currentConversation)
                        go(.conversation(next))
                    }
                }
                #if os(macOS)
                .frame(minWidth: 420, idealWidth: 460, minHeight: 420, idealHeight: 520)
                #endif
            }
    }

    @ViewBuilder
    private var detailContent: some View {
        if memoryMode {
            MemoryView(url: Self.memoryWikiURL, state: memoryState)
        } else if isImprovementsConversation {
            // The software engineer's conversation holds the improvement cards
            // (the old Improvements channel) beside the messages.
            VStack(spacing: 0) {
                Picker("Show", selection: $showImprovementCards) {
                    Text("Messages").tag(false)
                    Text(team.pendingImprovements > 0 ? "Improvements (\(team.pendingImprovements))" : "Improvements").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 14)
                .padding(.vertical, 8)
                if showImprovementCards {
                    // A card feed, not a chat log — every action lives in the
                    // card's menu; no input bar, no reactions. "Chat" hands the
                    // card back to a conversation, where there is a keyboard.
                    SelfImproveFeedView(onChat: { improvement in
                        Task { await openImprovementThread(improvement) }
                    })
                } else {
                    chatPane
                }
            }
        } else {
            chatPane
        }
    }


    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        #if os(iOS)
        if memoryMode {
            ToolbarItemGroup(placement: .topBarLeading) { memoryNavButtons }
        }
        if !memoryMode {
            ToolbarItem(placement: .principal) { conversationHeader }
        }
        if memoryMode {
            ToolbarItem(placement: .topBarTrailing) { memoryReloadButton }
        }
        #else
        if !memoryMode {
            ToolbarItem(placement: .principal) { conversationHeader }
        }
        if memoryMode {
            ToolbarItemGroup(placement: .navigation) { memoryNavButtons }
            ToolbarItem(placement: .primaryAction) { memoryReloadButton }
        }
        #endif
    }

    @ViewBuilder
    private var memoryNavButtons: some View {
        Button { memoryState.goBack() } label: {
            Label("Back", systemImage: "chevron.backward")
        }
        .disabled(!memoryState.canGoBack)
        .help("Back (⌘[)")
        Button { memoryState.goForward() } label: {
            Label("Forward", systemImage: "chevron.forward")
        }
        .disabled(!memoryState.canGoForward)
        .help("Forward (⌘])")
    }

    private var memoryReloadButton: some View {
        Button { memoryState.reload() } label: {
            Label("Reload", systemImage: "arrow.clockwise")
        }
        .help("Reload (⇧⌘R)")
    }

    private var settingsMenu: some View {
        Menu {
            // Memory lives here on the iPhone (the Go menu, ⌘2, elsewhere).
            Button { go(.memory) } label: { Label("Memory", systemImage: "book.closed") }
            Section("Approvals") {
                if TradeApproval.isEnabled {
                    Button { showApprovalPairing = true } label: {
                        Label {
                            Text("Trade Approval")
                            Text(TradeApproval.isRegistered ? "Paired" : "Not set up")
                        } icon: {
                            Image(systemName: "checkmark.shield")
                        }
                    }
                }
                Button { showPurchasePairing = true } label: {
                    Label {
                        Text("Purchase Approval")
                        Text(PurchaseApproval.isRegistered ? "Paired" : "Not set up")
                    } icon: {
                        Image(systemName: "cart.badge.questionmark")
                    }
                }
                if hasApprovals {
                    Button { showPendingApprovals = true } label: {
                        Label {
                            Text("Pending approvals")
                            Text(pendingApprovalCount == 0 ? "None waiting" : "\(pendingApprovalCount) waiting")
                        } icon: {
                            Image(systemName: "clock.badge.checkmark")
                        }
                    }
                }
            }
            #if os(iOS)
            if Install.has(.screenTime) {
                Button { showUsageSetup = true } label: {
                    Label("Sleep & Wake", systemImage: "bed.double")
                }
            }
            #endif
            Divider()
            Button(role: .destructive) { confirmSignOut = true } label: {
                Label("Sign Out", systemImage: "rectangle.portrait.and.arrow.right")
            }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
    }

    // MARK: - Offline Banner

    @ViewBuilder
    private var offlineBanner: some View {
        if viewModel.isOffline {
            HStack(spacing: 8) {
                ProgressView()
                    .controlSize(.small)
                Text("Reconnecting…")
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .glassSurface(in: Capsule())
            .padding(.top, 8)
            .transition(.move(edge: .top).combined(with: .opacity))
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Chat

    private var chatPane: some View {
        chatMessages
            .overlay { replyBackdrop }
            .safeAreaInset(edge: .bottom, spacing: 0) { composerStack }
            .overlay { dropOverlay }
            .onDrop(of: [.fileURL, .image], isTargeted: $isDropTargeted, perform: handleDrop)
            .animation(.easeOut(duration: 0.15), value: isDropTargeted)
    }

    @ViewBuilder
    private func loadOlderButton(hidden: Int) -> some View {
        if hidden > 0 || viewModel.hasOlderMessages {
            Button {
                if hidden > 0 {
                    renderLimit += Self.renderPage
                } else {
                    renderLimit += Self.renderPage
                    Task { await viewModel.loadOlderMessages() }
                }
            } label: {
                Group {
                    if viewModel.isLoadingOlder {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Load earlier messages")
                            .font(.footnote.weight(.medium))
                            .foregroundStyle(JoriTheme.cobalt)
                    }
                }
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .background(Capsule().fill(JoriTheme.slate))
            }
            .buttonStyle(PressableStyle())
            .padding(.vertical, 8)
        }
    }

    /// Scroll to a message, first widening the drawn window if it falls
    /// outside it (a quoted parent, a notification's message).
    private func reveal(_ id: UUID, proxy: ScrollViewProxy) {
        if let index = viewModel.messages.lastIndex(where: { $0.id == id }) {
            let fromEnd = viewModel.messages.count - index
            if fromEnd > renderLimit {
                renderLimit = fromEnd + 10
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(id, anchor: .center) }
                }
                return
            }
        }
        withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(id, anchor: .center) }
    }

    @ViewBuilder
    private var messagesList: some View {
        // LazyVStack on iOS avoids a scene-update watchdog kill on fast scroll
        // (Markdown rendering hundreds of bubbles eagerly pegs the main thread).
        // But LazyVStack breaks `defaultScrollAnchor(.bottom)` and `scrollTo` on
        // macOS — off-screen items aren't realized, so the view lands at the
        // top and the latest messages appear to be missing. macOS doesn't have
        // the same watchdog, so a plain VStack is safe there.
        #if os(macOS)
        VStack(spacing: 2) { messagesListContent }
            .padding(.horizontal, 16)
            .padding(.top, 8)
            .padding(.bottom, 12)
        #else
        LazyVStack(spacing: 2) { messagesListContent }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            .padding(.bottom, 12)
        #endif
    }

    @ViewBuilder
    private var messagesListContent: some View {
        let all = viewModel.messages.filter { !viewModel.isChecklistTick($0) && !viewModel.isQuestionDismissal($0) }
        let visible = Array(all.suffix(renderLimit))
        let layout = BubbleLayout.compute(visible)
        let actions = bubbleActions
        // Name the speaker over the first bubble of each run when the
        // conversation has more than one person in it, or the message came
        // from someone other than the conversation's own role.
        let conversationRole = ConversationID.roleId(viewModel.currentConversation)
        let multi = team.memberIds(of: viewModel.currentConversation).count > 1
        let held = heldByAnchor(visible)
        loadOlderButton(hidden: all.count - visible.count)
        ForEach(visible) { message in
            let place = layout[message.id] ?? .solo
            VStack(spacing: 0) {
                if let separator = place.separator {
                    DaySeparator(date: separator)
                }
                MessageBubble(
                    message: message,
                    layout: place,
                    thread: thread(for: message,
                                   senderLabel: place.startsGroup && message.isAssistant
                                       && (multi || (message.sender != nil && message.sender != conversationRole))
                                       ? team.senderLabel(message.sender) : nil),
                    isPaletteOpen: activeReactionMessageId == message.id,
                    actions: actions
                )
                .equatable()
                // What the speak gate held after this message: never
                // delivered, so no bubble, just the folded line to grade.
                ForEach(held[message.id] ?? []) { review in
                    HStack(spacing: 0) {
                        GateReviewLine(review: review) { grade, note in actions.gradeGate(review.id, grade, note) }
                        Spacer(minLength: 56)
                    }
                    .padding(.top, 6)
                }
            }
            .padding(.top, place.startsGroup && place.separator == nil ? 10 : 0)
            .modifier(OnScreenReader(id: message.id, tracked: viewModel.isOpenQuestion(message), onScreen: $onScreenQuestionIds))
            .id(message.id)
            .zIndex(activeReactionMessageId == message.id ? 1 : 0)
        }
    }

    private var bubbleActions: BubbleActions {
        let vm = viewModel
        return BubbleActions(
            reply: { beginReply(to: $0) },
            quoteTap: { quoteJumpTarget = $0 },
            setPalette: { activeReactionMessageId = $0 },
            react: { message, reaction in Task { await vm.setReaction(for: message, to: reaction) } },
            answer: { label, parent in Task { await vm.sendMessage(label, replyTo: parent) } },
            toggleChecklist: { label, on, id in vm.toggleChecklistItem(label, checked: on, on: id) },
            resolveParent: { vm.resolveQuotedParent($0) },
            dismiss: { vm.dismissQuestion($0) },
            gradeGate: { id, grade, note in Task { await team.gradeGate(id, grade: grade, note: note) } }
        )
    }

    /// Messages the speak gate held have no row of their own: each is shown,
    /// folded, under the last message before it was judged (or the last one
    /// on screen). Ones older than the first message on screen wait for
    /// "load older".
    private func heldByAnchor(_ visible: [Message]) -> [UUID: [GateReview]] {
        let list = team.heldReviews[viewModel.currentConversation] ?? []
        guard !list.isEmpty, let first = visible.first else { return [:] }
        var out: [UUID: [GateReview]] = [:]
        for r in list {
            let at = r.judged_at ?? .distantFuture
            if at < first.createdAt { continue }
            let anchor = visible.last(where: { $0.createdAt <= at }) ?? first
            out[anchor.id, default: []].append(r)
        }
        return out
    }

    private func thread(for m: Message, senderLabel: String? = nil) -> BubbleThread {
        var t = BubbleThread()
        t.senderLabel = senderLabel
        if m.isAssistant { t.gate = team.gateReviews[m.id] }
        if let parent = m.replyTo { t.quotedParent = viewModel.quotedParent(parent) }
        if m.isUser {
            t.notPickedUp = viewModel.isNotPickedUp(m.id)
            return t
        }
        guard m.isAssistant, m.metadata != nil else { return t }
        t.isOpenQuestion = viewModel.isOpenQuestion(m)
        if m.metadata?[Checklist.metadataKey] != nil {
            t.checked = viewModel.checkedLabels(for: m.id)
        }
        if m.metadata?[ChoicePrompt.metadataKey] != nil {
            t.answer = viewModel.tappedAnswer(for: m.id)
            t.defaultApplied = viewModel.defaultApplied(for: m.id)
        }
        return t
    }

    private var chatMessages: some View {
        ScrollViewReader { proxy in
            ScrollView { messagesList }
            #if os(iOS)
            .scrollDismissesKeyboard(.interactively)
            .onTapGesture {
                if activeReactionMessageId != nil {
                    withAnimation(.easeOut(duration: 0.15)) {
                        activeReactionMessageId = nil
                    }
                } else {
                    isInputFocused = false
                }
            }
            #endif
            .defaultScrollAnchor(.bottom)
            .modifier(ScrolledUpReader(isScrolledUp: $isScrolledUp))
            .onChange(of: isScrolledUp) { _, up in
                if !up { unseenCount = 0 }
            }
            .onChange(of: activeReactionMessageId) { _, newValue in
                guard let target = newValue else { return }
                withAnimation(.easeOut(duration: 0.2)) {
                    // Anchor slightly below top so the palette (above the bubble) stays visible.
                    proxy.scrollTo(target, anchor: UnitPoint(x: 0.5, y: 0.25))
                }
            }
            .onChange(of: viewModel.messages.count) { oldCount, newCount in
                // If a push notification target is pending and now loaded, jump to it
                if let target = pendingScrollId,
                   viewModel.messages.contains(where: { $0.id == target }) {
                    reveal(target, proxy: proxy)
                    pendingScrollId = nil
                    return
                }
                // First non-empty population (fresh-install network load,
                // post-empty channel switch) — defaultScrollAnchor(.bottom)
                // doesn't re-resolve once the LazyVStack has measured an
                // empty layout, so explicitly jump to the latest message.
                if oldCount == 0, newCount > 0, let last = viewModel.messages.last {
                    proxy.scrollTo(last.id, anchor: .bottom)
                }
            }
            // A new latest message (not a page of older ones prepended above):
            // follow it — unless the user has scrolled up to read, in which case a
            // Jori message waits behind the jump button with a count. Their
            // own sends always follow.
            .onChange(of: viewModel.messages.last?.id) { oldId, newId in
                guard oldId != nil, let newId, pendingScrollId == nil,
                      let last = viewModel.messages.last else { return }
                if isScrolledUp && !last.isUser {
                    unseenCount += 1
                    return
                }
                withAnimation(.smooth(duration: 0.35)) {
                    proxy.scrollTo(newId, anchor: .bottom)
                }
            }
            .onChange(of: viewModel.currentConversation) { _, _ in
                // A conversation switch replaces `messages` from cache — the
                // ScrollView keeps its prior offset, so latest can be
                // off-screen. Force a snap to bottom.
                renderLimit = Self.renderPage
                scrollToBottomTick &+= 1
            }
            .onAppear {
                // A notification opened this conversation and named a message in it.
                if let pending = pendingScrollId, viewModel.messages.contains(where: { $0.id == pending }) {
                    reveal(pending, proxy: proxy)
                    pendingScrollId = nil
                    return
                }
                // Consume any message ID stashed while the app was launching / locked
                if let pending = AppDelegate.pendingMessageId {
                    pendingScrollId = pending
                    AppDelegate.pendingMessageId = nil
                    if viewModel.messages.contains(where: { $0.id == pending }) {
                        reveal(pending, proxy: proxy)
                        pendingScrollId = nil
                    }
                    return
                }
                // LazyVStack + defaultScrollAnchor(.bottom) is unreliable on
                // first appearance — the viewport often lands above the
                // realized cells, leaving the user looking at empty space
                // with the actual messages off-screen below. Snap to bottom
                // once cells have had a tick to realize.
                if let last = viewModel.messages.last {
                    DispatchQueue.main.async {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .openJoriMessage)) { note in
                guard let uuid = note.object as? UUID else { return }
                if viewModel.messages.contains(where: { $0.id == uuid }) {
                    reveal(uuid, proxy: proxy)
                } else {
                    pendingScrollId = uuid
                }
            }
            // Tapping a quote bubble jumps to the message it quotes.
            .onChange(of: quoteJumpTarget) { _, target in
                guard let target else { return }
                quoteJumpTarget = nil
                guard viewModel.messages.contains(where: { $0.id == target }) else { return }
                reveal(target, proxy: proxy)
            }
            .onChange(of: scrollToBottomTick) { _, _ in
                guard let last = viewModel.messages.last else { return }
                // Defer past the current layout pass. On a size-class
                // change (which is what `scrollToBottomTick` mainly tracks),
                // the LazyVStack hasn't re-realized cells yet, so a
                // synchronous scrollTo(last.id) silently no-ops and the
                // viewport stays blank. Two staggered retries: a fast
                // unanimated pin (so the user doesn't watch a blank
                // viewport while waiting for the animated retry), then an
                // animated finish that catches any late-arriving layout.
                let lastId = last.id
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    proxy.scrollTo(lastId, anchor: .bottom)
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(lastId, anchor: .bottom)
                    }
                }
            }
        }
    }

    // MARK: - Composer stack (thinking, jump, input)

    private var composerStack: some View {
        VStack(alignment: .leading, spacing: 8) {
            if viewModel.isWaitingForResponse || isScrolledUp {
                HStack(alignment: .bottom) {
                    if viewModel.isWaitingForResponse {
                        StaffLightDots()
                            .padding(.horizontal, 14)
                            .padding(.vertical, 12)
                            .glassSurface(in: Capsule())
                            .transition(.scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity))
                    }
                    Spacer(minLength: 0)
                    if isScrolledUp {
                        jumpToLatestButton
                            .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .padding(.horizontal, 14)
            }
            Group {
                OpenQuestionsTray(
                    questions: trayQuestions,
                    reveal: { quoteJumpTarget = $0.id },
                    answer: { beginReply(to: $0) },
                    dismiss: { q in
                        viewModel.dismissQuestion(q)
                        Task { try? await Task.sleep(for: .seconds(1)); await team.loadSummaries() }
                    },
                    select: { option, q in Task { await viewModel.sendMessage(option.label, replyTo: q.id); await team.loadSummaries() } }
                )
                .padding(.horizontal, 14)
            }
            inputBar
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: viewModel.isWaitingForResponse)
        .animation(.spring(response: 0.35, dampingFraction: 0.8), value: isScrolledUp)
    }

    /// The tray: the thread's own open questions not on screen, plus any the
    /// badge counts that are too old to be loaded here (answer or dismiss them
    /// from the tray), oldest first.
    private var trayQuestions: [Message] {
        let loaded = viewModel.openQuestions.filter { !onScreenQuestionIds.contains($0.id) }
        let loadedIds = Set(viewModel.messages.map(\.id))
        let older = (team.openQuestionMessages[viewModel.currentConversation] ?? []).filter { !loadedIds.contains($0.id) }
        return (older + loaded).sorted { $0.createdAt < $1.createdAt }
    }

    private var jumpToLatestButton: some View {
        Button {
            scrollToBottomTick &+= 1
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.primary)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .buttonStyle(PressableStyle(pressedScale: 0.9))
        .glassSurface(in: Circle(), interactive: true)
        .overlay(alignment: .topTrailing) {
            if unseenCount > 0 {
                ChannelBadgeBubble(count: unseenCount)
                    .offset(x: 4, y: -4)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .animation(.snappy, value: unseenCount)
        .help("Jump to latest (⌘J)")
        .accessibilityLabel(unseenCount > 0 ? "Jump to latest, \(unseenCount) new" : "Jump to latest")
    }

    // MARK: - Reply Composer

    /// Open the reply composer for `message`. The conversation behind it gets
    /// frosted out and the input bar switches to "Reply", so the next send is
    /// threaded to this bubble instead of to whatever arrived most recently.
    private func beginReply(to message: Message) {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.86)) {
            activeReactionMessageId = nil
            replyTarget = message
        }
        focusComposer()
    }

    private func focusComposer() {
        #if os(iOS)
        isInputFocused = true
        #else
        inputActive = true
        #endif
    }

    private func cancelReply() {
        withAnimation(.easeOut(duration: 0.2)) { replyTarget = nil }
    }

    /// "Chat" on an improvement card: land in its conversation with the reply
    /// composer already open on that improvement, so the next thing typed is a
    /// question or feedback about it.
    ///
    /// The anchor is a real chat message (find-or-create, see
    /// SelfImproveApproval.chatAnchor) rather than a synthetic quote: `reply_to`
    /// is a foreign key, and phone-channel builds the agent's context by reading
    /// the parent row — a fake target would thread to nothing and the agent
    /// would answer the question against whatever it last said instead.
    fileprivate func openImprovementThread(_ improvement: SelfImproveApproval.Improvement) async {
        do {
            let anchor = try await SelfImproveApproval.chatAnchor(for: improvement)
            await MainActor.run {
                // Wherever the anchor landed (the server files it by role).
                showImprovementCards = false
                go(.conversation(anchor.conversationId))
                // The anchor may be brand new (or older than the loaded window),
                // so seed it locally instead of waiting for the channel's fetch —
                // beginReply needs the message present for the quote to render.
                if !viewModel.messages.contains(where: { $0.id == anchor.id }) {
                    viewModel.messages.append(anchor)
                }
                pendingScrollId = anchor.id
                // Hand off rather than calling beginReply() here: the chat view
                // (and the input bar the composer focuses) hasn't mounted yet
                // this run loop, so the focus request would land on nothing.
                viewModel.pendingReplyMessage = anchor
            }
        } catch {
            print("[SelfImprove] opening chat thread failed: \(error)")
        }
    }

    /// Send `text`, threading it to `replyTarget` when the reply composer is open.
    private func send(_ text: String) {
        let threadParent = replyTarget?.id
        if replyTarget != nil {
            withAnimation(.easeOut(duration: 0.2)) { replyTarget = nil }
        }
        sendWithMentions(text, replyTo: threadParent)
    }

    private func replyHeaderLabel(_ date: Date) -> String {
        let time = date.formatted(date: .omitted, time: .shortened)
        if Calendar.current.isDateInToday(date) { return "Today \(time)" }
        if Calendar.current.isDateInYesterday(date) { return "Yesterday \(time)" }
        return date.formatted(date: .abbreviated, time: .shortened)
    }

    /// The semi-transparent sheet iMessage puts over the conversation while
    /// you compose a reply: everything behind it is frosted out, the message
    /// being replied to stays crisp. Tap anywhere (or Escape) to back out;
    /// the input bar underneath stays live.
    @ViewBuilder
    private var replyBackdrop: some View {
        if let target = replyTarget {
            ZStack(alignment: .bottom) {
                Rectangle()
                    .fill(.ultraThinMaterial)
                    .contentShape(Rectangle())
                    .onTapGesture { cancelReply() }

                VStack(spacing: 8) {
                    HStack {
                        Text(replyHeaderLabel(target.createdAt))
                            .font(.caption.weight(.medium))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Button { cancelReply() } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 28, height: 28)
                                .contentShape(Circle())
                        }
                        .buttonStyle(PressableStyle(pressedScale: 0.88))
                        .glassSurface(in: Circle(), interactive: true)
                        // Escape reaches this as a key equivalent even while
                        // the composer's NSTextView holds first responder,
                        // which `.onExitCommand` alone does not.
                        .keyboardShortcut(.cancelAction)
                        .accessibilityLabel("Cancel reply")
                    }

                    HStack {
                        if target.isUser { Spacer(minLength: 48) }
                        ReplyTargetBubble(message: target)
                        if target.isAssistant { Spacer(minLength: 48) }
                    }
                }
                .padding(.horizontal, 14)
                .padding(.bottom, 16)
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            .transition(.opacity)
            #if os(macOS)
            .onExitCommand { cancelReply() }
            #endif
        }
    }

    // MARK: - Input Bar

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 10) {
            attachMenu
            composerField
        }
        .padding(.horizontal, 12)
        .padding(.top, 4)
        .padding(.bottom, 8)
        // Double-tap the input bar area to jump to the latest message —
        // useful when scrolled up and the user wants back to "now".
        .simultaneousGesture(
            TapGesture(count: 2).onEnded {
                scrollToBottomTick &+= 1
            }
        )
        #if !os(macOS)
        .onChange(of: isInputFocused) { _, focused in
            withAnimation(.easeOut(duration: 0.2)) { inputActive = focused }
            // Tapping the field shrinks the ScrollView's available height
            // (keyboard slides up). LazyVStack + defaultScrollAnchor(.bottom)
            // doesn't re-resolve when the viewport size changes — same
            // failure mode as a size-class change on rotation: cells aren't
            // re-realized for the new height and the viewport can land
            // blank, or with the latest messages hidden behind the
            // keyboard. Nudging the tick reuses the deferred + retried
            // scroll-restore in the ScrollViewReader.
            if focused {
                scrollToBottomTick &+= 1
            }
        }
        #endif
        .photosPicker(isPresented: $showPhotoPicker, selection: $selectedPhoto, matching: .images)
        .onChange(of: selectedPhoto) { _, newItem in
            guard let newItem else { return }
            Task {
                if let data = try? await newItem.loadTransferable(type: Data.self) {
                    await viewModel.sendAttachment(data: data, filename: "photo.jpg", contentType: "image/jpeg")
                }
                selectedPhoto = nil
            }
        }
        .fileImporter(isPresented: $showFilePicker, allowedContentTypes: [.item], allowsMultipleSelection: false) { result in
            guard case .success(let urls) = result, let url = urls.first else { return }
            guard url.startAccessingSecurityScopedResource() else { return }
            defer { url.stopAccessingSecurityScopedResource() }
            guard let data = try? Data(contentsOf: url) else { return }
            let filename = url.lastPathComponent
            let contentType = attachmentContentType(forExtension: url.pathExtension)
            Task {
                await viewModel.sendAttachment(data: data, filename: filename, contentType: contentType)
            }
        }
    }

    private var attachMenu: some View {
        Menu {
            Button {
                showPhotoPicker = true
            } label: {
                Label("Photos", systemImage: "photo.on.rectangle")
            }
            Button {
                showFilePicker = true
            } label: {
                Label("Files", systemImage: "doc")
            }
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(.secondary)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .menuIndicator(.hidden)
        .fixedSize()
        #if os(macOS)
        .menuStyle(.borderlessButton)
        #endif
        .glassSurface(in: Circle(), interactive: true)
        .help("Attach a photo or file (⌘O)")
        .accessibilityLabel("Attach")
    }

    /// The text field lives in its own view with its own state: typing then
    /// redraws only the field, not the whole conversation above it.
    private var composerField: some View {
        let placeholder = replyTarget == nil ? "Message \(team.title(of: viewModel.currentConversation))" : "Reply"
        #if os(macOS)
        return ComposerField(placeholder: placeholder,
                             team: team.team,
                             isActive: $inputActive,
                             onSend: send)
        #else
        return ComposerField(placeholder: placeholder,
                             team: team.team,
                             focus: $isInputFocused,
                             isActive: $inputActive,
                             onSend: send)
        #endif
    }

    // MARK: - Drag and drop

    @ViewBuilder
    private var dropOverlay: some View {
        if isDropTargeted {
            let shape = RoundedRectangle(cornerRadius: 24, style: .continuous)
            shape
                .fill(JoriTheme.cobalt.opacity(0.06))
                .overlay(shape.strokeBorder(JoriTheme.cobalt.opacity(0.7), style: StrokeStyle(lineWidth: 2, dash: [8, 6])))
                .overlay {
                    Label("Drop to send to \(team.title(of: viewModel.currentConversation))", systemImage: "arrow.down.doc")
                        .font(.headline)
                        .foregroundStyle(JoriTheme.cobalt)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .glassSurface(in: Capsule())
                }
                .padding(12)
                .allowsHitTesting(false)
                .transition(.opacity)
        }
    }

    /// Files and pictures dragged onto the conversation go out exactly like the
    /// + menu's attachments.
    private func handleDrop(_ providers: [NSItemProvider]) -> Bool {
        let vm = viewModel
        var accepted = false
        for provider in providers {
            if provider.hasItemConformingToTypeIdentifier(UTType.fileURL.identifier) {
                accepted = true
                _ = provider.loadObject(ofClass: URL.self) { url, _ in
                    guard let url else { return }
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    guard let data = try? Data(contentsOf: url) else { return }
                    let filename = url.lastPathComponent
                    let type = attachmentContentType(forExtension: url.pathExtension)
                    Task { @MainActor in
                        await vm.sendAttachment(data: data, filename: filename, contentType: type)
                    }
                }
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                accepted = true
                provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                    guard let data else { return }
                    Task { @MainActor in
                        await vm.sendAttachment(data: data, filename: "photo.jpg", contentType: "image/jpeg")
                    }
                }
            }
        }
        return accepted
    }

    // MARK: - Lifecycle & sheets
    //
    // Split out of `body` so the type-checker gets two small chains instead of
    // one very long one.

    fileprivate struct LifecycleModifier: ViewModifier {
        let view: ContentView

        func body(content: Content) -> some View {
            let viewModel = view.viewModel
            let badges = view.team
            return content
                .task {
                    // A notification that launched the app names a message:
                    // open its conversation first.
                    if let pending = AppDelegate.pendingMessageId {
                        AppDelegate.pendingMessageId = nil
                        view.pendingScrollId = pending
                        if let conv = await viewModel.conversationOf(pending) { view.openConversation(conv) }
                    }
                    await viewModel.loadMessages()
                    viewModel.startCatchUpTimer()
                    // Opening a conversation reads it: mark it read, then refresh
                    // so its badge clears instead of waiting out the poll.
                    await badges.markRead(viewModel.currentConversation)
                    await badges.refresh()
                }
                .task {
                    badges.activeConversation = viewModel.currentConversation
                    badges.start()
                }
                // One source for the counts: the list's own query. The thread
                // only sees the messages it has loaded, so letting it override
                // the count made a badge clear on open and return on the way
                // back. An answer here just triggers a recount.
                .onChange(of: viewModel.openQuestions.count) { _, _ in
                    Task { await badges.loadSummaries() }
                }
                .onChange(of: viewModel.currentConversation) { oldConversation, newConversation in
                    badges.activeConversation = newConversation
                    Task {
                        await badges.markRead(oldConversation)
                        await badges.markRead(newConversation)
                        await badges.refresh()
                    }
                }
                // A notification tapped while the app runs: open the message's
                // conversation; the thread scrolls to it once it has loaded.
                .onReceive(NotificationCenter.default.publisher(for: .openJoriMessage)) { note in
                    guard let uuid = note.object as? UUID else { return }
                    Task {
                        guard let conv = await viewModel.conversationOf(uuid) else { return }
                        if conv != viewModel.currentConversation || view.memoryMode {
                            view.pendingScrollId = uuid
                            view.openConversation(conv)
                        }
                    }
                }
                .sheet(isPresented: view.$showNewConversation) {
                    NewConversationSheet(team: badges) { ids in view.startConversation(with: ids) }
                        #if os(macOS)
                        .frame(minWidth: 420, idealWidth: 460, minHeight: 420, idealHeight: 520)
                        #endif
                }
                // Handoff from the Improvements card menu's "Chat" action. Attached at
                // this level (not inside the conversation's chat subview) so it
                // fires after the switch has actually mounted the chat view.
                .onChange(of: viewModel.pendingReplyMessage) { _, message in
                    guard let message else { return }
                    viewModel.pendingReplyMessage = nil
                    view.memoryModeOff()
                    view.beginReply(to: message)
                }
                .task {
                    await viewModel.subscribeToNewMessages()
                }
                .task {
                    await viewModel.subscribeToCommands()
                }
                #if os(macOS)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
                    Task {
                        await viewModel.loadMessages()
                        await badges.refresh()
                    }
                    viewModel.reconnectIfDisconnected()
                    viewModel.startCatchUpTimer()
                    viewModel.pickupWatchForeground()
                }
                #endif
                .onChange(of: view.scenePhase) { _, newPhase in
                    if newPhase == .active {
                        // macOS: didBecomeActiveNotification (above) already handles the
                        // active path — running it here too double-fires loadMessages() +
                        // reconnectIfNeeded() on every focus event on the host.
                        #if os(iOS)
                        Task { await viewModel.loadMessages() }
                        viewModel.reconnectIfDisconnected()
                        viewModel.startCatchUpTimer()
                        viewModel.pickupWatchForeground()
                        #endif
                        // Both platforms: come back to full-speed polling the moment
                        // we're foregrounded again.
                        badges.start()
                        #if os(macOS)
                        badges.setBackgroundPolling(false)
                        #endif
                        Task { await badges.refresh() }
                    } else {
                        viewModel.stopCatchUpTimer()
                        if newPhase == .background { viewModel.pickupWatchBackground() }
                        #if os(macOS)
                        // The window is frequently open-but-unfocused on the host
                        // rather than actually closed — keep polling for a pending
                        // Improvements card, just less often than while focused.
                        badges.setBackgroundPolling(true)
                        #else
                        badges.stop()
                        #endif
                    }
                }
                #if os(iOS)
                // Rotation / size-class changes invalidate the LazyVStack's realized
                // cells, and `defaultScrollAnchor(.bottom)` doesn't re-resolve — the
                // viewport ends up blank until the user scrolls. Nudging the tick
                // triggers a `scrollTo(last, .bottom)` which forces re-realization.
                .onChange(of: view.verticalSizeClass) { _, _ in
                    view.scrollToBottomTick &+= 1
                }
                .onChange(of: view.horizontalSizeClass) { _, _ in
                    view.scrollToBottomTick &+= 1
                }
                #endif
                .alert("Something went wrong", isPresented: .init(
                    get: { viewModel.error != nil },
                    set: { if !$0 { viewModel.error = nil } }
                )) {
                    Button("OK") { viewModel.error = nil }
                } message: {
                    Text(viewModel.error ?? "")
                }
        }
    }

    fileprivate func memoryModeOff() {
        memoryMode = false
    }

    fileprivate struct ApprovalsModifier: ViewModifier {
        let view: ContentView

        @MainActor
        private func checkWaitingApprovals() async {
            view.pendingApprovalCount = await PendingApprovals.count()
            guard TradeApproval.isRegistered, view.pendingApproval == nil, !view.showPendingApprovals,
                  let waiting = try? await TradeApproval.fetchPending(interactive: false).first,
                  view.pendingApproval == nil
            else { return }
            view.pendingApproval = waiting
        }

        func body(content: Content) -> some View {
            content
                // Trade approval — iPhone (Face ID) and Mac (Touch ID); each device
                // pairs with the trading web app on its own (TradeApproval.swift).
                .sheet(isPresented: view.$showApprovalPairing) {
                    TradeApprovalPairingView()
                        #if os(macOS)
                        .frame(minWidth: 480, idealWidth: 520, minHeight: 460, idealHeight: 500)
                        #endif
                }
                .sheet(isPresented: view.$showPendingApprovals) {
                    PendingApprovalsView(onCount: { view.pendingApprovalCount = $0 })
                        #if os(macOS)
                        .frame(minWidth: 420, idealWidth: 480, minHeight: 360, idealHeight: 460)
                        #endif
                }
                .onReceive(NotificationCenter.default.publisher(for: .openTradeApproval)) { note in
                    AppDelegate.pendingApprovalRequest = nil
                    view.pendingApproval = note.object as? TradeApproval.Request
                }
                // Don't depend on the push (2026-11-06): on launch and whenever
                // the app comes forward, ask the trading web app for approvals
                // still waiting and open the newest. Silent — no Face ID here; a
                // device without a read token yet gets one silently (or from
                // Pending approvals). Also refreshes the Pending approvals badge.
                .task { await checkWaitingApprovals() }
                .onChange(of: view.pendingApproval?.id) { _, id in
                    if id == nil { Task { view.pendingApprovalCount = await PendingApprovals.count() } }
                }
                .onChange(of: view.pendingPurchase?.id) { _, id in
                    if id == nil { Task { view.pendingApprovalCount = await PendingApprovals.count() } }
                }
                .onChange(of: view.scenePhase) { _, phase in
                    if phase == .active { Task { await checkWaitingApprovals() } }
                }
                // Consume a request that arrived while we weren't mounted (cold launch /
                // lock screen), once this view actually appears.
                .onAppear {
                    if let r = AppDelegate.pendingApprovalRequest {
                        AppDelegate.pendingApprovalRequest = nil
                        view.pendingApproval = r
                    }
                    if let id = AppDelegate.pendingPurchaseId {
                        AppDelegate.pendingPurchaseId = nil
                        view.pendingPurchase = PurchaseApproval.Ref(id: id)
                    }
                    if let id = AppDelegate.pendingActionApprovalId {
                        AppDelegate.pendingActionApprovalId = nil
                        view.pendingAction = ActionApproval.Ref(id: id)
                    }
                }
                #if os(iOS)
                .sheet(isPresented: view.$showUsageSetup) {
                    PhoneUsageSetupView()
                }
                // Blocking full-screen review: the user can't touch the rest of the app
                // until they Approve (Face ID) or Deny.
                .fullScreenCover(item: view.$pendingApproval) { req in
                    TradeApprovalReviewView(request: req) { view.pendingApproval = nil }
                }
                #else
                .sheet(item: view.$pendingApproval) { req in
                    TradeApprovalReviewView(request: req) { view.pendingApproval = nil }
                        .frame(minWidth: 420, idealWidth: 480, minHeight: 520, idealHeight: 620)
                }
                #endif
                // Purchase approval — iPhone (Face ID) and Mac (Touch ID) alike; each
                // device pairs its own Secure Enclave key (PurchaseApproval.swift).
                .sheet(isPresented: view.$showPurchasePairing) {
                    PurchaseApprovalPairingView()
                        #if os(macOS)
                        .frame(minWidth: 480, idealWidth: 520, minHeight: 440, idealHeight: 480)
                        #endif
                }
                .onReceive(NotificationCenter.default.publisher(for: .openPurchaseApproval)) { note in
                    AppDelegate.pendingPurchaseId = nil
                    if let id = note.object as? String { view.pendingPurchase = PurchaseApproval.Ref(id: id) }
                }
                // A push can be missed (Focus, swiped away). Whenever the app comes
                // forward, surface any purchase still waiting on approval.
                .onReceive(NotificationCenter.default.publisher(for: PurchaseApproval.didBecomeActive)) { _ in
                    guard view.pendingPurchase == nil, PurchaseApproval.isRegistered else { return }
                    Task {
                        if let id = try? await PurchaseApproval.fetchPendingId(), view.pendingPurchase == nil {
                            view.pendingPurchase = PurchaseApproval.Ref(id: id)
                        }
                    }
                }
                // Plugin-action approval: same shape as purchases (ActionApproval.swift).
                .onReceive(NotificationCenter.default.publisher(for: .openActionApproval)) { note in
                    AppDelegate.pendingActionApprovalId = nil
                    if let id = note.object as? String { view.pendingAction = ActionApproval.Ref(id: id) }
                }
                .onReceive(NotificationCenter.default.publisher(for: PurchaseApproval.didBecomeActive)) { _ in
                    guard view.pendingAction == nil, ActionApproval.isRegistered else { return }
                    Task {
                        if let id = try? await ActionApproval.fetchPendingId(), view.pendingAction == nil {
                            view.pendingAction = ActionApproval.Ref(id: id)
                        }
                    }
                }
                .sheet(item: view.$pendingAction) { ref in
                    ActionApprovalReviewView(approvalId: ref.id) { view.pendingAction = nil }
                        #if os(iOS)
                        .presentationDetents([.large])
                        .presentationDragIndicator(.hidden)
                        #else
                        .frame(minWidth: 460, idealWidth: 520, minHeight: 560, idealHeight: 680)
                        #endif
                }
                #if os(iOS)
                // A bottom sheet, not a chat message: it can't be
                // swiped away (interactiveDismissDisabled in the view); Buy with Face ID
                // or Deny are the only ways out.
                .sheet(item: view.$pendingPurchase) { ref in
                    PurchaseApprovalReviewView(purchaseId: ref.id) { view.pendingPurchase = nil }
                        .presentationDetents([.large])
                        .presentationDragIndicator(.hidden)
                }
                #else
                .sheet(item: view.$pendingPurchase) { ref in
                    PurchaseApprovalReviewView(purchaseId: ref.id) { view.pendingPurchase = nil }
                        .frame(minWidth: 460, idealWidth: 520, minHeight: 640, idealHeight: 760)
                }
                #endif
        }
    }
}

#if os(macOS)
/// Holds the window a view lives in (weakly).
final class WindowBox {
    weak var window: NSWindow?
}

/// Finds the NSWindow hosting this view and hands it over once attached.
private struct WindowReader: NSViewRepresentable {
    let box: WindowBox
    let onAttach: (NSWindow) -> Void

    func makeNSView(context: Context) -> NSView {
        let view = AttachView()
        view.onWindow = { window in
            box.window = window
            onAttach(window)
        }
        return view
    }

    func updateNSView(_ view: NSView, context: Context) {}

    private final class AttachView: NSView {
        var onWindow: ((NSWindow) -> Void)?
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if let window { DispatchQueue.main.async { self.onWindow?(window) } }
        }
    }
}
#endif

/// Reports whether the conversation is scrolled away from its newest message.
/// Needs the scroll-geometry API (iOS 18 / macOS 15); a no-op before that.
private struct ScrolledUpReader: ViewModifier {
    @Binding var isScrolledUp: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentSize.height - geo.visibleRect.maxY > 280
            } action: { _, scrolledUp in
                if scrolledUp != isScrolledUp { isScrolledUp = scrolledUp }
            }
        } else {
            content
        }
    }
}

/// Keeps `onScreen` in step with whether this row is visible in its scroll
/// view (at least half of it), for rows that are `tracked`. Needs the scroll-
/// visibility API (iOS 18 / macOS 15); before that nothing is ever reported
/// on screen, so the open-questions tray keeps listing every question.
private struct OnScreenReader: ViewModifier {
    let id: UUID
    let tracked: Bool
    @Binding var onScreen: Set<UUID>

    func body(content: Content) -> some View {
        if tracked, #available(iOS 18.0, macOS 15.0, *) {
            content
                .onScrollVisibilityChange(threshold: 0.5) { visible in
                    if visible { onScreen.insert(id) } else { onScreen.remove(id) }
                }
                .onDisappear { onScreen.remove(id) }
        } else {
            content
        }
    }
}

// MARK: - Grouping

/// Where a bubble sits in the run of messages around it. Consecutive messages
/// from the same side within a few minutes form a group: they sit close, their
/// facing corners tighten, and only the last one carries the time. A long gap
/// or a new day starts a fresh section with a centred timestamp.
struct BubbleLayout: Equatable {
    var startsGroup = true
    var endsGroup = true
    /// Set when a section header goes above this bubble.
    var separator: Date?

    static let solo = BubbleLayout()

    private static let groupGap: TimeInterval = 5 * 60
    private static let sectionGap: TimeInterval = 60 * 60

    static func compute(_ messages: [Message]) -> [UUID: BubbleLayout] {
        var result: [UUID: BubbleLayout] = [:]
        result.reserveCapacity(messages.count)
        var places: [BubbleLayout] = []
        places.reserveCapacity(messages.count)
        let calendar = Calendar.current
        for (i, m) in messages.enumerated() {
            var place = BubbleLayout()
            if i == 0 {
                place.separator = m.createdAt
            } else {
                let prev = messages[i - 1]
                let gap = m.createdAt.timeIntervalSince(prev.createdAt)
                if gap > sectionGap || !calendar.isDate(prev.createdAt, inSameDayAs: m.createdAt) {
                    place.separator = m.createdAt
                }
                place.startsGroup = place.separator != nil
                    || prev.role != m.role
                    || prev.sender != m.sender
                    || gap > groupGap
                    || m.replyTo != nil
            }
            places.append(place)
        }
        for i in places.indices {
            places[i].endsGroup = i == places.count - 1 || places[i + 1].startsGroup
            result[messages[i].id] = places[i]
        }
        return result
    }
}

private struct DaySeparator: View {
    let date: Date

    var body: some View {
        Text(label)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.top, 14)
            .padding(.bottom, 6)
            .accessibilityAddTraits(.isHeader)
    }

    private var label: String {
        let calendar = Calendar.current
        let time = date.formatted(date: .omitted, time: .shortened)
        if calendar.isDateInToday(date) { return "Today \(time)" }
        if calendar.isDateInYesterday(date) { return "Yesterday \(time)" }
        if let days = calendar.dateComponents([.day], from: date, to: .now).day, days < 6 {
            return "\(date.formatted(.dateTime.weekday(.wide))) \(time)"
        }
        return "\(date.formatted(.dateTime.weekday(.abbreviated).month(.abbreviated).day())), \(time)"
    }
}

// MARK: - Message Bubble

/// What a bubble shows that comes from other messages — its quoted parent,
/// whether it is still waiting on an answer, the answer itself. The list
/// computes it, so a bubble depends only on values and redraws only when one
/// of them changes.
struct BubbleThread: Equatable {
    var quotedParent: Message?
    var isOpenQuestion = false
    var checked: Set<String> = []
    var answer: String?
    var defaultApplied: String?
    /// The user's own message, waiting 10 minutes with no sign it was picked
    /// up (PickupWatch).
    var notPickedUp = false
    /// "Ada · CFO" over the first bubble of a run, where it isn't obvious who is speaking.
    var senderLabel: String?
    /// The speak gate's shadow verdict on this message, for the user to grade.
    var gate: GateReview?
}

/// What a bubble can ask the conversation to do.
struct BubbleActions {
    var reply: (Message) -> Void
    var quoteTap: (UUID) -> Void
    var setPalette: (UUID?) -> Void
    var react: (Message, Reaction?) -> Void
    var answer: (String, UUID) -> Void
    var toggleChecklist: (String, Bool, UUID) -> Void
    var resolveParent: (UUID) -> Void
    var dismiss: (Message) -> Void
    var gradeGate: (UUID, String, String) -> Void = { _, _, _ in }
}

/// Equatable on its inputs (the closures are deliberately left out — they
/// are the same actions every time), and used with `.equatable()`: a bubble
/// whose message, place and thread are unchanged is skipped entirely when the
/// conversation redraws.
struct MessageBubble: View, Equatable {
    let message: Message
    var layout: BubbleLayout
    var thread: BubbleThread
    var isPaletteOpen: Bool
    var actions: BubbleActions

    /// False for a message that has only just arrived; it springs in once.
    @State private var settled: Bool
    @State private var hovering = false
    /// The quick-action bar sits half outside the bubble, so it tracks its own
    /// hover — moving onto it must not count as leaving the message.
    @State private var barHovering = false
    @State private var dragX: CGFloat = 0
    @State private var replyArmed = false
    @State private var reactionTick = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(message: Message,
         layout: BubbleLayout,
         thread: BubbleThread,
         isPaletteOpen: Bool,
         actions: BubbleActions) {
        self.message = message
        self.layout = layout
        self.thread = thread
        self.isPaletteOpen = isPaletteOpen
        self.actions = actions
        self._settled = State(initialValue: Date().timeIntervalSince(message.createdAt) > 8)
    }

    static func == (lhs: MessageBubble, rhs: MessageBubble) -> Bool {
        lhs.message == rhs.message && lhs.layout == rhs.layout
            && lhs.thread == rhs.thread && lhs.isPaletteOpen == rhs.isPaletteOpen
    }

    private func onReply(_ m: Message) { actions.reply(m) }

    private var isImageURL: Bool { isAttachmentImage(message.content) }

    /// Big corners outside a group, tight ones where bubbles from the same
    /// side meet — the group reads as one turn of the conversation.
    private var bubbleShape: UnevenRoundedRectangle {
        let big = Radius.bubble
        let top = layout.startsGroup ? big : Radius.joined
        let bottom = layout.endsGroup ? big : Radius.joined
        if message.isUser {
            return UnevenRoundedRectangle(topLeadingRadius: big, bottomLeadingRadius: big,
                                          bottomTrailingRadius: bottom, topTrailingRadius: top,
                                          style: .continuous)
        }
        return UnevenRoundedRectangle(topLeadingRadius: top, bottomLeadingRadius: bottom,
                                      bottomTrailingRadius: big, topTrailingRadius: big,
                                      style: .continuous)
    }

    private func openPalette() {
        reactionTick &+= 1
        withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) {
            actions.setPalette(message.id)
        }
    }

    private func apply(_ reaction: Reaction?) {
        let target = message
        reactionTick &+= 1
        withAnimation(.easeOut(duration: 0.15)) {
            actions.setPalette(nil)
        }
        actions.react(target, reaction)
    }

    var body: some View {
        VStack(spacing: 0) {
            if let parentId = message.replyTo {
                QuotedReplyView(
                    parent: thread.quotedParent,
                    onTap: { actions.quoteTap(parentId) }
                )
            }

            HStack(alignment: .bottom, spacing: 0) {
                if message.isUser { Spacer(minLength: 56) }

                VStack(alignment: message.isUser ? .trailing : .leading, spacing: 3) {
                    if let label = thread.senderLabel {
                        Text(label)
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .padding(.horizontal, 8)
                    }
                    bubbleContent
                        .overlay(alignment: message.isUser ? .topLeading : .topTrailing) {
                            if (hovering || barHovering) && !isPaletteOpen {
                                hoverBar
                                    .onHover { inside in barHovering = inside }
                                    .offset(x: message.isUser ? -12 : (message.reaction == nil ? -8 : -34), y: -14)
                                    .transition(.scale(scale: 0.8).combined(with: .opacity))
                            }
                        }

                    if layout.endsGroup {
                        Text(message.createdAt, style: .time)
                            .font(.caption2)
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 8)
                            .padding(.bottom, 2)
                    }

                    if thread.notPickedUp {
                        notPickedUpLine
                            .transition(.opacity)
                    }

                    if let gate = thread.gate {
                        GateReviewLine(review: gate) { grade, note in actions.gradeGate(gate.id, grade, note) }
                    }
                }

                if message.isAssistant { Spacer(minLength: 56) }
            }
            .offset(x: dragX)
            .background(alignment: .leading) { swipeReplyIndicator }
        }
        .scaleEffect(settled || reduceMotion ? 1 : 0.88,
                     anchor: message.isUser ? .bottomTrailing : .bottomLeading)
        .opacity(settled ? 1 : 0)
        .onAppear {
            guard !settled else { return }
            withAnimation(.spring(response: 0.42, dampingFraction: 0.74)) { settled = true }
        }
        .onHover { inside in
            withAnimation(.easeOut(duration: 0.12)) { hovering = inside }
        }
        #if os(iOS)
        .modifier(SwipeToReplyGesture(onChange: swipeChanged, onEnd: swipeEnded))
        #endif
        #if os(iOS)
        // Touch only: on the Mac each bubble's feedback generator was ~1,000
        // extra views in the list for haptics a trackpad doesn't play.
        .sensoryFeedback(.impact(weight: .medium), trigger: replyArmed) { _, armed in armed }
        .sensoryFeedback(.selection, trigger: reactionTick)
        #endif
        // Resolve the quoted parent when it has scrolled out of the loaded
        // window (no-ops when it's already on screen or cached).
        .task(id: message.replyTo) {
            if let parentId = message.replyTo {
                actions.resolveParent(parentId)
            }
        }
    }

    /// Calm on purpose: it reports what the app can see (no sign of pickup),
    /// not a diagnosis, and it leaves on its own when a sign arrives.
    private var notPickedUpLine: some View {
        Label("Not picked up yet — \(Install.displayName) may be down", systemImage: "clock.badge.exclamationmark")
            .font(.caption2)
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.bottom, 2)
            .accessibilityLabel("Not picked up yet. \(Install.displayName) may be down.")
    }

    // MARK: Pointer — quick actions on hover (Mac, iPad with a pointer)

    private var hoverBar: some View {
        HStack(spacing: 2) {
            if message.isAssistant {
                ForEach(Reaction.allCases, id: \.self) { reaction in
                    Button {
                        apply(message.reaction == reaction ? nil : reaction)
                    } label: {
                        Text(reaction.emoji)
                            .font(.system(size: 14))
                            .frame(width: 28, height: 26)
                            .background(Circle().fill(message.reaction == reaction ? JoriTheme.cobalt.opacity(0.18) : .clear))
                    }
                    .buttonStyle(PressableStyle(pressedScale: 0.8))
                    .help(reaction.label)
                }
                Divider().frame(height: 16)
            }
            Button { onReply(message) } label: {
                Image(systemName: "arrowshape.turn.up.left.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
                    .frame(width: 28, height: 26)
            }
            .buttonStyle(PressableStyle(pressedScale: 0.8))
            .help("Reply")
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 2)
        .glassSurface(in: Capsule())
        .shadow(color: .black.opacity(0.1), radius: 6, y: 2)
    }

    // MARK: Touch — swipe right to reply

    #if os(iOS)
    private static let replyThreshold: CGFloat = 56

    private func swipeChanged(_ dx: CGFloat) {
        let t = Self.replyThreshold
        let x = max(0, dx)
        dragX = x < t ? x : t + (x - t) * 0.25
        let armed = dragX >= t
        if armed != replyArmed { replyArmed = armed }
    }

    private func swipeEnded() {
        if replyArmed { onReply(message) }
        replyArmed = false
        withAnimation(.spring(response: 0.32, dampingFraction: 0.78)) { dragX = 0 }
    }
    #endif

    @ViewBuilder
    private var swipeReplyIndicator: some View {
        if dragX > 4 {
            #if os(iOS)
            let progress = min(dragX / Self.replyThreshold, 1)
            #else
            let progress: CGFloat = 0
            #endif
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(replyArmed ? .white : .secondary)
                .frame(width: 32, height: 32)
                .background(Circle().fill(replyArmed ? JoriTheme.cobalt : JoriTheme.slate))
                .scaleEffect(0.5 + 0.5 * progress)
                .opacity(progress)
                .offset(x: -6)
                .animation(.spring(response: 0.25, dampingFraction: 0.6), value: replyArmed)
        }
    }

    /// Shared across every bubble shape (text, rich, image) so Reply is always
    /// one right-click away.
    @ViewBuilder
    private var replyMenuItem: some View {
        Button {
            onReply(message)
        } label: {
            Label("Reply", systemImage: "arrowshape.turn.up.left")
        }
    }

    @ViewBuilder
    private var bubbleContent: some View {
        if isImageURL, let url = URL(string: message.content) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: 240, maxHeight: 300)
                        .clipShape(bubbleShape)
                        .transition(.opacity)
                case .failure:
                    Label("Couldn't load this image", systemImage: "photo")
                        .font(.callout)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(message.isUser ? JoriTheme.cobalt : JoriTheme.slate, in: bubbleShape)
                        .foregroundStyle(message.isUser ? Color.white : Color.secondary)
                default:
                    bubbleShape
                        .fill(JoriTheme.slate)
                        .frame(width: 180, height: 140)
                        .overlay(ProgressView())
                }
            }
            .contextMenu {
                replyMenuItem
                Divider()
                Button {
                    copyToPasteboard(message.content)
                } label: {
                    Label("Copy Link", systemImage: "doc.on.doc")
                }
                ShareLink(item: url) {
                    Label("Share…", systemImage: "square.and.arrow.up")
                }
            }
        } else if message.isAssistant {
            assistantBubble
        } else {
            Text(message.content)
                #if os(macOS)
                .font(.system(size: 16))
                #else
                .font(.body)
                #endif
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(JoriTheme.cobalt, in: bubbleShape)
                .foregroundStyle(.white)
                .contextMenu {
                    replyMenuItem
                    Divider()
                    Button {
                        copyToPasteboard(message.content)
                    } label: {
                        Label("Copy", systemImage: "doc.on.doc")
                    }
                    ShareLink(item: message.content) {
                        Label("Share…", systemImage: "square.and.arrow.up")
                    }
                }
        }
    }

    @ViewBuilder
    private var assistantBubble: some View {
        let openQuestion = thread.isOpenQuestion
        let choice = ChoicePrompt.from(metadata: message.metadata)
        // A decision card stays question-gold after it is answered too
        // (decisions are drawn as questions).
        let isDecision = choice?.isDecision == true
        // A placed purchase (purchase-approval-poll tags it card=purchase,
        // status=placed): an approved purchase that went through gets a
        // highlighted confirmation in the chat.
        let isConfirmed = message.metadata?["card"] == "purchase" && message.metadata?["status"] == "placed"
        let fill: Color = isConfirmed ? JoriTheme.confirmedWash : (openQuestion || isDecision ? JoriTheme.staffWash : JoriTheme.slate)
        VStack(alignment: .leading, spacing: 10) {
            if isConfirmed {
                Label("Purchase confirmed", systemImage: "checkmark.seal.fill")
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(JoriTheme.confirmed)
            }
            if openQuestion {
                Label("Waiting for your answer", systemImage: "sparkle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(JoriTheme.staffInk)
            }
            if let checklist = Checklist.from(metadata: message.metadata) {
                // The checklist carries the agenda; the message text is the
                // plain copy for older builds and the push.
                if let title = checklist.title, !title.isEmpty {
                    RichMessageView(content: title)
                }
                ChecklistView(
                    checklist: checklist,
                    checked: thread.checked,
                    onToggle: { label, on in actions.toggleChecklist(label, on, message.id) }
                )
            } else if let prompt = choice, prompt.isDecision {
                // The card carries the question and every option; the
                // message text is the plain-text copy for older builds.
                DecisionCardView(
                    prompt: prompt,
                    answeredLabel: thread.answer,
                    onSelect: { option in
                        actions.answer(option.label, message.id)
                    },
                    onTypeSomething: { onReply(message) }
                )
            } else {
                // A location card carries its own question, time and map; the
                // message text (written to stand alone for older builds)
                // would only repeat it.
                if choice?.subject == nil {
                    RichMessageView(content: message.content)
                }
                if let prompt = choice {
                    ChoicePromptView(
                        prompt: prompt,
                        answeredLabel: thread.answer,
                        defaultAppliedLabel: thread.defaultApplied
                    ) { option in
                        // The tap IS the reply — same path as typing it.
                        actions.answer(option.label, message.id)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background {
            // The staff light: an unanswered question glows faintly gold, the
            // one place in the stream that is waiting on you. The shadow is
            // cast by the plain background shape, and only on open questions —
            // a shadow over the text itself forces an offscreen render of the
            // whole bubble on every scroll frame.
            if openQuestion {
                bubbleShape.fill(fill).shadow(color: JoriTheme.staff.opacity(0.28), radius: 12, y: 2)
            } else {
                bubbleShape.fill(fill)
            }
        }
        .overlay {
            if isConfirmed {
                bubbleShape.stroke(JoriTheme.confirmed.opacity(0.6), lineWidth: 1.5)
            } else if openQuestion {
                bubbleShape.stroke(JoriTheme.staff.opacity(0.6), lineWidth: 1)
            }
        }
        .scaleEffect(isPaletteOpen ? 1.015 : 1.0)
        .animation(.spring(response: 0.28, dampingFraction: 0.75), value: isPaletteOpen)
        .animation(.easeInOut(duration: 0.3), value: openQuestion)
        .overlay(alignment: .topTrailing) {
            if let reaction = message.reaction {
                ReactionBadge(reaction: reaction)
                    .offset(x: 6, y: -8)
                    .transition(.scale(scale: 0.3).combined(with: .opacity))
                    .id(reaction)
            }
        }
        .animation(.spring(response: 0.35, dampingFraction: 0.55), value: message.reaction)
        .overlay(alignment: .topLeading) {
            if isPaletteOpen {
                ReactionPalette(selected: message.reaction, onSelect: { r in
                    apply(message.reaction == r ? nil : r)
                })
                .offset(y: -56)
                .transition(.scale(scale: 0.6, anchor: .bottomLeading).combined(with: .opacity))
            }
        }
        #if os(iOS)
        .onLongPressGesture(minimumDuration: 0.35) {
            openPalette()
        }
        #endif
        .contextMenu {
            replyMenuItem
            if thread.isOpenQuestion {
                Button {
                    actions.dismiss(message)
                } label: {
                    Label("Dismiss Question", systemImage: "xmark.circle")
                }
            }
            Divider()
            ForEach(Reaction.allCases, id: \.self) { reaction in
                Button {
                    apply(message.reaction == reaction ? nil : reaction)
                } label: {
                    if message.reaction == reaction {
                        Label("\(reaction.emoji) \(reaction.label)", systemImage: "checkmark")
                    } else {
                        Text("\(reaction.emoji) \(reaction.label)")
                    }
                }
            }
            Divider()
            Button {
                copyToPasteboard(message.content)
            } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            // Hand the text to the system share sheet (Messages, Mail,
            // WhatsApp, AirDrop…) to pass a Jori answer on to someone.
            ShareLink(item: message.content) {
                Label("Share…", systemImage: "square.and.arrow.up")
            }
        }
    }
}

#if os(iOS)
/// Swipe a bubble right to reply. A UIKit pan that refuses to begin unless the
/// swipe is clearly rightward: a SwiftUI DragGesture on every bubble took the
/// touch away from the scroll view on iOS 18+, and the conversation stopped
/// scrolling. Needs iOS 18 (UIGestureRecognizerRepresentable); earlier
/// systems keep Reply in the long-press menu only.
private struct SwipeToReplyGesture: ViewModifier {
    let onChange: (CGFloat) -> Void
    let onEnd: () -> Void

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.gesture(HorizontalPan(onChange: onChange, onEnd: onEnd))
        } else {
            content
        }
    }
}

@available(iOS 18.0, *)
private struct HorizontalPan: UIGestureRecognizerRepresentable {
    let onChange: (CGFloat) -> Void
    let onEnd: () -> Void

    func makeCoordinator(converter: CoordinateSpaceConverter) -> Coordinator { Coordinator() }

    func makeUIGestureRecognizer(context: Context) -> UIPanGestureRecognizer {
        let pan = UIPanGestureRecognizer()
        pan.delegate = context.coordinator
        return pan
    }

    func handleUIGestureRecognizerAction(_ pan: UIPanGestureRecognizer, context: Context) {
        switch pan.state {
        case .began, .changed:
            onChange(pan.translation(in: pan.view).x)
        case .ended, .cancelled, .failed:
            onEnd()
        default:
            break
        }
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        func gestureRecognizerShouldBegin(_ recognizer: UIGestureRecognizer) -> Bool {
            guard let pan = recognizer as? UIPanGestureRecognizer else { return false }
            let v = pan.velocity(in: pan.view)
            return v.x > 0 && abs(v.x) > abs(v.y) * 1.5
        }
    }
}
#endif

// MARK: - Threaded Reply Rendering

/// The quoted original that sits above a threaded reply, plus the little
/// curled connector linking the two — iMessage's shape: an outlined (never
/// filled) bubble on the *quoted* message's side of the conversation.
private struct QuotedReplyView: View {
    /// nil while the parent is still being resolved, or if it's gone.
    let parent: Message?
    let onTap: () -> Void

    /// Quotes hang on the side of whoever wrote the quoted message. While the
    /// parent is unresolved, assume Jori's side — replying to one of its
    /// pings is the case this whole feature exists for.
    private var parentOnLeft: Bool { !(parent?.isUser ?? false) }

    private var preview: String {
        guard let parent else { return "Message unavailable" }
        let c = parent.content
        if isAttachmentImage(c) { return "Photo" }
        let flattened = c
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return flattened.count > 180 ? String(flattened.prefix(180)) + "…" : flattened
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 16, style: .continuous)
        VStack(alignment: parentOnLeft ? .leading : .trailing, spacing: 0) {
            Button(action: onTap) {
                Text(preview)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 7)
                    .background(shape.strokeBorder(JoriTheme.hairline, lineWidth: 1))
                    .contentShape(shape)
            }
            .buttonStyle(PressableStyle())
            .accessibilityLabel("Replying to: \(preview)")
            .accessibilityHint("Shows the original message")

            ReplyConnector(mirrored: !parentOnLeft)
                .stroke(JoriTheme.hairline, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                .frame(width: 34, height: 18)
                .padding(parentOnLeft ? .leading : .trailing, 14)
        }
        .frame(maxWidth: .infinity, alignment: parentOnLeft ? .leading : .trailing)
        .padding(parentOnLeft ? .trailing : .leading, 56)
        .padding(.bottom, 1)
    }
}

/// The curled tail hanging off the quote toward the reply below it.
private struct ReplyConnector: Shape {
    /// Flip for quotes that sit on the right (the user's own messages).
    let mirrored: Bool

    func path(in rect: CGRect) -> Path {
        var p = Path()
        let top = CGPoint(x: rect.maxX, y: rect.minY)
        let mid = CGPoint(x: rect.maxX, y: rect.midY)
        let end = CGPoint(x: rect.minX + rect.width * 0.15, y: rect.maxY - 2)
        p.move(to: top)
        p.addQuadCurve(to: end, control: mid)
        if mirrored {
            p = p.applying(CGAffineTransform(scaleX: -1, y: 1)
                .concatenating(CGAffineTransform(translationX: rect.width, y: 0)))
        }
        return p
    }
}

/// The message being replied to, rendered crisply on the reply backdrop.
/// Deliberately menu-free and reaction-free — it's a target, not a live bubble.
private struct ReplyTargetBubble: View {
    let message: Message

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Radius.bubble, style: .continuous)
        Group {
            if isAttachmentImage(message.content), let url = URL(string: message.content) {
                AsyncImage(url: url) { image in
                    image
                        .resizable()
                        .scaledToFill()
                        .frame(maxWidth: 240, maxHeight: 300)
                        .clipShape(shape)
                } placeholder: {
                    ProgressView().frame(width: 120, height: 120)
                }
            } else if message.isAssistant {
                // Long digests get their own scroll rather than pushing the
                // composer off-screen.
                ScrollView {
                    RichMessageView(content: message.content)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                }
                .frame(maxHeight: 320)
                .fixedSize(horizontal: false, vertical: true)
                .background(JoriTheme.slate, in: shape)
            } else {
                Text(message.content)
                    #if os(macOS)
                    .font(.system(size: 16))
                    #else
                    .font(.body)
                    #endif
                    .padding(.horizontal, 14)
                    .padding(.vertical, 9)
                    .background(JoriTheme.cobalt, in: shape)
                    .foregroundStyle(.white)
            }
        }
        .shadow(color: Color.black.opacity(0.14), radius: 16, x: 0, y: 6)
    }
}

// MARK: - Reaction Palette

private struct ReactionPalette: View {
    let selected: Reaction?
    let onSelect: (Reaction) -> Void
    @State private var appeared = false

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(Reaction.allCases.enumerated()), id: \.element) { index, reaction in
                Button {
                    onSelect(reaction)
                } label: {
                    Text(reaction.emoji)
                        .font(.system(size: 26))
                        .frame(width: 42, height: 42)
                        .background(
                            Circle().fill(selected == reaction ? JoriTheme.cobalt.opacity(0.2) : Color.clear)
                        )
                }
                .buttonStyle(PressableStyle(pressedScale: 0.78))
                .scaleEffect(appeared ? 1 : 0.2)
                .opacity(appeared ? 1 : 0)
                .animation(.spring(response: 0.34, dampingFraction: 0.58).delay(Double(index) * 0.045), value: appeared)
                .accessibilityLabel(reaction.label)
            }
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 4)
        .glassSurface(in: Capsule())
        .shadow(color: Color.black.opacity(0.16), radius: 14, x: 0, y: 6)
        .onAppear { appeared = true }
    }
}

// MARK: - Reaction Badge

private struct ReactionBadge: View {
    let reaction: Reaction

    var body: some View {
        Text(reaction.emoji)
            .font(.system(size: 13))
            .frame(width: 26, height: 26)
            .background(Circle().fill(JoriTheme.slateRaised))
            .overlay(Circle().stroke(JoriTheme.canvas, lineWidth: 2))
            .shadow(color: Color.black.opacity(0.1), radius: 3, x: 0, y: 1)
            .accessibilityLabel("Reacted \(reaction.label)")
    }
}

/// The message field and send button. Owns the draft text, so a keystroke
/// re-renders this view alone.
private struct ComposerField: View {
    let placeholder: String
    /// The team, for @mentions: typing "@" offers them, a tap completes the handle.
    var team: [TeamMember] = []
    #if os(iOS)
    var focus: FocusState<Bool>.Binding
    #endif
    @Binding var isActive: Bool
    let onSend: (String) -> Void

    @State private var text: String = ChatViewModel.loadDraft()
    /// Bumped on every send, for the send haptic.
    @State private var sendTick = 0
    @Environment(\.scenePhase) private var scenePhase

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private func submit() {
        let toSend = text
        guard !toSend.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        text = ""
        sendTick &+= 1
        onSend(toSend)
    }

    /// Team members matching the "@handle" being typed; empty when not typing one.
    private var mentionMatches: [TeamMember] {
        guard let q = MentionSuggestions.query(in: text) else { return [] }
        return MentionSuggestions.matches(team, query: q)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !mentionMatches.isEmpty {
                MentionSuggestions(members: mentionMatches) { m in
                    text = MentionSuggestions.complete(text, with: m)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
            field
        }
        .animation(.snappy(duration: 0.2), value: mentionMatches.map(\.id))
    }

    private var field: some View {
        let shape = RoundedRectangle(cornerRadius: 20, style: .continuous)
        return HStack(alignment: .bottom, spacing: 4) {
            Group {
                #if os(macOS)
                MacMessageField(
                    text: $text,
                    placeholder: placeholder,
                    isFocused: $isActive,
                    onSend: submit
                )
                #else
                TextField(placeholder, text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused(focus)
                    .submitLabel(.send)
                    .onSubmit(submit)
                #endif
            }
            .padding(.leading, 16)
            .padding(.trailing, canSend ? 0 : 16)
            .padding(.vertical, 10)

            if canSend {
                Button(action: submit) {
                    Image(systemName: "arrow.up")
                        .font(.system(size: 15, weight: .bold))
                        .foregroundStyle(.white)
                        .frame(width: 30, height: 30)
                        .background(Circle().fill(JoriTheme.cobalt))
                }
                .buttonStyle(PressableStyle(pressedScale: 0.85))
                #if os(iOS)
                // Hardware keyboards: ⌘Return sends, plain Return stays a newline.
                .keyboardShortcut(.return, modifiers: .command)
                #endif
                .padding(5)
                .transition(.scale(scale: 0.3).combined(with: .opacity))
                .accessibilityLabel("Send")
            }
        }
        .frame(minHeight: 40)
        .glassSurface(in: shape)
        .overlay(
            shape.strokeBorder(JoriTheme.cobalt.opacity(isActive ? 0.45 : 0), lineWidth: 1)
        )
        .animation(.spring(response: 0.3, dampingFraction: 0.72), value: canSend)
        .animation(.easeOut(duration: 0.2), value: isActive)
        .sensoryFeedback(.impact(weight: .light), trigger: sendTick)
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { ChatViewModel.saveDraft(text) } // persist on background
        }
    }
}

#if os(macOS)

/// Native macOS input field: NSTextView that sends on Return, inserts a
/// newline on Option+Return, and grows from 1 up to 5 lines with a
/// placeholder overlay handled in SwiftUI.
private struct MacMessageField: View {
    @Binding var text: String
    var placeholder: String
    @Binding var isFocused: Bool
    var onSend: () -> Void
    @State private var textHeight: CGFloat = 20

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(.system(size: 16))
                    .foregroundStyle(Color(NSColor.placeholderTextColor))
                    .allowsHitTesting(false)
                    .padding(.top, 1)
            }
            MacTextViewRepresentable(
                text: $text,
                isFocused: $isFocused,
                onSend: onSend,
                desiredHeight: $textHeight
            )
            .frame(height: textHeight)
        }
    }
}

/// NSTextView subclass that intercepts Return at the keyDown level (more
/// reliable than doCommandBy: for detecting Option/Shift modifiers). Plain
/// Return calls `onSend`; Option+Return and Shift+Return insert a newline.
private final class MacSendTextView: NSTextView {
    var onSend: (() -> Void)?

    override func keyDown(with event: NSEvent) {
        // keyCode 36 = Return, 76 = Enter (numeric keypad)
        if event.keyCode == 36 || event.keyCode == 76 {
            let mods = event.modifierFlags
            if mods.contains(.option) || mods.contains(.shift) || mods.contains(.command) {
                insertNewline(nil)  // insert newline
            } else {
                onSend?()
            }
            return
        }
        super.keyDown(with: event)
    }
}

private struct MacTextViewRepresentable: NSViewRepresentable {
    @Binding var text: String
    @Binding var isFocused: Bool
    var onSend: () -> Void
    @Binding var desiredHeight: CGFloat

    private static let maxLines: CGFloat = 5

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.drawsBackground = false
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.borderType = .noBorder

        let textView = MacSendTextView()
        textView.delegate = context.coordinator
        textView.isEditable = true
        textView.isSelectable = true
        textView.allowsUndo = true
        textView.isRichText = false
        textView.font = NSFont.systemFont(ofSize: 16)
        textView.insertionPointColor = NSColor(JoriTheme.cobalt)
        textView.drawsBackground = false
        textView.backgroundColor = .clear
        textView.textContainerInset = NSSize(width: 0, height: 0)
        textView.textContainer?.lineFragmentPadding = 0
        textView.minSize = NSSize(width: 0, height: 0)
        textView.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        textView.isVerticallyResizable = true
        textView.isHorizontallyResizable = false
        textView.autoresizingMask = [.width]
        textView.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        textView.textContainer?.widthTracksTextView = true
        textView.onSend = { [weak coordinator = context.coordinator] in
            coordinator?.parent.onSend()
        }

        scrollView.documentView = textView
        context.coordinator.textView = textView

        // Compute initial single-line height.
        if let font = textView.font, let lm = textView.layoutManager {
            let lineH = lm.defaultLineHeight(for: font)
            DispatchQueue.main.async { self.desiredHeight = ceil(lineH) }
        }

        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        guard let textView = scrollView.documentView as? MacSendTextView else { return }
        context.coordinator.parent = self

        if textView.string != text {
            textView.string = text
            if text.isEmpty {
                // Reset to single-line height immediately — layout manager
                // hasn't re-laid out yet so recalcHeight would keep the old size.
                if let font = textView.font, let lm = textView.layoutManager {
                    let lineH = ceil(lm.defaultLineHeight(for: font))
                    if abs(desiredHeight - lineH) > 0.5 {
                        DispatchQueue.main.async { self.desiredHeight = lineH }
                    }
                }
            } else {
                context.coordinator.recalcHeight()
            }
        }

        if isFocused,
           textView.window != nil,
           textView.window?.firstResponder !== textView {
            DispatchQueue.main.async {
                textView.window?.makeFirstResponder(textView)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MacTextViewRepresentable
        weak var textView: MacSendTextView?

        init(_ parent: MacTextViewRepresentable) {
            self.parent = parent
        }

        func recalcHeight() {
            guard let tv = textView,
                  let lm = tv.layoutManager,
                  let container = tv.textContainer,
                  let font = tv.font else { return }
            lm.ensureLayout(for: container)
            let usedHeight = lm.usedRect(for: container).height
            let lineHeight = lm.defaultLineHeight(for: font)
            let maxHeight = ceil(lineHeight * MacTextViewRepresentable.maxLines)
            let newHeight = min(max(ceil(usedHeight), ceil(lineHeight)), maxHeight)
            if abs(newHeight - parent.desiredHeight) > 0.5 {
                parent.desiredHeight = newHeight
            }
        }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
            recalcHeight()
        }

        func textDidBeginEditing(_ notification: Notification) {
            if !parent.isFocused {
                parent.isFocused = true
            }
        }

        func textDidEndEditing(_ notification: Notification) {
            if parent.isFocused {
                parent.isFocused = false
            }
        }
    }
}

#endif

#Preview {
    ContentView()
}


// MARK: - Open questions tray

/// The questions still waiting for an answer in this channel, pinned at the
/// bottom of the stream above the composer so what is open is always in view,
/// however far the flow of messages has pushed the question itself. Tap a row
/// to jump to the question; Answer opens a reply to it; the x dismisses it
/// (a silent reply the server closes in code — see ChatViewModel.dismissQuestion).
struct OpenQuestionsTray: View {
    let questions: [Message]
    var reveal: (Message) -> Void
    var answer: (Message) -> Void
    var dismiss: (Message) -> Void
    /// A tapped option: the same pre-composed reply a tap on the card sends.
    var select: (ChoiceOption, Message) -> Void
    @AppStorage(Install.key("openQuestionsTrayExpanded")) private var expanded = true

    var body: some View {
        if !questions.isEmpty {
            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "sparkle")
                        Text(questions.count == 1 ? "1 open question" : "\(questions.count) open questions")
                        Spacer(minLength: 0)
                        Image(systemName: expanded ? "chevron.down" : "chevron.up")
                    }
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(JoriTheme.staffInk)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if expanded {
                    ScrollView {
                        VStack(spacing: 0) {
                            ForEach(questions) { q in
                                Divider().overlay(JoriTheme.hairline)
                                row(q)
                            }
                        }
                    }
                    .frame(maxHeight: 280)
                    .fixedSize(horizontal: false, vertical: questions.count <= 3)
                }
            }
            .background(JoriTheme.staffWash, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).stroke(JoriTheme.staff.opacity(0.35), lineWidth: 0.5))
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    private func row(_ q: Message) -> some View {
        // A question that carries tappable options (a decision card, a choice
        // prompt) is answered by tapping one right here. The "Answer" button
        // alone only opens a typed reply, so a card scrolled out of view used to
        // be answerable only in words (2026-11-10: a "stay in touch?" card).
        let options = ChoicePrompt.from(metadata: q.metadata)?.options ?? []
        return VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Button { reveal(q) } label: {
                    Text(Self.headline(q.content))
                        .font(.subheadline)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Button(options.isEmpty ? "Answer" : "Type") { answer(q) }
                    .font(.caption.weight(.semibold))
                    .buttonStyle(.borderless)
                    .foregroundStyle(JoriTheme.staffInk)
                Button { dismiss(q) } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss question")
            }
            ForEach(options) { option in
                Button { select(option, q) } label: {
                    Text(option.label)
                        .font(.callout.weight(.medium))
                        .multilineTextAlignment(.leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Color.primary.opacity(0.06), in: RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                        .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                }
                .buttonStyle(PressableStyle())
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
    }

    /// The line worth showing: our own card formatting (a `❓ Title` header,
    /// bold markers) stripped, and the first line that asks something preferred.
    static func headline(_ content: String) -> String {
        let lines = content
            .split(whereSeparator: \.isNewline)
            .map { $0.replacingOccurrences(of: "**", with: "").replacingOccurrences(of: "❓", with: "").trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        return lines.first(where: { $0.contains("?") }) ?? lines.first ?? content
    }
}
