import Foundation
import ImageIO
import UniformTypeIdentifiers
#if os(iOS)
import UIKit
#endif

/// What the share sheet handed us, normalized into the three shapes Jori's
/// chat already understands: plain text, links, and uploaded attachments.
struct SharedContent {
    struct Attachment: Identifiable {
        let id = UUID()
        let data: Data
        /// The name as shared, for the preview. The storage key is spelled
        /// from it separately (AttachmentKey), since Storage takes only ASCII.
        let filename: String
        let contentType: String
        let thumbnail: CGImage?
        var isImage: Bool { contentType.hasPrefix("image/") }
    }

    var texts: [String] = []
    var urls: [URL] = []
    var attachments: [Attachment] = []

    var isEmpty: Bool { texts.isEmpty && urls.isEmpty && attachments.isEmpty }

    /// Photos are re-encoded to JPEG at this long edge — plenty for Jori to
    /// read, and keeps a 10-photo share inside the extension's memory budget.
    private static let maxImagePixels = 2048
    /// Storage's per-object limit.
    private static let maxFileBytes = 50 * 1024 * 1024

    static func load(from items: [NSExtensionItem]) async -> SharedContent {
        var content = SharedContent()
        for item in items {
            for provider in item.attachments ?? [] {
                await content.add(provider)
            }
            // Safari etc. put the page title here alongside the URL.
            if let title = item.attributedContentText?.string
                .trimmingCharacters(in: .whitespacesAndNewlines),
               !title.isEmpty, !content.texts.contains(title) {
                content.texts.append(title)
            }
        }
        return content
    }

    private mutating func add(_ provider: NSItemProvider) async {
        if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier),
           let image = await Self.loadImage(provider) {
            attachments.append(image)
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
           let url = await Self.loadURL(provider) {
            if url.isFileURL {
                if let file = Self.loadFile(at: url) { attachments.append(file) }
            } else if !urls.contains(url) {
                urls.append(url)
            }
            return
        }
        if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
           let text = await Self.loadText(provider) {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, !texts.contains(trimmed) { texts.append(trimmed) }
            return
        }
        // Anything else (PDFs, documents…) — ship the file as-is.
        if let type = provider.registeredTypeIdentifiers.first,
           let file = await Self.loadFileRepresentation(provider, type: type) {
            attachments.append(file)
        }
    }

    // MARK: - Loading

    /// macOS hosts often hand URLs and text over as raw Data, not objects.
    private static func loadURL(_ provider: NSItemProvider) async -> URL? {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier)
        if let url = item as? URL { return url }
        if let data = item as? Data { return URL(dataRepresentation: data, relativeTo: nil) }
        if let string = item as? String { return URL(string: string) }
        return nil
    }

    private static func loadText(_ provider: NSItemProvider) async -> String? {
        let item = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier)
        if let text = item as? String { return text }
        if let attributed = item as? NSAttributedString { return attributed.string }
        if let data = item as? Data { return String(data: data, encoding: .utf8) }
        return nil
    }

    private static func loadImage(_ provider: NSItemProvider) async -> Attachment? {
        let raw: Data? = await withCheckedContinuation { cont in
            provider.loadDataRepresentation(forTypeIdentifier: UTType.image.identifier) { data, _ in
                cont.resume(returning: data)
            }
        }
        var data = raw
        #if os(iOS)
        // Screenshots shared straight from the markup editor arrive as a
        // UIImage object rather than encoded data.
        if data == nil,
           let image = try? await provider.loadItem(forTypeIdentifier: UTType.image.identifier) as? UIImage {
            data = image.pngData()
        }
        #endif
        guard let data, let source = CGImageSourceCreateWithData(data as CFData, nil),
              let jpeg = downscaledJPEG(source) else { return nil }
        let base = displayName(provider.suggestedName, or: "photo")
        return Attachment(data: jpeg, filename: "\(base).jpg", contentType: "image/jpeg",
                          thumbnail: thumbnail(source))
    }

    private static func loadFileRepresentation(_ provider: NSItemProvider, type: String) async -> Attachment? {
        await withCheckedContinuation { cont in
            // The temp file only lives for the duration of this callback.
            provider.loadFileRepresentation(forTypeIdentifier: type) { url, _ in
                cont.resume(returning: url.flatMap(loadFile(at:)))
            }
        }
    }

    private static func loadFile(at url: URL) -> Attachment? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize,
              size <= maxFileBytes,
              let data = try? Data(contentsOf: url) else { return nil }
        let type = UTType(filenameExtension: url.pathExtension)
        // An image that arrived as a file still gets the photo treatment so it
        // renders inline in the chat.
        if type?.conforms(to: .image) == true,
           let source = CGImageSourceCreateWithData(data as CFData, nil),
           let jpeg = downscaledJPEG(source) {
            let base = displayName(url.deletingPathExtension().lastPathComponent, or: "photo")
            return Attachment(data: jpeg, filename: "\(base).jpg", contentType: "image/jpeg",
                              thumbnail: thumbnail(source))
        }
        return Attachment(data: data, filename: displayName(url.lastPathComponent, or: "file"),
                          contentType: type?.preferredMIMEType ?? "application/octet-stream",
                          thumbnail: nil)
    }

    // MARK: - Images

    private static func downscaledJPEG(_ source: CGImageSource) -> Data? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxImagePixels,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        // Carry the camera's GPS and capture time across the re-encode. A
        // thumbnail has no metadata, so a lunch photo shared on 2026-10-08
        // arrived with no location or time, and the server could not place it
        // inside the stop it was taken in. The orientation is dropped because
        // the thumbnail is already rotated upright.
        var props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.85]
        if let src = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            for key in [kCGImagePropertyGPSDictionary, kCGImagePropertyExifDictionary, kCGImagePropertyTIFFDictionary] {
                if var dict = src[key] as? [CFString: Any] {
                    dict.removeValue(forKey: kCGImagePropertyTIFFOrientation)
                    dict.removeValue(forKey: kCGImagePropertyExifPixelXDimension)
                    dict.removeValue(forKey: kCGImagePropertyExifPixelYDimension)
                    props[key] = dict
                }
            }
        }
        props[kCGImagePropertyOrientation] = 1
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }

    private static func thumbnail(_ source: CGImageSource) -> CGImage? {
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 240,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    }

    /// The shared name as the user knows it, in any script, for display.
    /// The storage key is spelled separately (AttachmentKey): Storage takes
    /// ASCII only, which `CharacterSet.alphanumerics` is not.
    private static func displayName(_ name: String?, or fallback: String) -> String {
        let trimmed = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}
