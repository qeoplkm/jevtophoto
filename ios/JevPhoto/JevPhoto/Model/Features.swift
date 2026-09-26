// 一张照片的结构化特征。形状、字段名、顺序和 tools/capability/items.js 的 SHAPE 完全一致。
import Foundation
import Photos
import Vision

struct FeatureState {
    // asset（PHAsset）
    var mediaType = "image", mediaSubtypes: [String] = [], playbackStyle = "image"
    var pixelWidth = 0, pixelHeight = 0, duration = 0.0
    var hasLocation = false, isFavorite = false, isHidden = false, hasAdjustments = false, adjustmentsState = "none"
    var sourceType = "typeUserLibrary", burstIdentifier: String? = nil, representsBurst = false, burstSelectionTypes: [String] = []
    // resource（PHAssetResource）
    var contentType: String? = nil, dataSize: Int? = nil
    // imageProperties（ImageIO {TIFF} / {Exif}）
    var make: String? = nil, model: String? = nil, lensModel: String? = nil, iso: Int? = nil, exposureTime: Double? = nil, fNumber: Double? = nil
    // vision
    var faceCount = 0, textCharCount = 0, barcodeCount = 0, aestheticScore: Double? = nil, isUtility: Bool? = nil, sceneLabels: [(String, Double)] = []
    // derived
    var daysSinceCreation = 0, daysSinceAdded = 0, sharpness: Double? = nil, meanLuminance: Double? = nil
    var ocrHasAmount = false, ocrDocType = "none", exactDuplicateCount = 0, nearDuplicateCount = 0, isSharpestInBurst: Bool? = nil

    func toJ() -> J {
        .obj([
            ("asset", .obj([
                ("mediaType", .s(mediaType)), ("mediaSubtypes", .arr(mediaSubtypes.map { .s($0) })), ("playbackStyle", .s(playbackStyle)),
                ("pixelWidth", .i(pixelWidth)), ("pixelHeight", .i(pixelHeight)), ("duration", J.num(duration, digits: 1)),
                ("hasLocation", .b(hasLocation)), ("isFavorite", .b(isFavorite)), ("isHidden", .b(isHidden)),
                ("hasAdjustments", .b(hasAdjustments)), ("adjustmentsState", .s(adjustmentsState)), ("sourceType", .s(sourceType)),
                ("burstIdentifier", J.str(burstIdentifier)), ("representsBurst", .b(representsBurst)), ("burstSelectionTypes", .arr(burstSelectionTypes.map { .s($0) })),
            ])),
            ("resource", .obj([("contentType", J.str(contentType)), ("dataSize", J.int(dataSize))])),
            ("imageProperties", .obj([
                ("TIFF", .obj([("Make", J.str(make)), ("Model", J.str(model))])),
                ("Exif", .obj([("LensModel", J.str(lensModel)), ("ISOSpeedRatings", J.int(iso)), ("ExposureTime", J.num(exposureTime, digits: 5)), ("FNumber", J.num(fNumber, digits: 2))])),
            ])),
            ("vision", .obj([
                ("faceCount", .i(faceCount)), ("recognizedTextCharCount", .i(textCharCount)), ("barcodeCount", .i(barcodeCount)),
                ("aesthetics", .obj([("overallScore", J.num(aestheticScore, digits: 2)), ("isUtility", J.bool(isUtility))])),
                ("sceneLabels", .arr(sceneLabels.map { .obj([("identifier", .s($0.0)), ("confidence", J.num($0.1, digits: 2))]) })),
            ])),
            ("derived", .obj([
                ("daysSinceCreation", .i(daysSinceCreation)), ("daysSinceAdded", .i(daysSinceAdded)),
                ("sharpness", J.num(sharpness, digits: 2)), ("meanLuminance", J.num(meanLuminance, digits: 2)),
                ("ocrHasAmount", .b(ocrHasAmount)), ("ocrDocType", .s(ocrDocType)),
                ("exactDuplicateCount", .i(exactDuplicateCount)), ("nearDuplicateCount", .i(nearDuplicateCount)), ("isSharpestInBurst", J.bool(isSharpestInBurst)),
            ])),
        ])
    }

    // 审核页上的一行摘要
    var summary: String {
        var bits: [String] = []
        if mediaType == "video" { bits.append("video \(Int(duration))s") }
        bits.append(contentsOf: mediaSubtypes)
        bits.append("\(pixelWidth)×\(pixelHeight)")
        bits.append(model ?? "无 EXIF")
        if sourceType == "typeCloudShared" { bits.append("共享相簿") }
        bits.append("脸 \(faceCount)"); bits.append("字 \(textCharCount)")
        if barcodeCount > 0 { bits.append("码 \(barcodeCount)") }
        if ocrDocType != "none" { bits.append(ocrDocType) }
        if isUtility == true { bits.append("utility") }
        if !sceneLabels.isEmpty { bits.append(sceneLabels.prefix(3).map { $0.0 }.joined(separator: "/")) }
        bits.append("美 \(aestheticScore.map { String(format: "%.2f", $0) } ?? "–")")
        bits.append("清 \(sharpness.map { String(format: "%.2f", $0) } ?? "–")")
        bits.append("亮 \(meanLuminance.map { String(format: "%.2f", $0) } ?? "–")")
        bits.append("\(daysSinceCreation)d")
        if exactDuplicateCount > 0 { bits.append("副本 \(exactDuplicateCount)") }
        if nearDuplicateCount > 0 { bits.append("近重复 \(nearDuplicateCount)") }
        if isSharpestInBurst == false { bits.append("非最清晰") } else if isSharpestInBurst == true { bits.append("最清晰") }
        if burstIdentifier != nil { bits.append("连拍" + (burstSelectionTypes.isEmpty ? "" : " " + burstSelectionTypes.joined(separator: "+"))) }
        if isFavorite { bits.append("★") }
        if adjustmentsState != "none" { bits.append(adjustmentsState) }
        return bits.joined(separator: " · ")
    }
}

// Jev 对一个问题的一次读数
struct JevAnswer {
    var probabilities: [(String, Double)]   // 按 criteria 顺序
    var confidence: Double
    var mode: String { probabilities.max { $0.1 < $1.1 }?.0 ?? "" }
    var top: Double { probabilities.max { $0.1 < $1.1 }?.1 ?? 0 }
}

enum Column: String { case delete, unsure, keep
    var title: String { switch self { case .delete: return "建议删除"; case .unsure: return "拿不准"; case .keep: return "保留" } }
}

struct Decision {
    var column: Column
    var by: String      // "rule" / "jev" / "none"
    var reason: String
}

struct PhotoRecord: Identifiable {
    let id: String              // PHAsset.localIdentifier
    let asset: PHAsset
    var state: FeatureState
    var creationDate: Date?, addedDate: Date?
    var notes: [String] = []    // 抽特征时的备注（原图在 iCloud、Vision 失败…）
    var sha: String? = nil
    var featurePrint: VNFeaturePrintObservation? = nil
    var rule: RuleResult = RuleResult(verdict: nil, reason: nil)
    var junk: JevAnswer? = nil, kind: JevAnswer? = nil
    var decision = Decision(column: .unsure, by: "none", reason: "还没判")
    var local = Decision(column: .unsure, by: "local", reason: "还没判")   // 全本地阈值版（对照）
    var jevMs: Int? = nil, bytesSent: Int? = nil
    var stateJSON: String { state.toJ().encode(pretty: true) }
}
