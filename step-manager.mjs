/**
 * step-manager.mjs — 步驟指紋追蹤管理器（移植版）
 * ================================================
 * 合併映射（見《移植報告》文件映射表 M-02 / M-01）：
 *   - 原 scripts/step-manager.js        → 本模組 step-manager 部分（init/complete/complete-batch/validate-all）
 *   - 原 dependencies/judgment-skill/step-content-guard.js（外部依賴，隨包附帶）
 *                                       → 本模組 step-content-guard 部分（init/submit-fingerprint/
 *                                          check-fingerprint/verify/validate-all）
 * 兩者為原版「雙重監督機制」的兩層：第一層步驟布爾狀態，第二層輸出內容 MD5 指紋，缺一不可。
 * 合併原因：附件總數 ≤12（指令書 2.1 安裝 B）；全部函數 1:1 保留，狀態檔分離不變。
 *
 * 原版差異（均為形式適配，能力無缺口）：
 *   - /tmp/prose-step-state.json      → prose-tmp/prose-step-state.json
 *   - /tmp/prose-batch-progress.json  → prose-tmp/prose-batch-progress.json
 *   - /tmp/.step-content-gate.json    → prose-tmp/.step-content-gate.json
 *   - CLI（node ... --action init）    → 導出函數 + dispatch(opts)（宿主 eval 直調）
 *   - process.exit(1)                 → 返回值攜帶 exit_code: 1
 *   - crypto MD5                      → pw-compat 純 JS md5Hex
 *   - Math.random                     → mulberry32 種子 PRNG（nonce 隨機語義不變）
 */

import {
  TMP_DIR, tmpPath, existsP, readText, writeText,
  printJson, nowIsoLocal, strftime, randInt, md5Hex,
  parseArgs, readStdin,
} from "./pw-compat.mjs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 第一層：step-manager（原 step-manager.js 1:1）
// ---------------------------------------------------------------------------

/** 步驟名稱映射（對應 SKILL.md 進度條格式）。 */
export const STEP_NAMES = {
  "1": "S1 解構原料",
  "1.5": "S1.5 因果時序校驗",
  "2": "S2 重建敘事",
  "3": "S3 專業大綱",
  "4": "S4 寫作",
  "5": "S5 語氣掃描",
  "6": "S6 去機械化",
  "7": "S7 靈魂注入",
  "8": "S8 QA",
  "9": "S9 自我批判",
};

const STATE_FILE = tmpPath("prose-step-state.json");
const PROGRESS_FILE = tmpPath("prose-batch-progress.json");

const STEP_KEYS = ["1", "1.5", "2", "3", "4", "5", "6", "7", "8", "9"];

/** 原版 write_progress()：根據 STATE 寫入進度條（供批次規劃檢查命令讀取）。 */
function write_progress() {
  if (!existsP(STATE_FILE)) {
    return;
  }
  const state = JSON.parse(readText(STATE_FILE));
  const parts = [];
  for (const key of STEP_KEYS) {
    const icon = state.steps[key] === "completed" ? "✅" : "⏳";
    parts.push(icon + " " + STEP_NAMES[key]);
  }
  writeText(PROGRESS_FILE, parts.join(" | "));
}

/** 原版 init(topic)。 */
export function init(topic) {
  const state = {
    "topic": topic,
    "timestamp": strftime("%Y-%m-%dT%H:%M:%S"),
    "steps": {},
    "batches": {
      "1": ["1", "1.5", "2", "3"],
      "2": ["4"],
      "3": ["5", "6", "7"],
      "4": ["8"],
      "5": ["9"]
    },
    "batch_status": {},
    "nonce": Date.now().toString(16)
  };
  for (const k of STEP_KEYS) state.steps[k] = "pending";
  for (let i = 1; i <= 5; i++) state.batch_status[String(i)] = "pending";
  writeText(STATE_FILE, JSON.stringify(state, null, 2));
  write_progress();
  return { "status": "ok", "action": "init", "nonce": state.nonce };
}

/** 原版 complete(step)。step 可為整數或 1.5。 */
export function complete(step) {
  if (!existsP(STATE_FILE)) {
    return { "status": "error", "message": "STATE 檔案不存在，請先 init", "exit_code": 1 };
  }
  const state = JSON.parse(readText(STATE_FILE));
  const step_num = Number(step);
  const step_str = (step_num === Math.floor(step_num)) ? String(Math.floor(step_num)) : String(step_num);
  if (!(step_str in state.steps)) {
    return { "status": "error", "message": "無效步驟: " + step_num, "exit_code": 1 };
  }
  state.steps[step_str] = "completed";
  // 自動更新 batch_status
  for (const batch_id in state.batches) {
    const step_ids = state.batches[batch_id];
    if (step_ids.indexOf(step_str) !== -1) {
      const all_completed = step_ids.every(s => state.steps[s] === "completed");
      state.batch_status[batch_id] = all_completed ? "completed" : "in_progress";
    }
  }
  writeText(STATE_FILE, JSON.stringify(state, null, 2));
  write_progress();
  return { "status": "ok", "action": "complete", "step": step_num, "nonce": state.nonce };
}

