import SwiftUI
#if os(iOS)
import AVFoundation
import UIKit
#endif

/// "Find your Jori" (board B6): the shared app's first screen until it is
/// paired. Scan the code on the host's setup page, or type/paste it. On
/// success the normal Google sign-in follows (SignInView).
struct FindJoriView: View {
    let onPaired: () -> Void
    /// Back to the sign-in screen; nil when there is nothing to go back to.
    var onCancel: (() -> Void)?

    @State private var typing = false
    @State private var code = ""
    @State private var error: String?
    @State private var paired = false
    @FocusState private var codeFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer(minLength: 24)

            Text("Find your Jori")
                .font(JoriTheme.display(38))

            Text("On the computer that runs Jori, open the setup page and scan the code under “Pair the app”.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.top, 8)
                .padding(.horizontal, 32)

            #if os(iOS)
            if !typing {
                QRScanner { scanned in submit(scanned, fromScanner: true) }
                    .frame(width: 260, height: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 24, style: .continuous)
                            .strokeBorder(JoriTheme.eye.opacity(0.7), lineWidth: 2)
                    )
                    .padding(.top, 28)
                    .accessibilityLabel("Camera viewfinder for the pairing code")
            }
            #endif

            if typing {
                codeEntry.padding(.top, 28)
            }

            if let error {
                Label(error, systemImage: "exclamationmark.triangle.fill")
                    .font(.footnote)
                    .foregroundStyle(JoriTheme.deny)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
                    .padding(.top, 14)
                    .transition(.opacity.combined(with: .move(edge: .top)))
            }

            Spacer(minLength: 24)

            #if os(iOS)
            Button(typing ? "Scan the code instead" : "Type the code instead") {
                withAnimation(.snappy) {
                    typing.toggle()
                    error = nil
                }
                codeFocused = typing
            }
            .font(.callout.weight(.semibold))
            .foregroundStyle(JoriTheme.eye)
            #endif

            if let onCancel {
                Button("Cancel", action: onCancel)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .padding(.top, 12)
            }

            Spacer().frame(height: 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .foregroundStyle(.white)
        .background(JoriBackdrop())
        .tint(JoriTheme.eye)
        .environment(\.colorScheme, .dark)
        .animation(.snappy, value: error)
        .sensoryFeedback(.error, trigger: error) { _, new in new != nil }
        .sensoryFeedback(.success, trigger: paired)
        #if os(macOS)
        // No scanner on the Mac: the code is pasted from the setup page.
        .onAppear { typing = true }
        #endif
    }

    private var codeEntry: some View {
        VStack(spacing: 12) {
            TextField("jori-pair:1:…", text: $code, axis: .vertical)
                .lineLimit(3...6)
                .font(.callout.monospaced())
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .focused($codeFocused)
                .padding(12)
                .background(.white.opacity(0.08), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                .onSubmit { submit(code, fromScanner: false) }

            HStack(spacing: 12) {
                PasteButton(payloadType: String.self) { strings in
                    guard let pasted = strings.first else { return }
                    Task { @MainActor in
                        code = pasted
                        submit(pasted, fromScanner: false)
                    }
                }
                .labelStyle(.titleAndIcon)
                .buttonBorderShape(.capsule)

                Button {
                    submit(code, fromScanner: false)
                } label: {
                    Text("Pair").fontWeight(.semibold).frame(minWidth: 80)
                        .foregroundStyle(JoriTheme.iconDeep)
                }
                .prominentButtonStyle()
                .buttonBorderShape(.capsule)
                .disabled(code.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .keyboardShortcut(.defaultAction)
            }
        }
        .frame(maxWidth: 420)
        .padding(.horizontal, 32)
    }

    /// The scanner reports every QR it sees: one that isn't a Jori code only
    /// earns a hint, and keeps scanning.
    private func submit(_ text: String, fromScanner: Bool) {
        guard !paired else { return }
        do {
            try PairingCoordinator.pair(with: text)
            error = nil
            paired = true
            onPaired()
        } catch let parse as Pairing.ParseError {
            if fromScanner && parse == .notAPairingCode {
                error = "That QR code isn't a Jori pairing code."
            } else {
                error = parse.localizedDescription
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
}

#if os(iOS)
/// A live camera view that reports the text of QR codes it sees (AVFoundation
/// metadata output). Asks for camera access on first show; if it is refused,
/// says so and offers Settings — typing the code still works.
struct QRScanner: View {
    let onCode: (String) -> Void
    @State private var status = AVCaptureDevice.authorizationStatus(for: .video)

    var body: some View {
        ZStack {
            Color.black.opacity(0.35)
            switch status {
            case .authorized:
                QRCameraView(onCode: onCode)
            case .notDetermined:
                ProgressView()
                    .task {
                        _ = await AVCaptureDevice.requestAccess(for: .video)
                        status = AVCaptureDevice.authorizationStatus(for: .video)
                    }
            default:
                VStack(spacing: 10) {
                    Image(systemName: "camera.fill").font(.title)
                    Text("Camera access is off.")
                        .font(.callout.weight(.semibold))
                    Text("Allow it in Settings, or type the code instead.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                    Button("Open Settings") {
                        if let url = URL(string: UIApplication.openSettingsURLString) {
                            UIApplication.shared.open(url)
                        }
                    }
                    .font(.footnote.weight(.semibold))
                }
                .padding()
            }
        }
    }
}

private struct QRCameraView: UIViewRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.previewLayer.session = context.coordinator.session
        view.previewLayer.videoGravity = .resizeAspectFill
        context.coordinator.start()
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onCode = onCode
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.stop()
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let session = AVCaptureSession()
        var onCode: (String) -> Void
        private let queue = DispatchQueue(label: "jori.qr-scanner")
        private var configured = false
        private var lastCode: String?

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func start() {
            queue.async { [weak self] in
                guard let self else { return }
                if !self.configured { self.configure() }
                if self.configured && !self.session.isRunning { self.session.startRunning() }
            }
        }

        func stop() {
            queue.async { [weak self] in
                guard let self, self.session.isRunning else { return }
                self.session.stopRunning()
            }
        }

        private func configure() {
            guard let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                    ?? AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: camera) else { return }
            session.beginConfiguration()
            defer { session.commitConfiguration() }
            guard session.canAddInput(input) else { return }
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else { return }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            if output.availableMetadataObjectTypes.contains(.qr) {
                output.metadataObjectTypes = [.qr]
            }
            configured = true
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard let value = metadataObjects
                    .compactMap({ ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue })
                    .first,
                  value != lastCode else { return }
            lastCode = value   // report each distinct code once
            onCode(value)
        }
    }
}
#endif
