/**
 * check-narrative-coherence.mjs — 敘事連貫校驗腳本（移植版）
 * ==========================================================
 * 原 scripts/check-narrative-coherence.js 1:1（見《移植報告》映射表 M-06）。
 * 2026-07-04 新增：配合 prose-weaver S4 §5 敘事連貫校驗。
 *
 * 功能：接收一段新寫段落文字，掃描回指模式（「這{名詞}」「那{名詞}」「回到那個問題」等），
 * 反向驗證 antecedent 是否在已寫的上下文中被顯式定義。
 *
 * 掃描規則（字符串比對，非語義判斷）：
 *   第 1 步：閉集掃描 25 個抽象名詞
 *   第 2 步：正則匹配 4 類回指模式
 *   第 3 步：逆向 antecedent 驗證
 *   第 4 步：閘門判定
 */

import { existsP, readText, readTextIfExists, printJson, parseArgs, resolveTextArg } from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// 第 1 步：抽象名詞閉集
export const ABSTRACT_NOUNS = [
  "問題", "結論", "矛盾", "趨勢", "邏輯", "前提", "假設", "路徑",
  "框架", "理論", "觀點", "判斷", "推論", "影響", "衝擊", "效應",
  "意義", "本質", "核心", "關鍵", "基礎", "根源", "分歧", "衝突", "情況"
];

// 第 2 步：回指模式正則
export const PATTERNS = [
  new RegExp("這(個|一|種|套)?(" + ABSTRACT_NOUNS.join("|") + ")"),
  new RegExp("那(個|一)?(" + ABSTRACT_NOUNS.join("|") + ")"),
  new RegExp("回到(最初)?那(個|一)問題"),
  new RegExp("(如此一來|這樣一來)"),
];

// 定義性語境關鍵詞
const DEFINING_KEYWORDS = ["是", "即", "：", "——", "稱為", "叫做", "指"];

const NUM_PATTERN = new RegExp("\\d+[\\.\\d]*%?");
const DATE_PATTERN = new RegExp("\\d{4}[-/年]\\d{1,2}[-/月]\\d{1,2}");

/** 原版 is_defining_context。 */
export function is_defining_context(sentence) {
  for (const kw of DEFINING_KEYWORDS) {
    if (sentence.includes(kw)) return true;
  }
  if (NUM_PATTERN.exec(sentence)) return true;
  if (DATE_PATTERN.exec(sentence)) return true;
  if (new RegExp("^(### |P\\d+[：:])").exec(sentence.trim())) return true;
  return false;
}

