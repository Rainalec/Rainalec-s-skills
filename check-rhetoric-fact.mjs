/**
 * check-rhetoric-fact.mjs — 修辭性事實校驗閘門（移植版）
 * ======================================================
 * 原 scripts/check-rhetoric-fact.js 1:1（見《移植報告》映射表 M-10）。
 * prose-weaver S4 §7。檢查 LLM 在寫作時自行添加的修辭性表述是否與原始素材的事實數據衝突。
 *
 * 輸入：text（剛寫完的段落文字，字符串）、source（S1 原料 JSON 路徑）、output（輸出路徑）
 * 輸出：{ spatial_exaggerations, temporal_exaggerations, new_concepts, verdict }
 */

import { matchIter, readText, writeText, printJson, println, pyRound, parseArgs, resolveTextArg } from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// (1) 空間誇張關鍵詞
export const SPATIAL_KEYWORDS = [
  "罩住", "覆蓋", "籠罩", "橫跨", "囊括", "籠罩整片", "蓋住",
  "吞沒", "席捲", "漫過", "鋪滿",
];

// (2) 時間誇張關鍵詞
export const TEMPORAL_KEYWORDS = [
  "瞬間", "頃刻", "轉眼", "一眨眼", "須臾", "剎那", "立時",
];

// 時間誇張模式 regex（含動態數字）
const TEMPORAL_PATTERN = /(?:不到|僅僅|不過|只用了)\s*(\d+)\s*(小時|分鐘|秒)/g;

// (3) 因果創新關鍵詞
export const NEW_CONCEPT_KEYWORDS = [
  "效應", "定律", "原理", "現象", "機制",
];

// 地理名詞列表（常用於氣象/天文寫作）
export const LOCATION_NAMES = [
  "東海", "南海", "黃海", "渤海", "太平洋", "台灣海峽",
  "浙江", "福建", "廣東", "上海", "江蘇", "江西", "安徽",
  "湖北", "台灣", "山東", "寧德", "溫州", "寧波", "象山",
];

// 可從 S1 提取的距離/範圍數據模式
export const DISTANCE_PATTERNS = [
  {
    pattern: "環流直徑(?:超過?|約|達|近)?([\\d,]+)\\s*千(?:米|裡)",
    re: /環流直徑(?:超過?|約|達|近)?([\d,]+)\s*千(?:米|裡)/g,
    extract: m => [parseInt(m[1].replace(/,/g, ""), 10) * 1000, "km"]
  },
  {
    pattern: "環流(?:半|直)徑(?:超過?|約|達|近)?([\\d,]+)\\s*公里",
    re: /環流(?:半|直)徑(?:超過?|約|達|近)?([\d,]+)\s*公里/g,
    extract: m => [parseInt(m[1].replace(/,/g, ""), 10), "km"]
  },
  {
    pattern: "雲系直徑(?:超過?|約|達|近)?([\\d,]+)\\s*公里",
    re: /雲系直徑(?:超過?|約|達|近)?([\d,]+)\s*公里/g,
    extract: m => [parseInt(m[1].replace(/,/g, ""), 10), "km"]
  },
  {
    pattern: "七級風圈半徑(?:超過?|約|達|近)?([\\d,]+)\\s*(?:[-~]?)\\s*([\\d,]+)?\\s*公里",
    re: /七級風圈半徑(?:超過?|約|達|近)?([\d,]+)\s*(?:[-~]?)\s*([\d,]+)?\s*公里/g,
    extract: m => [parseInt(m[1].replace(/,/g, ""), 10), "km"]
  },
  {
    pattern: "中心風力(?:約|達)?([\\d,]+)\\s*級",
    re: /中心風力(?:約|達)?([\d,]+)\s*級/g,
    extract: m => [parseInt(m[1].replace(/,/g, ""), 10), "level"]
  },
  {
    pattern: "半徑(?:超過?|約|達|近)?([\\d,]+)\\s*公里",
    re: /半徑(?:超過?|約|達|近)?([\d,]+)\s*公里/g,
    extract: m => [parseInt(m[1].replace(/,/g, ""), 10), "km"]
  },
];

