// 一次扫描：选来源 → 抽特征 → 规则 → Jev → 三栏。什么都不删。结果 + 你的 👍👎 可以导出成 JSON 拿回 Mac 分析。
import Foundation
import Photos
import SwiftUI

enum PhotoSource: Hashable, Identifiable {
    case recent(Int)
    case album(String, String)   // localIdentifier, title
    var id: String { switch self { case .recent(let n): return "recent-\(n)"; case .album(let id, _): return "album-\(id)" } }
    var title: String { switch self { case .recent(let n): return "最近 \(n) 张"; case .album(_, let t): return "相簿「\(t)」" } }
}

enum Phase: Equatable {
    case idle, extracting(Int, Int), asking(Int, Int), done, failed(String)
    var isRunning: Bool { switch self { case .extracting, .asking: return true; default: return false } }
}

@MainActor
final class Session: ObservableObject {
    @Published var phase: Phase = .idle
    @Published var records: [PhotoRecord] = []
    @Published var albums: [PhotoSource] = []
    @Published var authorization: PHAuthorizationStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
    @Published var feedback: [String: String] = UserDefaults.standard.dictionary(forKey: "jev.feedback") as? [String: String] ?? [:]
    @Published var apiKey: String = UserDefaults.standard.string(forKey: "jev.apiKey") ?? Session.bundledKey() ?? "" { didSet { UserDefaults.standard.set(apiKey, forKey: "jev.apiKey") } }
    @Published var tau: Double = ((UserDefaults.standard.object(forKey: "jev.aggressive") as? Bool) ?? true) ? PROFILE_AGGRESSIVE_TAU : DEFAULT_TAU
    @Published var aggressive: Bool = (UserDefaults.standard.object(forKey: "jev.aggressive") as? Bool) ?? true {   // 默认激进：保守档在手机上实测太保守
        didSet { UserDefaults.standard.set(aggressive, forKey: "jev.aggressive"); tau = aggressive ? PROFILE_AGGRESSIVE_TAU : DEFAULT_TAU }
    }
    var questions: J { aggressive ? QUESTIONS_AGGRESSIVE : QUESTIONS }
    var recentDays: Int { aggressive ? PROFILE_AGGRESSIVE_RECENT_DAYS : RECENT_SCREENSHOT_DAYS }
    @Published var allowICloud = false
    @Published var model: String? = nil
    @Published var log: [String] = []
    var startedAt: Date? = nil
    var source: PhotoSource? = nil

    static func bundledKey() -> String? {
        guard let url = Bundle.main.url(forResource: "Secrets", withExtension: "plist"), let d = NSDictionary(contentsOf: url) else { return nil }
        return d["OPENROUTER_API_KEY"] as? String
    }

    func requestAccess() async {
        authorization = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        if authorization == .authorized || authorization == .limited { loadAlbums() }
    }

