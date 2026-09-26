// 在手机上抽特征：PhotoKit（字段原样）+ ImageIO（EXIF）+ Vision（人脸 / 文字 / 条码 / 美学分 / 特征印）+ 代码算的。
// 像素不出手机；OCR 原文只留字数 / 有没有金额 / 单据类型。和 tools/extract/extract.swift 的算法一致。
import Foundation
import Photos
import Vision
import ImageIO
import AVFoundation
import CryptoKit
import UIKit

let ANALYSIS_MAX_PIXEL: CGFloat = 1024
let NEAR_DUP_DISTANCE: Float = 0.4   // VNFeaturePrint 距离阈值，拍的；真图上要看分布再定

// 一次性 continuation（PHImageManager 的回调可能来两次）
final class Once<T> {
    private var cont: CheckedContinuation<T, Never>?
    init(_ c: CheckedContinuation<T, Never>) { cont = c }
    func resume(_ v: T) { cont?.resume(returning: v); cont = nil }
}

enum Extractor {
    static let exifDate: DateFormatter = { let f = DateFormatter(); f.dateFormat = "yyyy:MM:dd HH:mm:ss"; f.timeZone = TimeZone.current; return f }()

    // ---------- PhotoKit 字段 ----------
    static func subtypeNames(_ st: PHAssetMediaSubtype) -> [String] {
        var out: [String] = []
        if st.contains(.photoPanorama) { out.append("photoPanorama") }
        if st.contains(.photoHDR) { out.append("photoHDR") }
        if st.contains(.photoScreenshot) { out.append("photoScreenshot") }
        if st.contains(.photoLive) { out.append("photoLive") }
        if st.contains(.photoDepthEffect) { out.append("photoDepthEffect") }
        if st.contains(PHAssetMediaSubtype(rawValue: 1 << 6)) { out.append("photoAnimation") }
        if st.contains(PHAssetMediaSubtype(rawValue: 1 << 10)) { out.append("spatialMedia") }
        if st.contains(.videoStreamed) { out.append("videoStreamed") }
        if st.contains(.videoHighFrameRate) { out.append("videoHighFrameRate") }
        if st.contains(.videoTimelapse) { out.append("videoTimelapse") }
        if st.contains(PHAssetMediaSubtype(rawValue: 1 << 19)) { out.append("videoScreenRecording") }
        if st.contains(PHAssetMediaSubtype(rawValue: 1 << 21)) { out.append("videoCinematic") }
        return out
    }
    static func playbackName(_ p: PHAsset.PlaybackStyle) -> String {
        switch p { case .image: return "image"; case .imageAnimated: return "imageAnimated"; case .livePhoto: return "livePhoto"; case .video: return "video"; case .videoLooping: return "videoLooping"; default: return "unsupported" }
    }
    static func sourceName(_ s: PHAssetSourceType) -> String {
        if s.contains(.typeCloudShared) { return "typeCloudShared" }
        if s.contains(.typeiTunesSynced) { return "typeiTunesSynced" }
        return "typeUserLibrary"
    }

    static func baseState(_ a: PHAsset) -> FeatureState {
        var s = FeatureState()
        s.mediaType = a.mediaType == .video ? "video" : a.mediaType == .audio ? "audio" : "image"
        s.mediaSubtypes = subtypeNames(a.mediaSubtypes)
        s.playbackStyle = playbackName(a.playbackStyle)
        s.pixelWidth = a.pixelWidth; s.pixelHeight = a.pixelHeight; s.duration = a.duration
        s.hasLocation = a.location != nil; s.isFavorite = a.isFavorite; s.isHidden = a.isHidden
        s.hasAdjustments = a.hasAdjustments
        switch a.adjustmentsState { case .userAdjusted: s.adjustmentsState = "userAdjusted"; case .cameraAutoAdjusted: s.adjustmentsState = "cameraAutoAdjusted"; default: s.adjustmentsState = "none" }
        s.sourceType = sourceName(a.sourceType)
        s.burstIdentifier = a.burstIdentifier; s.representsBurst = a.representsBurst
        var sel: [String] = []
        if a.burstSelectionTypes.contains(.autoPick) { sel.append("autoPick") }
        if a.burstSelectionTypes.contains(.userPick) { sel.append("userPick") }
        s.burstSelectionTypes = sel
        // resource：原始那份
        let res = PHAssetResource.assetResources(for: a)
        if let r = res.first(where: { $0.type == .photo || $0.type == .video }) ?? res.first {
            if #available(iOS 26.0, *) { s.contentType = r.contentType.identifier } else { s.contentType = r.uniformTypeIdentifier }
            if r.responds(to: NSSelectorFromString("fileSize")), let n = r.value(forKey: "fileSize") as? NSNumber { s.dataSize = n.intValue }
        }
        return s
    }

