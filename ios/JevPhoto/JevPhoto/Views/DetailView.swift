// 一张照片：大图、判定、Jev 的分布条、kind、规则、备注、发出去的 state、👍👎。
import SwiftUI
import Photos

struct DetailView: View {
    @EnvironmentObject var session: Session
    let recordID: String
    @State private var image: UIImage? = nil

    var record: PhotoRecord? { session.records.first { $0.id == recordID } }

    var body: some View {
        ScrollView {
            if let r = record {
                VStack(alignment: .leading, spacing: 14) {
                    ZStack { Color.secondary.opacity(0.1); if let img = image { Image(uiImage: img).resizable().scaledToFit() } }
                        .frame(maxWidth: .infinity).frame(height: 320).clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 4) {
                        Text(r.decision.column.title).font(.title3).bold().foregroundStyle(r.decision.column == .delete ? .red : r.decision.column == .unsure ? .orange : .green)
                        Text("\(r.decision.by == "rule" ? "规则" : r.decision.by == "jev" ? "Jev" : "—") · \(r.decision.reason)")
                    }
                    let differ = r.local.column != r.decision.column
                    if differ {
                        Text("本地规则说：\(r.local.column.title)（\(r.local.reason)）").font(.subheadline).foregroundStyle(.orange)
                        HStack(spacing: 8) {
                            fb(r.id, "jev", "Jev 对", .blue); fb(r.id, "local", "本地对", .orange); fb(r.id, "neither", "都不对", .red)
                        }
                    } else {
                        Text("本地规则也这么判（\(r.local.reason)）").font(.footnote).foregroundStyle(.secondary)
                        HStack(spacing: 12) { fb(r.id, "ok", "判得对", .green); fb(r.id, "wrong", "判错了", .red) }
                    }
                    if let j = r.junk {
                        GroupBox("该不该删 · 置信 \(String(format: "%.2f", j.confidence))") {
                            VStack(spacing: 4) { ForEach(Array(j.probabilities.enumerated()), id: \.offset) { i, p in bar(JUNK_LEVELS[i], p.1, top: p.0 == j.mode) } }
                        }
                    }
                    if let k = r.kind {
                        GroupBox("是哪类 · \(k.mode) · 置信 \(String(format: "%.2f", k.confidence))") {
                            VStack(spacing: 4) { ForEach(Array(k.probabilities.enumerated()), id: \.offset) { _, p in bar(p.0, p.1, top: p.0 == k.mode) } }
                        }
                    }
                    if let v = r.rule.verdict { Text("规则：\(v) · \(r.rule.reason ?? "")").font(.footnote).foregroundStyle(.secondary) }
                    if !r.notes.isEmpty { ForEach(r.notes, id: \.self) { Text("备注：\($0)").font(.footnote).foregroundStyle(.orange) } }
                    Text(r.state.summary).font(.footnote).foregroundStyle(.secondary)
                    DisclosureGroup("发给 Jev 的 state（原样）") {
                        Text(r.stateJSON).font(.system(size: 11, design: .monospaced)).textSelection(.enabled).frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding()
                .task(id: r.id) {
                    let o = PHImageRequestOptions(); o.deliveryMode = .highQualityFormat; o.isNetworkAccessAllowed = true
                    PHImageManager.default().requestImage(for: r.asset, targetSize: CGSize(width: 1200, height: 1200), contentMode: .aspectFit, options: o) { img, _ in
                        if let img = img { Task { @MainActor in image = img } }
                    }
                }
            } else { Text("找不到这条记录") }
        }
        .navigationTitle("照片").navigationBarTitleDisplayMode(.inline)
    }

    func fb(_ id: String, _ value: String, _ title: String, _ color: Color) -> some View {
        Button { session.setFeedback(id, session.feedback[id] == value ? nil : value) } label: { Text(title).frame(maxWidth: .infinity) }
            .buttonStyle(.bordered).tint(session.feedback[id] == value ? color : .secondary)
    }

    func bar(_ label: String, _ p: Double, top: Bool) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.caption).frame(width: 96, alignment: .leading).lineLimit(1)
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3).fill(Color.secondary.opacity(0.15))
                    RoundedRectangle(cornerRadius: 3).fill(top ? Color.blue : Color.secondary.opacity(0.5)).frame(width: max(0, g.size.width * p))
                }
            }.frame(height: 10)
            Text(String(format: "%.2f", p)).font(.caption.monospacedDigit()).frame(width: 36, alignment: .trailing)
        }
    }
}
