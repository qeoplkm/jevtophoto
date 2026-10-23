// Home: authorize → pick a source → run → see results. Nothing is deleted.
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
                    Text("On this phone, code extracts structured features from each photo (PhotoKit / Vision), hard rules go first, and Jev is asked about the rest: delete or keep, and what kind of photo it is. Results come in three columns. Pixels, file names and OCR text never leave the phone; this app never deletes or changes any photo.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
                Section("Photo library") {
                    if authorized {
                        Label(session.authorization == .limited ? "Authorized (selected photos)" : "Authorized", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                        Picker("Source", selection: $selected) {
                            Text("Choose").tag(PhotoSource?.none)
                            ForEach(session.albums) { s in Text(s.title).tag(PhotoSource?.some(s)) }
                        }
                        Toggle("Also download originals stored in iCloud (slow, uses data)", isOn: $session.allowICloud)
                    } else {
                        Button { Task { await session.requestAccess() } } label: { Label("Allow photo library access", systemImage: "photo.on.rectangle") }
                        if session.authorization == .denied { Text("Access denied: turn it on in Settings › Privacy & Security › Photos.").font(.footnote).foregroundStyle(.secondary) }
                    }
                }
                Section("Jev") {
                    HStack { Text("API key"); Spacer(); Text(session.apiKey.isEmpty ? "Not set" : "Set (\(session.apiKey.prefix(6))…)").foregroundStyle(session.apiKey.isEmpty ? .red : .secondary) }
                    Toggle("Aggressive mode (screenshots / saved images regardless of age, document photos deleted after two weeks, gate 0.2)", isOn: $session.aggressive)
                    HStack { Text("\"Not sure\" gate τ"); Spacer(); Text(String(format: "%.1f", session.tau)).monospacedDigit() }
                    Slider(value: $session.tau, in: 0...0.9, step: 0.1)
                    Button("Settings") { showSettings = true }
                }
                Section {
                    Button {
                        if let s = selected { session.run(s) }
                    } label: {
                        HStack { Spacer(); Text(session.phase.isRunning ? "Running…" : "Start").bold(); Spacer() }
                    }
                    .disabled(!authorized || selected == nil || session.phase.isRunning)
                    switch session.phase {
                    case .idle: EmptyView()
                    case .extracting(let d, let n): ProgressView(value: Double(d), total: Double(n)) { Text("Extracting features \(d)/\(n)") }
                    case .asking(let d, let n): ProgressView(value: Double(d), total: Double(n)) { Text("Asking Jev \(d)/\(n) (\(session.records.count - n) decided by rules)") }
                    case .done:
                        Label("Done: suggest delete \(session.column(.delete).count) · not sure \(session.column(.unsure).count) · keep \(session.column(.keep).count)", systemImage: "checkmark.seal")
                        if let m = session.model { Text(m).font(.caption).foregroundStyle(.secondary) }
                    case .failed(let msg): Label(msg, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    }
                    if !session.records.isEmpty {
                        NavigationLink("See results (\(session.records.count) photos)") { ResultsView() }
                    }
                }
                if !session.log.isEmpty { Section("Errors") { ForEach(session.log, id: \.self) { Text($0).font(.caption).foregroundStyle(.secondary) } } }
            }
            .navigationTitle("JevPhoto")
            .sheet(isPresented: $showSettings) { SettingsView().environmentObject(session) }
            .task {
                if authorized { session.loadAlbums() }
                // headless check: JEV_AUTORUN=recent:50 runs on launch and writes Documents/jevphoto-autorun.json
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
                    Text("Used only to call ~typesafe/jev-latest. Stored in this phone\u{2019}s UserDefaults. Filled in automatically if the build includes Secrets.plist.").font(.footnote).foregroundStyle(.secondary)
                }
                Section("Feedback") {
                    Text("\(session.feedback.count) photos labelled 👍/👎.").font(.footnote)
                    Button("Clear feedback", role: .destructive) { session.feedback = [:]; UserDefaults.standard.removeObject(forKey: "jev.feedback") }
                }
            }
            .navigationTitle("Settings")
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}
