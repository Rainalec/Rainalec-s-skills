/**
 * check-inference-boundary.mjs — 推論邊界校驗閘門（移植版）
 * ======================================================
 * 原 scripts/check-inference-boundary.js 1:1（見《移植報告》映射表 M-11）。
 * prose-weaver S4 §8。檢查 LLM 在寫作時自行引入的群體性判斷、確定性結論、
 * 心理描寫、絕對修飾是否超出原始素材的支持範圍。
 *
 * 輸入（dispatch 對象鍵名 = 原 CLI 長選項）：
 *   text    剛寫完的段落文字（字符串）
 *   source  S1 原料 JSON 路徑（原 /tmp/prose-s1.json → prose-tmp/prose-s1.json）
 *   output  輸出 JSON 路徑
 *
 * 輸出格式（JSON）：
 * {
 *   "group_judgments": [...],
 *   "certainty_conclusions": [...],
 *   "psychological_descriptions": [...],
 *   "absolute_modifiers": [...],
 *   "verdict": "pass|warning|critical"
 * }
 *
 * 形式適配（均已公示）：
 *   - matchAll → pw-compat.matchIter（等價 exec 循環）；
 *   - 原版 pyWordBoundaryRegex 的 \p{L}\p{N}（指令書附錄未實測，目標環境不可依賴）
 *     → 等價字符類 [一-鿿A-Za-z0-9_]（見本檔 pyWordBoundaryRegex 註釋）；
 *   - 後行斷言 (?<!...) 指令書實測可用 → PSYCHOLOGY_PATTERNS 原樣保留；
 *   - safeLoad 讀檔失敗：原版 printJson + pyExit(1) 終止 → dispatch 返回
 *     {status:"error", exit_code:1}（QuickJS 無 process.exit，終止語義以返回值表達）。
 */

import { matchIter, readText, writeText, printJson, println, parseArgs, resolveTextArg } from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// ---- local helpers（原版 isDict/isList/isStr）----
function isDict(x) { return typeof x === "object" && x !== null && !Array.isArray(x); }
function isList(x) { return Array.isArray(x); }
function isStr(x) { return typeof x === "string"; }

// (1) 群體性判斷關鍵詞
export const GROUP_JUDGMENT_PATTERNS = [
  "沒有人[會想]?[就還]?",
  "所有人[都就]?",
  "誰都知道",
  "每個人都",
  "人人都",
  "無人不知",
  "誰都[會能]?",
];

// (2) 確定性結論關鍵詞
export const CERTAINTY_PATTERNS = [
  "一定是",
  "註定",
  "不可能",
  "無可避免",
  "鐵定",
  "必定",
  "必然會",
  "絕對會",
  "完全(?:是|不|沒有|錯了|一樣)",
  "徹底(?:是|不|改變|推翻|否定)",
  "實乃",
  "根本不|根本就|根本沒|根本無",
  "勢必",
  "全盤|全然|全錯|全賭",
  "斷言",
];

// (3) 心理描寫關鍵詞（排除「我認為」「我們認為」「分析認為」）
export const PSYCHOLOGY_PATTERNS = [
  ["(?<!我)(?<!我們)(?<!分析)(?<!本文)覺得", "覺得"],
  ["(?<!我)(?<!我們)(?<!分析)(?<!本文)感到", "感到"],
  ["(?<!我)(?<!我們)(?<!分析)(?<!本文)認為", "認為"],
  ["(?<!我)(?<!我們)(?<!分析)(?<!本文)猜想", "猜想"],
  ["(?<!我)(?<!我們)(?<!分析)(?<!本文)以為", "以為"],
];

// (4) 絕對修飾關鍵詞（\b 由 pyWordBoundaryRegex 做等價邊界處理）
export const ABSOLUTE_MODIFIER_PATTERNS = [
  "\\b任何[人都]?",
  "\\b一切[事物都]?",
  "\\b從不",
  "\\b永遠",
  "\\b全部",
  "\\b所有[的人事]?",
  "\\b絲毫[沒有不]?",
];

