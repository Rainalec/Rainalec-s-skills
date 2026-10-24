/**
 * check-causal-chain.mjs — 因果時序校驗腳本（移植版）
 * ====================================================
 * 合併映射（見《移植報告》映射表 M-07 / M-08）：
 *   - 原 scripts/check-causal-chain.js     → 因果時序校驗（6 種模式）
 *   - 原 scripts/check-temporal-clarity.js → 重寫時間錨點清晰度校驗（S1.5 規則 E）
 * 兩者同屬 S1.5 階段（規則 A-D / 規則 E），合併以滿足附件總數 ≤12；全部函數 1:1 保留。
 *
 * check-causal-chain 支援模式（原版 1:1）：
 *   --check-temporal       顯式日期時序校驗
 *   --check-implicit-time  隱含時間流向提取
 *   --trace-chain          跨段落因果鏈追蹤
 *   --check-reorder        S2 重排後因果斷裂檢測
 *   --check-new-causal     S4 新因果 claim 監控
 *   --scan-inconsistency   全文因果矛盾掃描
 *   --action complete      標記 S1.5 完成
 *
 * 形式適配：matchAll → pw-compat.matchIter（等價 exec 循環）；
 * textPath「存在則讀檔、否則當文本」語義以 fs.exists 探測保留。
 */

import {
  reEscape, matchIter, existsP, readText, writeText, printJson, println, pyRound,
  tmpPath, parseArgs, resolveTextArg,
} from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Part 1：原 check-causal-chain.js（1:1）
// ---------------------------------------------------------------------------

// 日期格式正則
export const DATE_PATTERNS = [
  "\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}",  // YYYY-MM-DD / YYYY/MM/DD
  "\\d{4}年\\d{1,2}月\\d{1,2}日",      // YYYY年MM月DD日
  "\\d{4}年\\d{1,2}月",               // YYYY年MM月
  "\\d{1,2}月\\d{1,2}日",             // MM月DD日
  "\\d{2}[-/]\\d{2}[-/]\\d{2}",        // YY/MM/DD
];

/** 原版 checkTemporal(inputPath)（1:1，含字符串序比較語義）。 */
export function checkTemporal(inputPath) {
  const s1Data = JSON.parse(readText(inputPath));
  const temporalMismatches = [];
  const paraDates = {};

  if (s1Data && typeof s1Data === "object" && !Array.isArray(s1Data) && ("temporal_paragraphs" in s1Data)) {
    for (const paraId in s1Data.temporal_paragraphs) {
      const content = s1Data.temporal_paragraphs[paraId];
      const text = (content.text !== undefined) ? content.text : "";
      for (const pattern of DATE_PATTERNS) {
        const matches = text.match(new RegExp(pattern, "g")) || [];
        if (matches.length) {
          const dateVal = matches[0];
          if (!dateVal.startsWith("XXXX")) {
            paraDates[Number(paraId)] = [dateVal, text.slice(0, 50)];
          }
          break;
        }
      }
    }
  }

  const sortedByPara = Object.keys(paraDates).map(Number).sort((a, b) => a - b);

  for (let i = 1; i < sortedByPara.length; i++) {
    const prevPid = sortedByPara[i - 1];
    const currPid = sortedByPara[i];
    const prevDate = paraDates[prevPid][0];
    const currDate = paraDates[currPid][0];
    if (prevDate > currDate) {
      temporalMismatches.push({
        "type": "temporal",
        "para_a": prevPid,
        "date_a": prevDate,
        "para_b": currPid,
        "date_b": currDate,
        "issue": "段落" + prevPid + "（" + prevDate + "）在段落" + currPid + "（" + currDate + "）之前，但日期更晚"
      });
    }
  }

  return {
    "status": temporalMismatches.length === 0 ? "ok" : "warning",
    "temporal_mismatches": temporalMismatches.length,
    "details": temporalMismatches
  };
}

