// 三栏：建议删除 / 拿不准 / 保留。点进去看分布、state、给 👍👎。右上角导出 JSON。
import SwiftUI
import Photos

struct ResultsView: View {
    @EnvironmentObject var session: Session
    @State private var tab: String = "disagree"
    @State private var exportURL: URL? = nil

    var shown: [PhotoRecord] {
        switch tab { case "delete": return session.column(.delete); case "unsure": return session.column(.unsure); case "keep": return session.column(.keep); default: return session.disagreements }
    }
    var body: some View {
        VStack(spacing: 0) {
            Picker("栏", selection: $tab) {
                Text("分歧 \(session.disagreements.count)").tag("disagree")
                Text("删 \(session.column(.delete).count)").tag("delete")
                Text("？\(session.column(.unsure).count)").tag("unsure")
                Text("留 \(session.column(.keep).count)").tag("keep")
            }
            .pickerStyle(.segmented).padding([.horizontal, .top])
            Text(tab == "disagree" ? "本地阈值规则和 Jev 判得不一样的照片——只用判这些，点进去选谁对。" : "本地和 Jev 一致的照片也能标：判得对 / 判错了。")
                .font(.caption).foregroundStyle(.secondary).padding(.horizontal).padding(.vertical, 6)
            let t = session.jevTotals
            if t.calls > 0 { Text("Jev：\(t.calls) 次调用 · 共 \(t.ms / 1000) 秒（并发 4）· 发出 \(t.bytes / 1024) KB · 约 $\(String(format: "%.3f", Double(t.calls) * 0.00015))").font(.caption2).foregroundStyle(.secondary).padding(.horizontal) }
            List(shown) { r in
                NavigationLink { DetailView(recordID: r.id) } label: { RecordRow(record: r, feedback: session.feedback[r.id]) }
            }
            .listStyle(.plain)
        }
        .navigationTitle("结果")
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                if let url = exportURL { ShareLink(item: url) { Label("导出", systemImage: "square.and.arrow.up") } }
                else { Button { exportURL = session.exportURL() } label: { Label("导出", systemImage: "square.and.arrow.up") } }
            }
        }
    }
}

struct RecordRow: View {
    let record: PhotoRecord
    let feedback: String?
    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AssetThumb(asset: record.asset, size: 72)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 4) {
                    Text(record.decision.by == "rule" ? "规则" : record.decision.by == "jev" ? "Jev" : "—").font(.caption2).padding(.horizontal, 5).padding(.vertical, 1)
                        .background(record.decision.by == "rule" ? Color.secondary.opacity(0.2) : Color.blue.opacity(0.15)).clipShape(Capsule())
                    Text("\(record.decision.column.title)：\(record.decision.reason)").font(.subheadline).lineLimit(2)
                    if let f = feedback { Text(["ok": "👍", "wrong": "👎", "jev": "Jev✓", "local": "本地✓", "neither": "都✗"][f] ?? f).font(.caption) }
                }
                if record.local.column != record.decision.column {
                    Text("本地规则：\(record.local.column.title)（\(record.local.reason)）").font(.caption).foregroundStyle(.orange)
                }
                if let k = record.kind { Text("kind \(k.mode) \(String(format: "%.2f", k.confidence))").font(.caption).foregroundStyle(.secondary) }
                Text(record.state.summary).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
            }
        }
        .padding(.vertical, 2)
    }
}

struct AssetThumb: View {
    let asset: PHAsset
    let size: CGFloat
    @State private var image: UIImage? = nil
    var body: some View {
        ZStack {
            Color.secondary.opacity(0.15)
            if let img = image { Image(uiImage: img).resizable().scaledToFill() }
        }
        .frame(width: size, height: size).clipShape(RoundedRectangle(cornerRadius: 6))
        .task(id: asset.localIdentifier) {
            let o = PHImageRequestOptions(); o.deliveryMode = .opportunistic; o.resizeMode = .fast; o.isNetworkAccessAllowed = true
            let scale = UIScreen.main.scale
            PHImageManager.default().requestImage(for: asset, targetSize: CGSize(width: size * scale, height: size * scale), contentMode: .aspectFill, options: o) { img, _ in
                if let img = img { Task { @MainActor in image = img } }
            }
        }
    }
}
