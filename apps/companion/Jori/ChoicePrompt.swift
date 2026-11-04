import SwiftUI
import MapKit

/// A tappable multiple-choice question attached to a Jori message.
///
/// Generic by design: any use case, not only location questions.
///
/// WHY THE TAP IS JUST A PRE-COMPOSED REPLY. Choosing an option inserts an
/// ordinary `role:user` message carrying the option's label, with `reply_to`
/// pointing at the question. Nothing downstream learns a new protocol: the
/// phone-channel subscription, the chat-agent's reply handling and the whole
/// `findme resolve` path treat it exactly as they treat typed text. That is what
/// makes this generic rather than a location feature — a new use case needs only
/// to attach `metadata.choices` and to understand the words that come back.
///
/// WHY `metadata` AND NOT A NEW COLUMN. `jori_messages.metadata` is already
/// `jsonb`, and the Swift model decodes it as `[String: String]`, so the prompt
/// rides as a JSON string under one key. No migration, and an older build that
/// has never heard of choices simply renders the message text — which is written
/// to stand on its own for exactly that reason.
///
/// ANSWERED STATE IS DERIVED, NEVER STORED. A question counts as answered when a
/// user message replying to it exists. That needs no write-back, survives a
/// reinstall, and is automatically consistent across devices — two phones cannot
/// disagree about whether the user tapped, because they are both reading the same
/// reply.

struct ChoiceOption: Codable, Identifiable, Equatable {
    let id: String
    let label: String
    var sublabel: String?
}

/// What a question is ABOUT — so the user can tell at a glance whether it asks about
/// a place, a walk or drive, or an event, and when: a location question has
/// to make clear whether it asks about a route, a specific place or an event.
///
/// Optional and additive: a prompt without it renders exactly as before, and an
/// older build ignores the key (Codable skips unknown keys) and shows the
/// message text, which still stands on its own.
struct ChoiceSubject: Codable, Equatable {
    /// "place" | "route" | "event". Unknown values draw as a place.
    let kind: String
    /// For a route: "walking" | "driving".
    var mode: String?
    /// ISO timestamps, kept as strings for the same reason as `expiresAt`.
    var start: String?
    var end: String?
    /// Their zone when it happened — times read in the place they happened.
    var tz: String?
    var ongoing: Bool?
    var lat: Double?
    var lon: Double?
    var mapUrl: String?
    /// The trace behind the map picture, for the full-screen interactive map
    /// (stop-map --json): where the user came from, the stretch itself, where the user went.
    var path: SubjectPath?
    /// One line of where: "around <street>, after <the previous stop>".
    var context: String?
    /// The bare question; the card draws time and place itself.
    var question: String?

    enum CodingKeys: String, CodingKey {
        case kind, mode, start, end, tz, ongoing, lat, lon, path, context, question
        case mapUrl = "map_url"
    }
}

/// [[lat, lon], …] runs, as stop-map draws them.
struct SubjectPath: Codable, Equatable {
    var stop: [Double]?
    var before: [[Double]]?
    var during: [[Double]]?
    var after: [[Double]]?
}

struct ChoicePrompt: Codable, Equatable {
    /// Contract version. An unknown version renders nothing rather than
    /// guessing — a stale build must degrade to plain text, never to a
    /// mis-drawn question that files the wrong answer.
    var v: Int = 1
    let id: String
    /// Free-form routing tag (`location_stop`, …). The client does not
    /// interpret it; it exists so the answering side knows what it answered.
    let kind: String
    /// What the question is about — a visit id, a task id, whatever `kind` implies.
    var ref: String?
    var prompt: String?
    let options: [ChoiceOption]
    /// Applied server-side if the user never answers. The client shows it as the
    /// suggested option; it does NOT auto-tap, because a default applied by the
    /// UI would be indistinguishable from a real answer — and because a default
    /// is provisional: the user can still tap later and override it.
    var defaultId: String?
    /// Kept as a STRING, not a Date, and that is load-bearing.
    ///
    /// `JSONDecoder.dateDecodingStrategy = .iso8601` uses ISO8601DateFormatter
    /// with `.withInternetDateTime` only — it REJECTS fractional seconds. Every
    /// prompt the server sends carries them (`…T02:24:13.416572+00:00`, straight
    /// from Postgres), so the whole ChoicePrompt failed to decode and every
    /// question rendered as plain text with no buttons. The `try?` that keeps a
    /// malformed prompt from taking the message down with it also swallowed the
    /// error, so it looked like the feature simply had not shipped.
    ///
    /// The client never computes with this value — expiry is the sweeper's job
    /// server-side — so parsing it here bought nothing and cost the feature.
    var expiresAt: String?
    /// See ChoiceSubject. When present the card is self-contained and the
    /// bubble does not repeat the message text above it.
    var subject: ChoiceSubject?
    /// Decision cards (`kind == "decision"`, 2026-10-22): the short topic chip
    /// over the question, the option Jori recommends (drawn first and marked
    /// "(Recommended)"), and whether to offer a final "Type something" row.
    /// Additive and optional — an older build ignores them and still draws the
    /// options as plain buttons under the message text, which stands alone.
    var header: String?
    var recommendedId: String?
    var freeText: Bool?