/** 原版 traceChain(inputPath)（1:1）。 */
export function traceChain(inputPath) {
  const s1Data = JSON.parse(readText(inputPath));

  const chains = [];
  const causeParas = new Set();
  const effectParas = new Set();
  const orphanCauses = [];
  const orphanEffects = [];

  if (s1Data && typeof s1Data === "object" && !Array.isArray(s1Data) && ("paragraphs" in s1Data)) {
    for (const pid in s1Data.paragraphs) {
      const pdata = s1Data.paragraphs[pid];
      const text = (pdata.text !== undefined) ? pdata.text : "";
      const tags = (pdata.tags !== undefined) ? pdata.tags : [];

      if (tags.indexOf("cause") !== -1) {
        causeParas.add(Number(pid));
        const m = new RegExp("(因為|由於|源於|起因是|歸因於)\\s*[，,：:\\s]*([^，,。.;；]{2,20})").exec(text);
        if (m) {
          const matchId = "C" + (chains.length + 1);
          chains.push({
            "id": matchId,
            "cause_para": Number(pid),
            "trigger": m[1],
            "subject": m[2].trim().slice(0, 30)
          });
        }
      }

      if (tags.indexOf("effect") !== -1) {
        effectParas.add(Number(pid));
      }
    }
  }

  const sortedParas = Array.from(new Set([...causeParas, ...effectParas])).sort((a, b) => a - b);
  for (const c of causeParas) {
    const hasNearbyEffect = [...effectParas].some(e => c < e && e <= c + 3);
    if (!hasNearbyEffect) orphanCauses.push({ "cause_para": c, "issue": "孤兒原因：無附近 effect 段落" });
  }

  for (const e of effectParas) {
    const hasNearbyCause = [...causeParas].some(c => e - 3 <= c && c < e);
    if (!hasNearbyCause) orphanEffects.push({ "effect_para": e, "issue": "孤兒結果：無附近 cause 段落" });
  }

  for (const chain of chains) {
    const cp = chain.cause_para;
    const nearbyEffects = [...effectParas].filter(e => e > cp);
    chain.effect_para = nearbyEffects.length ? Math.min(...nearbyEffects) : null;
  }

  const cycleCauses = [];
  for (const ci of chains) {
    for (const cj of chains) {
      if (ci.cause_para >= cj.cause_para) continue;
      if (ci.effect_para && cj.effect_para && ci.effect_para === cj.cause_para) {
        const si = ci.subject || "";
        const sj = cj.subject || "";
        const sameSubject = !!(si && sj && (si.indexOf(sj) !== -1 || sj.indexOf(si) !== -1));
        cycleCauses.push({
          "chain_a": ci.id, "chain_b": cj.id,
          "subject": si || sj || "(unknown)",
          "cause_para": ci.cause_para,
          "linking_para": ci.effect_para,
          "is_cycle": sameSubject,
          "issue": (
            "主體「" + si + "→" + sj + "」段落" + ci.cause_para + "→" + ci.effect_para + "→" + (cj.effect_para !== undefined ? cj.effect_para : "?")
            + (sameSubject ? "（循環✅）" : "（段落鏈接，主體不同）")
          )
        });
      }
    }
  }

  let severity = "ok";
  if (orphanCauses.length + orphanEffects.length >= 2) severity = "error";
  else if (orphanCauses.length + orphanEffects.length > 0) severity = "warning";

  return {
    "status": severity,
    "chains": chains,
    "orphan_causes": orphanCauses,
    "orphan_effects": orphanEffects,
    "cycle_causes": cycleCauses,
    "total_causes": causeParas.size,
    "total_effects": effectParas.size
  };
}

// 相對時間詞模式
export const IMPLICIT_TIME_WORDS = [
  "此後", "此前", "隨後", "同時", "較早前",
  "數月後", "數天後", "數年後", "不久後", "其後",
  "翌年", "翌日", "隔年", "隔日", "稍早",
  "稍後", "同期", "同一時期", "不久之前",
];

/** 原版 checkImplicitTime(inputPath)（1:1）。 */
export function checkImplicitTime(inputPath) {
  const s1Data = JSON.parse(readText(inputPath));
  const results = [];

  let rawText = "";
  const paraMap = {};
  if (s1Data && typeof s1Data === "object" && !Array.isArray(s1Data)) {
    if ("paragraphs" in s1Data) {
      for (const pid in s1Data.paragraphs) {
        const pdata = s1Data.paragraphs[pid];
        const text = (pdata.text !== undefined) ? pdata.text : "";
        paraMap[Number(pid)] = text;
      }
    }
    rawText = ("raw_text" in s1Data) ? s1Data.raw_text
      : (("text" in s1Data) ? s1Data.text : JSON.stringify(s1Data));
  }

  for (const pid of Object.keys(paraMap).map(Number).sort((a, b) => a - b)) {
    const text = paraMap[pid];
    for (const word of IMPLICIT_TIME_WORDS) {
      for (const m of matchIter(text, new RegExp(reEscape(word), "g"))) {
        const start = Math.max(0, m.index - 30);
        const end = Math.min(text.length, m.index + word.length + 30);
        const context = text.slice(start, end);
        results.push({
          "paragraph": pid,
          "word": word,
          "position": m.index,
          "context": context.trim(),
          "note": "含相對時間詞「" + word + "」，無法自動推定絕對時間"
        });
        break;
      }
    }
  }

  return {
    "status": results.length === 0 ? "ok" : "info",
    "implicit_time_hits": results.length,
    "details": results
  };
}

