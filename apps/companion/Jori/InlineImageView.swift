import SwiftUI
#if os(iOS)
import UIKit
#endif

struct InlineImageView: View {
    let url: URL
    var maxWidth: CGFloat = 260
    // Tap opens the picture full screen with pinch/double-tap zoom (a seat
    // map has to be readable).
    @State private var showViewer = false
    @Environment(\.openURL) private var openURL

    var body: some View {
        AsyncImage(url: url) { phase in
            switch phase {
            case .success(let image):
                image
                    .resizable()
                    .scaledToFit()
                    .frame(maxWidth: maxWidth)
                    .clipShape(RoundedRectangle(cornerRadius: Radius.row, style: .continuous))
                    .contentShape(Rectangle())
                    .onTapGesture {
                        #if os(iOS)
                        showViewer = true
                        #else
                        openURL(url)   // the Mac opens it in the browser, which zooms natively
                        #endif
                    }
                    .accessibilityAddTraits(.isButton)
                    .accessibilityHint("Opens the image full screen")
            case .failure:
                Label("Image failed to load", systemImage: "photo")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            default:
                ProgressView()
                    .frame(width: 120, height: 80)
            }
        }
        #if os(iOS)
        .fullScreenCover(isPresented: $showViewer) {
            ImageViewer(url: url)
        }
        #endif
    }
}

#if os(iOS)

/// Full-screen image with pinch, pan and double-tap zoom, plus close and share.
struct ImageViewer: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var image: UIImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            if let image {
                ZoomableImage(image: image).ignoresSafeArea()
            } else if failed {
                Label("Image failed to load", systemImage: "photo")
                    .foregroundStyle(.white.opacity(0.8))
            } else {
                ProgressView().tint(.white)
            }
        }
        .overlay(alignment: .top) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.headline)
                        .padding(12)
                        .background(.ultraThinMaterial, in: Circle())
                }
                .accessibilityLabel("Close")
                Spacer()
                if let image {
                    ShareLink(item: Image(uiImage: image), preview: SharePreview("Image", image: Image(uiImage: image))) {
                        Image(systemName: "square.and.arrow.up")
                            .font(.headline)
                            .padding(12)
                            .background(.ultraThinMaterial, in: Circle())
                    }
                    .accessibilityLabel("Share")
                }
            }
            .foregroundStyle(.white)
            .padding()
        }
        .task {
            do {
                let (data, _) = try await URLSession.shared.data(from: url)
                if let img = UIImage(data: data) { image = img } else { failed = true }
            } catch {
                failed = true
            }
        }
    }
}

/// UIScrollView-backed zoom: native pinch, pan and bounce, double-tap to zoom in/out.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> UIScrollView {
        let scroll = UIScrollView()
        scroll.delegate = context.coordinator
        scroll.minimumZoomScale = 1
        scroll.maximumZoomScale = 6
        scroll.showsHorizontalScrollIndicator = false
        scroll.showsVerticalScrollIndicator = false
        scroll.backgroundColor = .clear
        scroll.contentInsetAdjustmentBehavior = .never

        let imageView = UIImageView(image: image)
        imageView.contentMode = .scaleAspectFit
        imageView.isUserInteractionEnabled = true
        scroll.addSubview(imageView)
        context.coordinator.imageView = imageView

        let doubleTap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        scroll.addGestureRecognizer(doubleTap)
        return scroll
    }

    func updateUIView(_ scroll: UIScrollView, context: Context) {
        // Size the image view to the scroll view's bounds once they are known.
        DispatchQueue.main.async {
            guard let iv = context.coordinator.imageView, scroll.zoomScale == 1 else { return }
            iv.frame = scroll.bounds
            scroll.contentSize = scroll.bounds.size
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate {
        weak var imageView: UIImageView?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? { imageView }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            // Keep the image centred while it is smaller than the screen.
            guard let iv = imageView else { return }
            let dx = max(0, (scrollView.bounds.width - iv.frame.width) / 2)
            let dy = max(0, (scrollView.bounds.height - iv.frame.height) / 2)
            scrollView.contentInset = UIEdgeInsets(top: dy, left: dx, bottom: dy, right: dx)
        }

        @objc func doubleTapped(_ g: UITapGestureRecognizer) {
            guard let scroll = g.view as? UIScrollView else { return }
            if scroll.zoomScale > 1 {
                scroll.setZoomScale(1, animated: true)
            } else {
                let p = g.location(in: imageView)
                let scale: CGFloat = 3
                let size = CGSize(width: scroll.bounds.width / scale, height: scroll.bounds.height / scale)
                scroll.zoom(to: CGRect(x: p.x - size.width / 2, y: p.y - size.height / 2, width: size.width, height: size.height), animated: true)
            }
        }
    }
}
#endif
