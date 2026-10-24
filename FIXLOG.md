# prose-weaver-cube-skill v1.5.0-port（fixed）修復日誌

- 修復日期：2026-09-08
- 修復對象：prose-weaver（Cube Agent 移植版）SKILL.md + scripts/*.mjs
- 修復方式：逐處定點 edit（唯一匹配 old_string），逐處回讀驗證；全程未使用任何批量腳本改寫。
- 回歸：所有斷言通過（詳見文末回歸表）。

---

## 一、代碼修復（scripts/）

### C1 chain-gate.mjs — checkUpstream 支援 step 1.5
- 原：`step <= 1` 直接 ok；`1.5` 落入 `step - 1 = 0.5`，STEP_FILES 無 0.5 → 恆 error「無效步驟: step=1.5, prev=0.5」，S1.5 閘門 A 卡死流程。
- 修：新增 `if (step === 1.5)` 特判，上游 = STEP_FILES[1]（prose-s1.json）；缺檔 blocked、有檔 ok。
- 回歸：`checkUpstream(1.5)` → `{status:"ok", exists:true}`（原 error）。

### C2 chain-gate.mjs — STEP_TOOLS[4] 補入 check-narrative-coherence.mjs
- 原：`4: ["check-robot-pattern.mjs"]`，`checkTool(4, "check-narrative-coherence.mjs")` 恆 error，與鐵律 3 要求不符。
- 修：`4: ["check-robot-pattern.mjs", "check-narrative-coherence.mjs"]`。
- 回歸：`checkTool(4, "check-narrative-coherence.mjs")` → status ok（原 error）。

### C3 check-causal-chain.mjs — safeLoadClarity 讀失敗不再靜默返回 dict
- 原：讀失敗返回 `{"__load_error__": …}`，被當 dict 處理後規則 E verdict = pass（缺檔靜默通過）。
- 修：`readText` 失敗直接拋出；解析失敗仍當原文返回。doc 注釋同步。

### C4 check-causal-chain.mjs — dispatchTemporalClarity 捕獲讀失敗轉 error
- 修：safeLoad 包 try/catch，失敗返回 `{status:"error", message:"無法讀取: …", exit_code:1}`。
- 回歸：缺 narrative-plan → `{status:"error", exit_code:1}`（原靜默 pass）。

### C5 check-narrative-coherence.mjs — load_s2_anchors 兼容 JSON 落盤形態
- 原：僅正則「回答的問題：【…】」；S2 以 JSON 落盤時必然失配 → 「回到那個問題」恆誤報結構缺陷。
- 修：雙正則（文本形態 + JSON 形態 `"回答的問題"\s*:\s*"【…】"`），依次掃描，跳過「無」值。
- 回歸：S2 JSON 形態 + prior-text → `passed:true, structural_defect_count:0`（原 sd:1）。

### C6 tone-analyzer.mjs — calc_distance 人稱代詞命中去重
- 原：PERSONAL_MARKERS = ["我", "我們"] 子串重疊，含「我們」的句子被雙重扣分（-4）。
- 修：按詞長降序、命中一個即 break（一句最多計一次人稱；行為變更已登記）。
- 回歸：`calc_distance(["我們認為，數據顯示結論成立"])` → 5（原 3）。

### C7 pw-compat.mjs — 頭部注釋 randInt 可復現措辭修正
- 原：「（時間種子，可復現）」；修：同種子可復現、默認種子隨會話而異、僅作 nonce。

### C8 check-causal-chain.mjs — 閘門提示語與規則 E 後置對齊
- 原 println：「S2 強制加入回溯要求」；修：「S4 開頭強制加入回溯句」。

---

## 二、SKILL.md 修復

### E11 M1 佈署代碼
- 原：`writeFile("scripts/…")`（宿主全域 writeFile 實測落盤 outputs/，部署落空且冪等失效）。
- 修：先 `fs.mkdir("scripts")`，再 `fs.writeFile("scripts/…")`。

### E6 S1.5 規則 E 引言時機
- 原：「在 S2 執行前」+ S1.5 段內嵌執行指令（需 prose-s2.json，雞生蛋）。
- 修：改「在 S2 產出 `prose-s2.json` 之後執行」，執行指令移交 S2；第 1/2/3 步判定細則保留。

### E7 S1.5 規則 C trace-chain 落盤
- 修：調用補 `"output": "prose-tmp/prose-s1.5.json"`（此前從未落盤，QA11 缺檔靜默跳過）。

### E8 S1.5 落盤約定（新增）
- 「步驟標記」前插入「🔴 S1.5 JSON 落盤約定」blockquote（chains 結構，下游 S2/S4/QA11 依賴）。

### E1 S1.5 輸出格式 [時間壓縮映射] 塊
- 原 9 行模板 → 一句移交說明；「含規則 A-E 綜合判定」→「含規則 A-D 綜合判定；規則 E 見 S2」。

### E2a S1.5 綜合判定
- 刪規則 E 三行；判定行「（>0 或時間跨度警告）」「（孤兒/循環 ≥ 2 或時間混用）」→「（>0）」「（孤兒/循環 ≥ 2）」；處理規則句移交 S2。

### E9 S2 末新增「🔴 時間錨點清晰度校驗（規則 E，S2 後置）」
- 不帶數字編號（避開 S2 既有錯亂編號）；含執行指令與 verdict 處理規則：
  critical → S4 時段劃分標示；warning → S4 開頭回溯句；error → 補齊落盤重跑，不得直接進入 S3。

### E10 S4 §5 敘事連貫調用
- 修：補 `"prior-text": "{已寫全文}"` + 說明句（首段傳 `""`）——原缺該參數時所有「這{名詞}」回指必誤判 dangling。

### E12 M4 追加宿主接口注意
- 新增：含 import 的 eval 最後表達式不被宿主捕獲；統一經 `run({...})` 取結果；step-content-guard 無 run 入口，用 `console.log(JSON.stringify(result))`。

---

## 三、回歸斷言表

| 斷言 | 修復前 | 修復後 |
| --- | --- | --- |
| checkUpstream(1.5) | error 無效步驟 | ok, exists:true |
| checkTool(4, check-narrative-coherence.mjs) | error | ok |
| 規則 E 缺 prose-s2.json | 靜默 verdict:pass | status:error, exit_code:1 |
| 規則 E 正常（起點偏移+跨度警告樣本） | — | verdict:warning（新文案「S4 開頭」） |
| 敘事連貫（S2 JSON 形態 + prior-text） | passed:false, sd:1 | passed:true, sd:0, dr:0 |
| calc_distance（我們+數據顯示） | 3 | 5 |
| md5Hex("abc") 對照 | 正確 | 正確（無回歸） |
| qa-gate 全域 13 項（含 QA11/12/13 靜態互調） | — | 13/13 全通過 |

---

## 四、已知限制（本輪未修，登記備查）

1. check-causal-chain 的 checkTemporal 對日期為字符串序比較：S1/S1.5 顯式日期格式一致時可靠，多格式混寫可能誤判（原版 1:1 行為）。
2. checkUpstream(2) 仍只驗 S1 產出、不驗 prose-s1.5.json（S2 因果斷層校驗讀原檔時異常可兜底）。
3. STEP_FILES / STEP_TOOLS 未新增 1.5 鍵（維持原版依賴鏈，避免連鎖改動）。

---

## 五、WorkBuddy 原生適配（W 系列，2026-10-24）

- 適配對象：prose-weaver（Cube Agent QuickJS 移植版 → WorkBuddy Node.js 原生版）
- 適配方式：11 個 scripts/*.mjs 定點補丁（腳本層）+ SKILL.md/FIXLOG/references 文檔改寫（文檔層）
- 回歸：`node --check` 11/11 通過；40+ 項 CLI 實測全通過（exit code 語義、文本雙形態、stdin 管道、--guard 模式、qa-gate 三模式、負面案例 blocked/error）

### W1 pw-compat.mjs — fs 層改 node:fs 原生
- 原：依賴宿主注入全域 `fs.exists/readFile/writeFile/mkdir/remove` 與全域 `readFile/writeFile`（Cube Agent 專屬接口）
- 修：改為 `import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs"`，行為 1:1
- 新增共用導出：`resolveTextArg`（路徑/內聯雙形態解析）與 `readStdin`（fd 0 管道讀取）

### W2 全部 11 模組 — CLI 入口（import.meta.url 判定被直調）
- 原：僅導出 dispatch 函數，依賴宿主 eval 環境調用
- 修：每模組末尾追加 CLI 入口：`parseArgs(process.argv.slice(2), CLI_OPTS)` → dispatch → `printJson` → `process.exitCode`（0/1）
- 回歸：node 直調全部模式實測通過

### W3 chain-gate.mjs — 姊妹腳本檢查改 SELF_DIR + step 參數 float 化
- 原：`checkPrerequisites` 檢查工作區 `scripts/` 佈署（依賴 M1 兩段式佈署）；CLI step 若為 int 會把 S1.5 截斷為 1
- 修：改為 `import.meta.url` 定位技能安裝目錄（零佈署）；CLI `step` 型別 `float`
- 回歸：`--check-prerequisites` ok；`--check-upstream --step 1.5` 正確識別 S1 產出

### W4 文本參數雙形態 — --text / --prior-text / --full-text / --content
- 原：dispatch 的 text 為純字符串，長文本需呼叫方預先落盤
- 修：經 `resolveTextArg` 解析——不含換行、<4096 字符且文件存在 → 讀檔，否則內聯；`step-manager --guard` 另支持 `--content-file` 與 stdin 管道回退
- 回歸：內聯/路徑/管道三種餵入實測均正確

### W5 SKILL.md — 適配總則 M1-M8 重寫 + 36 個 eval 塊全量轉 CLI
- 〈移植適配總則（Cube Agent 環境）〉→〈WorkBuddy 適配總則〉：M1 零佈署直調／M3 CLI 映射／M4 exit code 語義／M5 雙形態／M6 Write 工具落盤／M7 任務清單／M8 grep 自檢
- 36 個 javascript eval 塊 → bash CLI 命令；`writeText`/`saveOutput` 塊 → Write 工具說明；鐵律 1-4 的行內 dispatch 引用 → CLI 命令
- 〈降級前置警告〉+〈降級方案〉兩節 → 〈校驗不可繞過〉：零佈署後無降級路徑，故障須書面記錄
- 附錄查閱姿勢：eval `readFile` → Read 工具絕對路徑

### W6 FIXLOG / pw-legacy-notes — 文檔同步
- pw-legacy-notes.md 查閱姿勢改 Read 工具路徑；V2 自證條目「dispatch eval 指令」→「CLI 指令」