// 確定性關鍵詞的「軟化對照」— S1 若包含此類詞，則不應升級為確定語氣
export const SOFTENING_WORDS = [
  "可能", "或許", "大概", "也許", "恐怕", "不一定",
  "不確定", "尚未", "有待", "預計", "預測", "推測",
  "估計", "約", "近", "左右", "上下",
];

/**
 * 原版 pyWordBoundaryRegex 的公示性等價替換。
 * 原版：pat.replace(/\\b/g, "(?<![\\p{L}\\p{N}_])") + "gu" 標誌 ——
 *       Python 3 的 \b 將 CJK 視為詞字符；JS \b 僅 ASCII，故以 Unicode 屬性類模擬。
 * 移植：\p{L}/\p{N} 屬 Unicode 屬性轉義，指令書附錄 A/B 未對其做「可用」實測標註，
 *       按鐵律不得依賴 → 改用 [一-鿿A-Za-z0-9_]：
 *       一-鿿 = U+4E00–U+9FFF（CJK 統一表意文字主區塊，覆蓋全部常用漢字），
 *       A-Za-z0-9_ 覆蓋 ASCII 字母/數字/下劃線。
 *       差異僅在「絕對修飾詞前置字符為全角字母/假名/諺文等」時出現——prose-weaver
 *       的中文寫作工作流中不存在該場景。已登記《移植報告》缺口公示。
 */
function pyWordBoundaryRegex(pat) {
  const emulated = pat.replace(/\\b/g, "(?<![一-鿿A-Za-z0-9_])");
  return new RegExp(emulated, "gu");
}

/** 原版 extractNgramKeywords（1:1）。 */
export function extractNgramKeywords(text, maxLen) {
  maxLen = maxLen || 2;
  const keywords = [];
  const segments = matchIter(text, /[一-鿿]+/g).map(m => m[0]);
  for (const segment of segments) {
    for (let i = 0; i < segment.length - maxLen + 1; i++) {
      keywords.push(segment.slice(i, i + maxLen));
    }
  }
  const seen = new Set();
  const unique = [];
  for (const k of keywords) {
    if (!seen.has(k)) { seen.add(k); unique.push(k); }
  }
  return unique;
}

/** 原版 checkGroupJudgments（1:1；含「說實話」等懺悔詞 support 邏輯）。 */
export function checkGroupJudgments(text, sourceText) {
  const results = [];

  for (const pattern of GROUP_JUDGMENT_PATTERNS) {
    for (const m of matchIter(text, new RegExp(pattern, "gu"))) {
      const start = Math.max(0, m.index - 20);
      const end = Math.min(text.length, m.index + m[0].length + 40);
      const context = text.slice(start, end);

      const judgmentContent = text.slice(m.index + m[0].length, m.index + m[0].length + 30);

      let hasSupport = false;
      const keywordsInContent = extractNgramKeywords(judgmentContent);

      const confessionHits = ["說實話", "老實說", "坦率說", "坦白說"].filter(mm => text.indexOf(mm) !== -1);
      if (confessionHits.length) {
        const firstPos = Math.min(...confessionHits.map(mm => text.indexOf(mm)));
        const claimText = text.slice(firstPos + 4, Math.min(firstPos + 60, text.length));
        const claimKeywords = extractNgramKeywords(claimText);
        const uniq = Array.from(new Set(claimKeywords));
        const matchCount = uniq.filter(kw => sourceText.indexOf(kw) !== -1).length;
        hasSupport = matchCount >= 2;
      }

      for (const kw of keywordsInContent) {
        if (sourceText.indexOf(kw) !== -1) { hasSupport = true; break; }
      }

      const severity = hasSupport ? "warning" : "critical";

      results.push({
        "pattern": pattern,
        "match": m[0],
        "context": context,
        "judgment_content": judgmentContent,
        "has_source_support": hasSupport,
        "severity": severity
      });
    }
  }

  return results;
}

