/**
 * s1-verify-classification.mjs — S1 分類校驗閘門（移植版）
 * ========================================================
 * 原 scripts/s1-verify-classification.js 1:1（見《移植報告》映射表 M-04）。
 * 在 S1 完成後執行，驗證 JSON 結構完整性和標籤一致性。
 * 審計模式（非強制閘門）：檢出問題時輸出警報但不會阻止流程。
 *
 * 輸出（printJson 至宿主可見日誌）：
 *   {"status": "ok", "paragraphs": 9, "issues": 0}
 *   {"status": "issues_found", "paragraphs": 9, "issues": 2, ...}
 */

import { tmpPath, existsP, readText, printJson, parseArgs } from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// S1 分類表中定義的 10 個合法標籤
export const VALID_TAGS = new Set([
  "fact", "judgment", "inference", "cause", "effect",
  "temporal", "data", "rhetoric", "transition", "uncertain",
]);

// inference 與 cause/effect 衝突規則
const CAUSE_EFFECT_TAGS = new Set(["cause", "effect"]);
const INFERENCE_TAG = new Set(["inference"]);

/** 原版 verify(input_path)（1:1）。 */
export function verify(input_path) {
  const issues = [];
  const warnings = [];

  if (!existsP(input_path)) {
    return { "status": "error", "paragraphs": 0, "issues": 1, "details": ["檔案不存在: " + input_path], "exit_code": 1 };
  }

  let data;
  try {
    data = JSON.parse(readText(input_path));
  } catch (e) {
    return { "status": "error", "paragraphs": 0, "issues": 1, "details": ["JSON 解析失敗: " + e.message], "exit_code": 1 };
  }

  // 檢查頂層必填字段
  const required_fields = ["paragraphs", "total_paragraph_match_rate"];
  for (const field of required_fields) {
    if (!(field in data)) {
      issues.push({ "field": field, "issue": "缺少必填字段: " + field });
    }
  }

  // 驗證匹配率
  let match_rate = data.total_paragraph_match_rate !== undefined ? data.total_paragraph_match_rate : "";
  if (typeof match_rate === "string" && match_rate.indexOf("%") !== -1) {
    try {
      const rate_val = parseFloat(match_rate.replace("%", "").trim());
      if (rate_val < 80) {
        warnings.push({ "field": "total_paragraph_match_rate", "issue": "匹配率 " + rate_val + "% < 80%" });
      }
    } catch (e) {
      issues.push({ "field": "total_paragraph_match_rate", "issue": "匹配率格式無法解析: " + match_rate });
    }
  } else if (typeof match_rate !== "string" || !match_rate) {
    issues.push({ "field": "total_paragraph_match_rate", "issue": "匹配率缺失或無效" });
  }

  // 驗證 paragraphs 結構
  let paragraphs = data.paragraphs !== undefined ? data.paragraphs : {};
  if (typeof paragraphs !== "object" || paragraphs === null || Array.isArray(paragraphs)) {
    issues.push({ "field": "paragraphs", "issue": "paragraphs 必須是 dict" });
    paragraphs = {};
  }

  const para_count = Object.keys(paragraphs).length;
  const isDigit = s => /^\d+$/.test(s);
  Object.keys(paragraphs)
    .sort((a, b) => (isDigit(a) ? parseInt(a, 10) : 0) - (isDigit(b) ? parseInt(b, 10) : 0))
    .forEach(pid => {
      const pdata = paragraphs[pid];
      const p_issues = [];

      // 檢查 text 字段
      const text = pdata.text !== undefined ? pdata.text : "";
      if (!text || typeof text !== "string") {
        p_issues.push("段落 " + pid + ": text 缺失或非字符串");
      }

      // 檢查 tags 字段
      const tags = pdata.tags !== undefined ? pdata.tags : [];
      if (!Array.isArray(tags)) {
        p_issues.push("段落 " + pid + ": tags 必須是 list");
        return;
      }

      if (!tags.length) {
        warnings.push("段落 " + pid + ": tags 為空（可能漏分類）");
        return;
      }

      // 檢查標籤合法性
      for (const tag of tags) {
        if (!VALID_TAGS.has(tag)) {
          p_issues.push("段落 " + pid + ": 非法標籤「" + tag + "」");
        }
      }

      // 檢查 inference 與 cause/effect 衝突規則
      const has_cause_effect = Array.from(CAUSE_EFFECT_TAGS).some(t => tags.indexOf(t) !== -1);
      const has_inference = Array.from(INFERENCE_TAG).some(t => tags.indexOf(t) !== -1);
      if (has_cause_effect && has_inference) {
        warnings.push("段落 " + pid + ": 同時包含 cause/effect 和 inference（應已降級移除 inference）");
      }

      if (p_issues.length) {
        for (const pi of p_issues) issues.push({ "paragraph": pid, "issue": pi });
      }
    });

  // 檢查 raw_text（選用字段，不作強制要求）
  if (!("raw_text" in data)) {
    warnings.push("缺少 raw_text 字段（可選，但供修辭/推論腳本使用）");
  }

  // 綜合判定
  const status = issues.length ? "issues_found" : "ok";
  const result = {
    "status": status,
    "paragraphs": para_count,
    "issues": issues.length,
    "warnings": warnings.length,
    "issue_details": issues.slice(0, 10),  // 最多顯示 10 條
    "warning_details": warnings.slice(0, 10),
  };
  return result;
}

/**
 * dispatchS1Verify(opts) —— 原版 main() 的對象參數直調版。
 * opts: { input: string（如 prose-tmp/prose-s1.json） }
 */
export function dispatchS1Verify(opts) {
  if (opts["input"] === null || opts["input"] === undefined || opts["input"] === "") {
    return { "status": "error", "message": "--input 為必填項", "exit_code": 1 };
  }
  const result = verify(opts["input"]);
  if (result.status === "error") {
    result["exit_code"] = 1;
  }
  return result;
}

/** 便捷入口：校驗預設路徑 prose-tmp/prose-s1.json 並輸出。 */
export function run(opts) {
  const result = dispatchS1Verify(opts || { "input": tmpPath("prose-s1.json") });
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配）
//   node s1-verify-classification.mjs --input prose-tmp/prose-s1.json
//   stdout 輸出 JSON；exit code 1 = error
// ---------------------------------------------------------------------------

const CLI_OPTS = { input: { type: "str" } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchS1Verify(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