/** 原版 complete_batch()。 */
export function complete_batch() {
  if (!existsP(STATE_FILE)) {
    return { "status": "error", "message": "STATE 檔案不存在", "exit_code": 1 };
  }
  const state = JSON.parse(readText(STATE_FILE));
  const pending = [];
  for (const s in state.steps) { if (state.steps[s] !== "completed") pending.push(s); }
  if (pending.length) {
    return { "status": "error", "message": "尚有未完成步驟: " + JSON.stringify(pending), "exit_code": 1 };
  }
  for (const b in state.batch_status) {
    state.batch_status[b] = "completed";
  }
  writeText(STATE_FILE, JSON.stringify(state, null, 2));
  return { "status": "ok", "action": "complete-batch", "nonce": state.nonce };
}

/** 原版 validate_all()。 */
export function validate_all() {
  if (!existsP(STATE_FILE)) {
    return { "status": "error", "message": "STATE 檔案不存在", "exit_code": 1 };
  }
  const state = JSON.parse(readText(STATE_FILE));
  const all_done = Object.values(state.steps).every(v => v === "completed");
  const all_batches = Object.values(state.batch_status).every(v => v === "completed");
  return {
    "status": (all_done && all_batches) ? "ok" : "error",
    "action": "validate-all",
    "all_steps_completed": all_done,
    "all_batches_completed": all_batches,
    "nonce": state.nonce,
    "exit_code": (all_done && all_batches) ? 0 : 1
  };
}

/**
 * dispatchStepManager(opts) —— 原版 main() 的對象參數直調版。
 * opts: { action: "init"|"complete"|"complete-batch"|"validate-all",
 *         topic?: string, step?: number }
 * 返回：原版 printJson 的對象 + exit_code。
 */
export function dispatchStepManager(opts) {
  const choices = ["init", "complete", "complete-batch", "validate-all"];
  if (opts["action"] === null || opts["action"] === undefined || opts["action"] === "") {
    return { "status": "error", "message": "--action 為必填項", "exit_code": 1 };
  }
  if (choices.indexOf(opts["action"]) === -1) {
    return { "status": "error", "message": "無效 action: " + opts["action"], "exit_code": 1 };
  }
  if (opts["action"] === "init") {
    if (!opts["topic"]) {
      return { "status": "error", "message": "init 模式需提供 --topic", "exit_code": 1 };
    }
    return init(opts["topic"]);
  } else if (opts["action"] === "complete") {
    if (opts["step"] === null || opts["step"] === undefined) {
      return { "status": "error", "message": "complete 模式需提供 --step", "exit_code": 1 };
    }
    return complete(opts["step"]);
  } else if (opts["action"] === "complete-batch") {
    return complete_batch();
  }
  return validate_all();
}

// ---------------------------------------------------------------------------
// 第二層：step-content-guard（原 dependencies/judgment-skill/step-content-guard.js 1:1）
// ---------------------------------------------------------------------------

const GUARD_STATE_PATH = tmpPath(".step-content-gate.json");

/** 原版 initState()。 */
export function guardInit() {
  const state = { "steps": {}, "require_fingerprint": true };
  writeText(GUARD_STATE_PATH, JSON.stringify(state, null, 2));
  const nonce = randInt(10000000, 99999999);
  return { "status": "ok", "action": "init", "require_fingerprint": true, "nonce": nonce };
}

function loadGuardState() {
  if (!existsP(GUARD_STATE_PATH)) {
    return null;
  }
  return JSON.parse(readText(GUARD_STATE_PATH));
}

function saveGuardState(state) {
  writeText(GUARD_STATE_PATH, JSON.stringify(state, null, 2));
}

