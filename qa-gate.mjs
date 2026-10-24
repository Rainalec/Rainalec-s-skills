/**
 * qa-gate.mjs — 最終 QA 清單校驗 & 自動匯總（移植版）
 * ======================================================
 * 原 scripts/qa-gate.js 1:1（見《移植報告》映射表 M-12）。
 *
 * 三種模式（dispatch 對象鍵名 = 原 CLI 長選項）：
 *   1. "checklist": <path>    讀取 JSON 並執行逐項驗證（原行為）
 *   2. 手動參數               從參數對象構造 checklist 後驗證（原行為）
 *   3. "auto-summary": <path> 從 prose-tmp/ 前序產出自動匯總 checklist（QA1–QA13）
 *
 * 形式適配（均已公示）：
 *   - TMP="/tmp" → tmpPath() → 工作區 prose-tmp/ 子目錄；
 *   - runScript(spawnSync 子進程調用 check-causal-chain.js / check-rhetoric-fact.js /
 *     check-inference-boundary.js) → 同 eval 內靜態 import 對應模組 dispatch 直調
 *     （見《移植報告》P1 決策 D-11；QA11 原版即「直接讀取文件而非依賴 returncode」，
 *     直調後仍讀 qa11-result.json，行為 1:1）；
 *   - mkdirSync(recursive) + writeFileSync → writeText（內部 ensureDir 逐級建目錄）；
 *   - 終止語義：原版 pyExit(0/1) → 返回值攜帶 exit_code 欄位。
 */

import {
  tmpPath, existsP, readText, writeText, printJson, pyReprStr, nowIsoLocal, matchIter,
  parseArgs, resolveTextArg,
} from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";
import { dispatchCausalChain } from "./check-causal-chain.mjs";
import { dispatchRhetoricFact } from "./check-rhetoric-fact.mjs";
import { dispatchInferenceBoundary } from "./check-inference-boundary.mjs";

/** 原版 _extract_keywords（1:1；2-4 字連續中文子串 + 停用詞，供大綱覆蓋率匹配）。 */
export function _extract_keywords(text, max_words) {
  max_words = max_words === undefined ? 3 : max_words;
  // 移除非中文字符，保留中文
  const cleaned = text.replace(/[^\u4e00-\u9fff]/g, "");
  if (!cleaned) {
    return [];
  }
  // 常見停用詞（2字詞居多）
  const stopwords = new Set(['一個', '沒有', '不是', '什麼', '可以', '這個', '那個', '這些', '那些',
    '已經', '正在', '就是', '還是', '只是', '但是', '而且', '如果',
    '因為', '所以', '雖然', '然後', '他們', '我們', '你們', '自己',
    '可能', '應該', '能夠', '需要', '必須', '不會', '不能', '一直',
    '一件', '之後', '之前', '之間', '關於']);
  // 提取 2-4 字連續子串作爲關鍵詞
  const candidates = [];
  for (const length of [2, 3, 4]) {
    let i = 0;
    while (i + length <= cleaned.length) {
      const chunk = cleaned.slice(i, i + length);
      if (!stopwords.has(chunk)) {
        candidates.push(chunk);
      }
      i += 1;
    }
  }
  // 去重
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    if (!seen.has(c)) {
      seen.add(c);
      unique.push(c);
    }
  }
  return unique.slice(0, max_words);
}

/**
 * 原版 auto_summary（1:1；數據來源 S4→S5→S6→S7，QA1–QA13）。
 * QA11/QA12/QA13 的 runScript 子進程 → 靜態 import dispatch 直調。
 */
