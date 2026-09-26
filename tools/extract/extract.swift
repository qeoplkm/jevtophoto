// B 阶段：从照片抽结构化特征，输出和 tools/capability/items.js 的 SHAPE 同名同值的 JSON。像素不出这台机器。
//
//   swiftc -O -o tools/extract/extract tools/extract/extract.swift      # 编译（macOS 15+，Vision 美学分要 15+）
//   tools/extract/extract --folder ~/Downloads --out out/downloads       # 文件夹模式：不碰 PhotoKit，不用权限，冒烟用
//   tools/extract/extract --album "Jev 测试" --out out/jev-test           # PhotoKit 模式（下一步）
//
// 文件夹模式拿不到的 PhotoKit 字段按「不知道」填：mediaSubtypes 只能从 EXIF UserComment 认出 iOS 截图、从 GIF 帧数认出动图；
// isFavorite / isHidden / hasAdjustments / burst* 一律 false / null；sourceType 固定 typeUserLibrary。
// 输出 <out>/features.json + <out>/thumbs/<id>.jpg（256px，只给审核页看）。
import Foundation
import ImageIO
import CoreGraphics
import Vision
import AVFoundation
import CryptoKit
import UniformTypeIdentifiers

// ---------- 有序 JSON（字段顺序是 prompt 的一部分，Dictionary 不保序） ----------
indirect enum J {
    case obj([(String, J)]), arr([J]), s(String), d(Double), i(Int), b(Bool), null
    static func num(_ v: Double?, digits: Int = 3) -> J {
        guard let v = v, v.isFinite else { return .null }
        let p = pow(10.0, Double(digits)); let r = (v * p).rounded() / p
        return r == r.rounded() && abs(r) < 1e9 ? .i(Int(r)) : .d(r)
    }
    static func str(_ v: String?) -> J { v.map { .s($0) } ?? .null }
    static func int(_ v: Int?) -> J { v.map { .i($0) } ?? .null }
    static func bool(_ v: Bool?) -> J { v.map { .b($0) } ?? .null }
}
func encode(_ j: J, _ ind: Int = 0) -> String {
    let pad = String(repeating: " ", count: ind), pad1 = String(repeating: " ", count: ind + 1)
    switch j {
    case .obj(let kv):
        if kv.isEmpty { return "{}" }
        return "{\n" + kv.map { "\(pad1)\"\($0.0)\": \(encode($0.1, ind + 1))" }.joined(separator: ",\n") + "\n\(pad)}"
    case .arr(let a):
        if a.isEmpty { return "[]" }
        return "[" + a.map { encode($0, ind + 1) }.joined(separator: ", ") + "]"
    case .s(let s):
        var out = "\""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""; case "\\": out += "\\\\"; case "\n": out += "\\n"; case "\r": out += "\\r"; case "\t": out += "\\t"
            default: if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
            }
        }
        return out + "\""
    case .d(let d): return String(format: "%.6g", d)
    case .i(let i): return String(i)
    case .b(let b): return b ? "true" : "false"
    case .null: return "null"
    }
}

// ---------- 参数 ----------
var folder: String? = nil, album: String? = nil, outDir = "out/extract"
var args = Array(CommandLine.arguments.dropFirst())
while !args.isEmpty {
    let a = args.removeFirst()
    switch a {
    case "--folder": folder = args.removeFirst()
    case "--album": album = args.removeFirst()
    case "--out": outDir = args.removeFirst()
    default: FileHandle.standardError.write("未知参数 \(a)\n".data(using: .utf8)!); exit(2)
    }
}
if album != nil { FileHandle.standardError.write("PhotoKit 模式还没写，先用 --folder\n".data(using: .utf8)!); exit(2) }
guard let folder = folder else { FileHandle.standardError.write("用法：extract --folder <dir> --out <dir>\n".data(using: .utf8)!); exit(2) }