    enum CodingKeys: String, CodingKey {
        case v, id, kind, ref, prompt, options, subject, header
        case defaultId = "default_id"
        case expiresAt = "expires_at"
        case recommendedId = "recommended_id"
        case freeText = "free_text"
    }

    /// A decision waiting on the user (hum `decisions` lane, bin/decision-ask).
    var isDecision: Bool { kind == "decision" }

    static let metadataKey = "choices"
    static let supportedVersion = 1

    /// Decode from a message's metadata. Returns nil on anything unexpected —
    /// a malformed prompt must not take the message down with it.
    static func from(metadata: [String: String]?) -> ChoicePrompt? {
        guard let raw = metadata?[metadataKey],
              let data = raw.data(using: .utf8) else { return nil }
        // No date strategy: nothing in the payload decodes to a Date any more.
        guard let p = try? JSONDecoder().decode(ChoicePrompt.self, from: data) else { return nil }
        // A card with a subject may carry no buttons — the user answers by typing
        // a reply; the card is there to make plain what is being asked.
        guard p.v == supportedVersion, !p.options.isEmpty || p.subject != nil else { return nil }
        return p
    }
}

// MARK: - View

struct ChoicePromptView: View {
    let prompt: ChoicePrompt
    /// Nil until the user taps; set from the reply that already exists, so a relaunch
    /// shows the answered state without any local persistence.
    let answeredLabel: String?
    /// A default the server applied because the user never answered in time.
    ///
    /// Deliberately NOT the same thing as an answer: the user can return to a
    /// missed question after a default was applied and answer differently, and
    /// that tap overrides the default however late it comes. So a default is shown as a provisional
    /// mark and leaves every option live — the question stays askable forever,
    /// and a late tap supersedes it. Locking on a default would make being busy
    /// permanent, which is the opposite of what defaulting is for.
    var defaultAppliedLabel: String? = nil
    let onSelect: (ChoiceOption) -> Void