/** 原版 extractSourceData（1:1）。 */
export function extractSourceData(sourceJson) {
  const data = { "distances": [], "durations": [], "concepts": [], "all_text": "" };

  let rawText = "";
  if (sourceJson && typeof sourceJson === "object" && !Array.isArray(sourceJson)) {
    rawText = ("raw_text" in sourceJson) ? sourceJson.raw_text
      : (("text" in sourceJson) ? sourceJson.text : JSON.stringify(sourceJson));
  }

  data.all_text = rawText;

  for (const { re, pattern, extract } of DISTANCE_PATTERNS) {
    for (const m of matchIter(rawText, re)) {
      try {
        const [value, unit] = extract(m);
        data.distances.push({
          "pattern": pattern,
          "match": m[0],
          "value": value,
          "unit": unit
        });
      } catch (e) { /* continue */ }
    }
  }

  const timePattern = /(\d+)\s*[小時天]/g;
  for (const m of matchIter(rawText, timePattern)) {
    data.durations.push({
      "match": m[0],
      "value": parseInt(m[1], 10),
      "unit": m[0].indexOf("小時") !== -1 ? "hour" : "day"
    });
  }

  for (const kw of NEW_CONCEPT_KEYWORDS) {
    if (rawText.indexOf(kw) !== -1) {
      const idx = rawText.indexOf(kw);
      const start = Math.max(0, idx - 30);
      const end = Math.min(rawText.length, idx + kw.length + 30);
      const context = rawText.slice(start, end).replace(/\n/g, " ");
      data.concepts.push({
        "keyword": kw,
        "context": context
      });
    }
  }

  return data;
}

/** 原版 estimateSpatialClaim。 */
export function estimateSpatialClaim(context, keyword) {
  let estimate = 0;

  for (const loc of LOCATION_NAMES) {
    if (context.indexOf("大半個" + loc) !== -1 || context.indexOf("大半個 " + loc) !== -1) {
      if (loc === "東海") estimate = 700;
      else if (loc === "南海" || loc === "太平洋") estimate = 1000;
      else estimate = 400;
    }
  }

  for (const loc of LOCATION_NAMES) {
    if (context.indexOf("整個" + loc) !== -1 || context.indexOf("覆蓋" + loc) !== -1 || context.indexOf("籠罩" + loc) !== -1) {
      if (loc === "東海") estimate = 1200;
      else if (loc === "浙江") estimate = 450;
      else if (loc === "福建") estimate = 500;
      else estimate = 400;
    }
  }

  return estimate;
}

/** 原版 checkSpatialExaggeration（1:1）。 */
export function checkSpatialExaggeration(text, sourceData) {
  const results = [];

  for (const kw of SPATIAL_KEYWORDS) {
    if (text.indexOf(kw) !== -1) {
      const idx = text.indexOf(kw);
      const start = Math.max(0, idx - 40);
      const end = Math.min(text.length, idx + kw.length + 50);
      const context = text.slice(start, end);

      const foundLocations = LOCATION_NAMES.filter(loc => context.indexOf(loc) !== -1);

      let deviation = 0;
      let severity = "pass";

      if (foundLocations.length && sourceData.distances.length) {
        const maxDist = Math.max(0, ...sourceData.distances.map(d => d.value));
        if (maxDist > 0) {
          const rhetoricValue = estimateSpatialClaim(context, kw);
          if (rhetoricValue > 0) {
            const deviationPct = Math.abs(rhetoricValue - maxDist) / maxDist;
            if (deviationPct > 0.30) severity = "critical";
            else if (deviationPct > 0.15) severity = "warning";
          }
        }
      }

      results.push({
        "keyword": kw,
        "context": context,
        "locations_found": foundLocations,
        "source_data_match": {
          "max_distance_km": Math.max(0, ...sourceData.distances.map(d => d.value))
        },
        "deviation_pct": pyRound(deviation, 2),
        "severity": severity
      });
    }
  }

  return results;
}

/** 原版 checkTemporalExaggeration（1:1）。 */
export function checkTemporalExaggeration(text, sourceData) {
  const results = [];

  for (const kw of TEMPORAL_KEYWORDS) {
    if (text.indexOf(kw) !== -1) {
      const idx = text.indexOf(kw);
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + kw.length + 40);
      const context = text.slice(start, end);

      results.push({
        "keyword": kw,
        "context": context,
        "source_data": {
          "original_durations": sourceData.durations
        },
        "deviation_pct": 0,
        "severity": "warning"
      });
    }
  }

  for (const m of matchIter(text, TEMPORAL_PATTERN)) {
    const value = parseInt(m[1], 10);
    const unit = m[2];
    const contextStart = Math.max(0, m.index - 20);
    const contextEnd = Math.min(text.length, m.index + m[0].length + 20);
    const context = text.slice(contextStart, contextEnd);

    let deviation = 0;
    let severity = "warning";
    let origHoursVal = "N/A";
    if (sourceData.durations.length) {
      const origDurations = sourceData.durations.map(d => d.value);
      const avgOrig = origDurations.reduce((a, b) => a + b, 0) / origDurations.length;
      let rhetoricalHours;
      if (unit === "小時") rhetoricalHours = value;
      else if (unit === "分鐘") rhetoricalHours = value / 60;
      else rhetoricalHours = value * 24;

      const origHours = avgOrig;
      if (Math.abs(rhetoricalHours - origHours) > 0) {
        deviation = origHours > 0 ? Math.abs(rhetoricalHours - origHours) / origHours : 0;
        if (deviation > 0.50) severity = "warning";
        else severity = "pass";
      }
      origHoursVal = origHours;
    }

    results.push({
      "keyword": m[0],
      "context": context,
      "rhetorical_value": value + unit,
      "source_value": origHoursVal + "小時",
      "deviation_pct": pyRound(deviation, 2),
      "severity": severity
    });
  }

  return results;
}