    // ---------- PHImageManager 的 async 包装 ----------
    static func requestImage(_ a: PHAsset, maxPixel: CGFloat, allowNetwork: Bool) async -> UIImage? {
        await withCheckedContinuation { (c: CheckedContinuation<UIImage?, Never>) in
            let once = Once(c)
            let o = PHImageRequestOptions(); o.deliveryMode = .highQualityFormat; o.resizeMode = .fast; o.isNetworkAccessAllowed = allowNetwork; o.isSynchronous = false
            PHImageManager.default().requestImage(for: a, targetSize: CGSize(width: maxPixel, height: maxPixel), contentMode: .aspectFit, options: o) { img, info in
                if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
                once.resume(img)
            }
        }
    }
    static func requestData(_ a: PHAsset, allowNetwork: Bool) async -> (Data?, inCloud: Bool) {
        await withCheckedContinuation { (c: CheckedContinuation<(Data?, inCloud: Bool), Never>) in
            let once = Once(c)
            let o = PHImageRequestOptions(); o.isNetworkAccessAllowed = allowNetwork; o.version = .original; o.deliveryMode = .highQualityFormat
            PHImageManager.default().requestImageDataAndOrientation(for: a, options: o) { data, _, _, info in
                once.resume((data, (info?[PHImageResultIsInCloudKey] as? Bool) == true))
            }
        }
    }
    static func requestAVAsset(_ a: PHAsset, allowNetwork: Bool) async -> AVAsset? {
        await withCheckedContinuation { (c: CheckedContinuation<AVAsset?, Never>) in
            let once = Once(c)
            let o = PHVideoRequestOptions(); o.isNetworkAccessAllowed = allowNetwork; o.deliveryMode = .fastFormat
            PHImageManager.default().requestAVAsset(forVideo: a, options: o) { av, _, _ in once.resume(av) }
        }
    }

