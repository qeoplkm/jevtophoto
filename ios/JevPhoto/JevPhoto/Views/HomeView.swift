// 首页：授权 → 选来源 → 跑 → 看结果。不删任何东西。
import SwiftUI
import Photos

struct HomeView: View {
    @EnvironmentObject var session: Session
    @State private var selected: PhotoSource? = nil
    @State private var showResults = false
    @State private var showSettings = false

    var authorized: Bool { session.authorization == .authorized || session.authorization == .limited }

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("代码在手机上从每张照片抽结构化特征（PhotoKit / Vision），规则先过一遍，剩下的问 Jev「该不该删、是哪类」，分三栏给你看。像素、文件名、OCR 原文都不出手机；这个 app 不会删除或修改任何照片。")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("相册") {
                    if authorized {
                        Label(session.authorization == .limited ? "已授权（部分照片）" : "已授权", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        Picker("来源", selection: $selected) {
                            Text("选一个").tag(PhotoSource?.none)
                            ForEach(session.albums) { s in Text(s.title).tag(PhotoSource?.some(s)) }
                        }
                        Toggle("原图在 iCloud 的也下载（慢，费流量）", isOn: $session.allowICloud)
                    } else {
                        Button { Task { await session.requestAccess() } } label: { Label("允许读取相册", systemImage: "photo.on.rectangle") }
                        if session.authorization == .denied { Text("被拒绝了：到 设置 › 隐私与安全性 › 照片 里打开。").font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                Section("Jev") {
                    HStack { Text("API key"); Spacer(); Text(session.apiKey.isEmpty ? "未设置" : "已设置（\(session.apiKey.prefix(6))…）").foregroundStyle(session.apiKey.isEmpty ? .red : .secondary) }
                    Toggle("激进模式（截图 / 存图不看天数，文档照片过两周就删，门槛 0.2）", isOn: $session.aggressive)
                    HStack { Text("拿不准的门槛 τ"); Spacer(); Text(String(format: "%.1f", session.tau)).monospacedDigit() }
                    Slider(value: $session.tau, in: 0...0.9, step: 0.1)
                    Button("设置") { showSettings = true }
                }
                Section {
                    Button {
                        if let s = selected { session.run(s) }
                    } label: {
                        HStack { Spacer(); Text(session.phase.isRunning ? "跑着呢…" : "开始").bold(); Spacer() }
                    }
                    .disabled(!authorized || selected == nil || session.phase.isRunning)
                    switch session.phase {
                    case .idle: EmptyView()
                    case .extracting(let d, let n): ProgressView(value: Double(d), total: Double(n)) { Text("抽特征 \(d)/\(n)") }
                    case .asking(let d, let n): ProgressView(value: Double(d), total: Double(n)) { Text("问 Jev \(d)/\(n)（规则已定 \(session.records.count - n) 条）") }
                    case .done:
                        Label("完成：建议删除 \(session.column(.delete).count) · 拿不准 \(session.column(.unsure).count) · 保留 \(session.column(.keep).count)", systemImage: "checkmark.seal")
                        if let m = session.model { Text(m).font(.caption).foregroundStyle(.secondary) }
                    case .failed(let msg): Label(msg, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    }
                    if !session.records.isEmpty {
                        NavigationLink("看结果（\(session.records.count) 张）") { ResultsView() }
                    }
                }
                if !session.log.isEmpty { Section("错误") { ForEach(session.log, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) } } }
            }
            .navigationTitle("JevPhoto")
            .sheet(isPresented: $showSettings) { SettingsView().environmentObject(session) }
            .task {
                if authorized { session.loadAlbums() }
                // 无头验证：JEV_AUTORUN=recent:50 启动就跑，结果写到 Documents/jevphoto-autorun.json
                if let spec = ProcessInfo.processInfo.environment["JEV_AUTORUN"], session.phase == .idle {
                    if let prof = ProcessInfo.processInfo.environment["JEV_PROFILE"] { session.aggressive = (prof == "aggressive") }
                    if !authorized { await session.requestAccess() }
                    let n = Int(spec.split(separator: ":").last ?? "50") ?? 50
                    session.run(.recent(n))
                    while session.phase.isRunning || session.phase == .idle { try? await Task.sleep(nanoseconds: 300_000_000) }
                    if let dir = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                        try? session.exportJSON().encode(pretty: true).write(to: dir.appendingPathComponent("jevphoto-autorun.json"), atomically: true, encoding: .utf8)
                    }
                }
            }
        }
    }
}

struct SettingsView: View {
    @EnvironmentObject var session: Session
    @Environment(\.dismiss) var dismiss
    var body: some View {
        NavigationStack {
            Form {
                Section("OpenRouter API key") {
                    SecureField("sk-or-…", text: $session.apiKey)
                    Text("只用来调 ~typesafe/jev-latest。存在这台手机的 UserDefaults 里。打包时若带了 Secrets.plist 会自动填。").font(.footnote).foregroundStyle(.secondary)
                }
                Section("反馈") {
                    Text("已标记 \(session.feedback.count) 条 👍/👎。").font(.footnote)
                    Button("清空反馈", role: .destructive) { session.feedback = [:]; UserDefaults.standard.removeObject(forKey: "jev.feedback") }
                }
            }
            .navigationTitle("设置")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
        }
    }
}
