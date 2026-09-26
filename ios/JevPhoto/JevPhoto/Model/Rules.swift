// 代码硬规则 + 端到端决策，和 tools/capability/rules.js 一一对应。
import Foundation

let RECENT_SCREENSHOT_DAYS = 14
let DEFAULT_TAU = 0.3

struct RuleResult { var verdict: String?; var reason: String? }   // verdict: skip / keep / delete / nil

func applyRules(_ s: FeatureState, recentScreenshotDays: Int = RECENT_SCREENSHOT_DAYS) -> RuleResult {
    if s.isHidden { return RuleResult(verdict: "skip", reason: "隐藏的") }
    if s.sourceType == "typeCloudShared" { return RuleResult(verdict: "skip", reason: "共享相簿里的") }
    if s.isFavorite { return RuleResult(verdict: "keep", reason: "收藏了") }
    if s.adjustmentsState == "userAdjusted" { return RuleResult(verdict: "keep", reason: "用户编辑过") }
    if s.burstSelectionTypes.contains("userPick") { return RuleResult(verdict: "keep", reason: "连拍里用户选中的") }
    if s.mediaSubtypes.contains("photoScreenshot") && s.daysSinceCreation < recentScreenshotDays { return RuleResult(verdict: "skip", reason: "\(recentScreenshotDays) 天内的截图") }
    if s.exactDuplicateCount > 0 { return RuleResult(verdict: "delete", reason: "有一模一样的副本") }
    if s.isSharpestInBurst == false && s.burstSelectionTypes.isEmpty {
        return RuleResult(verdict: "delete", reason: s.burstIdentifier != nil ? "连拍里不是最清晰的" : "连按快门里不是最清晰的")
    }
    return RuleResult(verdict: nil, reason: nil)
}

func decide(_ s: FeatureState, rule: RuleResult, junk: JevAnswer?, tau: Double = DEFAULT_TAU) -> Decision {
    if rule.verdict == "delete" { return Decision(column: .delete, by: "rule", reason: rule.reason ?? "") }
    if rule.verdict == "keep" || rule.verdict == "skip" { return Decision(column: .keep, by: "rule", reason: rule.reason ?? "") }
    guard let j = junk else { return Decision(column: .unsure, by: "none", reason: "没有模型读数") }
    let mode = j.mode, conf = j.confidence
    if mode == "2" || conf < tau {
        return Decision(column: .unsure, by: "jev", reason: mode == "2" ? "模型说不准" : String(format: "置信度 %.2f 不到 %.1f", conf, tau))
    }
    let level = Int(mode) ?? 0
    return Decision(column: mode == "3" ? .keep : .delete, by: "jev", reason: String(format: "%@，置信度 %.2f", JUNK_LEVELS[min(level, JUNK_LEVELS.count - 1)], conf))
}

// 全本地对照：激进档政策写成阈值规则，一次 Jev 都不调（和 tools/extract/local-baseline.js 一致）
func localDecide(_ s: FeatureState, recentScreenshotDays: Int = 3) -> Decision {
    let r = applyRules(s, recentScreenshotDays: recentScreenshotDays)
    if r.verdict == "delete" { return Decision(column: .delete, by: "local", reason: r.reason ?? "") }
    if r.verdict != nil { return Decision(column: .keep, by: "local", reason: r.reason ?? "") }
    let cam = s.model != nil
    if s.faceCount > 0 { return Decision(column: .keep, by: "local", reason: "有人脸") }
    if s.ocrDocType == "id_document" { return Decision(column: .keep, by: "local", reason: "证件") }
    if s.ocrDocType != "none" { return s.daysSinceCreation <= 90 ? Decision(column: .keep, by: "local", reason: "\(s.ocrDocType) 90 天内") : Decision(column: .delete, by: "local", reason: "\(s.ocrDocType) 超过 90 天") }
    if (s.sharpness ?? 1) < 0.25 || (s.meanLuminance ?? 1) < 0.06 { return Decision(column: .delete, by: "local", reason: "糊图 / 黑图") }
    if s.mediaSubtypes.contains("photoScreenshot") || !cam { return s.daysSinceCreation >= 7 ? Decision(column: .delete, by: "local", reason: "截图 / 存图超过一周") : Decision(column: .unsure, by: "local", reason: "截图 / 存图不到一周") }
    if s.isUtility == true && s.textCharCount >= 30 { return s.daysSinceCreation > 14 ? Decision(column: .delete, by: "local", reason: "文档照片超过两周") : Decision(column: .unsure, by: "local", reason: "文档照片两周内") }
    return Decision(column: .keep, by: "local", reason: "相机拍的")
}
