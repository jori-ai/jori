// photo-ocr — Apple Vision text recognition in ACCURATE mode, one line per
// recognised line: "<text>\t<confidence>". Built and run by bin/photo-ocr.
//
// Photos' own index (photos.detected_text) is the fast pass, returned as an
// alphabetised bag: on 2026-10-07 it read "mama" off a café sign and missed the
// cursive "greg" under it. This pass read "COME TO MAMA" / "MAMA" / "greg",
// all at 1.00, in order.
import Vision
import AppKit

let url = URL(fileURLWithPath: CommandLine.arguments[1])
guard let img = NSImage(contentsOf: url),
      let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  FileHandle.standardError.write("photo-ocr: cannot read \(url.path)\n".data(using: .utf8)!)
  exit(1)
}
let req = VNRecognizeTextRequest()
req.recognitionLevel = .accurate
req.usesLanguageCorrection = true
req.recognitionLanguages = ["en-US", "he-IL", "fr-FR"]
do { try VNImageRequestHandler(cgImage: cg).perform([req]) } catch {
  FileHandle.standardError.write("photo-ocr: \(error)\n".data(using: .utf8)!)
  exit(1)
}
for o in req.results ?? [] {
  if let c = o.topCandidates(1).first { print("\(c.string)\t\(String(format: "%.2f", c.confidence))") }
}
