/**
 * chain-gate.mjs — 步驟依賴鏈檢查閘門 v2（移植版）
 * =================================================
 * 原 scripts/chain-gate.js 1:1（見《移植報告》映射表 M-03）。
 * 四種模式：
 *   1. checkUpstream(step)       : 檢查上游檔案是否存在（原 --check-upstream）
 *   2. validateContent(step)     : 檢查上游檔案內容是否有效（原 --validate-content）
 *   3. checkTool(step, tool)     : 檢查步驟是否使用指定合法工具（原 --check-tool）
 *   4. checkPrerequisites()      : 檢查執行環境前提條件（原 --check-prerequisites）
 *
 * 形式適配：
 *   - /tmp/ → prose-tmp/（TMP_DIR，見 pw-compat.mjs）；
 *   - 原版 fs.accessSync(TMP, W_OK) → 探針寫入+刪除（fs.remove 實測可刪文件）；
 *   - 原版以 __dirname 檢查姊妹腳本存在（同目錄）→ 以 import.meta.url 定位技能安裝目錄（WorkBuddy 適配，零佈署）；
 *   - process.exit(1) → 返回值攜帶 exit_code: 1。
 */

import {
  TMP_DIR, tmpPath, existsP, ensureDir, readText, writeText, printJson, parseArgs,
} from "./pw-compat.mjs";
import { rmSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** 本模組所在目錄（= 技能安裝目錄 scripts/；WorkBuddy 適配：姊妹腳本存在性以此為準）。 */
const SELF_DIR = dirname(fileURLToPath(import.meta.url));

// 各步驟的產出檔案對應（原版 1:1）
export const STEP_FILES = {
  1: "prose-s1.json",
  2: "prose-s2.json",
  3: "prose-s3.json",
  4: "prose-s4.txt",
  5: "prose-s5-tone.json",
  6: "prose-s6.txt",
  7: "prose-s7.json",
  8: "prose-s8-checklist.json",
};

// 各步驟的合法工具列表（工具綁定；原版 1:1，腳本名對應移植版模組名）
export const STEP_TOOLS = {
  0: ["chain-gate.mjs"],
  1: [],        // S1：LLM 直接執行
  2: [],        // S2：LLM 直接執行
  3: [],        // S3：LLM 直接執行
  4: ["check-robot-pattern.mjs", "check-narrative-coherence.mjs"],  // S4 跳出檢查+敘事連貫必須經過
  5: ["tone-analyzer.mjs"],         // S5 語氣分析必須經過此腳本
  6: ["check-robot-pattern.mjs"],  // S6 AI模式掃描必須經過此腳本
  7: [],        // S7：LLM 直接執行
  8: ["qa-gate.mjs"],              // S8 QA 必須經過此腳本
};

/** 原版 check_prerequisites()。 */
export function checkPrerequisites() {
  const issues = [];
  // 原版 fs.accessSync(TMP, W_OK) → 探針寫入+刪除（能力等價驗證「可寫入」）
  try {
    ensureDir(TMP_DIR);
    const probe = tmpPath(".probe-" + Date.now() + ".tmp");
    writeText(probe, "ok");
    rmSync(probe, { force: true });
  } catch (e) {
    issues.push(TMP_DIR + " 不可寫入");
  }
  const required_scripts = [
    "step-manager.mjs", "check-robot-pattern.mjs", "qa-gate.mjs", "tone-analyzer.mjs",
  ];
  // WorkBuddy 適配：腳本與本模組同目錄（技能安裝目錄），不再要求工作區 scripts/ 佈署
  for (const f of required_scripts) {
    const p = SELF_DIR + "/" + f;
    if (!existsP(p)) {
      issues.push("腳本缺失: " + f + " at " + p);
    }
  }
  if (issues.length) {
    return { "status": "error", "issues": issues, "exit_code": 1 };
  }
  return { "status": "ok", "message": "所有前提條件已滿足" };
}

/** 原版 check_upstream(step)。 */
export function checkUpstream(step) {
  if (step <= 1) {
    return { "status": "ok", "step": step, "upstream_file": "none", "exists": true };
  }
  if (step === 1.5) {
    const filepath = tmpPath(STEP_FILES[1]);
    const exists = existsP(filepath);
    return exists
      ? { "status": "ok", "step": step, "prev_step": 1, "required_file": filepath, "exists": true, "message": "S1 產出存在，允許進入 S1.5" }
      : { "status": "blocked", "step": step, "prev_step": 1, "required_file": filepath, "exists": false, "message": "跳步風險：S1 產出檔案缺失，執行凍結", "exit_code": 1 };
  }
  const prev_step = step - 1;
  if (!(prev_step in STEP_FILES)) {
    return { "status": "error", "message": "無效步驟: step=" + step + ", prev=" + prev_step, "exit_code": 1 };
  }
  const filename = STEP_FILES[prev_step];
  const filepath = tmpPath(filename);
  const exists = existsP(filepath);
  if (!exists) {
    return {
      "status": "blocked", "step": step, "prev_step": prev_step,
      "required_file": filepath, "exists": false,
      "message": "跳步風險：S" + prev_step + " 產出檔案缺失，執行凍結",
      "exit_code": 1
    };
  }
  return {
    "status": "ok", "step": step, "prev_step": prev_step,
    "required_file": filepath, "exists": true,
    "message": "S" + prev_step + " 產出存在，允許進入 S" + step
  };
}

// 各步驟的內容有效性檢查規則（原版 1:1）
function _validate_s1(data) {
  // S1：必須有分類標籤表，匹配率 ≥80%
  const issues = [];
  let match_rate = data.total_paragraph_match_rate || 0;
  if (typeof match_rate === "string" && match_rate.indexOf("%") !== -1) {
    match_rate = parseFloat(match_rate.replace("%", "").trim());
  }
  if (match_rate < 80) {
    issues.push("匹配率不足: " + match_rate + "% < 80%");
  }
  return issues;
}

function _validate_s2(data) {
  // S2：必須有 ≥3 個敘事層
  const issues = [];
  const layers = Object.keys(data).filter(k => k.indexOf("敘事層") !== -1 || k.toLowerCase().indexOf("narrative_layer") !== -1);
  if (layers.length < 3) {
    issues.push("敘事層不足: " + layers.length + " < 3");
  }
  return issues;
}

function _validate_s3(data) {
  // S3：大綱必須有 5-10 個段落
  const issues = [];
  const outline = data.outline || [];
  if (outline.length < 5) {
    issues.push("大綱段落不足: " + outline.length + " < 5");
  }
  if (outline.length > 10) {
    issues.push("大綱段落過多: " + outline.length + " > 10");
  }
  return issues;
}

function _validate_s4(content) {
  // S4：初稿必須 ≥500 字
  const issues = [];
  if (content.length < 500) {
    issues.push("字數不足: " + content.length + " < 500");
  }
  return issues;
}

function _validate_s5(data) {
  // S5：語氣曲線必須有句子數和異常記錄
  const issues = [];
  if ((data.sentence_count || 0) < 3) {
    issues.push("句子數不足: " + (data.sentence_count || 0) + " < 3");
  }
  if (!("anomalies" in data)) {
    issues.push("缺少 anomalies 字段");
  }
  return issues;
}

function _validate_s6(content) {
  // S6：修正稿無未閉合括號，結尾為句號
  const issues = [];
  if (content.split("{").length - 1 !== content.split("}").length - 1) {
    const c1 = content.split("{").length - 1;
    const c2 = content.split("}").length - 1;
    issues.push("花括號未閉合: { " + c1 + " } " + c2);
  }
  if (content.split("[").length - 1 !== content.split("]").length - 1) {
    const c1 = content.split("[").length - 1;
    const c2 = content.split("]").length - 1;
    issues.push("方括號未閉合: [ " + c1 + " ] " + c2);
  }
  if (!content.endsWith("。")) {
    issues.push("結尾不是句號: ..." + content.slice(-10));
  }
  return issues;
}

function _validate_s7(data) {
  // S7：靈魂注入必須有通過維度數
  const issues = [];
  const passed = data.passed_dimensions || 0;
  if (passed < 2) {
    issues.push("通過維度不足: " + passed + " < 2");
  }
  return issues;
}

function _validate_s8(data) {
  // S8：checklist 必須有 items 陣列且非空
  const issues = [];
  const items = data.items || [];
  if (items.length < 8) {
    issues.push("QA 項目不足: " + items.length + " < 8");
  }
  return issues;
}

const VALIDATORS = {
  1: _validate_s1,
  2: _validate_s2,
  3: _validate_s3,
  4: _validate_s4,
  5: _validate_s5,
  6: _validate_s6,
  7: _validate_s7,
  8: _validate_s8,
};

/** 原版 validate_content(step)。 */
export function validateContent(step) {
  if (!(step in STEP_FILES)) {
    return { "status": "error", "message": "無效步驟編號: " + step, "exit_code": 1 };
  }
  const filename = STEP_FILES[step];
  const filepath = tmpPath(filename);

  let data;
  let content;
  if (!existsP(filepath)) {
    return {
      "status": "blocked", "step": step,
      "message": "S" + step + " 產出檔案缺失: " + filepath,
      "exit_code": 1
    };
  }

  try {
    if (filename.endsWith(".json")) {
      const raw = readText(filepath).trim();
      if (!raw) {
        throw new Error("JSON 檔案為空");
      }
      data = JSON.parse(raw);
    } else {
      content = readText(filepath).trim();
    }
  } catch (e) {
    return {
      "status": "blocked", "step": step,
      "message": "S" + step + " 內容無效: " + e.message,
      "exit_code": 1
    };
  }

  const validator = VALIDATORS[step];
  if (validator) {
    const issues = validator(filename.endsWith(".json") ? data : content);
    if (issues.length) {
      return {
        "status": "blocked", "step": step,
        "message": "S" + step + " 內容校驗不通過",
        "issues": issues,
        "exit_code": 1
      };
    }
  }

  return {
    "status": "ok", "step": step,
    "file": filepath, "message": "S" + step + " 內容有效"
  };
}

/** 原版 check_tool(step, expected_tool)。 */
export function checkTool(step, expected_tool) {
  if (!(step in STEP_TOOLS)) {
    return { "status": "error", "message": "無效步驟: " + step, "exit_code": 1 };
  }

  const allowed_tools = STEP_TOOLS[step] || [];

  // 若無指定合法工具，該步驟不鎖定
  if (!allowed_tools.length) {
    return {
      "status": "ok", "step": step,
      "message": "S" + step + " 無工具綁定，跳過檢查"
    };
  }

  // 若調用者指定了預期工具
  if (expected_tool) {
    if (allowed_tools.indexOf(expected_tool) === -1) {
      return {
        "status": "error", "step": step,
        "message": "工具 " + expected_tool + " 不在 S" + step + " 的合法工具列表中",
        "allowed_tools": allowed_tools,
        "exit_code": 1
      };
    }
    return {
      "status": "ok", "step": step,
      "tool": expected_tool, "allowed": true,
      "message": "S" + step + " 工具 " + expected_tool + " 已授權"
    };
  }

  // 若未指定預期工具，檢查產出檔案是否有 tool 標記
  const filename = STEP_FILES[step];
  if (filename) {
    const filepath = tmpPath(filename);
    if (existsP(filepath)) {
      try {
        const raw = readText(filepath);
        for (const t of allowed_tools) {
          if (raw.indexOf(t) !== -1) {
            return {
              "status": "ok", "step": step,
              "tool": t, "allowed": true,
              "message": "S" + step + " 標記工具 " + t + " 在產出中被找到"
            };
          }
        }
      } catch (e) {
        // ignore IOError
      }
    }
  }

  return {
    "status": "blocked", "step": step,
    "message": "S" + step + " 未使用任何合法工具（允許: " + JSON.stringify(allowed_tools) + "）",
    "allowed_tools": allowed_tools,
    "exit_code": 1
  };
}

/**
 * dispatchChainGate(opts) —— 原版 main() 的對象參數直調版。
 * opts: { "check-prerequisites"?: true, "check-upstream"?: true, step?: number,
 *         "validate-content"?: number, "check-tool"?: number, "expected-tool"?: string }
 */
export function dispatchChainGate(opts) {
  if (opts["check-prerequisites"]) {
    return checkPrerequisites();
  } else if (opts["check-upstream"]) {
    if (opts["step"] === null || opts["step"] === undefined) {
      return { "status": "error", "message": "--check-upstream 需提供 --step", "exit_code": 1 };
    }
    return checkUpstream(opts["step"]);
  } else if (opts["validate-content"] !== null && opts["validate-content"] !== undefined) {
    return validateContent(opts["validate-content"]);
  } else if (opts["check-tool"] !== null && opts["check-tool"] !== undefined) {
    return checkTool(opts["check-tool"], opts["expected-tool"]);
  }
  return { "status": "error", "message": "請指定操作模式", "exit_code": 1 };
}

/** 便捷入口（宿主一行調用）。 */
export function run(opts) {
  const result = dispatchChainGate(opts);
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配；命令在工作區根目錄執行）
//   node chain-gate.mjs --check-prerequisites
//   node chain-gate.mjs --check-upstream --step {N}
//   node chain-gate.mjs --validate-content {N}
//   node chain-gate.mjs --check-tool {N} --expected-tool {腳本名}
//   stdout 輸出 JSON；exit code 1 = status error/blocked
// ---------------------------------------------------------------------------

const CLI_OPTS = {
  "check-prerequisites": { type: "bool" },
  "check-upstream": { type: "bool" },
  step: { type: "float" },
  "validate-content": { type: "int" },
  "check-tool": { type: "int" },
  "expected-tool": { type: "str" },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  const result = dispatchChainGate(opts);
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
