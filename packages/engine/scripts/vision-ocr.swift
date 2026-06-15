import Foundation
import Vision
import AppKit

struct OCRLine: Codable {
  let text: String
  let confidence: Float
  let box: [String: Double]
}

struct OCRResult: Codable {
  let path: String
  let lines: [OCRLine]
}

func recognize(path: String) -> OCRResult {
  guard let image = NSImage(contentsOfFile: path),
        let tiff = image.tiffRepresentation,
        let bitmap = NSBitmapImageRep(data: tiff),
        let cgImage = bitmap.cgImage else {
    return OCRResult(path: path, lines: [])
  }

  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.usesLanguageCorrection = false
  request.minimumTextHeight = 0.015

  let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
  do {
    try handler.perform([request])
  } catch {
    return OCRResult(path: path, lines: [])
  }

  let lines = (request.results ?? []).compactMap { observation -> OCRLine? in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let box = observation.boundingBox
    return OCRLine(
      text: candidate.string,
      confidence: candidate.confidence,
      box: [
        "x": Double(box.origin.x),
        "y": Double(box.origin.y),
        "w": Double(box.width),
        "h": Double(box.height)
      ]
    )
  }
  return OCRResult(path: path, lines: lines)
}

let paths = Array(CommandLine.arguments.dropFirst())
let results = paths.map { recognize(path: $0) }
let encoder = JSONEncoder()
encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
if let data = try? encoder.encode(results), let json = String(data: data, encoding: .utf8) {
  print(json)
} else {
  print("[]")
}
