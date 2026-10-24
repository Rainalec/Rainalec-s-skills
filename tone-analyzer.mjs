/**
 * tone-analyzer.mjs — S5 語氣曲線自動計算（移植版）
 * ==================================================
 * 原 scripts/tone-analyzer.js 1:1（見《移植報告》映射表 M-05）。
 * 取代 LLM 手動打分，使用基於詞庫的字符串匹配算法。
 * 輸出與 chain-gate.mjs 兼容的 JSON 格式供 S6 讀取。
 *
 * 詞庫與 check-robot-pattern.mjs 共用設計模式（字符串比對，無語義判斷）。
 * 姊妹腳本參考：step-content-guard / step-manager / chain-gate / qa-gate。
 *
 * 形式適配：--text（文件路徑）→ dispatch({text: 路徑})；--output → opts.output；
 * fs.readFileSync/writeFileSync → pw-compat readText/writeText。
 */

import { existsP, readText, writeText, printJson, pyRound, parseArgs } from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// === 詞庫 ===
// 所有詞庫均為字符串比對，與 check-robot-pattern.mjs 設計一致

export const EMOTION_WORDS = {
  "positive": [
    "高興", "開心", "驚喜", "漂亮", "精彩", "喜歡", "欣賞",
    "佩服", "感謝", "幸運", "感動", "欣慰", "驕傲", "興奮",
    "振奮", "鼓舞", "期待", "盼望",
  ],
  "negative": [
    "可惜", "遺憾", "糟糕", "憤怒", "失望", "擔心", "可怕",
    "困難", "失敗", "痛點", "頭痛", "煩惱", "崩潰", "焦慮",
    "恐懼", "沮喪", "悲觀", "嚴峻", "不滿",
    // 2026-07-08 新增強烈情感詞
    "苟延殘喘", "苟且", "慘烈", "慘痛", "毀滅性", "致命",
    "惡劣", "惡化", "危急", "崩盤", "潰敗", "淪陷",
    "肆虐", "猖獗", "橫行", "粗暴", "野蠻", "醜陋",
  ],
};

export const ABSOLUTE_WORDS = [
  "絕對", "一定", "必然", "肯定", "永遠", "毫無疑問",
  "不容置疑", "不容忽視", "必定",
];

export const SOFTENER_WORDS = [
  "可能", "或許", "大概", "也許", "恐怕", "不一定", "說不定",
];

export const PERSONAL_MARKERS = ["我", "我們"];

export const DISTANCE_MARKERS = [
  "作者認為", "本文認為", "研究指出", "數據顯示",
  "專家表示", "報告指出", "分析認為",
];

// 無主語傾向標記（句中無主語代詞）
export const SUBJECTLESS_MARKERS = ["這", "那", "他", "她", "它", "他們", "她們", "它們"];

/** 原版 calc_temperature。 */
export function calc_temperature(sentences) {
  const scores = [];
  for (const s of sentences) {
    let score = 5;  // 中性基線
    for (const w of EMOTION_WORDS["positive"]) {
      if (s.includes(w)) score += 2;
    }
    for (const w of EMOTION_WORDS["negative"]) {
      if (s.includes(w)) score += 3;
    }
    scores.push(Math.max(Math.min(score, 10), 1));
  }
  return scores;
}

/** 原版 calc_intensity。 */
export function calc_intensity(sentences) {
  const scores = [];
  for (const s of sentences) {
    let score = 5;  // 中性基線
    for (const w of ABSOLUTE_WORDS) {
      if (s.includes(w)) score += 4;
    }
    for (const w of SOFTENER_WORDS) {
      if (s.includes(w)) score -= 2;
    }
    scores.push(Math.max(Math.min(score, 10), 1));
  }
  return scores;
}

/** 原版 calc_distance。 */
export function calc_distance(sentences) {
  const scores = [];
  for (const s of sentences) {
    let score = 5;  // 中性基線
    const personalSorted = PERSONAL_MARKERS.slice().sort((a, b) => b.length - a.length);
    for (const w of personalSorted) {
      if (s.includes(w)) { score -= 2; break; }
    }
    for (const w of DISTANCE_MARKERS) {
      if (s.includes(w)) score += 2;
    }
    // 無主語句傾向：句子不含任何人稱代詞或指示代詞，且長度 > 10 字符
    const has_subject = (PERSONAL_MARKERS.concat(SUBJECTLESS_MARKERS)).some(w => s.includes(w));
    if (!has_subject && s.length > 10 && !s.includes('？') && !s.includes('!')) {
      score += 1;
    }
    scores.push(Math.max(Math.min(score, 10), 1));
  }
  return scores;
}

/** 原版 detect_anomalies（檢測相鄰句 ≥5 級跳躍）。 */
export function detect_anomalies(sentences, temps, ints, dists) {
  const anomalies = [];
  for (let i = 2; i < temps.length; i++) {
    const dims = [
      ["temperature", temps],
      ["intensity", ints],
      ["distance", dists],
    ];
    for (const [dim_name, dim_data] of dims) {
      const jump = Math.abs(dim_data[i] - dim_data[i - 1]);
      if (jump >= 5) {
        anomalies.push({
          "sentence_index": i,
          "dimension": dim_name,
          "jump": jump,
          "from": dim_data[i - 1],
          "to": dim_data[i],
          "text_snippet": sentences[i].slice(0, 50),
        });
      }
    }
  }
  return anomalies;
}