    func loadAlbums() {
        var out: [PhotoSource] = [.recent(50), .recent(100), .recent(300)]
        let cols = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .albumRegular, options: nil)
        cols.enumerateObjects { c, _, _ in
            let n = PHAsset.fetchAssets(in: c, options: nil).count
            if n > 0 { out.append(.album(c.localIdentifier, "\(c.localizedTitle ?? "?")（\(n)）")) }
        }
        albums = out
    }

    func fetchAssets(_ src: PhotoSource) -> [PHAsset] {
        let opts = PHFetchOptions()
        opts.includeAllBurstAssets = true          // 不开拿不到非封面的连拍
        opts.includeHiddenAssets = false
        opts.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        var result: PHFetchResult<PHAsset>
        switch src {
        case .recent(let n):
            opts.fetchLimit = n
            result = PHAsset.fetchAssets(with: opts)
        case .album(let id, _):
            guard let col = PHAssetCollection.fetchAssetCollections(withLocalIdentifiers: [id], options: nil).firstObject else { return [] }
            result = PHAsset.fetchAssets(in: col, options: opts)
        }
        var assets: [PHAsset] = []
        result.enumerateObjects { a, _, _ in assets.append(a) }
        return assets
    }

    func run(_ src: PhotoSource) {
        guard !phase.isRunning else { return }
        source = src; startedAt = Date(); records = []; log = []; model = nil
        Task {
            let assets = fetchAssets(src)
            if assets.isEmpty { phase = .failed("这个来源里没有照片"); return }
            phase = .extracting(0, assets.count)
            var recs: [PhotoRecord] = []
            for (i, a) in assets.enumerated() {
                let r = await Extractor.extract(a, allowICloud: allowICloud)
                recs.append(r)
                phase = .extracting(i + 1, assets.count)
            }
            Extractor.finalize(&recs)
            let days = recentDays, qs = questions
            for i in recs.indices { recs[i].rule = applyRules(recs[i].state, recentScreenshotDays: days); recs[i].decision = decide(recs[i].state, rule: recs[i].rule, junk: nil, tau: tau); recs[i].local = localDecide(recs[i].state, recentScreenshotDays: days) }
            records = recs
            // 规则管不到的问 Jev
            let toAsk = recs.indices.filter { recs[$0].rule.verdict == nil }
            if toAsk.isEmpty { phase = .done; persistLastRun(); return }
            guard !apiKey.isEmpty else { phase = .failed("没有 API key：规则定了 \(recs.count - toAsk.count) 条，剩下 \(toAsk.count) 条没问 Jev。到设置里填 key。"); return }
            phase = .asking(0, toAsk.count)
            let client = JevClient(apiKey: apiKey)
            var done = 0
            await withTaskGroup(of: (Int, Result<(String?, [String: JevAnswer], Int, Int), Error>).self) { group in
                var next = 0, inFlight = 0
                let states = recs.map { $0.state.toJ() }
                // 最多 4 个在飞
                while next < toAsk.count && inFlight < 4 {
                    let i = toAsk[next]; next += 1; inFlight += 1
                    let st = states[i]
                    group.addTask { do { let r = try await client.ask(state: st, questions: qs); return (i, .success((r.model, r.answers, r.ms, r.bytes))) } catch { return (i, .failure(error)) } }
                }
                for await (i, result) in group {
                    inFlight -= 1; done += 1
                    switch result {
                    case .success(let (m, answers, ms, bytes)):
                        if let m = m { model = m }
                        recs[i].jevMs = ms; recs[i].bytesSent = bytes
                        recs[i].junk = answers["junk"]; recs[i].kind = answers["kind"]
                        recs[i].decision = decide(recs[i].state, rule: recs[i].rule, junk: recs[i].junk, tau: tau)
                    case .failure(let e):
                        recs[i].notes.append("Jev 调用失败：\(e.localizedDescription)")
                        recs[i].decision = Decision(column: .unsure, by: "none", reason: "Jev 调用失败")
                        log.append("\(recs[i].id.prefix(8))… \(e.localizedDescription)")
                    }
                    records = recs
                    phase = .asking(done, toAsk.count)
                    if next < toAsk.count {
                        let j = toAsk[next]; next += 1; inFlight += 1
                        let st = states[j]
                        group.addTask { do { let r = try await client.ask(state: st, questions: qs); return (j, .success((r.model, r.answers, r.ms, r.bytes))) } catch { return (j, .failure(error)) } }
                    }
                }
            }
            records = recs
            phase = .done
            persistLastRun()
        }
    }

    func column(_ c: Column) -> [PhotoRecord] { records.filter { $0.decision.column == c } }
    var disagreements: [PhotoRecord] { records.filter { $0.local.column != $0.decision.column } }
    var jevTotals: (calls: Int, ms: Int, bytes: Int) { let r = records.filter { $0.jevMs != nil }; return (r.count, r.reduce(0) { $0 + ($1.jevMs ?? 0) }, r.reduce(0) { $0 + ($1.bytesSent ?? 0) }) }

    func setFeedback(_ id: String, _ v: String?) {
        if let v = v { feedback[id] = v } else { feedback.removeValue(forKey: id) }
        UserDefaults.standard.set(feedback, forKey: "jev.feedback")
        persistLastRun()
    }

    // 每次跑完 / 每次标注都把结果写到 Documents/last-run.json，Mac 上 devicectl 直接拉，不用手动导出
    func persistLastRun() {
        guard !records.isEmpty, let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        try? exportJSON().encode(pretty: true).write(to: dir.appendingPathComponent("last-run.json"), atomically: true, encoding: .utf8)
    }

    // 导出：和 tools/extract 的 decisions.json 同构，拿回 Mac 用同一套脚本看
    func exportJSON() -> J {
        .obj([
            ("generatedAt", .s(ISO8601DateFormatter().string(from: Date()))), ("mode", .s("iphone")), ("source", .s(source?.title ?? "")),
            ("model", J.str(model)), ("profile", .s(aggressive ? "aggressive" : "conservative")), ("jevCalls", .i(jevTotals.calls)), ("jevTotalMs", .i(jevTotals.ms)), ("jevTotalBytes", .i(jevTotals.bytes)), ("tau", .d(tau)), ("recentScreenshotDays", .i(recentDays)), ("device", .s(UIDevice.current.model + " " + UIDevice.current.systemVersion)),
            ("records", .arr(records.map { r in
                .obj([
                    ("id", .s(r.id)), ("state", r.state.toJ()),
                    ("dates", .obj([("creationDate", J.str(r.creationDate.map { ISO8601DateFormatter().string(from: $0) })), ("addedDate", J.str(r.addedDate.map { ISO8601DateFormatter().string(from: $0) }))])),
                    ("rule", .obj([("verdict", J.str(r.rule.verdict)), ("reason", J.str(r.rule.reason))])),
                    ("junk", answerJ(r.junk)), ("kind", answerJ(r.kind)),
                    ("decision", .obj([("column", .s(r.decision.column.rawValue)), ("by", .s(r.decision.by)), ("reason", .s(r.decision.reason))])),
                    ("local", .obj([("column", .s(r.local.column.rawValue)), ("reason", .s(r.local.reason))])),
                    ("jevMs", J.int(r.jevMs)), ("bytesSent", J.int(r.bytesSent)),
                    ("feedback", J.str(feedback[r.id])), ("notes", .arr(r.notes.map { .s($0) })),
                ])
            })),
        ])
    }
    private func answerJ(_ a: JevAnswer?) -> J {
        guard let a = a else { return .null }
        return .obj([("mode", .s(a.mode)), ("confidence", J.num(a.confidence, digits: 3)), ("probabilities", .obj(a.probabilities.map { ($0.0, J.num($0.1, digits: 3)) }))])
    }
    func exportURL() -> URL? {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("jevphoto-\(Int(Date().timeIntervalSince1970)).json")
        do { try exportJSON().encode(pretty: true).write(to: url, atomically: true, encoding: .utf8); return url } catch { return nil }
    }
}
