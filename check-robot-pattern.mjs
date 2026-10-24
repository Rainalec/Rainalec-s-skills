/**
 * check-robot-pattern.mjs — AI模式檢測（18類字串掃描）（移植版）
 * ===============================================================
 * 原 scripts/check-robot-pattern.js 1:1（見《移植報告》映射表 M-09）。
 * 用於 S4 逐段跳出檢查（3類核心）及 S6 全篇掃描（18類）。
 * 支援 frequency-threshold 參數，用於 S6 上下文感知去重。
 * 純字符串比對，無語義判斷。
 *
 * v1.4.0 (2026-09-20)：合併 Humanizer-zh-TW 獨有品類（新類別 22-36，12 類腳本化）：
 *   - 字串類：visibility_stacking / challenge_formula / chat_residue / knowledge_cutoff /
 *     sycophancy / overqualification / generic_positive_ending
 *   - 計數類：emdash_density / bold_overuse / emoji_prop / embedded_heading_list / curve_quotes
 * v1.3.0 (2026-07-24)：新增 humanizer-zh 模式集成（5類）：
 *   - significance_copula：意義誇大 + 系詞迴避
 *   - ai_vocabulary_selected：AI 高頻詞精選
 *   - vague_attribution：模糊歸因
 *   - superficial_tail：膚淺分析 tail 模式
 *   - promotional_filler：宣傳腔 + 填充短語
 *
 * 姊妹腳本參考：step-content-guard / step-manager / chain-gate / qa-gate。
 */

import { existsP, readText, printJson, parseArgs, resolveTextArg } from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

/** 模組版本（供 SKILL.md M1 佈署版本閘比對；v1.4.0 = Humanizer-zh-TW 品類合併）。 */
export const MOD_VERSION = "1.4.0";