/** 原版 detect_outliers（句 vs 段落基線，2026-07-08 新增，1:1）。 */
export function detect_outliers(sentences, temps, ints, dists) {
  const THRESHOLD_TEMP_INTENSITY = 2.5;  // 溫度/力度偏離閾值
  const THRESHOLD_DISTANCE = 3.0;        // 距離偏離閾值

  const outliers = [];

  const n = sentences.length;
  if (n < 3) return outliers;

  const dim_config = [
    ["temperature", temps, THRESHOLD_TEMP_INTENSITY],
    ["intensity", ints, THRESHOLD_TEMP_INTENSITY],
    ["distance", dists, THRESHOLD_DISTANCE],
  ];

  for (const [dim_name, dim_data, threshold] of dim_config) {
    const window_half = 2;

    for (let i = 0; i < n; i++) {
      const start = Math.max(0, i - window_half);
      const end = Math.min(n, i + window_half + 1);
      const window_indices = [];
      for (let j = start; j < end; j++) if (j !== i) window_indices.push(j);

      if (window_indices.length < 2) continue;

      // 窗口基線 = 中位數
      const window_values = dim_data.filter((_, j) => window_indices.includes(j)).slice().sort((a, b) => a - b);
      const mid = Math.floor(window_values.length / 2);
      let baseline;
      if (window_values.length % 2 === 1) {
        baseline = window_values[mid];
      } else {
        baseline = (window_values[mid - 1] + window_values[mid]) / 2;
      }

      const deviation = Math.abs(dim_data[i] - baseline);

      if (deviation > threshold) {
        outliers.push({
          "sentence_index": i,
          "dimension": dim_name,
          "sentence_value": dim_data[i],
          "paragraph_median": pyRound(baseline, 1),
          "deviation": pyRound(deviation, 1),
          "text_snippet": sentences[i].slice(0, 60),
        });
      }
    }
  }

  return outliers;
}

/**
 * analyzeTone(text) —— 核心：原版 main() 去除文件 IO 後的計算主體（1:1）。
 * 返回 result 對象；無有效句子時返回 null（調用方按原版輸出 error）。
 */
export function analyzeTone(text) {
  text = String(text).trim();

  // 分句：以句號/問號/感嘆號/換行為邊界
  let sentences = text.split(new RegExp("[。！？!?\\n]"));
  sentences = sentences.map(s => s.trim()).filter(s => s.trim().length >= 2);

  if (!sentences.length) {
    return null;
  }

  const temps = calc_temperature(sentences);
  const ints = calc_intensity(sentences);
  const dists = calc_distance(sentences);
  const anomalies = detect_anomalies(sentences, temps, ints, dists);
  const outliers = detect_outliers(sentences, temps, ints, dists);

  return {
    "status": "ok",
    "sentence_count": sentences.length,
    "temperature": temps,
    "intensity": ints,
    "distance": dists,
    "anomalies": anomalies,
    "outliers": outliers,  // 2026-07-08 新增離群值檢測
    "summary": {
      "avg_temperature": temps.length ? pyRound(temps.reduce((a, b) => a + b, 0) / temps.length, 1) : 0,
      "avg_intensity": ints.length ? pyRound(ints.reduce((a, b) => a + b, 0) / ints.length, 1) : 0,
      "avg_distance": dists.length ? pyRound(dists.reduce((a, b) => a + b, 0) / dists.length, 1) : 0,
      "anomaly_count": anomalies.length,
      "outlier_count": outliers.length,  // 2026-07-08 新增
    },
  };
}

/**
 * dispatchToneAnalyzer(opts) —— 原版 main() 的對象參數直調版。
 * opts: { text: 輸入文件路徑（如 prose-tmp/prose-s4.txt）, output: 輸出 JSON 路徑 }
 */
export function dispatchToneAnalyzer(opts) {
  if (!opts["text"]) {
    return { "status": "error", "message": "缺少必要參數 --text", "exit_code": 1 };
  }
  if (!opts["output"]) {
    return { "status": "error", "message": "缺少必要參數 --output", "exit_code": 1 };
  }

  if (!existsP(opts["text"])) {
    return { "status": "error", "message": "輸入文件不存在: " + opts["text"], "exit_code": 1 };
  }

  let text;
  try {
    text = readText(opts["text"]).trim();
  } catch (e) {
    return { "status": "error", "message": "輸入文件不存在: " + opts["text"], "exit_code": 1 };
  }

  if (!text) {
    return { "status": "error", "message": "輸入文件為空", "exit_code": 1 };
  }

  const result = analyzeTone(text);
  if (result === null) {
    return { "status": "error", "message": "無有效句子（均 < 4 字符）", "exit_code": 1 };
  }

  // 寫入輸出（writeText 自動確保父目錄；原版 mkdirSync recursive 等價）
  writeText(opts["output"], JSON.stringify(result, null, 2));

  // stdout 輸出摘要
  return {
    "status": "ok",
    "output": opts["output"],
    "sentences": result.sentence_count,
    "anomalies": result.anomalies.length,
  };
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchToneAnalyzer(opts);
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配）
//   node tone-analyzer.mjs --text prose-tmp/prose-s4.txt --output prose-tmp/prose-s5-tone.json
//   stdout 輸出 JSON；exit code 1 = error
// ---------------------------------------------------------------------------

const CLI_OPTS = { text: { type: "str" }, output: { type: "str" } };

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchToneAnalyzer(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
