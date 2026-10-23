// Ordered JSON: the state's key order is part of the prompt, and Dictionary does not preserve order, so encode by hand.
import Foundation

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

    subscript(key: String) -> J? {
        if case .obj(let kv) = self { return kv.first { $0.0 == key }?.1 }
        return nil
    }
    var string: String? { if case .s(let s) = self { return s }; return nil }
    var double: Double? {
        switch self { case .d(let d): return d; case .i(let i): return Double(i); default: return nil }
    }

    func encode(pretty: Bool = false, _ ind: Int = 0) -> String {
        let nl = pretty ? "\n" : "", sp = pretty ? " " : ""
        let pad = pretty ? String(repeating: " ", count: ind) : "", pad1 = pretty ? String(repeating: " ", count: ind + 1) : ""
        switch self {
        case .obj(let kv):
            if kv.isEmpty { return "{}" }
            return "{" + nl + kv.map { "\(pad1)\"\(J.escape($0.0))\":\(sp)\($0.1.encode(pretty: pretty, ind + 1))" }.joined(separator: "," + nl) + nl + pad + "}"
        case .arr(let a):
            if a.isEmpty { return "[]" }
            return "[" + a.map { $0.encode(pretty: pretty, ind + 1) }.joined(separator: "," + sp) + "]"
        case .s(let s): return "\"" + J.escape(s) + "\""
        case .d(let d): return String(format: "%.6g", d)
        case .i(let i): return String(i)
        case .b(let b): return b ? "true" : "false"
        case .null: return "null"
        }
    }
    private static func escape(_ s: String) -> String {
        var out = ""
        for c in s.unicodeScalars {
            switch c {
            case "\"": out += "\\\""; case "\\": out += "\\\\"; case "\n": out += "\\n"; case "\r": out += "\\r"; case "\t": out += "\\t"
            default: if c.value < 0x20 { out += String(format: "\\u%04x", c.value) } else { out.unicodeScalars.append(c) }
            }
        }
        return out
    }
}