let fm = FileManager.default
let thumbsDir = (outDir as NSString).appendingPathComponent("thumbs")
try! fm.createDirectory(atPath: thumbsDir, withIntermediateDirectories: true)

let IMAGE_EXT: Set<String> = ["heic", "heif", "jpg", "jpeg", "png", "gif", "webp", "tif", "tiff", "bmp"]
let VIDEO_EXT: Set<String> = ["mov", "mp4", "m4v"]
let NOW = Date()
let ANALYSIS_MAX_PIXEL = 1024
let THUMB_MAX_PIXEL = 256
let NEAR_DUP_DISTANCE: Float = 0.4   // VNFeaturePrint 距离阈值，拍的；真图上要看分布再定

// ---------- 图像工具 ----------
func downscaled(_ src: CGImageSource, maxPixel: Int) -> CGImage? {
    let opts: [CFString: Any] = [kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceThumbnailMaxPixelSize: maxPixel,
                                 kCGImageSourceCreateThumbnailWithTransform: true, kCGImageSourceShouldCache: false]
    return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
}
func resized(_ img: CGImage, maxPixel: Int) -> CGImage? {
    let scale = min(1.0, Double(maxPixel) / Double(max(img.width, img.height)))
    let w = max(1, Int(Double(img.width) * scale)), h = max(1, Int(Double(img.height) * scale))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                              bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    return ctx.makeImage()
}
// 灰度 512px：平均亮度 + Laplacian 方差（清晰度）
func grayStats(_ img: CGImage) -> (meanLuminance: Double, laplacianVar: Double)? {
    let scale = min(1.0, 512.0 / Double(max(img.width, img.height)))
    let w = max(3, Int(Double(img.width) * scale)), h = max(3, Int(Double(img.height) * scale))
    guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(),
                              bitmapInfo: CGImageAlphaInfo.none.rawValue), let data = ctx.data else { return nil }
    ctx.interpolationQuality = .high
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
    let p = data.assumingMemoryBound(to: UInt8.self), stride = ctx.bytesPerRow
    var sum = 0.0
    for y in 0..<h { for x in 0..<w { sum += Double(p[y * stride + x]) } }
    let mean = sum / Double(w * h) / 255.0
    var lsum = 0.0, lsq = 0.0, n = 0.0
    for y in 1..<(h - 1) {
        for x in 1..<(w - 1) {
            let c = Double(p[y * stride + x])
            let l = 4 * c - Double(p[(y - 1) * stride + x]) - Double(p[(y + 1) * stride + x]) - Double(p[y * stride + x - 1]) - Double(p[y * stride + x + 1])
            lsum += l; lsq += l * l; n += 1
        }
    }
    let lmean = lsum / n
    return (mean, lsq / n - lmean * lmean)
}
// Laplacian 方差 → 0–1：var 10 → 0，100 → 0.4，1000 → 0.8，3000 → 1。刻度是拍的，真图上要重看
func sharpnessScore(_ v: Double) -> Double { min(1, max(0, (log10(v + 1) - 1) / 2.5)) }

