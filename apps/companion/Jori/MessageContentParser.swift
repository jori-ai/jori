import Foundation

enum MessageSegment: Equatable {
    case markdown(String)
    case inlineImage(URL)
    case linkPreview(URL)

    static func == (lhs: MessageSegment, rhs: MessageSegment) -> Bool {
        switch (lhs, rhs) {
        case (.markdown(let a), .markdown(let b)): return a == b
        case (.inlineImage(let a), .inlineImage(let b)): return a == b
        case (.linkPreview(let a), .linkPreview(let b)): return a == b
        default: return false
        }
    }
}

struct MessageContentParser {
    private static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "heic"]

    /// Known image hosting domains — URLs from these are always treated as images.
    private static let imageHosts: Set<String> = [
        "i.imgur.com",
        "images.unsplash.com",
        "upload.wikimedia.org",
        "pbs.twimg.com",          // Twitter/X images
        "media.licdn.com",        // LinkedIn images
        "m.media-amazon.com",     // Amazon product images
    ]

    /// URL path/query patterns that indicate an image response.
    private static let imagePathPatterns: [String] = [
        "/photo-",                // Unsplash photo URLs
        "/wikipedia/commons/",    // Wikimedia Commons
        "/wp-content/uploads/",   // WordPress media
    ]

    /// A line `<!-- more: <label> -->` folds a long message: the bubble shows what is above it and a
    /// tappable <label> ("+14 more"); tapping shows the whole message, marker removed. Sent by the
    /// meeting-agenda reminders. Nil when there is no marker or nothing follows it.
    static func fold(_ content: String) -> (head: String, full: String, label: String)? {
        let lines = content.components(separatedBy: "\n")
        guard let i = lines.firstIndex(where: {
            let t = $0.trimmingCharacters(in: .whitespaces)
            return t.hasPrefix("<!-- more") && t.hasSuffix("-->")
        }) else { return nil }
        let rest = lines[(i + 1)...].joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rest.isEmpty else { return nil }
        var label = lines[i].trimmingCharacters(in: .whitespaces).dropFirst("<!-- more".count).dropLast("-->".count)
            .trimmingCharacters(in: .whitespaces)
        if label.hasPrefix(":") { label = String(label.dropFirst()).trimmingCharacters(in: .whitespaces) }
        let head = lines[..<i].joined(separator: "\n")
        // The marker sits between two list chunks; joining with a single newline keeps them one list.
        let full = (Array(lines[..<i]) + Array(lines[(i + 1)...])).joined(separator: "\n")
        return (head, full, label.isEmpty ? "Show more" : label)
    }

    struct Parsed {
        let segments: [MessageSegment]
        /// The whole message when it folds (see `fold`).
        let fullSegments: [MessageSegment]?
        let foldLabel: String
    }

    /// `parse` (and `fold`) for a bubble, remembered per content. A bubble's
    /// view is rebuilt on every hover, palette or list change, and parsing
    /// runs link detection and regexes (ICU) on the main thread each time;
    /// the content of a message never changes.
    static func parsed(_ content: String) -> Parsed {
        let key = ((ShopBrowser.base?.absoluteString ?? "") + "\u{0}" + content) as NSString
        if let hit = parsedCache.object(forKey: key) { return hit.value }
        let value: Parsed
        if let fold = fold(content) {
            value = Parsed(segments: parse(fold.head), fullSegments: parse(fold.full), foldLabel: fold.label)
        } else {
            value = Parsed(segments: parse(content), fullSegments: nil, foldLabel: "")
        }
        parsedCache.setObject(ParsedBox(value), forKey: key)
        return value
    }

    private final class ParsedBox {
        let value: Parsed
        init(_ value: Parsed) { self.value = value }
    }

    private static let parsedCache: NSCache<NSString, ParsedBox> = {
        let c = NSCache<NSString, ParsedBox>()
        c.countLimit = 1000
        return c
    }()

    /// Built once: an NSDataDetector compiles its patterns on creation, and one
    /// was being made for every URL-looking line of every bubble.
    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)

    /// Parse message content into renderable segments.
    /// Standalone URLs on their own line become images or link previews.
    /// Everything else is coalesced into markdown segments.
    static func parse(_ content: String) -> [MessageSegment] {
        let lines = content.components(separatedBy: "\n")
        var segments: [MessageSegment] = []
        var markdownBuffer: [String] = []

        func flushMarkdown() {
            let text = markdownBuffer.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty {
                segments.append(.markdown(text))
            }
            markdownBuffer.removeAll()
        }

        for rawLine in lines {
            // A shop-browser address (an unqualified Tailscale host, which
            // Markdown won't autolink) becomes a tappable link that opens the
            // in-app shop browser (ShopBrowserView.swift).
            let line = linkShopBrowser(rawLine)
            if line != rawLine {
                markdownBuffer.append(line)
                continue
            }
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            // Check if the entire line is a standalone URL, or a 🔗-prefixed URL
            let urlCandidate = stripLinkEmoji(trimmed)
            if let url = standaloneURL(from: urlCandidate) {
                if isImageURL(url) {
                    flushMarkdown()
                    segments.append(.inlineImage(url))
                } else if isPreviewableURL(url) {
                    flushMarkdown()
                    segments.append(.linkPreview(url))
                } else {
                    markdownBuffer.append(line)
                }
            } else if let url = markdownLinkOnOwnLine(from: urlCandidate) {
                // Standalone markdown link like [Name](https://...) on its own line
                // → render as link preview instead of plain markdown
                if isImageURL(url) {
                    flushMarkdown()
                    segments.append(.inlineImage(url))
                } else if isPreviewableURL(url) {
                    flushMarkdown()
                    segments.append(.linkPreview(url))
                } else {
                    markdownBuffer.append(line)
                }
            } else {
                markdownBuffer.append(line)
            }
        }

        flushMarkdown()
        return segments
    }

    /// Bare shop-browser URLs in a line → `[Open the shop browser](url)`.
    /// Ones already inside a markdown link are left alone.
    static func linkShopBrowser(_ line: String) -> String {
        guard let base = ShopBrowser.base,
              let host = base.host, line.contains(host) else { return line }
        guard let re = shopBrowserRegex(for: base) else { return line }
        let range = NSRange(line.startIndex..., in: line)
        return re.stringByReplacingMatches(in: line, range: range, withTemplate: "[Open the shop browser]($0)")
    }

    private static let regexLock = NSLock()
    nonisolated(unsafe) private static var shopRegex: (base: URL, re: NSRegularExpression)?

    /// The shop-browser link pattern, compiled once per base address rather
    /// than once per line.
    private static func shopBrowserRegex(for base: URL) -> NSRegularExpression? {
        regexLock.lock(); defer { regexLock.unlock() }
        if let cached = shopRegex, cached.base == base { return cached.re }
        let root = base.absoluteString.hasSuffix("/") ? String(base.absoluteString.dropLast()) : base.absoluteString
        let pattern = "(?<!\\]\\()" + NSRegularExpression.escapedPattern(for: root) + "(?:/[^\\s)>\\]]*)?"
        guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
        shopRegex = (base, re)
        return re
    }

    /// Strip leading emoji + whitespace prefixes commonly used for link lines (e.g., "🔗 https://...")
    private static func stripLinkEmoji(_ text: String) -> String {
        var s = text
        // Strip leading emoji characters followed by whitespace
        while let first = s.unicodeScalars.first,
              first.properties.isEmoji && first.value > 0x23F, // skip ASCII symbols like #
              !s.isEmpty {
            s = String(s.drop(while: { $0.unicodeScalars.first.map { $0.properties.isEmoji && $0.value > 0x23F } ?? false }))
            s = s.trimmingCharacters(in: .whitespaces)
        }
        return s
    }

    /// Returns a URL if the entire string is a single URL (not markdown link syntax).
    private static func standaloneURL(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty,
              !trimmed.hasPrefix("["),  // markdown link
              !trimmed.hasPrefix("!"),  // markdown image
              !trimmed.hasPrefix("("),
              trimmed.lowercased().hasPrefix("http"),
              let url = URL(string: trimmed),
              url.scheme != nil,
              url.host != nil else {
            return nil
        }

        // Verify the URL spans the entire line (no extra text)
        guard let match = linkDetector?.firstMatch(in: trimmed, range: NSRange(trimmed.startIndex..., in: trimmed)) else {
            return nil
        }
        // The match must cover the full string
        guard match.range.location == 0, match.range.length == trimmed.utf16.count else {
            return nil
        }
        return url
    }

    private static func isImageURL(_ url: URL) -> Bool {
        // 1. Check file extension (works for most direct image links)
        let ext = url.pathExtension.lowercased()
        if imageExtensions.contains(ext) { return true }

        // 2. Check query params for format hints (CDNs like ?format=jpg&w=400)
        if let query = url.query?.lowercased() {
            if query.contains("format=jpg") || query.contains("format=jpeg") ||
               query.contains("format=png") || query.contains("format=webp") {
                return true
            }
        }

        // 3. Known image hosting domains
        if let host = url.host?.lowercased(), imageHosts.contains(host) {
            return true
        }

        // 4. URL path patterns that indicate images
        let absString = url.absoluteString.lowercased()
        for pattern in imagePathPatterns {
            if absString.contains(pattern) { return true }
        }

        // 5. Google Places photo URLs
        if absString.contains("places.googleapis.com") && absString.contains("/media") {
            return true
        }

        // 6. Supabase attachment images
        if absString.contains(Install.attachmentsBucket) {
            return true
        }

        return false
    }

    /// Detect a standalone markdown link `[text](url)` that fills the whole line.
    /// Returns the URL if matched, nil otherwise.
    private static func markdownLinkOnOwnLine(from text: String) -> URL? {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        // Match [anything](https://...)
        guard trimmed.hasPrefix("["),
              let closeBracket = trimmed.firstIndex(of: "]") else {
            return nil
        }
        // Guard against out-of-bounds: `]` may be the last character (e.g.,
        // "[just a bracketed phrase]" — no trailing `(url)`). Accessing one
        // past endIndex crashes with EXC_BREAKPOINT (Swift precondition).
        let afterBracket = trimmed.index(after: closeBracket)
        guard afterBracket < trimmed.endIndex,
              trimmed[afterBracket] == "(" else {
            return nil
        }
        // Extract URL between ( and )
        let rest = trimmed[trimmed.index(after: afterBracket)...]
        guard rest.hasSuffix(")") else { return nil }
        let urlString = String(rest.dropLast())
        guard let url = URL(string: urlString),
              url.scheme != nil,
              url.host != nil else {
            return nil
        }
        return url
    }

    private static func isPreviewableURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased() else { return false }
        return scheme == "http" || scheme == "https"
    }
}