    /// Only THEIR tap closes the question.
    private var isAnswered: Bool { answeredLabel != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let subject = prompt.subject {
                SubjectHeader(subject: subject)
                    .padding(.bottom, 4)
            }
            if let text = prompt.subject?.question ?? prompt.prompt, !text.isEmpty {
                Text(text)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .padding(.bottom, 2)
            }
            if prompt.options.isEmpty && prompt.subject != nil && !isAnswered {
                Label("Reply to this message to answer", systemImage: "arrowshape.turn.up.left")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            ForEach(prompt.options) { option in
                Button {
                    guard !isAnswered else { return }
                    onSelect(option)
                } label: {
                    HStack(spacing: 8) {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label)
                                .font(.callout.weight(.medium))
                                .multilineTextAlignment(.leading)
                            if let sub = option.sublabel, !sub.isEmpty {
                                Text(sub)
                                    .font(.caption2)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 4)
                        if chosen(option) {
                            Image(systemName: "checkmark.circle.fill")
                                .foregroundStyle(.tint)
                                .transition(.scale(scale: 0.3).combined(with: .opacity))
                        } else if isDefaultApplied(option) {
                            // Recorded, still overridable — hence a dotted mark
                            // and secondary colour rather than the solid tick an
                            // answer of their own gets.
                            Image(systemName: "checkmark.circle.dotted")
                                .foregroundStyle(.secondary)
                        } else if !isAnswered && option.id == prompt.defaultId {
                            // Marked, not pre-selected: the user should be able to see
                            // what silence will record without that looking like
                            // an answer the user already gave.
                            Text("default")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(
                        RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
                            .fill(chosen(option) ? Color.accentColor.opacity(0.14)
                                  : isDefaultApplied(option) ? Color.primary.opacity(0.10)
                                  : Color.primary.opacity(0.06))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
                            .strokeBorder(chosen(option) ? Color.accentColor.opacity(0.5)
                                                         : Color.clear, lineWidth: 1)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                    .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                }
                .buttonStyle(PressableStyle())
                // Dimming only the ones the user did NOT pick keeps their own answer
                // legible after the fact; greying the whole block would make the
                // record of what the user said harder to read than the question was.
                .opacity(isAnswered && !chosen(option) ? 0.45 : 1.0)
                .disabled(isAnswered)
            }
        }
        .padding(.top, 2)
        .animation(.spring(response: 0.32, dampingFraction: 0.8), value: answeredLabel)
        .sensoryFeedback(.selection, trigger: answeredLabel) { _, new in new != nil }
    }

    private func chosen(_ option: ChoiceOption) -> Bool {
        matches(answeredLabel, option)
    }

    /// True for the option a server-side default recorded — provisional, and
    /// only while the user has not since answered themselves.
    private func isDefaultApplied(_ option: ChoiceOption) -> Bool {
        !isAnswered && matches(defaultAppliedLabel, option)
    }

    private func matches(_ label: String?, _ option: ChoiceOption) -> Bool {
        guard let label else { return false }
        return label.compare(option.label,
                             options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
    }
}

// MARK: - Decision card

/// A decision Jori needs from the user, drawn like Claude Code's multiple-choice
/// prompt, in the question colour and with a recommended option: a short header chip, the question in bold, numbered
/// options each with a one-line label and a grey description, the recommended
/// one first and labelled "(Recommended)", and a last "Type something" row that
/// opens a threaded reply for an answer in their own words. The bubble behind it
/// is the question yellow (ContentView).
///
/// A tap is the same pre-composed reply as any choice (the option's label,
/// threaded to the card); the server files it against the decision in code
/// (lib/choice-reply.mjs → decision-answer).
struct DecisionCardView: View {
    let prompt: ChoicePrompt
    /// Whatever the user replied to the card — a tapped label or their own words.
    let answeredLabel: String?
    let onSelect: (ChoiceOption) -> Void
    let onTypeSomething: () -> Void

    private var isAnswered: Bool { answeredLabel != nil }

    /// The server already sends the recommended option first; this keeps it
    /// first even if a sender did not.
    private var ordered: [ChoiceOption] {
        guard let rec = prompt.recommendedId,
              let i = prompt.options.firstIndex(where: { $0.id == rec }) else { return prompt.options }
        var o = prompt.options
        let r = o.remove(at: i)
        return [r] + o
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = prompt.header, !header.isEmpty {
                Label(header, systemImage: "sparkle")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(JoriTheme.staffInk)
                    .padding(.horizontal, 9)
                    .padding(.vertical, 4)
                    .background(Capsule().fill(JoriTheme.staff.opacity(0.18)))
            }
            if let q = prompt.prompt, !q.isEmpty {
                Text(q)
                    .font(.body.weight(.semibold))
                    .foregroundStyle(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(Array(ordered.enumerated()), id: \.element.id) { index, option in
                Button {
                    guard !isAnswered else { return }
                    onSelect(option)
                } label: {
                    row(number: index + 1,
                        label: option.label,
                        recommended: option.id == prompt.recommendedId,
                        description: option.sublabel,
                        chosen: chosen(option))
                }
                .buttonStyle(PressableStyle())
                .opacity(isAnswered && !chosen(option) ? 0.45 : 1.0)
                .disabled(isAnswered)
            }
            if prompt.freeText == true {
                Button {
                    guard !isAnswered else { return }
                    onTypeSomething()
                } label: {
                    row(number: ordered.count + 1, label: "Type something", recommended: false,
                        description: nil, chosen: false, systemImage: "pencil")
                }
                .buttonStyle(PressableStyle())
                .opacity(isAnswered ? 0.45 : 1.0)
                .disabled(isAnswered)
            }
            if let answer = answeredLabel, !ordered.contains(where: { chosen($0) }) {
                Label("You answered: \(answer)", systemImage: "checkmark.circle.fill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, 2)
        .animation(.spring(response: 0.32, dampingFraction: 0.8), value: answeredLabel)
        .sensoryFeedback(.selection, trigger: answeredLabel) { _, new in new != nil }
    }

    private func row(number: Int, label: String, recommended: Bool, description: String?,
                     chosen: Bool, systemImage: String? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text("\(number)")
                .font(.caption.monospacedDigit().weight(.bold))
                .foregroundStyle(recommended && !isAnswered ? JoriTheme.staffInk : Color.secondary)
                .frame(width: 22, height: 22)
                .background(Circle().fill(recommended && !isAnswered ? JoriTheme.staff.opacity(0.22) : Color.primary.opacity(0.07)))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    if let systemImage {
                        Image(systemName: systemImage).font(.caption)
                    }
                    (Text(label).font(.callout.weight(.medium))
                     + (recommended ? Text("  Recommended").font(.caption.weight(.semibold)).foregroundColor(JoriTheme.staffInk) : Text("")))
                        .multilineTextAlignment(.leading)
                }
                if let d = description, !d.isEmpty {
                    Text(d)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 4)
            if chosen {
                Image(systemName: "checkmark.circle.fill").foregroundStyle(.tint)
                    .transition(.scale(scale: 0.3).combined(with: .opacity))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
                .fill(chosen ? Color.accentColor.opacity(0.14)
                      : recommended && !isAnswered ? JoriTheme.staff.opacity(0.14)
                      : Color.primary.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: Radius.row, style: .continuous)
                .strokeBorder(chosen ? Color.accentColor.opacity(0.5)
                              : recommended && !isAnswered ? JoriTheme.staff.opacity(0.55)
                              : Color.clear, lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
        .contentShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
    }

    private func chosen(_ option: ChoiceOption) -> Bool {
        guard let a = answeredLabel else { return false }
        return a.compare(option.label, options: [.caseInsensitive, .diacriticInsensitive]) == .orderedSame
    }
}

// MARK: - Subject header

/// The top of a location card: the map, with what kind of thing this is and
/// when it happened laid over it. The map is the one bold element — it answers
/// "which stretch of my day is this?" before a word is read.
private struct SubjectHeader: View {
    let subject: ChoiceSubject
    @State private var showMap = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let s = subject.mapUrl, let url = URL(string: s) {
                // Badge top-left: the PNG's own footer (time + route/stop
                // legend) runs along the bottom and a bottom badge covered it.
                ZStack(alignment: .topLeading) {
                    AsyncImage(url: url) { phase in
                        switch phase {
                        case .success(let image):
                            image.resizable().scaledToFill()
                        case .failure:
                            style.tint.opacity(0.12)
                        default:
                            Color.primary.opacity(0.06).overlay(ProgressView())
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .aspectRatio(1.25, contentMode: .fit)
                    .clipped()
                    badge
                        .padding(8)
                }
                .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                .overlay(alignment: .topTrailing) {
                    // Says the picture opens — a map in a chat bubble otherwise
                    // reads as a static image.
                    Image(systemName: "arrow.up.left.and.arrow.down.right")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(.secondary)
                        .padding(6)
                        .background(.ultraThinMaterial, in: Circle())
                        .padding(8)
                }
                .contentShape(Rectangle())
                .onTapGesture { showMap = true }
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isButton)
                .accessibilityHint("Opens a full-screen map")
                #if os(iOS)
                .fullScreenCover(isPresented: $showMap) { SubjectMapView(subject: subject) }
                #else
                .sheet(isPresented: $showMap) { SubjectMapView(subject: subject).frame(minWidth: 640, minHeight: 520) }
                #endif
            } else {
                badge
            }
            if let context = subject.context, !context.isEmpty {
                Text(context.prefix(1).uppercased() + context.dropFirst())
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Kind and time, on frosted glass over the map's top-left so it reads on any
    /// tiles and leaves the image's footer legend clear.
    private var badge: some View {
        TimelineView(.periodic(from: .now, by: 60)) { ctx in
            HStack(spacing: 8) {
                Image(systemName: style.symbol)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(style.tint))
                VStack(alignment: .leading, spacing: 0) {
                    Text(style.title)
                        .font(.footnote.weight(.semibold))
                    Text(SubjectTime.describe(subject, now: ctx.date))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .monospacedDigit()
                }
            }
            .padding(.vertical, 6)
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .background(.ultraThinMaterial, in: Capsule())
        }
    }

    private var style: SubjectStyle { SubjectStyle(subject) }

}

/// Each kind wears the colour it has on the map image, so the badge and the
/// trace agree: the stop pin is rust, a walk green, a drive blue.
struct SubjectStyle {
    let title: String
    let symbol: String
    let tint: Color

    init(_ s: ChoiceSubject) {
        switch (s.kind, s.mode) {
        case ("route", "driving"):
            title = "Drive"; symbol = "car.fill"
            tint = Color(red: 0x3B / 255.0, green: 0x5F / 255.0, blue: 0x9E / 255.0)
        case ("route", _):
            title = "Walk"; symbol = "figure.walk"
            tint = Color(red: 0x2F / 255.0, green: 0x7D / 255.0, blue: 0x5B / 255.0)
        case ("event", _):
            title = "Event"; symbol = "calendar"
            tint = Color(red: 0x7A / 255.0, green: 0x4F / 255.0, blue: 0xA3 / 255.0)
        default:
            title = "Place"; symbol = "mappin"
            tint = Color(red: 0xC2 / 255.0, green: 0x62 / 255.0, blue: 0x2C / 255.0)
        }
    }
}

/// The time line, written for the moment the user READS it, not when it was sent:
/// "Now, since 17:25" / "17:25–18:05, ended 12 min ago" / "Today 17:25–18:05" /
/// "Yesterday …" / "Mon …". Times are shown in the zone it happened in.
enum SubjectTime {
    static func parse(_ s: String?) -> Date? {
        guard let s else { return nil }
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    static func describe(_ s: ChoiceSubject, now: Date) -> String {
        guard let start = parse(s.start) else { return "" }
        let end = parse(s.end)
        let tz = s.tz.flatMap(TimeZone.init(identifier:)) ?? .current
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = tz
        let hm = DateFormatter()
        hm.timeZone = tz
        hm.dateFormat = "HH:mm"
        if s.ongoing == true {
            return "Now, since \(hm.string(from: start))"
        }
        let span: String = {
            guard let end, end.timeIntervalSince(start) >= 60 else { return hm.string(from: start) }
            let mins = Int(end.timeIntervalSince(start) / 60)
            let dur = mins >= 60 ? "\(mins / 60)h \(mins % 60)m" : "\(mins) min"
            return "\(hm.string(from: start))–\(hm.string(from: end)) (\(dur))"
        }()
        let ref = end ?? start
        let ago = Int(now.timeIntervalSince(ref) / 60)
        if ago >= 0 && ago < 60 {
            return ago < 2 ? "\(span), just now" : "\(span), ended \(ago) min ago"
        }
        if cal.isDate(start, inSameDayAs: now) { return "Today \(span)" }
        if let y = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(start, inSameDayAs: y) {
            return "Yesterday \(span)"
        }
        let day = DateFormatter()
        day.timeZone = tz
        day.dateFormat = "EEE d MMM"
        return "\(day.string(from: start)) \(span)"
    }
}

// MARK: - Full-screen map

/// Tap the card's map: the same stretch on a live map the user can pinch, pan and
/// rotate — tapping the map opens a full-page map with zoom. Drawn from the trace (subject.path), styled like the
/// picture — grey in, the kind's colour for the stretch itself, dashed grey
/// out, the pin where the user stopped — so the two read as one map at two sizes.
struct SubjectMapView: View {
    let subject: ChoiceSubject
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var position: MapCameraPosition = .automatic

    private var style: SubjectStyle { SubjectStyle(subject) }
    private func open(_ s: String) { if let url = URL(string: s) { openURL(url) } }

    /// A walk or drive opens in Google Maps as the ROUTE, not a pin.
    /// Google's Maps URL takes an origin, a destination and up to nine
    /// waypoints, and re-routes through them on its own streets — so the trace
    /// is sampled to its two ends plus 8 evenly spaced points, which is enough
    /// to pin the shape of a walk without exceeding what the app accepts.
    /// Places and events are a spot, so they stay a pin.
    private func googleMapsURL(stop: CLLocationCoordinate2D) -> String {
        let pin = "https://www.google.com/maps/search/?api=1&query=\(stop.latitude),\(stop.longitude)"
        guard subject.kind == "route" else { return pin }
        let p = subject.path
        let full = coords(p?.before) + coords(p?.during) + coords(p?.after)
        guard full.count >= 2, let first = full.first, let last = full.last else { return pin }
        let fmt = { (c: CLLocationCoordinate2D) in String(format: "%.6f,%.6f", c.latitude, c.longitude) }
        let interior = Array(full.dropFirst().dropLast())
        let n = min(8, interior.count)
        let way: [CLLocationCoordinate2D] = n == 0 ? [] : (0..<n).map {
            interior[Int((Double($0) + 0.5) * Double(interior.count) / Double(n))]
        }
        // Built by hand: the waypoint separator must be sent as %7C — a raw
        // "|" makes URL(string:) return nil and the tap silently does nothing.
        let mode = subject.mode == "driving" ? "driving" : "walking"
        var url = "https://www.google.com/maps/dir/?api=1&origin=\(fmt(first))&destination=\(fmt(last))&travelmode=\(mode)"
        if !way.isEmpty { url += "&waypoints=" + way.map(fmt).joined(separator: "%7C") }
        return url
    }
    private static let grey = Color(red: 0x9A / 255.0, green: 0x98 / 255.0, blue: 0x8F / 255.0)

    private func coords(_ runs: [[Double]]?) -> [CLLocationCoordinate2D] {
        (runs ?? []).compactMap { $0.count >= 2 ? CLLocationCoordinate2D(latitude: $0[0], longitude: $0[1]) : nil }
    }
    private var stop: CLLocationCoordinate2D? {
        if let p = subject.path?.stop, p.count >= 2 { return .init(latitude: p[0], longitude: p[1]) }
        if let lat = subject.lat, let lon = subject.lon { return .init(latitude: lat, longitude: lon) }
        return nil
    }

    var body: some View {
        let before = coords(subject.path?.before)
        let during = coords(subject.path?.during)
        let after = coords(subject.path?.after)
        NavigationStack {
            Map(position: $position) {
                if before.count > 1 {
                    MapPolyline(coordinates: before)
                        .stroke(Self.grey, style: StrokeStyle(lineWidth: 4, lineCap: .round, lineJoin: .round))
                }
                if after.count > 1 {
                    MapPolyline(coordinates: after)
                        .stroke(Self.grey, style: StrokeStyle(lineWidth: 4, lineCap: .round, dash: [2, 8]))
                }
                if during.count > 1 {
                    MapPolyline(coordinates: during)
                        .stroke(style.tint, style: StrokeStyle(lineWidth: 6, lineCap: .round, lineJoin: .round))
                }
                if let first = before.first {
                    Annotation("", coordinate: first) {
                        Circle().fill(.white)
                            .overlay(Circle().stroke(Self.grey, lineWidth: 3))
                            .frame(width: 12, height: 12)
                    }
                }
                if let stop {
                    Marker(style.title, systemImage: style.symbol, coordinate: stop)
                        .tint(style.tint)
                }
            }
            .mapStyle(.standard(pointsOfInterest: .including([.cafe, .restaurant, .bakery, .park, .beach, .store])))
            .mapControls {
                MapCompass()
                MapScaleView()
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .principal) {
                    VStack(spacing: 0) {
                        Text(style.title).font(.headline)
                        TimelineView(.periodic(from: .now, by: 60)) { ctx in
                            Text(SubjectTime.describe(subject, now: ctx.date))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                        }
                    }
                }
                if let stop {
                    ToolbarItem(placement: .primaryAction) {
                        // Hand off to whichever maps app the user uses. iOS exposes
                        // no "default maps app", so both are offered. The
                        // Google link is a universal link: the Google Maps app
                        // when installed, the web otherwise.
                        Menu {
                            Button {
                                open("https://maps.apple.com/?ll=\(stop.latitude),\(stop.longitude)&q=\(style.title)")
                            } label: { Label("Apple Maps", systemImage: "map") }
                            Button {
                                open(googleMapsURL(stop: stop))
                            } label: { Label("Google Maps", systemImage: "globe") }
                        } label: {
                            Label("Open in", systemImage: "arrow.up.forward.app")
                        }
                    }
                }
            }
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            .toolbarBackground(.visible, for: .navigationBar)
            #endif
        }
    }
}

// MARK: - Checklist

/// A tappable checklist attached to a Jori message (`metadata.checklist`, a
/// JSON string, like `choices`).
///
/// For lists the user works through (a meeting agenda): items that are done
/// or no longer relevant are ticked off.
///
/// Same contract as choices: a tap is an ordinary user reply to the message —
/// `✓ <label>` ticks, `↩ <label>` unticks — so the server files it in code
/// (lib/choice-reply.mjs) and the ticked state is derived from replies,
/// identical on every device. Those replies are hidden from the thread; the box
/// is the confirmation. An older build ignores the key and shows the text.
struct Checklist: Codable, Equatable {
    struct Item: Codable, Equatable {
        let label: String
    }
    var v: Int = 1
    let kind: String
    var title: String?
    /// How many items show before a tappable "+N more".
    var fold: Int?
    let items: [Item]

    static let metadataKey = "checklist"
    static let check = "✓ "
    static let uncheck = "↩ "

    static func from(metadata: [String: String]?) -> Checklist? {
        guard let raw = metadata?[metadataKey], let data = raw.data(using: .utf8),
              let c = try? JSONDecoder().decode(Checklist.self, from: data),
              c.v == 1, !c.items.isEmpty else { return nil }
        return c
    }

    /// The label a tick/untick reply carries, and which way it went.
    static func toggle(in content: String) -> (label: String, checked: Bool)? {
        if content.hasPrefix(check) { return (String(content.dropFirst(check.count)), true) }
        if content.hasPrefix(uncheck) { return (String(content.dropFirst(uncheck.count)), false) }
        return nil
    }
}

struct ChecklistView: View {
    let checklist: Checklist
    let checked: Set<String>
    let onToggle: (String, Bool) -> Void
    @State private var expanded = false

    var body: some View {
        let fold = min(checklist.fold ?? checklist.items.count, checklist.items.count)
        let shown = expanded ? checklist.items : Array(checklist.items.prefix(fold))
        VStack(alignment: .leading, spacing: 8) {
            ForEach(shown, id: \.label) { item in
                let on = checked.contains(item.label)
                Button {
                    onToggle(item.label, !on)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Image(systemName: on ? "checkmark.circle.fill" : "circle")
                            .foregroundStyle(on ? JoriTheme.confirmed : Color.secondary)
                            .contentTransition(.symbolEffect(.replace))
                        Text(item.label)
                            .strikethrough(on, color: .secondary)
                            .foregroundStyle(on ? Color.secondary : Color.primary)
                            .multilineTextAlignment(.leading)
                    }
                    .font(.system(size: JoriFontSize.body))
                    .padding(.vertical, 2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                    .animation(.snappy(duration: 0.25), value: on)
                }
                .buttonStyle(PressableStyle(pressedScale: 0.98))
                .sensoryFeedback(.selection, trigger: on)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            if checklist.items.count > fold {
                Button {
                    withAnimation(.easeInOut(duration: 0.2)) { expanded.toggle() }
                } label: {
                    Label(expanded ? "Show less" : "+\(checklist.items.count - fold) more",
                          systemImage: expanded ? "chevron.up" : "chevron.down")
                        .font(.system(size: JoriFontSize.body, weight: .medium))
                }
                .buttonStyle(.borderless)
            }
        }
    }
}
