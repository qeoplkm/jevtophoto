// 手机直接调 Jev（OpenRouter）。body 用有序 JSON 手工拼，state 的字段顺序和题库一致。
import Foundation

enum JevError: Error, LocalizedError {
    case noKey, http(Int, String), badResponse(String)
    var errorDescription: String? {
        switch self { case .noKey: return "没有 OpenRouter API key"; case .http(let c, let t): return "HTTP \(c)：\(t.prefix(200))"; case .badResponse(let t): return "返回格式不对：\(t.prefix(200))" }
    }
}

struct JevClient {
    let apiKey: String
    static let endpoint = URL(string: "https://openrouter.ai/api/alpha/decisions")!

    func ask(state: J, questions: J) async throws -> (model: String?, answers: [String: JevAnswer], ms: Int, bytes: Int) {
        let body = J.obj([("model", .s("~typesafe/jev-latest")), ("state", state), ("questions", questions)]).encode()
        var req = URLRequest(url: Self.endpoint)
        req.httpMethod = "POST"
        req.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = body.data(using: .utf8)
        req.timeoutInterval = 30
        var lastError: Error = JevError.badResponse("")
        for attempt in 0..<4 {
            let t0 = Date()
            do {
                let (data, resp) = try await URLSession.shared.data(for: req)
                let code = (resp as? HTTPURLResponse)?.statusCode ?? 0
                let text = String(data: data, encoding: .utf8) ?? ""
                guard (200..<300).contains(code) else { throw JevError.http(code, text) }
                guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any], let answers = root["answers"] as? [String: Any] else { throw JevError.badResponse(text) }
                var out: [String: JevAnswer] = [:]
                if case .obj(let qs) = questions {
                    for (key, q) in qs {
                        guard let a = answers[key] as? [String: Any], let probs = a["probabilities"] as? [String: Any] else { throw JevError.badResponse(text) }
                        // 按 criteria 的顺序取概率：score 题是 "0".."n"，choice 题是 key
                        var ordered: [(String, Double)] = []
                        if case .arr(let levels)? = q["criteria"] { for i in levels.indices { ordered.append((String(i), (probs[String(i)] as? NSNumber)?.doubleValue ?? 0)) } }
                        else if case .obj(let kv)? = q["criteria"] { for (k, _) in kv { ordered.append((k, (probs[k] as? NSNumber)?.doubleValue ?? 0)) } }
                        out[key] = JevAnswer(probabilities: ordered, confidence: (a["confidence"] as? NSNumber)?.doubleValue ?? 0)
                    }
                }
                return (root["model"] as? String, out, Int(Date().timeIntervalSince(t0) * 1000), body.utf8.count)
            } catch {
                lastError = error
                try? await Task.sleep(nanoseconds: UInt64(800_000_000 * (attempt + 1)))
            }
        }
        throw lastError
    }
}