// 檢測模式（原版 1:1）
export const PATTERNS = {
  "ai_transition": [
    "值得注意的是", "總的來說", "不可否認的是", "毋庸置疑", "不可忽視的是",
    "不容忽視", "顯而易見", "無可否認", "毫無疑問", "不難看出",
  ],
  "listing": [
    "首先", "其次", "再次", "最後",
    "第一", "第二", "第三", "第四", "第五",
    "其一", "其二", "其三",
  ],
  "long_sentence": null,  // 特殊處理：連續3句 > 30字符
  "self_correcting_negation": null,  // 特殊處理：「不是…是…」模式
  // --- 2026-07-24 新增：humanizer-zh 模式集成 ---
  "significance_copula": [
    "標誌著", "見證了", "作為…而",
  ],  // 意義誇大 + 系詞迴避。其餘用 regex（見 check_significance_regex）
  "ai_vocabulary_selected": [
    "此外", "至關重要", "深入探討", "織錦", "彰顯", "凸顯",
  ],  // AI 高頻詞精選。排除高誤報詞「證明」「格局」
  "vague_attribution": [
    "行業報告顯示", "專家認為", "觀察者指出", "多個來源指出", "業內人士表示",
  ],  // 模糊歸因
  "superficial_tail": null,  // 特殊處理：正則掃描（突出|強調|確保|彰顯）+ 泛化賓語
  "promotional_filler": [
    "充滿活力", "令人嘆為觀止", "必遊之地",
    "為了實現這一目標", "在這個時間點",
  ],  // 宣傳腔 + 填充短語。其餘用 regex（擁有+誇大修飾）
  // --- 2026-07-31 新增：S6 文檔對齊補實現（C4） ---
  "paragraph_opening_template": [
    "從…來看", "在…層面", "對於…而言", "關於…",
  ],  // 每段開頭模板（#6）
  "conclusion_template": [
    "總而言之", "總的來看", "總體而言", "綜上所述",
  ],  // 結論模板（#7）
  // ── v1.4.0（2026-09-20）Humanizer-zh-TW 獨有品類合併（新類別 22-36）──
  "visibility_stacking": [
    "獨立報導", "独立报道", "獨立報導", "独立报导", "地方媒體", "地方媒体",
    "區域媒體", "区域媒体", "國家級媒體", "国家级媒体", "由知名專家撰寫", "由知名专家撰写",
    "活躍的社群媒體", "活跃的社交媒体",
  ],  // #22 知名度堆砌/媒體背書
  "challenge_formula": [
    "面臨若干挑戰", "面临若干挑战", "挑戰與機遇並存", "挑战与机遇并存",
    "未來展望", "未来展望", "儘管存在這些挑戰", "尽管存在这些挑战",
  ],  // #23 公式化「挑戰與展望」段（標記級，重寫由 LLM 定奪）
  "chat_residue": [
    "希望這對您有幫助", "希望这对您有帮助", "希望對你有幫助", "希望对你有帮助",
    "請告訴我", "请告诉我", "如果您想讓我", "如果你想让我",
  ],  // #30 聊天助理殘留
  "knowledge_cutoff": [
    "根據我最後的訓練", "根据我最后的训练", "雖然具體細節有限", "虽然具体细节有限",
    "基於可用資訊", "基于可用信息", "在現成資料中沒有廣泛記錄", "在现成资料中没有广泛记录",
  ],  // #31 知識截止免責
  "sycophancy": [
    "好問題", "好问题", "您說得完全正確", "您说得完全正确",
    "說得太對了", "说得太对了", "這是一個非常好的問題", "这是一个非常好的问题",
  ],  // #32 諂媚腔（腳本檢出；位置判斷改寫由 LLM 定奪）
  "overqualification": [
    "潛在地可能", "潜在地可能", "可能有可能會", "可能有可能",
    "有可能會有可能", "有可能有可能", "某種程度上", "某种程度上",
    "在某種意義上", "在某种意义上", "一定意義上", "一定意义上",
  ],  // #33 過度限定
  "generic_positive_ending": [
    "未來看起來光明", "未来看起来光明", "光明的未來", "光明的未来",
    "激動人心的時代", "激动人心的时代", "向正確方向邁出重要一步", "向正确方向迈出重要一步",
    "前景一片光明",
  ],  // #34 通用積極結尾（腳本檢出；末段判定由 LLM 定奪）
  "emdash_density": null,          // #26 破折號密度（計數，位置判斷改寫）
  "bold_overuse": null,            // #27 粗體濫用（** 對數 ≥ 3）
  "emoji_prop": null,              // #29 表情符號（正則計數 ≥ 2）
  "embedded_heading_list": null,   // #28 內嵌標題式列表（正則計數 ≥ 2 條）
  "curve_quotes": null,            // #36 彎引號（計數 ≥ 3）
};

function strCount(s, sub) {
  if (!sub) return 0;
  return String(s).split(sub).length - 1;
}

// ---------------------------------------------------------------------------
// v1.4.0（2026-09-20）Humanizer-zh-TW 合併：正則常量
// ---------------------------------------------------------------------------

/** #29 表情符號區段（Emoticons+Symbols+Pictographs+VS16，u 旗標）。 */
const EMOJI_RE = new RegExp(
  "[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}\\u{FE0F}\\u{2B00}-\\u{2BFF}\\u{1F000}-\\u{1F251}]", "gu");

/** #28 內嵌標題式列表：行首列表符 + **短語**： */
const HEADING_LIST_RE = new RegExp("^\\s*[-*\\u2022]\\s*\\*\\*[^*]{1,40}(?:[：:]\\*\\*|\\*\\*[ \\u3000]*[：:])", "gm");

/** #30 聊天助理殘留補充句式：這是…的概述。 */
const CHAT_OVERVIEW_RE = new RegExp("這是[^。]{1,20}的(?:概述|介紹|簡介|總結)", "g");