    // ---------- ImageIO：EXIF / GPS ----------
    static func readImageProperties(_ data: Data, into s: inout FeatureState) -> Date? {
        guard let src = CGImageSourceCreateWithData(data as CFData, nil), let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any] else { return nil }
        let tiff = props[kCGImagePropertyTIFFDictionary as String] as? [String: Any] ?? [:]
        let exif = props[kCGImagePropertyExifDictionary as String] as? [String: Any] ?? [:]
        s.make = tiff[kCGImagePropertyTIFFMake as String] as? String
        s.model = tiff[kCGImagePropertyTIFFModel as String] as? String
        s.lensModel = exif[kCGImagePropertyExifLensModel as String] as? String
        s.iso = (exif[kCGImagePropertyExifISOSpeedRatings as String] as? [Int])?.first
        s.exposureTime = exif[kCGImagePropertyExifExposureTime as String] as? Double
        s.fNumber = exif[kCGImagePropertyExifFNumber as String] as? Double
        if let gps = props[kCGImagePropertyGPSDictionary as String] as? [String: Any], !gps.isEmpty { s.hasLocation = true }
        if let d = exif[kCGImagePropertyExifDateTimeOriginal as String] as? String { return exifDate.date(from: d) }
        return nil
    }

    // ---------- 灰度统计：亮度 + Laplacian 方差 ----------
    static func grayStats(_ img: CGImage) -> (mean: Double, lapVar: Double)? {
        let scale = min(1.0, 512.0 / Double(max(img.width, img.height)))
        let w = max(3, Int(Double(img.width) * scale)), h = max(3, Int(Double(img.height) * scale))
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue), let data = ctx.data else { return nil }
        ctx.interpolationQuality = .high
        ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
        let p = data.assumingMemoryBound(to: UInt8.self), stride = ctx.bytesPerRow
        var sum = 0.0
        for y in 0..<h { for x in 0..<w { sum += Double(p[y * stride + x]) } }
        var lsum = 0.0, lsq = 0.0, n = 0.0
        for y in 1..<(h - 1) { for x in 1..<(w - 1) {
            let c = Double(p[y * stride + x])
            let l = 4 * c - Double(p[(y - 1) * stride + x]) - Double(p[(y + 1) * stride + x]) - Double(p[y * stride + x - 1]) - Double(p[y * stride + x + 1])
            lsum += l; lsq += l * l; n += 1
        } }
        let lm = lsum / n
        return (sum / Double(w * h) / 255.0, lsq / n - lm * lm)
    }
    static func sharpnessScore(_ v: Double) -> Double { min(1, max(0, (log10(v + 1) - 1) / 2.5)) }

    // ---------- OCR 派生 ----------
    static func ocrDerived(_ text: String) -> (chars: Int, hasAmount: Bool, docType: String) {
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

    // ---------- Vision ----------
    static func runVision(_ img: CGImage, into s: inout FeatureState, notes: inout [String]) -> VNFeaturePrintObservation? {
        let face = VNDetectFaceRectanglesRequest()
        let text = VNRecognizeTextRequest(); text.recognitionLevel = .accurate; text.recognitionLanguages = ["zh-Hans", "en-US"]; text.usesLanguageCorrection = false
        let barcode = VNDetectBarcodesRequest()
        let fp = VNGenerateImageFeaturePrintRequest()
        let cls = VNClassifyImageRequest()
        let aesth = VNCalculateImageAestheticsScoresRequest()
        let handler = VNImageRequestHandler(cgImage: img, options: [:])
        // 分开跑：模拟器上美学分可能不支持，别把别的也拖垮
        do { try handler.perform([face, text, barcode, fp, cls]) } catch { notes.append("Vision 失败：\(error.localizedDescription)") }
        do { try handler.perform([aesth]) } catch { notes.append("美学分不可用：\(error.localizedDescription)") }
        s.faceCount = face.results?.count ?? 0
        let str = (text.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
        let o = ocrDerived(str); s.textCharCount = o.chars; s.ocrHasAmount = o.hasAmount; s.ocrDocType = o.docType
        s.barcodeCount = barcode.results?.count ?? 0
        if let a = aesth.results?.first { s.aestheticScore = Double(a.overallScore); s.isUtility = a.isUtility }
        s.sceneLabels = (cls.results ?? []).filter { $0.confidence >= 0.1 }.prefix(5).map { ($0.identifier, Double($0.confidence)) }
        return fp.results?.first
    }

    // ---------- 一张 ----------
    static func extract(_ a: PHAsset, allowICloud: Bool) async -> PhotoRecord {
        var s = baseState(a)
        var rec = PhotoRecord(id: a.localIdentifier, asset: a, state: s, creationDate: a.creationDate, addedDate: nil)
        if #available(iOS 26.0, *) { rec.addedDate = a.addedDate }
        var notes: [String] = []
        var cg: CGImage? = nil
        if a.mediaType == .video {
            if let av = await requestAVAsset(a, allowNetwork: allowICloud) {
                if let meta = try? await av.load(.metadata) {
                    for item in meta {
                        guard let id = item.identifier else { continue }
                        if id == .quickTimeMetadataMake || id == .commonIdentifierMake { s.make = try? await item.load(.stringValue) }
                        if id == .quickTimeMetadataModel || id == .commonIdentifierModel { s.model = try? await item.load(.stringValue) }
                    }
                }
                let gen = AVAssetImageGenerator(asset: av); gen.appliesPreferredTrackTransform = true; gen.maximumSize = CGSize(width: ANALYSIS_MAX_PIXEL, height: ANALYSIS_MAX_PIXEL)
                let t = CMTime(seconds: min(0.5, max(0, a.duration / 2)), preferredTimescale: 600)
                if let r = try? await gen.image(at: t) { cg = r.image } else { notes.append("视频取不到封面帧") }
            } else { notes.append("视频在 iCloud，没读") }
        } else {
            let (data, inCloud) = await requestData(a, allowNetwork: allowICloud)
            if let data = data {
                rec.sha = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
                if s.dataSize == nil { s.dataSize = data.count }
                if let d = readImageProperties(data, into: &s), rec.creationDate == nil { rec.creationDate = d }
            } else { notes.append(inCloud ? "原图在 iCloud，EXIF 和精确重复没算" : "读不到原图数据") }
            if let ui = await requestImage(a, maxPixel: ANALYSIS_MAX_PIXEL, allowNetwork: true) { cg = ui.cgImage } else { notes.append("拿不到分析用的图") }
        }
        if let img = cg {
            if let g = grayStats(img) { s.meanLuminance = g.mean; s.sharpness = sharpnessScore(g.lapVar) }
            rec.featurePrint = runVision(img, into: &s, notes: &notes)
        }
        let now = Date()
        s.daysSinceCreation = max(0, Int(now.timeIntervalSince(rec.creationDate ?? now) / 86400))
        s.daysSinceAdded = max(0, Int(now.timeIntervalSince(rec.addedDate ?? rec.creationDate ?? now) / 86400))
        rec.state = s; rec.notes = notes
        return rec
    }

    // ---------- 整批：精确重复、近重复、连拍里最清晰 ----------
    static func finalize(_ recs: inout [PhotoRecord]) {
        var shaCount: [String: Int] = [:]
        for r in recs { if let h = r.sha { shaCount[h, default: 0] += 1 } }
        for i in recs.indices { if let h = recs[i].sha { recs[i].state.exactDuplicateCount = max(0, (shaCount[h] ?? 1) - 1) } }
        var parent = Array(recs.indices)
        func find(_ x: Int) -> Int { var x = x; while parent[x] != x { parent[x] = parent[parent[x]]; x = parent[x] }; return x }
        // 连拍按 burstIdentifier 分组；其余按特征印距离
        var byBurst: [String: [Int]] = [:]
        for i in recs.indices { if let b = recs[i].state.burstIdentifier { byBurst[b, default: []].append(i) } }
        for (_, m) in byBurst { for j in m.dropFirst() { let a = find(m[0]), b = find(j); if a != b { parent[a] = b } } }
        for i in recs.indices {
            guard let a = recs[i].featurePrint else { continue }
            for j in recs.indices where j > i {
                guard let b = recs[j].featurePrint, recs[i].sha == nil || recs[i].sha != recs[j].sha else { continue }
                var d: Float = 0
                if (try? a.computeDistance(&d, to: b)) != nil, d < NEAR_DUP_DISTANCE {
                    recs[i].state.nearDuplicateCount += 1; recs[j].state.nearDuplicateCount += 1
                    let ri = find(i), rj = find(j); if ri != rj { parent[ri] = rj }
                }
            }
        }
        var groups: [Int: [Int]] = [:]
        for i in recs.indices { groups[find(i), default: []].append(i) }
        for (_, m) in groups where m.count > 1 {
            let best = m.max { (recs[$0].state.sharpness ?? -1) < (recs[$1].state.sharpness ?? -1) }!
            for x in m { recs[x].state.isSharpestInBurst = (x == best) }
        }
    }
}