/** 原版 extract_core_anchor。 */
export function extract_core_anchor(anchor_text) {
  // 從 S2 問題錨點文字中提取核心內容（去除格式前綴）。
  let core = anchor_text.trim();
  const eq_pos = core.indexOf('=');
  if (eq_pos !== -1) {
    core = core.slice(eq_pos + 1).trim().replace(/^[「」『』"']+|[「」『』"']+$/g, '');
  }
  if (core.startsWith('「') && core.endsWith('」')) {
    core = core.slice(1, -1);
  }
  if (core.startsWith('《') && core.endsWith('》')) {
    core = core.slice(1, -1);
  }
  return core;
}

/** 原版 load_s2_anchors（檔案不存在/IO 錯誤 → 忽略，返回空陣列）。 */
export function load_s2_anchors(s2_anchors_path) {
  const anchors = [];
  try {
    const content = readTextIfExists(s2_anchors_path);
    if (content === null) return anchors;
    const patterns = [
      new RegExp("回答的問題：【(.+?)】", "g"),             // 文本形態
      new RegExp('"回答的問題"\\s*:\\s*"【(.+?)】"', "g"),  // JSON 形態（S2 標準落盤）
    ];
    for (const re of patterns) {
      let m;
      while ((m = re.exec(content)) !== null) {
        const anchor_text = m[1].trim();
        if (anchor_text !== "無") {
          anchors.push(extract_core_anchor(anchor_text));
        }
      }
    }
  } catch (e) {
    // FileNotFoundError / IOError → 忽略
  }
  return anchors;
}

/** 原版 find_defining_sentence。 */
export function find_defining_sentence(prior_text, noun) {
  // 在 prior_text 中查找名詞 noun 的首次出現及其所在句子是否為定義性語境。
  const first_pos = prior_text ? prior_text.indexOf(noun) : -1;
  if (first_pos === -1) {
    return [false, "名詞未在前文中出現", ""];
  }
  let line_start = prior_text.lastIndexOf('\n', first_pos - 1);
  if (line_start === -1) line_start = 0;
  let line_end = prior_text.indexOf('\n', first_pos);
  if (line_end === -1) line_end = prior_text.length;
  const context_sentence = prior_text.slice(line_start, line_end).trim();
  const defining = is_defining_context(context_sentence);
  if (defining) {
    return [true, "定義性語境", context_sentence];
  }
  return [false, "非定義性語境", context_sentence];
}

/** 原版 scan_text（1:1）。 */
export function scan_text(text, prior_text, s2_anchors) {
  const results = {
    "dangling_references": [],
    "structural_defects": [],
    "pattern_matches": []
  };

  for (const pat of PATTERNS) {
    const re = new RegExp(pat.source, "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const matched_text = m[0];
      results["pattern_matches"].push({
        "match": matched_text,
        "position": m.index
      });

      let noun = null;
      for (const n of ABSTRACT_NOUNS) {
        if (matched_text.includes(n)) {
          noun = n;
          break;
        }
      }

      // 特殊規則：模式(3)「回到(最初)?那個問題」
      if (noun === "問題" && matched_text.startsWith("回到")) {
        if (s2_anchors.length) {
          let found = false;
          for (const anchor of s2_anchors) {
            if (!anchor) continue;
            const anchor_norm = anchor.replace(/\s+/g, '');
            const prior_norm = prior_text.replace(/\s+/g, '');
            if (prior_norm.includes(anchor_norm)) {
              found = true;
              break;
            }
          }
          if (!found) {
            results["structural_defects"].push({
              "match": matched_text,
              "reason": "S2 問題錨點核心內容未在上下文中找到定義句"
            });
          }
        } else {
          results["structural_defects"].push({
            "match": matched_text,
            "reason": "S2「回答的問題」字段缺失，無法驗證問題錨點"
          });
        }
        continue;
      }

      // 一般情況：掃描 dangling reference
      if (noun) {
        const [defining, reason, context] = find_defining_sentence(prior_text, noun);
        if (!defining) {
          results["dangling_references"].push({
            "match": matched_text,
            "noun": noun,
            "reason": "名詞「" + noun + "」" + reason
          });
        }
      }

      // 模式(4)：如此一來/這樣一來
      if (matched_text === "如此一來" || matched_text === "這樣一來") {
        const cause_markers = ["因為", "由於", "鑑於", "所以", "因此", "導致"];
        const has_cause = prior_text ? cause_markers.some(cm => prior_text.slice(-500).includes(cm)) : false;
        if (!has_cause) {
          results["dangling_references"].push({
            "match": matched_text,
            "noun": "因果",
            "reason": "「" + matched_text + "」出現但前500字無因果標記"
          });
        }
      }
    }
  }

  return results;
}

/**
 * dispatchNarrativeCoherence(opts) —— 原版 main() 的對象參數直調版。
 * opts: { text: 段落文字（字符串）, "prior-text"?: 已寫文字（字符串，默認 ""）,
 *         "s2-anchors"?: S2 JSON 路徑（默認 ""） }
 * 注意：原版 --s2-anchors 路徑不存在時靜默忽略（load_s2_anchors 捕獲 IO 錯誤）。
 */
export function dispatchNarrativeCoherence(opts) {
  if (!opts["text"]) {
    return { "status": "error", "message": "缺少必要參數 --text", "exit_code": 1 };
  }

  const s2_anchors = opts["s2-anchors"] ? load_s2_anchors(opts["s2-anchors"]) : [];
  // --text / --prior-text 支援「文件路徑 or 內聯文字」雙形態（見 pw-compat resolveTextArg）
  const scan_results = scan_text(resolveTextArg(opts["text"]), resolveTextArg(opts["prior-text"] || ""), s2_anchors);

  const passed = (
    scan_results["dangling_references"].length === 0
    && scan_results["structural_defects"].length === 0
  );

  const output = {
    "passed": passed,
    "dangling_reference_count": scan_results["dangling_references"].length,
    "structural_defect_count": scan_results["structural_defects"].length,
    "pattern_match_count": scan_results["pattern_matches"].length,
    "dangling_references": scan_results["dangling_references"],
    "structural_defects": scan_results["structural_defects"],
    "pattern_matches": scan_results["pattern_matches"],
    "exit_code": passed ? 0 : 1
  };
  return output;
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchNarrativeCoherence(opts);
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配）
//   node check-narrative-coherence.mjs --text {段落文字或路徑} \
//     --prior-text {已寫全文或路徑（首段可省略）} --s2-anchors prose-tmp/prose-s2.json
//   stdout 輸出 JSON；exit code 1 = dangling reference / 重大結構缺陷
// ---------------------------------------------------------------------------

const CLI_OPTS = {
  text: { type: "str" },
  "prior-text": { type: "str" },
  "s2-anchors": { type: "str" },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchNarrativeCoherence(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
