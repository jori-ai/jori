import SwiftUI

/// Drives the share composer: load what was shared, upload attachments, post
/// the rows (or park them in the outbox), then dismiss.
@MainActor
final class ShareComposeModel: ObservableObject {
    enum Phase: Equatable {
        case loading, ready, sending, queued
        case failed(String)
    }

    @Published var content = SharedContent()
    @Published var note = ""
    @Published var phase: Phase = .loading

    private let finish: (_ done: Bool) -> Void

    init(items: [NSExtensionItem], finish: @escaping (_ done: Bool) -> Void) {
        self.finish = finish
        Task {
            content = await SharedContent.load(from: items)
            phase = .ready
        }
    }

    var canSend: Bool {
        switch phase {
        case .ready, .failed: return !content.isEmpty || !trimmedNote.isEmpty
        default: return false
        }
    }

    private var trimmedNote: String { note.trimmingCharacters(in: .whitespacesAndNewlines) }

    func cancel() { finish(false) }

    func send() {
        phase = .sending
        Task {
            do {
                let rows = try await buildRows()
                switch await ShareOutbox.send(rows) {
                case .sent:
                    finish(true)
                case .queued:
                    phase = .queued
                    try? await Task.sleep(for: .seconds(1.6))
                    finish(true)
                case .failed:
                    phase = .failed("Couldn't send this or save it for later. Open Jori, then share again.")
                }
            } catch {
                phase = .failed(error.localizedDescription)
            }
        }
    }

    /// Photos go first, one row each, so they render inline in the chat; the
    /// note, shared text, links and any document links follow as ONE message,
    /// which is the one Jori answers with the photos above it as context.
    private func buildRows() async throws -> [ShareOutbox.Row] {
        let tz = TimeZone.current
        let metadata = [
            "source": "share",
            "timezone": tz.identifier,
            "utc_offset": "\(tz.secondsFromGMT() / 3600)",
        ]
        var rows: [ShareOutbox.Row] = []
        var lines: [String] = []
        if !trimmedNote.isEmpty { lines.append(trimmedNote) }
        lines += content.texts
        lines += content.urls.map(\.absoluteString)

        for attachment in content.attachments {
            let url = try await upload(attachment)
            if attachment.isImage {
                rows.append(.init(content: url.absoluteString, metadata: metadata))
            } else {
                lines.append(url.absoluteString)
            }
        }
        if !lines.isEmpty {
            rows.append(.init(content: lines.joined(separator: "\n\n"), metadata: metadata))
        }
        return rows
    }

    /// Same bucket + key layout as the app's own attachment send
    /// (ChatViewModel.sendAttachment), via Storage REST. The key is an ASCII
    /// spelling of the name: Storage answers 400 InvalidKey to anything else.
    private func upload(_ attachment: SharedContent.Attachment) async throws -> URL {
        let path = AttachmentKey.make(for: attachment.filename)
        var req = URLRequest(url: SupabaseConfig.url
            .appendingPathComponent("storage/v1/object/\(Install.attachmentsBucket)")
            .appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue(SupabaseConfig.anonKey, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(ShareOutbox.storageBearer())", forHTTPHeaderField: "Authorization")
        req.setValue(attachment.contentType, forHTTPHeaderField: "Content-Type")
        req.setValue("false", forHTTPHeaderField: "x-upsert")

        let (data, resp) = try await URLSession.shared.upload(for: req, from: attachment.data)
        let code = (resp as? HTTPURLResponse)?.statusCode ?? -1
        guard (200..<300).contains(code) else {
            throw NSError(domain: "JoriShare", code: code, userInfo: [
                NSLocalizedDescriptionKey: "Upload failed (\(code)): \(String(data: data, encoding: .utf8) ?? "")",
            ])
        }
        return SupabaseConfig.url
            .appendingPathComponent("storage/v1/object/public/\(Install.attachmentsBucket)")
            .appendingPathComponent(path)
    }
}

struct ShareComposeView: View {
    @ObservedObject var model: ShareComposeModel
    @FocusState private var noteFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    preview
                    TextField("Add a note for Jori…", text: $model.note, axis: .vertical)
                        .lineLimit(1...6)
                        .textFieldStyle(.plain)
                        .focused($noteFocused)
                        .padding(10)
                        .background(RoundedRectangle(cornerRadius: 10).fill(.quaternary))
                    status
                }
                .padding(16)
            }
        }
        .onAppear { noteFocused = true }
    }

    private var header: some View {
        HStack {
            Button("Cancel", action: model.cancel)
            Spacer()
            Text("Jori").font(.headline)
            Spacer()
            if model.phase == .sending {
                ProgressView().controlSize(.small)
            } else {
                Button("Send", action: model.send)
                    .bold()
                    .disabled(!model.canSend)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var preview: some View {
        if model.phase == .loading {
            ProgressView().frame(maxWidth: .infinity)
        }
        let images = model.content.attachments.filter(\.isImage)
        if !images.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(images) { image in
                        if let thumb = image.thumbnail {
                            Image(decorative: thumb, scale: 1)
                                .resizable()
                                .scaledToFill()
                                .frame(width: 72, height: 72)
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                        }
                    }
                }
            }
        }
        ForEach(model.content.urls, id: \.self) { url in
            Label {
                VStack(alignment: .leading, spacing: 2) {
                    Text(url.host() ?? url.absoluteString).font(.subheadline.bold())
                    Text(url.absoluteString).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                }
            } icon: {
                Image(systemName: "link")
            }
        }
        ForEach(model.content.texts, id: \.self) { text in
            Text(text).font(.callout).lineLimit(5).foregroundStyle(.secondary)
        }
        ForEach(model.content.attachments.filter { !$0.isImage }) { file in
            Label(file.filename, systemImage: "doc")
                .font(.subheadline)
        }
    }

    @ViewBuilder
    private var status: some View {
        switch model.phase {
        case .queued:
            Label("Saved — Jori will send it the next time the app opens.", systemImage: "clock")
                .font(.footnote).foregroundStyle(.secondary)
        case .failed(let message):
            Label(message, systemImage: "exclamationmark.triangle")
                .font(.footnote).foregroundStyle(.red)
        default:
            EmptyView()
        }
    }
}
