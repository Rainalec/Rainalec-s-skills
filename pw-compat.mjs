/**
 * pw-compat.mjs — prose-weaver 移植版共享兼容層
 * ================================================
 * 原版：12 個 Node CLI 腳本各自內聯同一套「Python-compat helpers」（parseArgs/coerce/
 *       reEscape/pyReprStr/runScript/md5Hex/randInt/nowIsoLocal/strftime/println/
 *       printJson/dumpJson/utcDate/pyRound/pyExit，每份約 97 行）。
 * 移植：提取為單一模組（行為 1:1，見《移植報告》文件映射表 M-00）。
 *
 * 目標環境（WorkBuddy 原生適配，2026-10-24；Node.js >= 18，本環境 Node 22）：
 *   - ES2020 模組（.mjs），同步代碼，無 async/Promise 依賴；
 *   - fs 用 node:fs 原生 API；相對路徑起於工作區根（命令在工作區根執行）；
 *   - md5Hex 保留純 JS 實現（RFC 1321）——行為 1:1，不依賴 node:crypto；
 *   - randInt 基於 mulberry32（時間種子，同種子可復現；僅作 nonce）；
 *   - matchIter() 為 String.prototype.matchAll 的等價替代（g-clone + exec 循環）；
 *   - 原版 /tmp/ 中間產出 → 工作區子目錄 prose-tmp/；最終成品走 outputs/；
 *   - CLI 入口：各模組以 import.meta.url 判定被直調；stdout 輸出 JSON，
 *     exit code 0/1（1 = status error/blocked）。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";

// ---------------------------------------------------------------------------
// 常量與路徑映射
// ---------------------------------------------------------------------------

/** 原版常量 TMP = "/tmp" 的工作區映射（中間產出子目錄）。 */
export const TMP_DIR = "prose-tmp";

/** 組合原版 /tmp 下檔名 → 工作區相對路徑。 */
export function tmpPath(filename) {
  return TMP_DIR + "/" + filename;
}

// ---------------------------------------------------------------------------
// fs 適配（WorkBuddy 原生：node:fs；相對路徑起於工作區根）
// ---------------------------------------------------------------------------

/** 等價原版 fs.existsSync → 布林。 */
export function existsP(p) {
  try {
    return !!existsSync(p);
  } catch (e) {
    return false;
  }
}

/** 逐級建目錄（原版 fs.mkdirSync(p, {recursive:true}) 的等價）。 */
export function ensureDir(dir) {
  if (!dir || dir === "." || dir === "/") return true;
  const parts = String(dir).split("/").filter(x => x.length > 0 && x !== ".");
  let cur = "";
  for (const part of parts) {
    cur = cur ? cur + "/" + part : part;
    if (!existsP(cur)) {
      try {
        mkdirSync(cur);
      } catch (e) {
        // 目錄已存在等競態 → 冪等忽略
      }
    }
  }
  return true;
}

/** 讀文本（原版 fs.readFileSync(p, "utf-8")；失敗拋 Error，語義一致）。 */
export function readText(p) {
  try {
    return readFileSync(p, "utf-8");
  } catch (e) {
    throw new Error("ENOENT: no such file or directory, open '" + p + "'");
  }
}

/** 存在則讀文本，否則返回 null（原版 existsSync+readFileSync 組合慣用式）。 */
export function readTextIfExists(p) {
  return existsP(p) ? readText(p) : null;
}

/** 寫文本到工作區（原版 fs.writeFileSync；自動確保父目錄存在）。 */
export function writeText(p, content) {
  const idx = String(p).lastIndexOf("/");
  if (idx > 0) ensureDir(String(p).slice(0, idx));
  writeFileSync(p, String(content));
  return true;
}

/** 寫最終成品 → outputs/（工作區相對路徑；父目錄自動創建）。 */
export function saveOutput(name, content) {
  return writeText(name, content);
}

// ---------------------------------------------------------------------------
// JSON 輸出（原版 println/printJson/dumpJson）
// ---------------------------------------------------------------------------

/** 原版 println：stdout 一行。 */
export function println(s) {
  console.log(String(s));
}

/** 原版 printJson：stdout 輸出縮排 JSON。 */
export function printJson(obj) {
  console.log(JSON.stringify(obj, null, 2) + "\n");
}

/** 原版 dumpJson。 */
export function dumpJson(obj) {
  return JSON.stringify(obj, null, 2);
}

// ---------------------------------------------------------------------------
// 數值與時間（原版 pyRound/utcDate/nowIsoLocal/strftime）
// ---------------------------------------------------------------------------