/** 原版 submitFingerprint(stepId, content)。 */
export function guardSubmitFingerprint(stepId, content) {
  const state = loadGuardState();
  if (state === null) {
    const nonce = randInt(10000000, 99999999);
    return { "status": "error", "message": "內容監督狀態檔案不存在。請先執行 --action init。", "nonce": nonce, "exit_code": 1 };
  }

  const stripped = content ? String(content).trim() : "";
  if (!stripped) {
    const nonce = randInt(10000000, 99999999);
    return { "status": "error", "message": "步驟 " + stepId + " 的輸出內容為空白，無法提交指紋。", "nonce": nonce, "exit_code": 1 };
  }

  if (stripped.length < 10) {
    const nonce = randInt(10000000, 99999999);
    return {
      "status": "error",
      "message": "步驟 " + stepId + " 的輸出內容不足 10 個字元（當前 " + stripped.length + " 字元），可能為無效輸出或輸出不完全。請確認完整輸出後重新提交。",
      "nonce": nonce,
      "exit_code": 1
    };
  }

  const md5Hash = md5Hex(stripped);
  const sk = String(stepId);

  // 覆蓋保存（以最新提交為準）
  state["steps"][sk] = {
    "fingerprint": md5Hash,
    "content_length": stripped.length,
    "submitted_at": nowIsoLocal()
  };
  saveGuardState(state);

  const nonce = randInt(10000000, 99999999);
  return {
    "status": "ok",
    "step_id": stepId,
    "fingerprint": md5Hash.slice(0, 16) + "...",
    "fingerprint_full": md5Hash,
    "content_length": stripped.length,
    "nonce": nonce
  };
}

/** 原版 checkFingerprint(stepId)。 */
export function guardCheckFingerprint(stepId) {
  const state = loadGuardState();
  if (state === null) {
    const nonce = randInt(10000000, 99999999);
    return { "status": "error", "message": "狀態檔案不存在。請先執行 --action init。", "nonce": nonce };
  }

  const sk = String(stepId);
  const hasFp = (sk in state["steps"]) && ("fingerprint" in state["steps"][sk]);
  const nonce = randInt(10000000, 99999999);

  const result = {
    "status": "ok",
    "step_id": stepId,
    "has_fingerprint": hasFp,
    "nonce": nonce
  };
  if (hasFp) {
    result["fingerprint"] = state["steps"][sk]["fingerprint"];
  }
  return result;
}

/** 原版 verify(stepId, content)。 */
export function guardVerify(stepId, content) {
  const state = loadGuardState();
  if (state === null) {
    const nonce = randInt(10000000, 99999999);
    return { "status": "error", "message": "狀態檔案不存在。", "nonce": nonce, "exit_code": 1 };
  }

  const sk = String(stepId);
  if (!(sk in state["steps"]) || !("fingerprint" in state["steps"][sk])) {
    const nonce = randInt(10000000, 99999999);
    return {
      "status": "error",
      "message": "步驟 " + stepId + " 無已提交的 fingerprint。請先調用 submit-fingerprint。",
      "nonce": nonce,
      "exit_code": 1
    };
  }

  const stripped = content ? String(content).trim() : "";
  const currentHash = md5Hex(stripped);
  const savedHash = state["steps"][sk]["fingerprint"];

  const nonce = randInt(10000000, 99999999);
  if (currentHash === savedHash) {
    return { "status": "ok", "step_id": stepId, "verified": true, "nonce": nonce };
  }
  return {
    "status": "error",
    "step_id": stepId,
    "verified": false,
    "message": "步驟 " + stepId + " 的輸出內容已被修改。原始 fingerprint: " + savedHash.slice(0, 16) + "...，當前 hash: " + currentHash.slice(0, 16) + "...。內容變更後必須從該步驟重新執行並重新提交指紋。",
    "nonce": nonce,
    "exit_code": 1
  };
}

/** 原版 validateAll()（step-content-guard 版）。 */
export function guardValidateAll() {
  const state = loadGuardState();
  if (state === null) {
    const nonce = randInt(10000000, 99999999);
    return { "status": "error", "message": "狀態檔案不存在。請先執行 --action init。", "nonce": nonce, "exit_code": 1 };
  }

  if (!state["steps"] || Object.keys(state["steps"]).length === 0) {
    const nonce = randInt(10000000, 99999999);
    return {
      "status": "ok",
      "all_steps_guarded": true,
      "total_steps_guarded": 0,
      "unguarded_steps": [],
      "nonce": nonce
    };
  }

  const unguarded = [];
  for (const sk in state["steps"]) {
    const info = state["steps"][sk];
    if (!("fingerprint" in info)) {
      unguarded.push(parseInt(sk, 10));
    }
  }

  if (unguarded.length > 0) {
    const nonce = randInt(10000000, 99999999);
    return {
      "status": "error",
      "all_steps_guarded": false,
      "total_steps_guarded": Object.keys(state["steps"]).length - unguarded.length,
      "unguarded_steps": unguarded,
      "message": "以下步驟無完整 fingerprint：" + JSON.stringify(unguarded) + "。請回到對應步驟重新提交指紋。",
      "nonce": nonce,
      "exit_code": 1
    };
  }

  const guarded = Object.keys(state["steps"]).map(Number).sort((a, b) => a - b);
  const nonce = randInt(10000000, 99999999);
  return {
    "status": "ok",
    "all_steps_guarded": true,
    "total_steps_guarded": guarded.length,
    "guarded_steps": guarded,
    "nonce": nonce
  };
}