func writeThumb(_ img: CGImage, to path: String) {
    guard let t = resized(img, maxPixel: THUMB_MAX_PIXEL),
          let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { return }
    CGImageDestinationAddImage(dest, t, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
    CGImageDestinationFinalize(dest)
}

// ---------- OCR 派生：原文不出去，只出字数 / 有没有金额 / 单据类型 ----------
func ocrDerived(_ text: String) -> (charCount: Int, hasAmount: Bool, docType: String) {
    let compact = text.replacingOccurrences(of: "\\s+", with: "", options: .regularExpression)
    let up = text.uppercased()
    let amount = text.range(of: #"[¥$€£￥]\s?\d[\d,]*(?:\.\d+)?|\d[\d,]*\.\d{2}(?!\d)"#, options: .regularExpression) != nil
        || ["合计", "总计", "实付", "应付", "TOTAL", "SUBTOTAL", "AMOUNT DUE"].contains { up.contains($0) }
    func hit(_ words: [String]) -> Bool { words.contains { up.contains($0.uppercased()) } }
    let docType: String
    if hit(["身份证", "公民身份号码", "PASSPORT", "护照", "驾驶证", "DRIVER LICENSE", "居民身份"]) { docType = "id_document" }
    else if hit(["BOARDING", "登机牌", "登机口", "GATE", "SEAT", "航班", "FLIGHT"]) { docType = "boarding_pass" }
    else if hit(["车票", "检票", "座位号", "TICKET", "ADMIT", "入场", "场次", "车次"]) { docType = "ticket" }
    else if hit(["收据", "发票", "小票", "RECEIPT", "INVOICE", "合计", "总计", "实付", "应付", "TOTAL", "SUBTOTAL", "找零", "CHANGE DUE"]) { docType = "receipt" }
    else { docType = "none" }
    return (compact.count, amount, docType)
}

// ---------- 每个文件的中间结果 ----------
struct Rec {
    var id: String, file: String, thumb: String?
    var mediaType = "image", subtypes: [String] = [], playbackStyle = "image", width = 0, height = 0, duration = 0.0
    var hasLocation = false, contentType: String? = nil, dataSize = 0
    var make: String? = nil, model: String? = nil, lens: String? = nil, iso: Int? = nil, exposure: Double? = nil, fnumber: Double? = nil
    var faceCount = 0, textChars = 0, barcodeCount = 0, aesthetic: Double? = nil, isUtility: Bool? = nil, sceneLabels: [(String, Double)] = []
    var creationDate = Date(), addedDate = Date()
    var sharpness: Double? = nil, meanLuminance: Double? = nil, ocrHasAmount = false, ocrDocType = "none"
    var sha: String = "", featurePrint: VNFeaturePrintObservation? = nil
    var exactDup = 0, nearDup = 0, sharpestInBurst: Bool? = nil
}

func runVision(_ img: CGImage, _ r: inout Rec) {
    let face = VNDetectFaceRectanglesRequest()
    let text = VNRecognizeTextRequest(); text.recognitionLevel = .accurate; text.recognitionLanguages = ["zh-Hans", "en-US"]; text.usesLanguageCorrection = false
    let barcode = VNDetectBarcodesRequest()
    let fp = VNGenerateImageFeaturePrintRequest()
    let cls = VNClassifyImageRequest()
    var reqs: [VNRequest] = [face, text, barcode, fp, cls]
    var aesth: VNCalculateImageAestheticsScoresRequest? = nil
    if #available(macOS 15.0, *) { let a = VNCalculateImageAestheticsScoresRequest(); aesth = a; reqs.append(a) }
    do { try VNImageRequestHandler(cgImage: img, options: [:]).perform(reqs) } catch { FileHandle.standardError.write("  Vision 失败 \(r.file): \(error)\n".data(using: .utf8)!) }
    r.faceCount = face.results?.count ?? 0
    let str = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
    let o = ocrDerived(str); r.textChars = o.charCount; r.ocrHasAmount = o.hasAmount; r.ocrDocType = o.docType
    r.barcodeCount = barcode.results?.count ?? 0
    r.featurePrint = fp.results?.first as? VNFeaturePrintObservation
    r.sceneLabels = (cls.results ?? []).filter { $0.confidence >= 0.1 }.prefix(5).map { ($0.identifier, Double($0.confidence)) }
    if #available(macOS 15.0, *), let obs = aesth?.results?.first as? VNImageAestheticsScoresObservation { r.aesthetic = Double(obs.overallScore); r.isUtility = obs.isUtility }
}

let exifDate: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy:MM:dd HH:mm:ss"; f.timeZone = TimeZone.current; return f }()

func processImage(_ url: URL, _ r: inout Rec) -> Bool {
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { return false }
    let props = (CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any]) ?? [:]
    var w = (props[kCGImagePropertyPixelWidth as String] as? Int) ?? 0, h = (props[kCGImagePropertyPixelHeight as String] as? Int) ?? 0
    if let o = props[kCGImagePropertyOrientation as String] as? Int, o >= 5 { swap(&w, &h) }
    r.width = w; r.height = h
    let tiff = props[kCGImagePropertyTIFFDictionary as String] as? [String: Any] ?? [:]
    let exif = props[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
    r.make = tiff[kCGImagePropertyTIFFMake as String] as? String
    r.model = tiff[kCGImagePropertyTIFFModel as String] as? String
    r.lens = exif[kCGImagePropertyExifLensModel as String] as? String
    r.iso = (exif[kCGImagePropertyExifISOSpeedRatings as String] as? [Int])?.first
    r.exposure = exif[kCGImagePropertyExifExposureTime as String] as? Double
    r.fnumber = exif[kCGImagePropertyExifFNumber as String] as? Double
    r.hasLocation = (props[kCGImagePropertyGPSDictionary as String] as? [String: Any]).map { !$0.isEmpty } ?? false
    if let s = exif[kCGImagePropertyExifDateTimeOriginal as String] as? String, let d = exifDate.date(from: s) { r.creationDate = d }
    if let c = exif[kCGImagePropertyExifUserComment as String] as? String, c.localizedCaseInsensitiveContains("screenshot") { r.subtypes.append("photoScreenshot") }
    if CGImageSourceGetCount(src) > 1, url.pathExtension.lowercased() == "gif" { r.subtypes.append("photoAnimation"); r.playbackStyle = "imageAnimated" }
    guard let img = downscaled(src, maxPixel: ANALYSIS_MAX_PIXEL) else { return false }
    if let g = grayStats(img) { r.meanLuminance = g.meanLuminance; r.sharpness = sharpnessScore(g.laplacianVar) }
    runVision(img, &r)
    let tp = (thumbsDir as NSString).appendingPathComponent("\(r.id).jpg"); writeThumb(img, to: tp); r.thumb = "thumbs/\(r.id).jpg"
    return true
}

func processVideo(_ url: URL, _ r: inout Rec) -> Bool {
    let asset = AVURLAsset(url: url)
    r.mediaType = "video"; r.playbackStyle = "video"
    r.duration = CMTimeGetSeconds(asset.duration)
    if let track = asset.tracks(withMediaType: .video).first {
        let size = track.naturalSize.applying(track.preferredTransform)
        r.width = Int(abs(size.width)); r.height = Int(abs(size.height))
    }
    for item in asset.metadata {
        guard let id = item.identifier else { continue }
        if id == .quickTimeMetadataMake || id == .commonIdentifierMake { r.make = item.stringValue }
        if id == .quickTimeMetadataModel || id == .commonIdentifierModel { r.model = item.stringValue }
        if id == .quickTimeMetadataLocationISO6709 || id == .commonIdentifierLocation { r.hasLocation = true }
    }
    if let d = asset.creationDate?.dateValue { r.creationDate = d }
    let gen = AVAssetImageGenerator(asset: asset)
    gen.appliesPreferredTrackTransform = true
    gen.maximumSize = CGSize(width: ANALYSIS_MAX_PIXEL, height: ANALYSIS_MAX_PIXEL)
    let t = CMTime(seconds: min(0.5, max(0, r.duration / 2)), preferredTimescale: 600)
    guard let img = try? gen.copyCGImage(at: t, actualTime: nil) else { return false }
    if let g = grayStats(img) { r.meanLuminance = g.meanLuminance; r.sharpness = sharpnessScore(g.laplacianVar) }
    runVision(img, &r)
    let tp = (thumbsDir as NSString).appendingPathComponent("\(r.id).jpg"); writeThumb(img, to: tp); r.thumb = "thumbs/\(r.id).jpg"
    return true
}

// ---------- 主流程 ----------
let urls = ((try? fm.contentsOfDirectory(at: URL(fileURLWithPath: folder), includingPropertiesForKeys: nil, options: [.skipsHiddenFiles])) ?? [])
    .filter { IMAGE_EXT.contains($0.pathExtension.lowercased()) || VIDEO_EXT.contains($0.pathExtension.lowercased()) }
    .sorted { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }
print("\(folder)：\(urls.count) 个媒体文件 → \(outDir)")

var recs: [Rec] = []
var usedIds = Set<String>()
for url in urls {
    var id = url.deletingPathExtension().lastPathComponent.replacingOccurrences(of: "[^A-Za-z0-9_.-]+", with: "_", options: .regularExpression)
    var n = 2; let base = id
    while usedIds.contains(id) { id = "\(base)-\(n)"; n += 1 }
    usedIds.insert(id)
    var r = Rec(id: id, file: url.lastPathComponent, thumb: nil)
    let rv = try? url.resourceValues(forKeys: [.creationDateKey, .addedToDirectoryDateKey, .contentTypeKey, .fileSizeKey])
    r.contentType = rv?.contentType?.identifier
    r.dataSize = rv?.fileSize ?? 0
    r.creationDate = rv?.creationDate ?? NOW
    if let data = fm.contents(atPath: url.path) { r.sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    let ok = VIDEO_EXT.contains(url.pathExtension.lowercased()) ? processVideo(url, &r) : processImage(url, &r)
    r.addedDate = rv?.addedToDirectoryDate ?? r.creationDate
    if !ok { FileHandle.standardError.write("  跳过（读不出来）：\(url.lastPathComponent)\n".data(using: .utf8)!); continue }
    print("  \(r.file.padding(toLength: 36, withPad: " ", startingAt: 0)) \(r.mediaType) \(r.width)×\(r.height) 脸\(r.faceCount) 字\(r.textChars) 码\(r.barcodeCount) 美\(r.aesthetic.map { String(format: "%.2f", $0) } ?? "-") \(r.isUtility == true ? "utility " : "")清\(r.sharpness.map { String(format: "%.2f", $0) } ?? "-") 亮\(r.meanLuminance.map { String(format: "%.2f", $0) } ?? "-") \(r.ocrDocType != "none" ? r.ocrDocType + " " : "")\(r.model ?? "无EXIF")")
    recs.append(r)
}

// 精确重复：文件哈希；近重复：特征印距离；「最清晰」：近重复连通分量里 sharpness 最高
for i in recs.indices {
    recs[i].exactDup = recs.enumerated().filter { $0.offset != i && !$0.element.sha.isEmpty && $0.element.sha == recs[i].sha }.count
}
var parent = Array(recs.indices)
func find(_ x: Int) -> Int { var x = x; while parent[x] != x { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
for i in recs.indices {
    guard let a = recs[i].featurePrint else { continue }
    for j in recs.indices where j > i {
        guard let b = recs[j].featurePrint, recs[i].sha != recs[j].sha else { continue }
        var d: Float = 0
        if (try? a.computeDistance(&d, to: b)) != nil, d < NEAR_DUP_DISTANCE {
            recs[i].nearDup += 1; recs[j].nearDup += 1
            let ri = find(i), rj = find(j); if ri != rj { parent[ri] = rj }
        }
    }
}
var groups: [Int: [Int]] = [:]
for i in recs.indices { groups[find(i), default: []].append(i) }
for (_, members) in groups where members.count > 1 {
    let best = members.max { (recs[$0].sharpness ?? -1) < (recs[$1].sharpness ?? -1) }!
    for m in members { recs[m].sharpestInBurst = (m == best) }
}

// ---------- 输出：state 的形状和 items.js 的 SHAPE 完全一致 ----------
let iso8601: ISO8601DateFormatter = { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f }()
func days(_ d: Date) -> Int { max(0, Int(NOW.timeIntervalSince(d) / 86400)) }
func stateOf(_ r: Rec) -> J {
    .obj([
        ("asset", .obj([
            ("mediaType", .s(r.mediaType)), ("mediaSubtypes", .arr(r.subtypes.map { .s($0) })), ("playbackStyle", .s(r.playbackStyle)),
            ("pixelWidth", .i(r.width)), ("pixelHeight", .i(r.height)), ("duration", J.num(r.duration, digits: 1)),
            ("hasLocation", .b(r.hasLocation)), ("isFavorite", .b(false)), ("isHidden", .b(false)),
            ("hasAdjustments", .b(false)), ("adjustmentsState", .s("none")), ("sourceType", .s("typeUserLibrary")),
            ("burstIdentifier", .null), ("representsBurst", .b(false)), ("burstSelectionTypes", .arr([])),
        ])),
        ("resource", .obj([("contentType", J.str(r.contentType)), ("dataSize", .i(r.dataSize))])),
        ("imageProperties", .obj([
            ("TIFF", .obj([("Make", J.str(r.make)), ("Model", J.str(r.model))])),
            ("Exif", .obj([("LensModel", J.str(r.lens)), ("ISOSpeedRatings", J.int(r.iso)), ("ExposureTime", J.num(r.exposure, digits: 5)), ("FNumber", J.num(r.fnumber, digits: 2))])),
        ])),
        ("vision", .obj([
            ("faceCount", .i(r.faceCount)), ("recognizedTextCharCount", .i(r.textChars)), ("barcodeCount", .i(r.barcodeCount)),
            ("aesthetics", .obj([("overallScore", J.num(r.aesthetic, digits: 2)), ("isUtility", J.bool(r.isUtility))])),
            ("sceneLabels", .arr(r.sceneLabels.map { .obj([("identifier", .s($0.0)), ("confidence", J.num($0.1, digits: 2))]) })),
        ])),
        ("derived", .obj([
            ("daysSinceCreation", .i(days(r.creationDate))), ("daysSinceAdded", .i(days(r.addedDate))),
            ("sharpness", J.num(r.sharpness, digits: 2)), ("meanLuminance", J.num(r.meanLuminance, digits: 2)),
            ("ocrHasAmount", .b(r.ocrHasAmount)), ("ocrDocType", .s(r.ocrDocType)),
            ("exactDuplicateCount", .i(r.exactDup)), ("nearDuplicateCount", .i(r.nearDup)), ("isSharpestInBurst", J.bool(r.sharpestInBurst)),
        ])),
    ])
}
let out = J.obj([
    ("generatedAt", .s(iso8601.string(from: NOW))), ("mode", .s("folder")), ("source", .s(folder)),
    ("notes", .arr([.s("文件夹模式：isFavorite / isHidden / hasAdjustments / burst* / sourceType 拿不到，按默认填；mediaSubtypes 只认得出 iOS 截图（EXIF UserComment）和 GIF"),
                    .s("sharpness = Laplacian 方差的对数刻度，meanLuminance = 512px 灰度均值，nearDuplicate 用 VNFeaturePrint 距离 < \(NEAR_DUP_DISTANCE)；阈值都是拍的")])),
    ("records", .arr(recs.map { r in
        .obj([("id", .s(r.id)), ("file", .s(r.file)), ("thumbnail", J.str(r.thumb)),
              ("dates", .obj([("creationDate", .s(iso8601.string(from: r.creationDate))), ("addedDate", .s(iso8601.string(from: r.addedDate)))])),
              ("state", stateOf(r))])
    })),
])
let outPath = (outDir as NSString).appendingPathComponent("features.json")
try! (encode(out) + "\n").write(toFile: outPath, atomically: true, encoding: .utf8)
print("写入 \(outPath)：\(recs.count) 条记录，缩略图在 \(thumbsDir)")
