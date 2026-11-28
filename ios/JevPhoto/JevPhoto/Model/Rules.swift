// Hard rules + end-to-end decision, mirroring tools/capability/rules.js one to one.
import Foundation

let RECENT_SCREENSHOT_DAYS = 14
let DEFAULT_TAU = 0.3

struct RuleResult { var verdict: String?; var reason: String? }   // verdict: skip / keep / delete / nil

func applyRules(_ s: FeatureState, recentScreenshotDays: Int = RECENT_SCREENSHOT_DAYS) -> RuleResult {
    if s.isHidden { return RuleResult(verdict: "skip", reason: "hidden") }
    if s.sourceType == "typeCloudShared" { return RuleResult(verdict: "skip", reason: "in a shared album") }
    if s.isFavorite { return RuleResult(verdict: "keep", reason: "favorited") }
    if s.adjustmentsState == "userAdjusted" { return RuleResult(verdict: "keep", reason: "edited by the user") }
    if s.burstSelectionTypes.contains("userPick") { return RuleResult(verdict: "keep", reason: "picked by the user in a burst") }
    if s.mediaSubtypes.contains("photoScreenshot") && s.daysSinceCreation < recentScreenshotDays { return RuleResult(verdict: "skip", reason: "screenshot from the last \(recentScreenshotDays) days") }
    if s.exactDuplicateCount > 0 { return RuleResult(verdict: "delete", reason: "an identical copy exists") }
    if s.isSharpestInBurst == false && s.burstSelectionTypes.isEmpty {
        return RuleResult(verdict: "delete", reason: s.burstIdentifier != nil ? "not the sharpest frame of the burst" : "not the sharpest of a rapid-fire sequence")
    }
    return RuleResult(verdict: nil, reason: nil)
}

func decide(_ s: FeatureState, rule: RuleResult, junk: JevAnswer?, tau: Double = DEFAULT_TAU) -> Decision {
    if rule.verdict == "delete" { return Decision(column: .delete, by: "rule", reason: rule.reason ?? "") }
    if rule.verdict == "keep" || rule.verdict == "skip" { return Decision(column: .keep, by: "rule", reason: rule.reason ?? "") }
    guard let j = junk else { return Decision(column: .unsure, by: "none", reason: "no model reading") }
    let mode = j.mode, conf = j.confidence
    let tied = tiedAcrossColumns(j)
    let known = mode == "0" || mode == "1" || mode == "3"
    if tied || !known || conf < tau {
        let reason: String
        if tied { reason = "top probability is tied" }
        else if mode == "2" { reason = "model is not sure" }
        else if !known { reason = "no unique level" }
        else { reason = String(format: "confidence %.2f below %.1f", conf, tau) }
        return Decision(column: .unsure, by: "jev", reason: reason)
    }
    let level = Int(mode) ?? 0
    return Decision(column: mode == "3" ? .keep : .delete, by: "jev", reason: String(format: "%@, confidence %.2f", JUNK_LEVELS[min(level, JUNK_LEVELS.count - 1)], conf))
}

// True when the highest junk probability is shared by levels that are not all the same column
// (delete = 0 or 1, not sure = 2, keep = 3). Same rule as tiedAcrossColumns in tools/capability/rules.js.
private func tiedAcrossColumns(_ j: JevAnswer) -> Bool {
    let levels = ["0", "1", "2", "3"]
    let dist = Dictionary(j.probabilities, uniquingKeysWith: { first, _ in first })
    let present = levels.compactMap { k -> (String, Double)? in dist[k].map { (k, $0) } }
    guard let best = present.map(\.1).max() else { return false }
    let tied = present.filter { $0.1 == best }.map(\.0)
    if tied.count < 2 { return false }
    func column(_ k: String) -> String { k == "3" ? "keep" : k == "2" ? "unsure" : "delete" }
    return Set(tied.map(column)).count > 1
}

// Fully local comparison: the aggressive policy as threshold rules, no Jev calls at all (same as tools/extract/local-baseline.js)
func localDecide(_ s: FeatureState, recentScreenshotDays: Int = 3) -> Decision {
    let r = applyRules(s, recentScreenshotDays: recentScreenshotDays)
    if r.verdict == "delete" { return Decision(column: .delete, by: "local", reason: r.reason ?? "") }
    if r.verdict != nil { return Decision(column: .keep, by: "local", reason: r.reason ?? "") }
    let cam = s.model != nil
    if s.faceCount > 0 { return Decision(column: .keep, by: "local", reason: "has faces") }
    if s.ocrDocType == "id_document" { return Decision(column: .keep, by: "local", reason: "ID document") }
    if s.ocrDocType != "none" { return s.daysSinceCreation <= 90 ? Decision(column: .keep, by: "local", reason: "\(s.ocrDocType) within 90 days") : Decision(column: .delete, by: "local", reason: "\(s.ocrDocType) older than 90 days") }
    if (s.sharpness ?? 1) < 0.25 || (s.meanLuminance ?? 1) < 0.06 { return Decision(column: .delete, by: "local", reason: "blurry / black frame") }
    if s.mediaSubtypes.contains("photoScreenshot") || !cam { return s.daysSinceCreation >= 7 ? Decision(column: .delete, by: "local", reason: "screenshot / saved image older than a week") : Decision(column: .unsure, by: "local", reason: "screenshot / saved image from the last week") }
    if s.isUtility == true && s.textCharCount >= 30 { return s.daysSinceCreation > 14 ? Decision(column: .delete, by: "local", reason: "document photo older than two weeks") : Decision(column: .unsure, by: "local", reason: "document photo from the last two weeks") }
    return Decision(column: .keep, by: "local", reason: "camera photo")
}