/** 原版 checkCertaintyConclusions（1:1；softening 對照升級判定）。 */
export function checkCertaintyConclusions(text, sourceText) {
  const results = [];

  for (const pattern of CERTAINTY_PATTERNS) {
    for (const m of matchIter(text, new RegExp(pattern, "gu"))) {
      const start = Math.max(0, m.index - 30);
      const end = Math.min(text.length, m.index + m[0].length + 50);
      const context = text.slice(start, end);

      const conclusionStart = m.index + m[0].length;
      const conclusionText = text.slice(conclusionStart, Math.min(text.length, conclusionStart + 40));

      let hasSoftening = false;
      const conclusionKeywords = extractNgramKeywords(conclusionText);

      for (const ckw of conclusionKeywords) {
        const idx = sourceText.indexOf(ckw);
        if (idx >= 0) {
          const nearby = sourceText.slice(Math.max(0, idx - 40), idx + ckw.length + 40);
          for (const soft of SOFTENING_WORDS) {
            if (nearby.indexOf(soft) !== -1) { hasSoftening = true; break; }
          }
          if (hasSoftening) break;
        }
      }

      const severity = hasSoftening ? "critical" : "warning";

      results.push({
        "pattern": pattern,
        "match": m[0],
        "context": context,
        "conclusion_scope": conclusionText,
        "source_uses_softening": hasSoftening,
        "severity": severity
      });
    }
  }

  return results;
}

/** 原版 checkPsychologicalDescriptions（1:1；含方位詞排除與感知詞 support）。 */
export function checkPsychologicalDescriptions(text, sourceText) {
  const results = [];

  for (const [pattern, keyword] of PSYCHOLOGY_PATTERNS) {
    for (const m of matchIter(text, new RegExp(pattern, "gu"))) {
      const start = Math.max(0, m.index - 20);
      const end = Math.min(text.length, m.index + m[0].length + 30);
      const context = text.slice(start, end);

      const preText = text.slice(Math.max(0, m.index - 15), m.index);
      const subjectKeywords = extractNgramKeywords(preText);

      let hasSource = false;
      for (const skw of subjectKeywords) {
        if (["東方", "西方", "北方", "南方"].indexOf(skw) !== -1) continue;
        if (skw.length >= 2 && sourceText.indexOf(skw) !== -1) {
          const idx = sourceText.indexOf(skw);
          const nearby = sourceText.slice(Math.max(0, idx - 20), idx + skw.length + 80);
          for (const perceptionWord of ["覺得", "感到", "認為", "擔心", "擔憂", "警惕", "關注"]) {
            if (nearby.indexOf(perceptionWord) !== -1) { hasSource = true; break; }
          }
          if (hasSource) break;
        }
      }

      const severity = hasSource ? "pass" : "warning";

      results.push({
        "keyword": keyword,
        "match": m[0],
        "context": context,
        "subject": subjectKeywords,
        "has_source": hasSource,
        "severity": severity
      });
    }
  }

  return results;
}

/** 原版 checkAbsoluteModifiers（1:1；邊界經 pyWordBoundaryRegex 等價替換）。 */
export function checkAbsoluteModifiers(text, sourceText) {
  const results = [];

  for (const pattern of ABSOLUTE_MODIFIER_PATTERNS) {
    for (const m of matchIter(text, pyWordBoundaryRegex(pattern))) {
      const start = Math.max(0, m.index - 20);
      const end = Math.min(text.length, m.index + m[0].length + 40);
      const context = text.slice(start, end);

      const objStart = m.index + m[0].length;
      const objText = text.slice(objStart, Math.min(text.length, objStart + 20));

      const absoluteKeyword = m[0].trim();
      const hasAbsoluteInSource = sourceText.indexOf(absoluteKeyword) !== -1;

      const severity = hasAbsoluteInSource ? "pass" : "warning";

      results.push({
        "pattern": pattern,
        "match": m[0],
        "context": context,
        "modified_object": objText,
        "has_absolute_in_source": hasAbsoluteInSource,
        "severity": severity
      });
    }
  }

  return results;
}