/** Python 風格四捨五入到 n 位。 */
export function pyRound(x, n) {
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

/** 原版 utcDate(y, m, d) → UTC 毫秒。 */
export function utcDate(y, m, d) {
  return Date.UTC(y, m - 1, d);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** 原版 nowIsoLocal()。 */
export function nowIsoLocal() {
  const d = new Date();
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    "T" + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

/** 原版 strftime（支援 %Y %m %d %H %M %S）。 */
export function strftime(fmt) {
  const d = new Date();
  return fmt.replace(/%Y/g, d.getFullYear()).replace(/%m/g, pad2(d.getMonth() + 1))
    .replace(/%d/g, pad2(d.getDate())).replace(/%H/g, pad2(d.getHours()))
    .replace(/%M/g, pad2(d.getMinutes())).replace(/%S/g, pad2(d.getSeconds()));
}

// ---------------------------------------------------------------------------
// 種子 PRNG（指令書 L2：隨機數自帶種子 PRNG 保證可復現）
// ---------------------------------------------------------------------------

/** mulberry32 —— 32 位種子 PRNG。 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

let _prng = mulberry32((Date.now() & 0xffffffff) >>> 0);

/** 原版 randInt(min, max)（含兩端）。改用種子 PRNG（nonce 語義不變）。 */
export function randInt(min, max) {
  return Math.floor(_prng() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------------
// 字串/正則工具（原版 reEscape/pyReprStr/strCount + matchIter 等價層）
// ---------------------------------------------------------------------------

export function reEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function pyReprStr(s) {
  let r = String(s);
  r = r.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  r = r.replace(/[\x00-\x1f\x7f]/g, ch => {
    const map = { "\n": "\\n", "\t": "\\t", "\r": "\\r", "\b": "\\b", "\f": "\\f", "\v": "\\v" };
    return map[ch] || "\\x" + ch.charCodeAt(0).toString(16).padStart(2, "0");
  });
  return "'" + r + "'";
}

/** 子串計數（原版 strCount，等價 s.split(sub).length - 1）。 */
export function strCount(s, sub) {
  if (!sub) return 0;
  return String(s).split(sub).length - 1;
}

/**
 * resolveTextArg(v) —— 「文件路徑 or 內聯文字」雙形態解析（WorkBuddy 適配新增，
 * 自 check-causal-chain.mjs 上移為共用導出）。判定為路徑的條件（三者同時滿足）：
 * 字符串、不含換行、長度 < 4096、文件存在；否則原樣返回（視為內聯文字）。
 * 用途：所有 --text 類參數；長文本落盤後傳路徑，規避命令行長度上限（見 SKILL.md M5）。
 */
export function resolveTextArg(v) {
  if (typeof v === "string" && v.indexOf("\n") === -1 && v.length < 4096 && existsP(v)) {
    return readText(v);
  }
  return v;
}

/** 讀 stdin 全文（管道/重定向輸入；TTY 或讀失敗返回空串）。 */
export function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch (e) {
    return "";
  }
}

/**
 * matchIter(text, regex) —— String.prototype.matchAll 的完全等價替代。
 * 返回匹配數組的陣列；每項為 exec 結果（含 index / 捕獲組），可 .slice(1) 取捕獲組。
 * 依賴 regex 的 g 標誌（與 matchAll 相同的約定）；內部克隆 regex，不污染調用方的 lastIndex。
 */
export function matchIter(text, regex) {
  const flags = (regex.flags.indexOf("g") === -1) ? regex.flags + "g" : regex.flags;
  const re = new RegExp(regex.source, flags);
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex += 1; // 零長匹配防死循環（與 matchAll 行為一致）
  }
  return out;
}

// ---------------------------------------------------------------------------
// CLI 參數解析（原版 parseArgs；移植版 dispatch 以對象參數為主，此函數保留用於
// 兼容原 CLI 選項名 → 對象欄位名的語義映射，並被各模組 dispatch 直接使用）
// ---------------------------------------------------------------------------

function coerce(type, v) {
  if (v === undefined || v === null) return v;
  if (type === "int") return parseInt(v, 10);
  if (type === "float") return parseFloat(v);
  return v;
}

/**
 * 原版 parseArgs(argv, options)。
 * options: { "name": {type: "str"|"int"|"float"|"bool", default, required, short, choices} }
 * 返回 { opts, positionals }。此處保留原實現（argv 形態）；移植版各模組另提供
 * dispatch(optsObject) 以對象直傳（宿主無命令行）。
 */
export function parseArgs(argv, options) {
  const opts = {};
  for (const k in options) {
    opts[k] = Object.prototype.hasOwnProperty.call(options[k], "default")
      ? options[k].default
      : (options[k].type === "bool" ? false : undefined);
  }
  const positionals = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a.startsWith("--")) {
      let body = a.slice(2);
      let inlineVal = undefined, hasInline = false;
      const eq = body.indexOf("=");
      if (eq !== -1) { inlineVal = body.slice(eq + 1); body = body.slice(0, eq); hasInline = true; }
      if (!(body in options)) { positionals.push(a); i++; continue; }
      const opt = options[body];
      if (opt.type === "bool") {
        opts[body] = hasInline ? (inlineVal === "true" || inlineVal === "1") : true;
      } else if (hasInline) {
        opts[body] = coerce(opt.type, inlineVal);
      } else {
        i++;
        opts[body] = coerce(opt.type, argv[i]);
      }
    } else if (a.length > 1 && a[0] === "-" && a[1] !== "-") {
      const c = a[1];
      let found = null;
      for (const k in options) { if (options[k].short === c) { found = k; break; } }
      if (found) {
        const opt = options[found];
        if (opt.type === "bool") opts[found] = true;
        else { i++; opts[found] = coerce(opt.type, argv[i]); }
      } else { positionals.push(a); }
    } else {
      positionals.push(a);
    }
    i++;
  }
  return { opts, positionals };
}

// ---------------------------------------------------------------------------
// 純 JS MD5（原版 md5Hex = crypto.createHash("md5")；crypto 在目標環境不存在）
// RFC 1321；輸入按 UTF-8 編碼（與 Node crypto.update(s, "utf-8") 一致）。
// ---------------------------------------------------------------------------

const MD5_S = [
  7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
  5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
  4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
  6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

const MD5_K = (() => {
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) {
    K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  }
  return K;
})();

function rotl32(x, c) {
  return ((x << c) | (x >>> (32 - c))) >>> 0;
}

function toHex32(x) {
  let out = "";
  for (let i = 0; i < 4; i++) {
    const byte = (x >>> (i * 8)) & 0xff;
    out += (byte < 16 ? "0" : "") + byte.toString(16);
  }
  return out;
}

/**
 * md5Hex(str) → 32 位小寫十六進制 MD5（UTF-8 輸入）。
 * 性能預算（對照指令書附錄 C）：QuickJS 純 JS MD5 ≈ 每秒數 MB；
 * prose-weaver 指紋對象為步驟輸出文本（典型 < 200KB）→ < 0.5s。
 */
export function md5Hex(str) {
  const msg = new TextEncoder().encode(String(str));
  const len = msg.length;
  // 填充：len + 0x80 + 零 + 8 字節 64 位小端比特長度，總長為 64 的倍數
  const total = (((len + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(total);
  padded.set(msg);
  padded[len] = 0x80;
  const bitLo = (len * 8) % 4294967296;   // len < 2^50 內 Number 精確
  const bitHi = Math.floor((len * 8) / 4294967296);
  padded[total - 8] = bitLo & 0xff;
  padded[total - 7] = (bitLo >>> 8) & 0xff;
  padded[total - 6] = (bitLo >>> 16) & 0xff;
  padded[total - 5] = (bitLo >>> 24) & 0xff;
  padded[total - 4] = bitHi & 0xff;
  padded[total - 3] = (bitHi >>> 8) & 0xff;
  padded[total - 2] = (bitHi >>> 16) & 0xff;
  padded[total - 1] = (bitHi >>> 24) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const M = new Uint32Array(16);

  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) {
      const j = off + i * 4;
      M[i] = (padded[j] | (padded[j + 1] << 8) | (padded[j + 2] << 16) | (padded[j + 3] << 24)) >>> 0;
    }
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) {
        F = (B & C) | (~B & D);
        g = i;
      } else if (i < 32) {
        F = (D & B) | (~D & C);
        g = (5 * i + 1) % 16;
      } else if (i < 48) {
        F = B ^ C ^ D;
        g = (3 * i + 5) % 16;
      } else {
        F = C ^ (B | ~D);
        g = (7 * i) % 16;
      }
      F = (F + A + MD5_K[i] + M[g]) >>> 0;
      A = D;
      D = C;
      C = B;
      B = (B + rotl32(F, MD5_S[i])) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  return toHex32(a0) + toHex32(b0) + toHex32(c0) + toHex32(d0);
}

// ---------------------------------------------------------------------------
// 原版 runScript（spawnSync 子進程）的移植替代
// ---------------------------------------------------------------------------

/**
 * 原版 runScript 透過 spawnSync 以子進程調用姊妹腳本（qa-gate.js →
 * check-causal-chain.js / check-rhetoric-fact.js / check-inference-boundary.js）。
 * 目標環境無子進程（os.exec 18 程序全 127，且一票否決清單禁關鍵路徑依賴）。
 * 移植版改為：qa-gate.mjs 內直接靜態 import 對應模組的導出函數並同步調用
 * （同一 eval 內模組互調，行為等價，見《移植報告》P1 決策 D-11）。
 * 本導出僅保留文檔性質的佔位說明，防止任何代碼路徑嘗試 spawn。
 */
export const RUNSCRIPT_REPLACED_BY_STATIC_IMPORT = true;