export function auto_summary(output_path) {
  const items = [];

  // QA1: 最低字數 — 從 prose-s4.txt 讀取
  const s4_path = tmpPath("prose-s4.txt");
  let s4_text = "";
  if (existsP(s4_path)) {
    s4_text = readText(s4_path).trim();
    items.push({
      "id": "QA1_min_length",
      "type": "min_length",
      "value": s4_text.length,
      "min": 500,
      "source": "prose-s4.txt",
    });
  } else {
    items.push({ "id": "QA1_min_length", "type": "min_length", "value": 0, "min": 500 });
  }

  // QA2: 不截斷 — 從 prose-s6.txt 讀取最後字符
  const s6_path = tmpPath("prose-s6.txt");
  let s6_text = "";
  if (existsP(s6_path)) {
    s6_text = readText(s6_path).trim();
    items.push({
      "id": "QA2_ends_with_period",
      "type": "ends_with",
      "value": s6_text.slice(-20) || "",
      "char": "。",
      "source": "prose-s6.txt",
    });
  } else {
    items.push({ "id": "QA2_ends_with_period", "type": "ends_with", "value": "", "char": "。" });
  }

  // QA3: 無殘留佔位符 — 從 prose-s6.txt 掃描
  items.push({
    "id": "QA3_no_unclosed_brackets",
    "type": "no_unclosed_brackets",
    "value": s6_text || s4_text,
    "source": "prose-s6.txt",
  });

  // QA4: 大綱覆蓋率 — 從 prose-s3.json 讀取大綱主題詞，用關鍵詞匹配
  const s3_path = tmpPath("prose-s3.json");
  let outline_ids = [];
  const outline_keywords = {};  // {id: [kw1, kw2, ...]}
  if (existsP(s3_path)) {
    try {
      const outline = JSON.parse(readText(s3_path));
      for (const p of outline.outline || []) {
        const pid = p.id || "";
        const theme = p.theme || "";
        outline_ids.push(pid);
        if (theme) {
          outline_keywords[pid] = _extract_keywords(theme, 3);
        }
      }
    } catch (e) {
      outline_ids = [];
    }
  }
  const search_text = s6_text || s4_text;
  items.push({
    "id": "QA4_outline_coverage",
    "type": "outline_coverage",
    "outline_ids": outline_ids,
    "outline_keywords": outline_keywords,
    "full_text": search_text,
    "source": "prose-s3.json + prose-s6.txt",
  });

  // QA5: 語氣無極端值 — 從 prose-s5-tone.json 讀取 anomalies
  const s5_path = tmpPath("prose-s5-tone.json");
  let anomaly_count = 0;
  if (existsP(s5_path)) {
    try {
      const tone = JSON.parse(readText(s5_path));
      anomaly_count = (tone.anomalies || []).length;
    } catch (e) {
      anomaly_count = 0;
    }
  }
  items.push({
    "id": "QA5_tone_anomaly_free",
    "type": "boolean",
    "value": anomaly_count === 0,
    "source": "prose-s5-tone.json",
  });

  // QA6: 去機械化完成度 — 從 prose-s6-unresolved.json 讀取
  const unresolved_path = tmpPath("prose-s6-unresolved.json");
  let unresolved_count = 0;
  let total_found = 0;
  if (existsP(unresolved_path)) {
    try {
      const unresolved = JSON.parse(readText(unresolved_path));
      unresolved_count = (unresolved.items || []).length;
      total_found = unresolved.total_found !== undefined ? unresolved.total_found : unresolved_count;
    } catch (e) {
      unresolved_count = 0;
      total_found = 0;
    }
  }
  items.push({
    "id": "QA6_derobot_completion",
    "type": "ratio_check",
    "numerator": unresolved_count,
    "denominator": Math.max(total_found, 1),
    "max_ratio": 0.3,
    "source": "prose-s6-unresolved.json",
  });

  // QA7: 靈魂注入充分 — 從 prose-s7.json 讀取通過維度數
  const s7_path = tmpPath("prose-s7.json");
  let s7_passed = 5;
  if (existsP(s7_path)) {
    try {
      const soul = JSON.parse(readText(s7_path));
      s7_passed = soul.passed_dimensions !== undefined ? soul.passed_dimensions : 5;
    } catch (e) {
      s7_passed = 5;
    }
  }
  items.push({
    "id": "QA7_soul_injection",
    "type": "min_length",
    "value": s7_passed,
    "min": 4,
    "source": "prose-s7.json",
  });

  // QA8: 免責聲明（如適用，僅投資/醫療分析類強制）
  // 檢查文體：從 prose-s3.json 的 tone 參數推測是否為投資/醫療分析
  let is_investment_or_medical = false;
  const s3_path_q8 = tmpPath("prose-s3.json");
  if (existsP(s3_path_q8)) {
    try {
      const s3data_q8 = JSON.parse(readText(s3_path_q8));
      for (const entry of s3data_q8.outline || []) {
        const theme = entry.theme || "";
        if (["投資", "股票", "醫療", "診斷", "藥", "基金"].some(kw => theme.indexOf(kw) !== -1)) {
          is_investment_or_medical = true;
          break;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  if (is_investment_or_medical) {
    items.push({
      "id": "QA8_disclaimer",
      "type": "string_match",
      "value": search_text.slice(0, 100) || "",
      "pattern": "免責|風險提示|僅供參考",
      "source": "全文掃描（強制）",
    });
  } else {
    // 非投資/醫療類：自動通過
    items.push({
      "id": "QA8_disclaimer",
      "type": "boolean",
      "value": true,
      "source": "非投資/醫療類，自動通過",
    });
  }

  // QA9: 因果鏈保留度 — 比對 S1 cause 段落在最終文字中的關鍵詞保留率
  let qa9_total = 0;
  let qa9_matched = 0;
  const s1_path_q9 = tmpPath("prose-s1.json");
  if (existsP(s1_path_q9)) {
    try {
      const s1data_q9 = JSON.parse(readText(s1_path_q9));
      const paragraphs = s1data_q9.paragraphs || {};
      Object.keys(paragraphs).map(Number).sort((a, b) => a - b).forEach(pid => {
        const pdata = paragraphs[String(pid)] !== undefined ? paragraphs[String(pid)] : paragraphs[pid];
        const tags = pdata.tags || [];
        if (tags.indexOf("cause") !== -1) {
          qa9_total += 1;
          const cause_text = pdata.text || "";
          const cause_kws = _extract_keywords(cause_text, 5);
          if (cause_kws.some(kw => search_text.indexOf(kw) !== -1)) {
            qa9_matched += 1;
          }
        }
      });
    } catch (e) {
      // ignore
    }
  }
  items.push({
    "id": "QA9_causal_retention",
    "type": "ratio_check",
    "numerator": Math.max(qa9_total - qa9_matched, 0),
    "denominator": Math.max(qa9_total, 1),
    "max_ratio": 0.2,
    "source": "prose-s1.json (cause paragraphs, heuristic)",
  });

  // QA10: 時序一致性 — 提取最終文字中日期，檢查時間回溯無標記
  let qa10_passed = true;
  const qa10_date_pat = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})|(\d{4})年(\d{1,2})月(\d{1,2})日|(\d{4})年(\d{1,2})月(?!\d)/g;
  const dates_extracted = [];
  for (const m of matchIter(search_text, qa10_date_pat)) {
    let norm;
    if (m[1]) {
      norm = m[1] + "-" + String(parseInt(m[2])).padStart(2, "0") + "-" + String(parseInt(m[3])).padStart(2, "0");
    } else if (m[4]) {
      norm = m[4] + "-" + String(parseInt(m[5])).padStart(2, "0") + "-" + String(parseInt(m[6])).padStart(2, "0");
    } else if (m[7]) {
      norm = m[7] + "-" + String(parseInt(m[8])).padStart(2, "0");
    } else {
      continue;
    }
    dates_extracted.push([m.index, norm]);
  }
  for (let i = 1; i < dates_extracted.length; i++) {
    const prev_pos = dates_extracted[i - 1][0];
    const prev_date = dates_extracted[i - 1][1];
    const curr_pos = dates_extracted[i][0];
    const curr_date = dates_extracted[i][1];
    if (prev_date > curr_date) {
      const between = search_text.slice(prev_pos, curr_pos);
      const has_bt_marker = ["回顧", "此前", "回溯", "早在"].some(mk => between.indexOf(mk) !== -1);
      if (!has_bt_marker) {
        qa10_passed = false;
        break;
      }
    }
  }
  items.push({
    "id": "QA10_temporal_consistency",
    "type": "boolean",
    "value": qa10_passed,
    "source": "prose-s6.txt 日期提取 + 回溯檢查",
  });

  // QA11: 無因果矛盾 — 對 prose-s6.txt 執行 check-causal-chain --scan-inconsistency
  //（原 runScript 子進程 → dispatchCausalChain 直調；原版即「直接讀取文件而非依賴 returncode」）
  let qa11_passed = true;
  if (s6_text) {
    const s15_path = tmpPath("prose-s1.5.json");
    if (existsP(s15_path)) {
      try {
        dispatchCausalChain({
          "scan-inconsistency": true,
          "text": s6_text,
          "causal-map": s15_path,
          "output": tmpPath("qa11-result.json"),
        });
        const qa11_out = tmpPath("qa11-result.json");
        if (existsP(qa11_out)) {
          const qa11_data = JSON.parse(readText(qa11_out));
          qa11_passed = qa11_data.passed !== false;
        }
      } catch (e) {
        // ignore（原版 1:1）
      }
    }
  }
  items.push({
    "id": "QA11_no_causal_inconsistency",
    "type": "boolean",
    "value": qa11_passed,
    "source": "check-causal-chain.js --scan-inconsistency",
  });

  // QA12: 無修辭事實衝突 — 對 prose-s6.txt 執行 check-rhetoric-fact
  let qa12_passed = true;
  if (s6_text) {
    const s1_path = tmpPath("prose-s1.json");
    if (existsP(s1_path)) {
      try {
        const r12 = dispatchRhetoricFact({
          "text": s6_text,
          "source": s1_path,
          "output": tmpPath("qa12-result.json"),
        });
        // 原版 if (r12.status === 0)（子進程成功退出才讀結果）；
        // 移植版 dispatch 成功時返回值不含 exit_code 欄位。
        if (r12.exit_code === undefined) {
          const qa12_data = JSON.parse(readText(tmpPath("qa12-result.json")));
          qa12_passed = qa12_data.verdict !== "critical";
        }
      } catch (e) {
        // ignore（原版 1:1）
      }
    }
  }
  items.push({
    "id": "QA12_no_rhetoric_fact_conflict",
    "type": "boolean",
    "value": qa12_passed,
    "source": "check-rhetoric-fact.js",
  });

  // QA13: 無推論越界 — 對 prose-s6.txt 執行 check-inference-boundary
  let qa13_passed = true;
  if (s6_text) {
    const s1_path = tmpPath("prose-s1.json");
    if (existsP(s1_path)) {
      try {
        const r13 = dispatchInferenceBoundary({
          "text": s6_text,
          "source": s1_path,
          "output": tmpPath("qa13-result.json"),
        });
        if (r13.exit_code === undefined) {
          const qa13_data = JSON.parse(readText(tmpPath("qa13-result.json")));
          qa13_passed = qa13_data.verdict !== "critical";
        }
      } catch (e) {
        // ignore（原版 1:1）
      }
    }
  }
  items.push({
    "id": "QA13_no_inference_boundary_violation",
    "type": "boolean",
    "value": qa13_passed,
    "source": "check-inference-boundary.js",
  });

  const checklist = {
    "items": items,
    "auto_generated": true,
    "generated_at": nowIsoLocal(),
    "source_steps": ["S1", "S4", "S5", "S6", "S7", "S8"],
  };

  writeText(output_path, JSON.stringify(checklist, null, 2));

  return checklist;
}

/** 原版 run_qa（1:1；7 種 item 類型 + 未知類型 fallback）。 */
export function run_qa(checklist_path) {
  if (!existsP(checklist_path)) {
    return { "status": "error", "message": "checklist 檔案不存在: " + checklist_path };
  }

  const checklist = JSON.parse(readText(checklist_path));

  const results = {};
  let passed_count = 0;
  const total = (checklist.items || []).length;
  let ok = false;

  for (const item of checklist.items || []) {
    const item_id = item.id;
    const item_type = item.type;
    const value = item.value;

    if (item_type === "min_length") {
      const min_len = item.min !== undefined ? item.min : 500;
      ok = typeof value === "number" && value >= min_len;
      results[item_id] = { "pass": ok, "value": value, "required": ">=" + min_len };

    } else if (item_type === "ends_with") {
      const char = item.char !== undefined ? item.char : "。";
      ok = typeof value === "string" && value.trim().endsWith(char);
      results[item_id] = { "pass": ok, "value": pyReprStr(value.slice(-10)), "required": "以「" + char + "」結尾" };

    } else if (item_type === "no_unclosed_brackets") {
      const text = typeof value === "string" ? value : "";
      const unclosed_curly = text.split("{").length - 1 !== text.split("}").length - 1;
      const unclosed_square = text.split("[").length - 1 > text.split("]").length - 1;
      ok = !(unclosed_curly || unclosed_square);
      results[item_id] = { "pass": ok, "value": pyReprStr(text.slice(-50)), "required": "無未閉合括號" };

    } else if (item_type === "string_match") {
      const pattern = item.pattern || "";
      ok = (typeof value === "string") ? (new RegExp(pattern).exec(value) !== null) : false;
      results[item_id] = { "pass": ok, "value": pyReprStr(value.slice(0, 50)), "required": "匹配「" + pattern + "」" };

    } else if (item_type === "ratio_check") {
      const numerator = parseFloat(item.numerator !== undefined ? item.numerator : 0);
      const denominator = parseFloat(item.denominator !== undefined ? item.denominator : 1);
      const max_ratio = parseFloat(item.max_ratio !== undefined ? item.max_ratio : 0.3);
      const ratio = denominator > 0 ? numerator / denominator : 1;
      ok = ratio <= max_ratio;
      results[item_id] = {
        "pass": ok,
        "value": ((Number.isInteger(numerator) ? numerator.toFixed(1) : String(numerator)) + "/" + (Number.isInteger(denominator) ? denominator.toFixed(1) : String(denominator)) + "=" + (ratio * 100).toFixed(1) + "%"),
        "required": "≤" + (max_ratio * 100).toFixed(0) + "%"
      };

    } else if (item_type === "boolean") {
      ok = Boolean(value);
      results[item_id] = { "pass": ok, "value": value, "required": true };

    } else if (item_type === "outline_coverage") {
      const outline_ids = item.outline_ids || [];
      const outline_keywords = item.outline_keywords || {};
      const full_text = item.full_text || "";
      const covered = [];
      for (const oid of outline_ids) {
        // 1) ID 直匹配
        if (full_text.indexOf(oid) !== -1) {
          covered.push(oid);
          continue;
        }
        // 2) 關鍵詞匹配（主題詞中 ≥1 個關鍵詞出現在正文中）
        const kws = outline_keywords[oid] || [];
        if (kws.length) {
          const matches = kws.filter(kw => full_text.indexOf(kw) !== -1).length;
          if (matches >= 1) {
            covered.push(oid);
          }
        }
      }
      const coverage_pct = covered.length / Math.max(outline_ids.length, 1);
      // 關鍵詞匹配的門檻降低：2/3 匹配 → 至少 1 個關鍵詞命中
      ok = coverage_pct >= 0.8;
      results[item_id] = {
        "pass": ok,
        "value": (covered.length + "/" + outline_ids.length + " (" + (coverage_pct * 100).toFixed(0) + "%)"),
        "required": "≥80%",
      };

    } else {
      results[item_id] = { "pass": false, "value": value, "error": "未知類型: " + item_type };
      ok = false;
    }

    if (ok) {
      passed_count += 1;
    }
  }

  const all_passed = passed_count === total;
  return {
    "status": all_passed ? "ok" : "blocked",
    "passed": all_passed,
    "passed_count": passed_count,
    "total": total,
    "results": results,
    "failed_items": Object.keys(results).filter(k => !results[k].pass),
  };
}

/** 原版 build_checklist_from_args（1:1；手動模式 10 項，QA9/QA10/QA11 不在內）。 */
export function build_checklist_from_args(args) {
  const items = [];
  items.push({ "id": "QA1_min_length", "type": "min_length", "value": args["min-length"], "min": 500 });
  items.push({ "id": "QA2_ends_with_period", "type": "ends_with", "value": args["last-char"], "char": "。" });
  items.push({ "id": "QA3_no_unclosed_brackets", "type": "no_unclosed_brackets", "value": resolveTextArg(args["full-text"]) });
  items.push({ "id": "QA4_outline_coverage", "type": "string_match", "value": args["outline-ids"], "pattern": args["outline-ids"] });
  items.push({ "id": "QA5_tone_anomaly_free", "type": "boolean", "value": args["tone-ok"] });
  items.push({
    "id": "QA6_derobot_completion",
    "type": "ratio_check",
    "numerator": args["unresolved-patterns"],
    "denominator": args["total-patterns"],
    "max_ratio": 0.3,
  });
  items.push({ "id": "QA7_soul_injection", "type": "min_length", "value": args["soul-passed"], "min": 4 });
  items.push({ "id": "QA8_disclaimer", "type": "boolean", "value": args["has-disclaimer"] });
  // 2026-07-08 新增 QA12、QA13
  items.push({ "id": "QA12_no_rhetoric_fact_conflict", "type": "boolean", "value": args["rhetoric-ok"] });
  items.push({ "id": "QA13_no_inference_boundary_violation", "type": "boolean", "value": args["inference-ok"] });

  return { "items": items };
}

/**
 * dispatchQaGate(opts) —— 原版 main() 直調版。
 * opts 鍵名與原 CLI 長選項一致：checklist / auto-summary / min-length / last-char /
 * full-text / outline-ids / tone-ok / unresolved-patterns / total-patterns /
 * soul-passed / has-disclaimer / rhetoric-ok / inference-ok。
 * 原版 pyExit(0/1) → 返回值攜帶 exit_code。
 */
export function dispatchQaGate(opts) {
  let result;
  if (opts["auto-summary"]) {
    // 自動匯總模式
    const checklist = auto_summary(opts["auto-summary"]);
    const ret = {
      "status": "ok",
      "output": opts["auto-summary"],
      "items": checklist.items.length,
      "auto_generated": true,
      "exit_code": 0,
    };
    printJson(ret);
    return ret;
  }

  if (opts["checklist"]) {
    result = run_qa(opts["checklist"]);
  } else {
    // 手動模式：從參數構建
    const checklist = build_checklist_from_args(opts);
    const tmp_path = tmpPath("prose-s8-checklist-manual.json");
    writeText(tmp_path, JSON.stringify(checklist, null, 2));
    result = run_qa(tmp_path);
  }

  printJson(result);
  const ret = Object.assign({}, result, { "exit_code": result.passed ? 0 : 1 });
  return ret;
}

/** 便捷入口（宿主一行調用；dispatch 內已含原版 printJson 輸出，故不再重複打印）。 */
export function run(opts) {
  return dispatchQaGate(opts);
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配；dispatch 內部已 printJson，此處不重複打印）
//   node qa-gate.mjs --auto-summary prose-tmp/prose-s8-checklist.json
//   node qa-gate.mjs --checklist prose-tmp/prose-s8-checklist.json
//   node qa-gate.mjs --min-length 800 --last-char 。 --full-text {全文或路徑} \
//     --outline-ids P1,P2 --tone-ok --unresolved-patterns 1 --total-patterns 10 \
//     --soul-passed 5 --has-disclaimer --rhetoric-ok --inference-ok
//   exit code 1 = 有 QA 項不通過或 status error
// ---------------------------------------------------------------------------

const CLI_OPTS = {
  checklist: { type: "str" },
  "auto-summary": { type: "str" },
  "min-length": { type: "int" },
  "last-char": { type: "str" },
  "full-text": { type: "str" },
  "outline-ids": { type: "str" },
  "tone-ok": { type: "bool" },
  "unresolved-patterns": { type: "int" },
  "total-patterns": { type: "int" },
  "soul-passed": { type: "int" },
  "has-disclaimer": { type: "bool" },
  "rhetoric-ok": { type: "bool" },
  "inference-ok": { type: "bool" },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchQaGate(opts);
  process.exitCode = result.exit_code || 0;
}