/** 原版 checkReorder(originalPath, reorderedPath)（1:1）。 */
export function checkReorder(originalPath, reorderedPath) {
  const original = JSON.parse(readText(originalPath));
  const reordered = JSON.parse(readText(reorderedPath));

  const causeEffectPairs = [];
  if ("chains" in original) {
    for (const chain of original.chains) {
      if ("cause_para" in chain) {
        for (const c2 of original.chains) {
          if (c2 !== chain && (c2.cause_para !== undefined ? c2.cause_para : 0) > chain.cause_para) {
            causeEffectPairs.push({
              "cause": chain.cause_para,
              "effect": c2.cause_para
            });
          }
        }
      }
    }
  }

  const reorderedSeq = [];
  if ("layers" in reordered) {
    for (const layer of reordered.layers) {
      const source = ("原料來源" in layer) ? layer["原料來源"] : "";
      if (typeof source === "string" && source.trim()) {
        const cleaned = source.trim().replace(/^[\[\]]+|[\[\]]+$/g, "");
        try {
          const nums = cleaned.split(",").filter(x => x.trim() && /^\d+$/.test(x.trim())).map(x => parseInt(x.trim(), 10));
          reorderedSeq.push(...nums);
        } catch (e) { /* pass */ }
      } else if (Array.isArray(source)) {
        for (const x of source) {
          if (typeof x === "number") reorderedSeq.push(x);
        }
      }
    }
  }

  const fractures = [];
  for (const pair of causeEffectPairs) {
    let causePos = -1;
    let effectPos = -1;
    for (let i = 0; i < reorderedSeq.length; i++) {
      const p = reorderedSeq[i];
      if (p === pair.cause) causePos = i;
      if (p === pair.effect) effectPos = i;
    }

    if (causePos >= 0 && effectPos >= 0) {
      const gap = effectPos - causePos - 1;
      if (gap >= 2) {
        const between = reorderedSeq.slice(causePos + 1, effectPos);
        fractures.push({
          "cause_para": pair.cause,
          "effect_para": pair.effect,
          "gap": gap,
          "intervening_paras": between,
          "suggestion": "cause（段落" + pair.cause + "）→ effect（段落" + pair.effect + "）被" + gap + "個段落分隔，建議加入銜接句"
        });
      }
    }
  }

  return {
    "status": fractures.length === 0 ? "ok" : "warning",
    "fractures": fractures.length,
    "details": fractures
  };
}

// resolveTextArg 已上移至 pw-compat.mjs 共用導出（WorkBuddy 適配，路徑/內聯雙形態）。