/** 原版 check_long_sentences（連續 3 句 > 30 字符）。 */
export function check_long_sentences(text) {
  let sentences = text.split(new RegExp("[。！？!?]"));
  sentences = sentences.map(s => s.trim()).filter(s => s.trim());
  let consecutive = 0;
  for (const s of sentences) {
    if (s.length > 30) {
      consecutive += 1;
      if (consecutive >= 3) return true;
    } else {
      consecutive = 0;
    }
  }
  return false;
}

/** 原版 check_listing_with_context（列舉病 + 上下文判斷降低誤報）。 */
export function check_listing_with_context(text) {
  const unconditional = ["首先", "其次", "再次", "其一", "其二", "其三"];
  const conditional_digits = ["第一", "第二", "第三", "第四", "第五"];
  const conditional_last = ["最後"];

  const matched = [];

  // 無條件觸發
  for (const p of unconditional) {
    if (text.includes(p)) matched.push(p);
  }

  // 條件觸發：數字序數詞（第一、第二等）
  const paragraphs = text.split(new RegExp("\\n\\s*\\n"));
  for (const p of conditional_digits) {
    if (!text.includes(p)) continue;
    let found = false;
    for (const para of paragraphs) {
      if (para.includes(p)) {
        const others = conditional_digits.filter(d => d !== p && para.includes(d));
        if (others.length) {
          matched.push(p);
          found = true;
          break;
        }
        const has_uncond = unconditional.slice(0, 3).some(u => para.includes(u));
        if (has_uncond) {
          matched.push(p);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const idx = text.indexOf(p);
      if (idx >= 0) {
        const before = text.slice(Math.max(0, idx - 50), idx);
        const after = text.slice(idx + p.length, idx + p.length + 50);
        const window = before + after;
        if (unconditional.slice(0, 3).some(u => window.includes(u))) {
          matched.push(p);
        } else if (conditional_digits.filter(d => d !== p).some(d => window.includes(d))) {
          matched.push(p);
        }
      }
    }
  }

  // 條件觸發：「最後」
  for (const p of conditional_last) {
    if (!text.includes(p)) continue;
    let found = false;
    const sentences = text.split(new RegExp("[。！？!?\\n]"));
    for (const sent of sentences) {
      if (sent.includes(p)) {
        if (new RegExp("最後[的]?[一]?(?:點|條|個|項)").exec(sent)) {
          matched.push(p);
          found = true;
          break;
        }
      }
    }
    if (!found) {
      const idx = text.indexOf(p);
      if (idx >= 0) {
        const prev = text.slice(Math.max(0, idx - 200), idx);
        if (unconditional.slice(0, 3).some(u => prev.includes(u))) {
          matched.push(p);
        }
      }
    }
  }

  return matched;
}

/** 原版 check_superficial_tail（句尾膚淺修飾 + 泛化賓語）。 */
export function check_superficial_tail(text) {
  const pattern = "(?:突出|強調|確保|彰顯)(?:了|地)\\s*.{0,20}?(?:重要性|意義|發展|推進|價值|作用|貢獻|影響|地位|格局)";
  const matches = [];
  const re = new RegExp(pattern, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    matches.push({ "match": m[0].slice(0, 60), "position": m.index });
  }
  return matches;
}

/** 原版 check_wenyan_number_ambiguity（文言數字模糊尾綴，2026-07-31 新增 C2）。 */
export function check_wenyan_number_ambiguity(text) {
  const pattern1 = "[零一二三四五六七八九十百千]+(?:美元|釐|厘|成|點|基點|分)有[零一二三四五六七八九]";
  const pattern2 = "[零一二三四五六七八九十百千]+有奇";
  const matches = [];
  let m;
  const re1 = new RegExp(pattern1, "g");
  while ((m = re1.exec(text)) !== null) {
    matches.push({ "type": "decimal_ambiguity", "match": m[0], "position": m.index });
  }
  const re2 = new RegExp(pattern2, "g");
  while ((m = re2.exec(text)) !== null) {
    matches.push({ "type": "odd_suffix", "match": m[0], "position": m.index });
  }
  return matches;
}

/** 原版 check_passive_voice（全文「被」字 > 句子數 15%）。 */
export function check_passive_voice(text) {
  let sentences = text.split(new RegExp("[。！？!?\\n]"));
  sentences = sentences.map(s => s.trim()).filter(s => s.trim());
  if (!sentences.length) return false;
  const bei_count = strCount(text, "被");
  return bei_count > sentences.length * 0.15;
}

/** 原版 check_patterns（1:1，含頻率閾值前置檢查）。 */
export function check_patterns(text, frequency_threshold) {
  frequency_threshold = frequency_threshold === undefined ? 0 : frequency_threshold;
  const results = { "matched_categories": [], "details": [], "passed": true, "frequency_skipped": [] };

  // ── 上下文頻率閾值前置檢查（僅 frequency_threshold > 0 時生效）──
  const skip_categories = new Set();
  if (frequency_threshold > 0) {
    for (const category in PATTERNS) {
      const patterns = PATTERNS[category];
      let count;
      if (patterns !== null) {
        count = patterns.reduce((a, p) => a + strCount(text, p), 0);
      } else if (category === "self_correcting_negation") {
        count = 0;
        const re = new RegExp("不是", "g");
        let m;
        while ((m = re.exec(text)) !== null) {
          const not_end = m.index + m[0].length;
          if (new RegExp("(?:而是|就是|是)").exec(text.slice(not_end, not_end + 30))) {
            count += 1;
          }
        }
      } else if (category === "superficial_tail") {
        count = (text.match(new RegExp("(?:突出|強調|確保|彰顯)(?:了|地)", "g")) || []).length;
      } else {
        continue;  // long_sentence 等特殊處理
      }
      if (0 < count && count < frequency_threshold) {
        skip_categories.add(category);
        results["frequency_skipped"].push({
          "category": category, "count": count, "threshold": frequency_threshold
        });
      }
    }
  }

  // ── 類別 1: AI過渡句 ──
  if (!skip_categories.has("ai_transition")) {
    const matched = PATTERNS["ai_transition"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("ai_transition");
      results["details"].push({ "category": "ai_transition", "matched": matched });
      results["passed"] = false;
    }
  }

  // ── 類別 2: 列舉結構（加入上下文判斷，降低誤報）──
  if (!skip_categories.has("listing")) {
    const matched = check_listing_with_context(text);
    if (matched.length) {
      results["matched_categories"].push("listing");
      results["details"].push({ "category": "listing", "matched": matched });
      results["passed"] = false;
    }
  }

  // ── 類別 3: 節奏異常 ──
  if (check_long_sentences(text)) {
    results["matched_categories"].push("long_sentence");
    results["details"].push({ "category": "long_sentence", "note": "連續3句以上 > 30字符" });
    results["passed"] = false;
  }

  // ── 類別 4: 自我修正否定式（2026-07-08 新增）──
  if (!skip_categories.has("self_correcting_negation")) {
    const negation_hits = [];
    const re = new RegExp("不是", "g");
    let m;
    while ((m = re.exec(text)) !== null) {
      const not_end = m.index + m[0].length;
      const search_window = text.slice(not_end, not_end + 30);
      const is_match = new RegExp("(?:而是|就是|是)").exec(search_window);
      if (is_match) {
        const gap = is_match.index;
        const matched_pattern = text.slice(m.index, not_end + is_match.index + is_match[0].length);
        negation_hits.push({
          "full_match": matched_pattern.slice(0, 40),
          "gap_chars": gap,
          "position": m.index
        });
      }
    }
    if (negation_hits.length) {
      results["matched_categories"].push("self_correcting_negation");
      results["details"].push({ "category": "self_correcting_negation", "hits": negation_hits });
      results["passed"] = false;
    }
  }

  // ── 類別 14: 意義誇大 + 系詞迴避（2026-07-24 新增）──
  if (!skip_categories.has("significance_copula")) {
    const matched = PATTERNS["significance_copula"].filter(p => text.includes(p));
    const sig_regex = text.match(new RegExp(
      "標誌著|見證了|是.{0,4}的體現" +
      "|作為.{0,20}(?:(?!是|為|了).)*(?:而|。)" +
      "|充當.{0,10}(?:角色|作用|功能|工具)" +
      "|代表著(?!.{0,8}(?:公司|集團|機構|組織|基金|銀行|部門|委員會))"
    , "g")) || [];
    if (matched.length || sig_regex.length) {
      results["matched_categories"].push("significance_copula");
      results["details"].push({
        "category": "significance_copula",
        "string_matches": matched,
        "regex_hits": sig_regex.length
      });
      results["passed"] = false;
    }
  }

  // ── 類別 15: AI 高頻詞（精選）（2026-07-24 新增）──
  if (!skip_categories.has("ai_vocabulary_selected")) {
    const matched = PATTERNS["ai_vocabulary_selected"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("ai_vocabulary_selected");
      results["details"].push({
        "category": "ai_vocabulary_selected",
        "matched": matched
      });
      results["passed"] = false;
    }
  }

  // ── 類別 16: 模糊歸因（2026-07-24 新增）──
  if (!skip_categories.has("vague_attribution")) {
    const raw_matched = PATTERNS["vague_attribution"].filter(p => text.includes(p));
    const filtered = [];
    for (const mm of raw_matched) {
      const idx = text.indexOf(mm);
      if (idx >= 0) {
        const after = text.slice(idx + mm.length, idx + mm.length + 20);
        if (new RegExp(
          "(?:高盛|摩根|麥肯錫|彭博|路透|中信|華泰|國泰|" +
          "招商|證監會|央行|統計局|財新|第一財經|新華社|" +
          "中國\\S{0,3}(?:銀行|證券|基金|保險|部|委|局|院|會))"
        ).exec(after)) {
          continue;
        }
      }
      filtered.push(mm);
    }
    if (filtered.length) {
      results["matched_categories"].push("vague_attribution");
      results["details"].push({
        "category": "vague_attribution",
        "matched": filtered,
        "raw_matches": raw_matched.length,
        "filtered_out": raw_matched.length - filtered.length
      });
      results["passed"] = false;
    }
  }

  // ── 類別 17: 膚淺分析 tail 模式（2026-07-24 新增）──
  if (!skip_categories.has("superficial_tail")) {
    const tail_hits = check_superficial_tail(text);
    if (tail_hits.length) {
      results["matched_categories"].push("superficial_tail");
      results["details"].push({
        "category": "superficial_tail",
        "hits": tail_hits
      });
      results["passed"] = false;
    }
  }

  // ── 類別 18: 宣傳腔 + 填充短語（2026-07-24 新增）──
  if (!skip_categories.has("promotional_filler")) {
    const matched = PATTERNS["promotional_filler"].filter(p => text.includes(p));
    const promo_regex = text.match(new RegExp(
      "擁有(?!的).{0,10}(?:卓越|獨特|超強|非凡|頂級|一流)"
    , "g")) || [];
    if (matched.length || promo_regex.length) {
      results["matched_categories"].push("promotional_filler");
      results["details"].push({
        "category": "promotional_filler",
        "string_matches": matched,
        "regex_hits": promo_regex.length
      });
      results["passed"] = false;
    }
  }

  // ── 類別 6: 每段開頭模板（2026-07-31 補實現，C4）──
  if (!skip_categories.has("paragraph_opening_template")) {
    const matched = PATTERNS["paragraph_opening_template"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("paragraph_opening_template");
      results["details"].push({
        "category": "paragraph_opening_template",
        "matched": matched
      });
      results["passed"] = false;
    }
  }

  // ── 類別 7: 結論模板（2026-07-31 補實現，C4）──
  if (!skip_categories.has("conclusion_template")) {
    const matched = PATTERNS["conclusion_template"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("conclusion_template");
      results["details"].push({
        "category": "conclusion_template",
        "matched": matched
      });
      results["passed"] = false;
    }
  }

  // ── 類別 8: 被動語態過多（2026-07-31 補實現，C4）──
  if (check_passive_voice(text)) {
    results["matched_categories"].push("passive_voice");
    results["details"].push({
      "category": "passive_voice",
      "note": "全文「被」字 > 句子數的 15%"
    });
    results["passed"] = false;
  }

  // ── 類別 21: 文言數字模糊尾綴（2026-07-31 新增，C2）──
  const number_hits = check_wenyan_number_ambiguity(text);
  if (number_hits.length) {
    results["matched_categories"].push("wenyan_number_ambiguity");
    results["details"].push({
      "category": "wenyan_number_ambiguity",
      "hits": number_hits
    });
    results["passed"] = false;
  }

  // ════════════════════════════════════════════════════════════════
  // v1.4.0（2026-09-20）Humanizer-zh-TW 合併（新類別 22-36）。
  // 字串類別走 skip_categories 門控（全域頻率閾值）；計數/密度類別為
  // null 模式常駐評估（自帶固定閾值，不參與 frequency_skipped）。
  // ════════════════════════════════════════════════════════════════

  // ── 類別 22: 知名度堆砌/媒體背書 ──
  if (!skip_categories.has("visibility_stacking")) {
    const matched = PATTERNS["visibility_stacking"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("visibility_stacking");
      results["details"].push({ "category": "visibility_stacking", "matched": matched, "severity": "fix" });
      results["passed"] = false;
    }
  }

  // ── 類別 23: 公式化「挑戰與展望」段 ──
  if (!skip_categories.has("challenge_formula")) {
    const matched = PATTERNS["challenge_formula"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("challenge_formula");
      results["details"].push({ "category": "challenge_formula", "matched": matched, "severity": "mark-llm-rewrite" });
      results["passed"] = false;
    }
  }

  // ── 類別 30: 聊天助理殘留（字串 + 「這是…的概述」句式）──
  if (!skip_categories.has("chat_residue")) {
    const str_matched = PATTERNS["chat_residue"].filter(p => text.includes(p));
    const rx_hits = text.match(CHAT_OVERVIEW_RE) || [];
    if (str_matched.length || rx_hits.length) {
      results["matched_categories"].push("chat_residue");
      results["details"].push({ "category": "chat_residue", "string_matches": str_matched, "regex_hits": rx_hits.length, "severity": "fix" });
      results["passed"] = false;
    }
  }

  // ── 類別 31: 知識截止免責 ──
  if (!skip_categories.has("knowledge_cutoff")) {
    const matched = PATTERNS["knowledge_cutoff"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("knowledge_cutoff");
      results["details"].push({ "category": "knowledge_cutoff", "matched": matched, "severity": "fix" });
      results["passed"] = false;
    }
  }

  // ── 類別 32: 諂媚腔（腳本檢出；位置判斷改寫由 LLM 定奪）──
  if (!skip_categories.has("sycophancy")) {
    const matched = PATTERNS["sycophancy"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("sycophancy");
      results["details"].push({ "category": "sycophancy", "matched": matched, "severity": "mark-position-judge" });
      results["passed"] = false;
    }
  }

  // ── 類別 33: 過度限定 ──
  if (!skip_categories.has("overqualification")) {
    const matched = PATTERNS["overqualification"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("overqualification");
      results["details"].push({ "category": "overqualification", "matched": matched, "severity": "fix" });
      results["passed"] = false;
    }
  }

  // ── 類別 34: 通用積極結尾（腳本檢出；末段判定由 LLM 定奪）──
  if (!skip_categories.has("generic_positive_ending")) {
    const matched = PATTERNS["generic_positive_ending"].filter(p => text.includes(p));
    if (matched.length) {
      results["matched_categories"].push("generic_positive_ending");
      results["details"].push({ "category": "generic_positive_ending", "matched": matched, "severity": "mark-llm-judge" });
      results["passed"] = false;
    }
  }

  // ── 類別 26: 破折號密度（「——」≥3 且密度 >2/500 字；位置判斷改寫，不自動刪）──
  (() => {
    const n = strCount(text, "——");
    const per500 = text.length ? (n / (text.length / 500)) : 0;
    if (n >= 3 && per500 > 2) {
      results["matched_categories"].push("emdash_density");
      results["details"].push({ "category": "emdash_density", "count": n, "density_per_500": Math.round(per500 * 100) / 100, "severity": "mark-position-judge" });
      results["passed"] = false;
    }
  })();

  // ── 類別 27: 粗體濫用（** 對數 ≥ 3）──
  (() => {
    const pairs = Math.floor(strCount(text, "**") / 2);
    if (pairs >= 3) {
      results["matched_categories"].push("bold_overuse");
      results["details"].push({ "category": "bold_overuse", "pairs": pairs, "severity": "fix" });
      results["passed"] = false;
    }
  })();

  // ── 類別 28: 內嵌標題式列表（≥ 2 條）──
  (() => {
    const hits = (text.match(HEADING_LIST_RE) || []);
    if (hits.length >= 2) {
      results["matched_categories"].push("embedded_heading_list");
      results["details"].push({ "category": "embedded_heading_list", "count": hits.length, "severity": "fix" });
      results["passed"] = false;
    }
  })();

  // ── 類別 29: 表情符號（≥ 2）──
  (() => {
    const hits = (text.match(EMOJI_RE) || []);
    if (hits.length >= 2) {
      results["matched_categories"].push("emoji_prop");
      results["details"].push({ "category": "emoji_prop", "count": hits.length, "severity": "fix" });
      results["passed"] = false;
    }
  })();

  // ── 類別 36: 彎引號（“ ” 計數 ≥ 3）──
  (() => {
    const n = strCount(text, "\u201C") + strCount(text, "\u201D");
    if (n >= 3) {
      results["matched_categories"].push("curve_quotes");
      results["details"].push({ "category": "curve_quotes", "count": n, "severity": "fix" });
      results["passed"] = false;
    }
  })();

  return results;
}

/**
 * dispatchRobotPattern(opts) —— 原版 main() 的對象參數直調版。
 * opts: { text?: 字符串, file?: 文件路徑, "frequency-threshold"?: int（默認 0） }
 * 原版 stdin 管道（fs.readFileSync(0)）在目標環境不存在；宿主一律可傳 text（能力等價）。
 */
export function dispatchRobotPattern(opts) {
  const threshold = (opts["frequency-threshold"] !== undefined && opts["frequency-threshold"] !== null)
    ? opts["frequency-threshold"] : 0;

  let text;
  if (opts["text"]) {
    text = resolveTextArg(opts["text"]);  // 路徑 or 內聯文字雙形態（WorkBuddy 適配）
  } else if (opts["file"]) {
    if (!existsP(opts["file"])) {
      return { "status": "error", "message": "無輸入文字", "exit_code": 1 };
    }
    text = readText(opts["file"]);
  } else {
    text = "";
  }

  if (!String(text).trim()) {
    return { "status": "error", "message": "無輸入文字", "exit_code": 1 };
  }

  const result = check_patterns(text, threshold);
  result["status"] = "ok";
  result["text_length"] = text.length;
  result["threshold_used"] = threshold;
  return result;
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchRobotPattern(opts);
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配）
//   node check-robot-pattern.mjs --text {段落文字或路徑}
//   node check-robot-pattern.mjs --file prose-tmp/prose-s4.txt --frequency-threshold 2
//   stdout 輸出 JSON；exit code 1 = 檢出 AI 模式（S4 逐段閘門）或 status error
// ---------------------------------------------------------------------------

const CLI_OPTS = {
  text: { type: "str" },
  file: { type: "str" },
  "frequency-threshold": { type: "int" },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchRobotPattern(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