/** 原版 checkInferenceBoundary（1:1）。 */
export function checkInferenceBoundary(text, sourceJson) {
  let sourceText = "";
  if (isDict(sourceJson)) {
    sourceText = ("raw_text" in sourceJson) ? sourceJson.raw_text
      : (("text" in sourceJson) ? sourceJson.text : JSON.stringify(sourceJson));
  }

  const groupJudgments = checkGroupJudgments(text, sourceText);
  const certaintyConclusions = checkCertaintyConclusions(text, sourceText);
  const psychDesc = checkPsychologicalDescriptions(text, sourceText);
  const absModifiers = checkAbsoluteModifiers(text, sourceText);

  const hasCritical = (
    groupJudgments.some(r => r.severity === "critical") ||
    certaintyConclusions.some(r => r.severity === "critical")
  );
  const hasWarning = (
    hasCritical ||
    groupJudgments.some(r => r.severity === "warning") ||
    certaintyConclusions.some(r => r.severity === "warning") ||
    psychDesc.some(r => r.severity === "warning") ||
    absModifiers.some(r => r.severity === "warning")
  );

  const verdict = hasCritical ? "critical" : (hasWarning ? "warning" : "pass");

  return {
    "group_judgments": groupJudgments,
    "certainty_conclusions": certaintyConclusions,
    "psychological_descriptions": psychDesc,
    "absolute_modifiers": absModifiers,
    "verdict": verdict
  };
}

/** 原版 safeLoad（讀失敗 → 拋錯由 dispatch 終止；解析失敗 → 當原文字符串）。 */
function safeLoad(p) {
  const content = readText(p); // 失敗拋 Error（等價原版 printJson + pyExit(1) 終止路徑）
  try { return JSON.parse(content); }
  catch (e) { return content; }
}

/**
 * dispatchInferenceBoundary(opts) —— 原版 main() 直調版。
 * opts: { text: 段落文字, source: S1 JSON 路徑, output: 輸出 JSON 路徑 }
 */
export function dispatchInferenceBoundary(opts) {
  if (!opts["text"] || !opts["source"] || !opts["output"]) {
    const err = { "status": "error", "message": "--text, --source, --output 皆為必填", "exit_code": 1 };
    printJson(err);
    return err;
  }

  let sourceJson;
  try {
    sourceJson = safeLoad(opts["source"]);
  } catch (e) {
    const err = { "status": "error", "message": "無法讀取: " + e.message, "exit_code": 1 };
    printJson(err);
    return err;
  }

  const result = checkInferenceBoundary(resolveTextArg(opts["text"]), sourceJson);

  writeText(opts["output"], JSON.stringify(result, null, 2));

  const icons = { "pass": "✅", "warning": "🟡", "critical": "🔴" };
  println("[推論邊界校驗] 判定：" + (icons[result.verdict] || "❓") + " " + result.verdict);

  for (const r of result.group_judgments) {
    println("  " + (icons[r.severity] || "❓") + " 群體判斷：「" + r.match + "」S1支持=" + (r.has_source_support ? "✅" : "❌"));
  }
  for (const r of result.certainty_conclusions) {
    println("  " + (icons[r.severity] || "❓") + " 確定結論：「" + r.match + "」S1推測語氣=" + (r.source_uses_softening ? "✅" : "❌"));
  }
  for (const r of result.psychological_descriptions) {
    println("  " + (icons[r.severity] || "❓") + " 心理描寫：「" + r.keyword + "」S1對應=" + (r.has_source ? "✅" : "❌"));
  }
  for (const r of result.absolute_modifiers) {
    println("  " + (icons[r.severity] || "❓") + " 絕對修飾：「" + r.match + "」S1對應=" + (r.has_absolute_in_source ? "✅" : "❌"));
  }

  return result;
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchInferenceBoundary(opts);
  return result;
}

// 未使用 helper 顯式引用，保持原版結構完整（isList/isStr 由原版 1:1 保留）
void isList; void isStr;


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配）
//   node check-inference-boundary.mjs --text {段落或路徑} --source prose-tmp/prose-s1.json \
//     --output prose-tmp/prose-inference-warnings.json
//   stdout 輸出 JSON；exit code 1 = status error（verdict 判定讀 JSON verdict 欄位）
// ---------------------------------------------------------------------------

const CLI_OPTS = { text: { type: "str" }, source: { type: "str" }, output: { type: "str" } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchInferenceBoundary(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