/** 原版 checkNewCausal(textPath, causalMapPath)（1:1）。 */
export function checkNewCausal(textArg, causalMapPath) {
  const causalMap = JSON.parse(readText(causalMapPath));

  const text = resolveTextArg(textArg);

  const knownSubjects = new Set();
  if ("chains" in causalMap) {
    for (const chain of causalMap.chains) {
      if ("subject" in chain) knownSubjects.add(chain.subject);
    }
  }

  const causalTriggers = ["因為", "所以", "因此", "導致", "由於", "引發"];
  const newClaims = [];
  const contradictions = [];

  const sentences = text.split(new RegExp("[。！？\\n]"));
  for (const sent of sentences) {
    for (const trigger of causalTriggers) {
      if (sent.indexOf(trigger) !== -1) {
        const rx = new RegExp(reEscape(trigger) + "\\s*[，,：:\\s]*([^，,。.;；\\s]{2,15})");
        const m = rx.exec(sent);
        if (m) {
          const subject = m[1].trim().slice(0, 20);

          const isKnown = [...knownSubjects].some(ks => subject.indexOf(ks) !== -1 || ks.indexOf(subject) !== -1);

          if (!isKnown) {
            newClaims.push({
              "trigger": trigger,
              "subject": subject,
              "sentence": sent.slice(0, 60),
              "level": "warning"
            });
          }

          if ("chains" in causalMap) {
            for (const chain of causalMap.chains) {
              if ("subject" in chain && chain.subject && sent.indexOf(chain.subject) !== -1) {
                if (trigger === "導致" || trigger === "引發") {
                  contradictions.push({
                    "trigger": trigger,
                    "subject": chain.subject,
                    "original_direction": chain.subject + "是原因",
                    "new_direction": chain.subject + "是結果",
                    "sentence": sent.slice(0, 80),
                    "level": "error"
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  let status;
  if (contradictions.length === 0 && newClaims.length === 0) status = "ok";
  else if (contradictions.length > 0) status = "error";
  else status = "warning";

  return {
    "status": status,
    "new_causal_claims": newClaims.length,
    "causal_contradictions": contradictions.length,
    "details": {
      "new_claims": newClaims,
      "contradictions": contradictions
    }
  };
}

/** 原版 scanInconsistency(textPath, causalMapPath)（1:1）。 */
export function scanInconsistency(textArg, causalMapPath) {
  const result = checkNewCausal(textArg, causalMapPath);
  return {
    "status": result.status,
    "inconsistencies": result.causal_contradictions,
    "warnings": result.new_causal_claims,
    "passed": result.status !== "error"
  };
}

/**
 * dispatchCausalChain(opts) —— 原版 main() 的對象參數直調版。
 * opts: { "check-temporal"?, "trace-chain"?, "check-reorder"?, "check-new-causal"?,
 *         "check-implicit-time"?, "scan-inconsistency"?, action?: "complete",
 *         input?, original?, reordered?, text?, "causal-map"?, output? }
 */
export function dispatchCausalChain(opts) {
  if (opts["action"] !== null && opts["action"] !== undefined && ["complete"].indexOf(opts["action"]) === -1) {
    return { "status": "error", "message": "--action 必須是 complete", "exit_code": 1 };
  }

  let result;

  if (opts["check-temporal"]) {
    if (!opts["input"]) return { "status": "error", "message": "--check-temporal 需要 --input", "exit_code": 1 };
    result = checkTemporal(opts["input"]);
  } else if (opts["trace-chain"]) {
    if (!opts["input"]) return { "status": "error", "message": "--trace-chain 需要 --input", "exit_code": 1 };
    result = traceChain(opts["input"]);
  } else if (opts["check-reorder"]) {
    if (!opts["original"] || !opts["reordered"]) return { "status": "error", "message": "--check-reorder 需要 --original 和 --reordered", "exit_code": 1 };
    result = checkReorder(opts["original"], opts["reordered"]);
  } else if (opts["check-implicit-time"]) {
    if (!opts["input"]) return { "status": "error", "message": "--check-implicit-time 需要 --input", "exit_code": 1 };
    result = checkImplicitTime(opts["input"]);
  } else if (opts["check-new-causal"]) {
    if (!opts["text"] || !opts["causal-map"]) return { "status": "error", "message": "--check-new-causal 需要 --text 和 --causal-map", "exit_code": 1 };
    result = checkNewCausal(opts["text"], opts["causal-map"]);
  } else if (opts["scan-inconsistency"]) {
    if (!opts["text"] || !opts["causal-map"]) return { "status": "error", "message": "--scan-inconsistency 需要 --text 和 --causal-map", "exit_code": 1 };
    result = scanInconsistency(opts["text"], opts["causal-map"]);
  } else if (opts["action"] === "complete") {
    result = { "status": "ok", "action": "complete", "message": "S1.5 已完成" };
  } else {
    println("用法：dispatchCausalChain({check-temporal|trace-chain|check-reorder|check-new-causal|check-implicit-time|scan-inconsistency|action:'complete'}, input, original, reordered, text, causal-map, output)");
    return { "status": "error", "message": "請指定操作模式", "exit_code": 1 };
  }

  if (opts["output"]) {
    writeText(opts["output"], JSON.stringify(result, null, 2));
  }

  if (result.status === "error") {
    result["exit_code"] = 1;
  }
  return result;
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchCausalChain(opts);
  printJson(result);
  return result;
}

// ---------------------------------------------------------------------------
// Part 2：原 check-temporal-clarity.js（S1.5 規則 E，1:1）
// ---------------------------------------------------------------------------

function isDict(x) { return x && typeof x === "object" && !Array.isArray(x); }

function parseDateSafe(dateStr) {
  if (typeof dateStr !== "string" || dateStr.startsWith("XXXX")) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dateStr);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{4})-(\d{1,2})$/.exec(dateStr);
  if (m) return Date.UTC(+m[1], +m[2] - 1, 1);
  return null;
}

export const CLARITY_DATE_PATTERNS = [
  {
    re: /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    fmt: m => m[0] + "-" + String(+m[1]).padStart(2, "0") + "-" + String(+m[2]).padStart(2, "0")
  },
  {
    re: /(\d{4})年(\d{1,2})月/g,
    fmt: m => m[0] + "-" + String(+m[1]).padStart(2, "0")
  },
  {
    re: /(\d{1,2})月(\d{1,2})日/g,
    fmt: m => "XXXX-" + String(+m[0]).padStart(2, "0") + "-" + String(+m[1]).padStart(2, "0")
  },
  {
    re: /(\d{4})-(\d{1,2})-(\d{1,2})/g,
    fmt: m => m[0] + "-" + String(+m[1]).padStart(2, "0") + "-" + String(+m[2]).padStart(2, "0")
  },
  {
    re: /(\d{4})\/(\d{1,2})\/(\d{1,2})/g,
    fmt: m => m[0] + "-" + String(+m[1]).padStart(2, "0") + "-" + String(+m[2]).padStart(2, "0")
  },
];

/** 原版 extractDatesFromText。 */
export function extractDatesFromText(text) {
  const dates = [];
  for (const { re, fmt } of CLARITY_DATE_PATTERNS) {
    for (const m of matchIter(text, re)) {
      try {
        const formatted = fmt(m.slice(1));
        dates.push(formatted);
      } catch (e) { /* continue */ }
    }
  }
  const seen = new Set();
  const unique = [];
  for (const d of dates) {
    if (!seen.has(d)) { seen.add(d); unique.push(d); }
  }
  return unique;
}

/** 原版 checkTemporalClarity(origJson, narrativeJson)（1:1）。 */
export function checkTemporalClarity(origJson, narrativeJson) {
  const result = {
    "orig_span": [],
    "orig_days": 0,
    "rewrite_anchor": "",
    "rewrite_start_matches_orig": true,
    "compression_warning": false,
    "origin_shift_warning": false,
    "mixed_timescales": [],
    "verdict": "pass"
  };

  let rawText = "";
  if (isDict(origJson)) {
    if ("raw_text" in origJson) rawText = origJson.raw_text;
    else if ("text" in origJson) rawText = origJson.text;
    else if ("paragraphs" in origJson) {
      rawText = origJson.paragraphs.map(p => isDict(p) ? (p.text || "") : String(p)).join("\n");
    } else {
      rawText = JSON.stringify(origJson);
    }
  }

  const allDates = extractDatesFromText(rawText);

  const validDates = allDates.filter(d => !d.startsWith("XXXX"));
  let parsed = validDates.map(d => [d, parseDateSafe(d)]).filter(([, dt]) => dt !== null);

  if (parsed.length) {
    parsed.sort((a, b) => a[1] - b[1]);
    result.orig_span = [parsed[0][0], parsed[parsed.length - 1][0]];
    const delta = Math.round((parsed[parsed.length - 1][1] - parsed[0][1]) / 86400000);
    result.orig_days = delta + 1;
  } else {
    result.orig_span = allDates.length >= 2 ? allDates.slice(0, 2) : allDates;
    result.orig_days = 0;
  }

  let rewriteText = "";
  if (isDict(narrativeJson)) {
    rewriteText = JSON.stringify(narrativeJson);
    let narrativeLayers = Array.isArray(narrativeJson.narrative_layers) ? narrativeJson.narrative_layers : [];
    if (!narrativeLayers.length) narrativeLayers = Array.isArray(narrativeJson.layers) ? narrativeJson.layers : [];

    const anchorDates = [];
    for (const layer of narrativeLayers) {
      let temporalAnchor = ("時序錨點" in layer) ? layer["時序錨點"]
        : (("temporal_anchor" in layer) ? layer.temporal_anchor : "");
      if (temporalAnchor && temporalAnchor !== "無") {
        anchorDates.push(...extractDatesFromText(temporalAnchor));
      }
    }

    if (anchorDates.length) {
      result.rewrite_anchor = anchorDates[0];
    } else {
      const fallbackDates = extractDatesFromText(rewriteText);
      if (fallbackDates.length) result.rewrite_anchor = fallbackDates[0];
    }
  }

  if (result.orig_days > 0 && result.rewrite_anchor) {
    const rewriteDt = parseDateSafe(result.rewrite_anchor);
    if (rewriteDt && parsed.length) {
      const origStart = parsed[0][1];
      const origEnd = parsed[parsed.length - 1][1];
      const totalSpan = Math.round((origEnd - origStart) / 86400000) + 1;
      const skippedDays = Math.round((rewriteDt - origStart) / 86400000);
      if (totalSpan > 0 && skippedDays > 0) {
        const skipRatio = skippedDays / totalSpan;
        if (skipRatio > 0.5) result.compression_warning = true;
      }
    }
  }

  if (result.orig_span.length && result.rewrite_anchor) {
    result.rewrite_start_matches_orig = (result.rewrite_anchor === result.orig_span[0]);
    if (!result.rewrite_start_matches_orig) result.origin_shift_warning = true;
  }

  const mixed = [];
  const layers = (isDict(narrativeJson) && Array.isArray(narrativeJson.narrative_layers)) ? narrativeJson.narrative_layers
    : ((isDict(narrativeJson) && Array.isArray(narrativeJson.layers)) ? narrativeJson.layers : []);
  for (const layer of layers) {
    const layerText = JSON.stringify(layer);
    const layerDates = extractDatesFromText(layerText);
    const layerValid = layerDates.filter(d => !d.startsWith("XXXX"));
    if (layerText.indexOf("同一天") !== -1 || layerText.indexOf("同一天內") !== -1 || layerText.indexOf("同一日") !== -1) {
      const dayTerms = ["同一天", "同一天內", "同一日", "24小時", "二十四小時"];
      const periodTerms = ["天前", "天後", "48小時", "四十八小時", "數日", "數天"];
      const hasDay = dayTerms.some(t => layerText.indexOf(t) !== -1);
      const hasPeriod = periodTerms.some(t => layerText.indexOf(t) !== -1);
      if (hasDay && hasPeriod) {
        mixed.push({
          "evidence": "同一敘事層內同時包含「同一天」和更長時段表述",
          "terms_found": {
            "day_terms": dayTerms.filter(t => layerText.indexOf(t) !== -1),
            "period_terms": periodTerms.filter(t => layerText.indexOf(t) !== -1)
          }
        });
      }
    }

    const timePatternsFound = [];
    const timePatterns = [
      [/(\d+)\s*小時/g, "hour"],
      [/(\d+)\s*天/g, "day"],
      [/(\d+)\s*週/g, "week"],
      [/(\d+)\s*個月/g, "month"],
    ];
    for (const [pat, unit] of timePatterns) {
      for (const m of matchIter(layerText, pat)) {
        timePatternsFound.push({ value: parseInt(m[1], 10), unit });
      }
    }

    if (timePatternsFound.length >= 2) {
      const unitsOrder = { "hour": 0, "day": 1, "week": 2, "month": 3 };
      const unitSet = new Set(timePatternsFound.map(t => t.unit));
      const unitOrderVals = [...unitSet].map(u => (u in unitsOrder) ? unitsOrder[u] : -1);
      if (unitSet.size >= 2 && (Math.max(...unitOrderVals) - Math.min(...unitOrderVals)) >= 1) {
        mixed.push({
          "evidence": "同一敘事層內混用多種時間單位: " + [...unitSet].join(", "),
          "time_patterns": timePatternsFound
        });
      }
    }
  }

  result.mixed_timescales = mixed;

  if (result.mixed_timescales.length) result.verdict = "critical";
  else if (result.compression_warning && result.origin_shift_warning) result.verdict = "warning";
  else if (result.compression_warning || result.origin_shift_warning) result.verdict = "warning";
  else result.verdict = "pass";

  return result;
}

/** 安全載入 JSON 檔：讀失敗 → 拋 Error（由 dispatchTemporalClarity 捕獲轉為 status:error）；
 *  解析失敗 → 當原文返回。 */
function safeLoadClarity(p) {
  const content = readText(p);   // 讀失敗向上拋出
  try { return JSON.parse(content); }
  catch (e) { return content; }
}

/**
 * dispatchTemporalClarity(opts) —— 原 check-temporal-clarity.js main() 直調版。
 * opts: { "orig-dates": S1 JSON 路徑, "narrative-plan": S2 JSON 路徑, output: 輸出路徑 }
 */
export function dispatchTemporalClarity(opts) {
  if (!opts["orig-dates"] || !opts["narrative-plan"] || !opts["output"]) {
    return { "status": "error", "message": "--orig-dates, --narrative-plan, --output 皆為必填", "exit_code": 1 };
  }

  let origJson, narrativeJson;
  try {
    origJson = safeLoadClarity(opts["orig-dates"]);
    narrativeJson = safeLoadClarity(opts["narrative-plan"]);
  } catch (e) {
    return { "status": "error", "message": "無法讀取: " + e.message, "exit_code": 1 };
  }

  const result = checkTemporalClarity(origJson, narrativeJson);

  writeText(opts["output"], JSON.stringify(result, null, 2));

  const verdictIcons = { "pass": "✅", "warning": "⚠️", "critical": "🔴" };
  println("[時間壓縮映射] 校驗結果：" + (verdictIcons[result.verdict] || "❓") + " " + result.verdict);
  println("  原始時間跨度：" + (result.orig_span.length ? result.orig_span[0] : "N/A") + " → " + (result.orig_span.length > 1 ? result.orig_span[1] : "N/A") + "（共 " + result.orig_days + " 天）");
  println("  重寫錨點時間：" + (result.rewrite_anchor || "N/A"));
  println("  跨度警告：" + (result.compression_warning ? "⚠️ 有" : "無"));
  println("  起點偏移：" + (result.origin_shift_warning ? "⚠️ 有" : "無"));
  if (result.mixed_timescales.length) {
    for (const m of result.mixed_timescales) {
      println("  🔴 時間混用：" + m.evidence);
    }
  }
  println("  判定：" + result.verdict);

  if (result.verdict === "critical") {
    println("[閘門] 🔴 時間混用異常 → S4 寫對應段落時強制加入時段劃分標示");
  } else if (result.verdict === "warning" && result.compression_warning && result.origin_shift_warning) {
    println("[閘門] ⚠️ 跨度警告 + 起點偏移 → S4 開頭強制加入回溯句");
  }

  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配；命令在工作區根目錄執行）
//   node check-causal-chain.mjs --check-temporal --input prose-tmp/prose-s1.json
//   node check-causal-chain.mjs --check-implicit-time --input prose-tmp/prose-s1.json
//   node check-causal-chain.mjs --trace-chain --input prose-tmp/prose-s1.json --output prose-tmp/prose-s1.5.json
//   node check-causal-chain.mjs --check-reorder --original prose-tmp/prose-s1.5.json --reordered prose-tmp/prose-s2.json
//   node check-causal-chain.mjs --check-new-causal --text {段落或路徑} --causal-map prose-tmp/prose-s1.5.json
//   node check-causal-chain.mjs --scan-inconsistency --text {全文或路徑} --causal-map prose-tmp/prose-s1.5.json
//   node check-causal-chain.mjs --action complete
//   node check-causal-chain.mjs --action temporal-clarity --orig-dates prose-tmp/prose-s1.json \
//     --narrative-plan prose-tmp/prose-s2.json --output prose-tmp/prose-temporal-clarity.json
//   stdout 輸出 JSON；exit code 1 = status error
// ---------------------------------------------------------------------------

const CLI_OPTS = {
  "check-temporal": { type: "bool" },
  "check-implicit-time": { type: "bool" },
  "trace-chain": { type: "bool" },
  "check-reorder": { type: "bool" },
  "check-new-causal": { type: "bool" },
  "scan-inconsistency": { type: "bool" },
  action: { type: "str" },
  input: { type: "str" },
  original: { type: "str" },
  reordered: { type: "str" },
  text: { type: "str" },
  "causal-map": { type: "str" },
  "orig-dates": { type: "str" },
  "narrative-plan": { type: "str" },
  output: { type: "str" },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = (opts["action"] === "temporal-clarity")
    ? dispatchTemporalClarity(opts)
    : dispatchCausalChain(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