/** 原版 checkNewConcepts（1:1；pass 級不記錄）。 */
export function checkNewConcepts(text, sourceData) {
  const results = [];

  for (const kw of NEW_CONCEPT_KEYWORDS) {
    if (text.indexOf(kw) !== -1) {
      const idx = text.indexOf(kw);
      const start = Math.max(0, idx - 30);
      const end = Math.min(text.length, idx + kw.length + 30);
      const context = text.slice(start, end);

      const inSource = sourceData.all_text.indexOf(kw) !== -1;

      const severity = inSource ? "pass" : "warning";
      if (!inSource) {
        results.push({
          "keyword": kw,
          "context": context,
          "in_source": false,
          "severity": "warning"
        });
      }
    }
  }

  return results;
}

/** 原版 checkRhetoricFact（1:1）。 */
export function checkRhetoricFact(text, sourceJson) {
  const sourceData = extractSourceData(sourceJson);

  const spatial = checkSpatialExaggeration(text, sourceData);
  const temporal = checkTemporalExaggeration(text, sourceData);
  const concepts = checkNewConcepts(text, sourceData);

  const hasCritical = spatial.some(r => r.severity === "critical");
  const hasWarning = (
    hasCritical ||
    spatial.some(r => r.severity === "warning") ||
    temporal.some(r => r.severity === "warning") ||
    concepts.some(r => r.severity === "warning")
  );

  const verdict = hasCritical ? "critical" : (hasWarning ? "warning" : "pass");

  return {
    "spatial_exaggerations": spatial,
    "temporal_exaggerations": temporal,
    "new_concepts": concepts,
    "verdict": verdict
  };
}

/**
 * 原版 safeLoad（讀失敗 → 拋錯由 dispatch 終止；解析失敗 → 當原文字符串）。
 * 原版讀失敗路徑為 printJson + pyExit(1) 終止；移植版拋錯並由 dispatch
 * 轉為 {status:"error", exit_code:1} 返回（QuickJS 無 process.exit）。
 */
function safeLoad(p) {
  const content = readText(p); // 失敗拋 Error
  try { return JSON.parse(content); }
  catch (e) { return content; }
}

/**
 * dispatchRhetoricFact(opts) —— 原版 main() 直調版。
 * opts: { text: 段落文字, source: S1 JSON 路徑, output: 輸出 JSON 路徑 }
 */
export function dispatchRhetoricFact(opts) {
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

  const result = checkRhetoricFact(resolveTextArg(opts["text"]), sourceJson);

  writeText(opts["output"], JSON.stringify(result, null, 2));

  const icons = { "pass": "✅", "warning": "🟡", "critical": "🔴" };
  println("[修辭事實校驗] 判定：" + (icons[result.verdict] || "❓") + " " + result.verdict);

  for (const r of result.spatial_exaggerations) {
    println("  " + (icons[r.severity] || "❓") + " 空間誇張：「" + r.keyword + "」in「" + r.context.slice(0, 50) + "...」");
  }
  for (const r of result.temporal_exaggerations) {
    println("  " + (icons[r.severity] || "❓") + " 時間誇張：「" + r.keyword + "」in「" + r.context.slice(0, 50) + "...」");
  }
  for (const r of result.new_concepts) {
    println("  " + (icons[r.severity] || "❓") + " 新概念：「" + r.keyword + "」in「" + r.context.slice(0, 50) + "...」（來源原料中" + (r.in_source ? "✅" : "❌") + "出現）");
  }

  return result;
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchRhetoricFact(opts);
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配）
//   node check-rhetoric-fact.mjs --text {段落或路徑} --source prose-tmp/prose-s1.json \
//     --output prose-tmp/prose-rhetoric-warnings.json
//   stdout 輸出 JSON；exit code 1 = status error（verdict 判定讀 JSON verdict 欄位）
// ---------------------------------------------------------------------------

const CLI_OPTS = { text: { type: "str" }, source: { type: "str" }, output: { type: "str" } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchRhetoricFact(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