/**
 * dispatchStepContentGuard(opts) —— 原版 main() 的對象參數直調版。
 * opts: { action: "init"|"submit-fingerprint"|"check-fingerprint"|"verify"|"validate-all",
 *         "step-id"?: number, content?: string }
 * 原版 stdin 管道讀取（fs.readFileSync(0)）在目標環境不存在 → 內容一律經 opts.content
 * 傳入（宿主把該步驟的完整對話輸出文字作為參數，能力等價）。
 */
export function dispatchStepContentGuard(opts) {
  const choices = ["init", "submit-fingerprint", "check-fingerprint", "verify", "validate-all"];
  if (opts["action"] === null || opts["action"] === undefined) {
    return { "status": "error", "message": "--action 參數為必填（required）。", "exit_code": 1 };
  }
  if (choices.indexOf(opts["action"]) === -1) {
    return { "status": "error", "message": "無效的 --action 值：" + opts["action"] + "。", "exit_code": 1 };
  }

  if (opts["action"] === "init") {
    return guardInit();
  } else if (opts["action"] === "submit-fingerprint") {
    if (opts["step-id"] === null || opts["step-id"] === undefined) {
      return { "status": "error", "message": "submit-fingerprint 模式需要 --step-id 參數", "exit_code": 1 };
    }
    return guardSubmitFingerprint(opts["step-id"], opts["content"]);
  } else if (opts["action"] === "check-fingerprint") {
    if (opts["step-id"] === null || opts["step-id"] === undefined) {
      return { "status": "error", "message": "check-fingerprint 模式需要 --step-id 參數", "exit_code": 1 };
    }
    return guardCheckFingerprint(opts["step-id"]);
  } else if (opts["action"] === "verify") {
    if (opts["step-id"] === null || opts["step-id"] === undefined) {
      return { "status": "error", "message": "verify 模式需要 --step-id 參數", "exit_code": 1 };
    }
    return guardVerify(opts["step-id"], opts["content"]);
  }
  return guardValidateAll();
}

/** 便捷入口（宿主一行調用）：sm = import 後 sm.run({...})。 */
export function run(opts) {
  const result = dispatchStepManager(opts);
  printJson(result);
  return result;
}


// ---------------------------------------------------------------------------
// CLI 入口（WorkBuddy 適配；命令在工作區根目錄執行）
//   步驟追蹤：
//     node step-manager.mjs --action init --topic {topic}
//     node step-manager.mjs --action complete --step {N|1.5}
//     node step-manager.mjs --action complete-batch
//     node step-manager.mjs --action validate-all
//   內容指紋（--guard 模式，第二層監督）：
//     node step-manager.mjs --guard --action init
//     node step-manager.mjs --guard --action submit-fingerprint --step-id {N} --content-file {path}
//     node step-manager.mjs --guard --action check-fingerprint --step-id {N}
//     node step-manager.mjs --guard --action verify --step-id {N} --content-file {path}
//     node step-manager.mjs --guard --action validate-all
//   （submit-fingerprint/verify 亦可省略 --content-file，改走 stdin 管道）
//   stdout 輸出 JSON；exit code 1 = error
// ---------------------------------------------------------------------------

const CLI_OPTS = {
  guard: { type: "bool" },
  action: { type: "str" },
  topic: { type: "str" },
  step: { type: "float" },
  "step-id": { type: "int" },
  content: { type: "str" },
  "content-file": { type: "str" },
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { opts } = parseArgs(process.argv.slice(2), CLI_OPTS);
  let result;
  if (opts["guard"]) {
    if (opts["content-file"]) {
      opts["content"] = readText(opts["content-file"]);
    } else if (!opts["content"]) {
      const piped = readStdin();
      if (piped) opts["content"] = piped;
    }
    result = dispatchStepContentGuard(opts);
  } else {
    result = dispatchStepManager(opts);
  }
  printJson(result);
  process.exitCode = result.exit_code || 0;
}
