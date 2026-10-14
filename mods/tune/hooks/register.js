// /tune：晶圓機器人有片取放的伺服參數調機引導。
// 階段、往復組、驗收項目與每一項的步驟都寫在專案的 procedures/<機型>.json（可 extends 基底），mod 只讀取、顯示與推進；
// .tune/session.json 只記目前選擇（程序、軸、階段、實驗組）；實驗資料一軸一個封閉迴路，放在
// data/<機型>/<軸>/：工程/ 是這一軸的 MR Configurator2 工程，實驗紀錄/<實驗組>/ 裡有紀錄.json（各項狀態 items 與過程 log）、參數/、採樣/。
// 輸入框上方以三個分頁顯示：調機總覽（驗收項目的技能按鈕與調整階段）、標準作業流程（docs/標準作業流程.md 裡目前階段各項的原文），
// 以及實驗紀錄（檢核這一軸的工程、這組實驗的參數檔與採樣檔是否存在）；
// 每一項驗收項目有「開始」按鈕：AI 依步驟操作這台電腦上的軟體，輪到工程師時停下，
// 面板顯示工程師要做的事與「完成」或選項按鈕，按下後 AI 接著做，全部做完才判定通過或未通過。

const COMMAND = 'tune'
const STATE = '.tune/session.json'
const PROCEDURES = 'procedures/'
// 資料目錄：data/<機型>/<軸>/工程/、data/<機型>/<軸>/實驗紀錄/<實驗組>/{紀錄.json, 參數/, 採樣/}
const DATA = 'data/'
const DEFAULT_SET = 'A01_伺服調機'
const PROJECT_FILE = 'Project.mr2'
// 標準作業流程：每一項的標題是「## 項次｜階段｜驗收項目」，階段名稱與程序定義的 stages[].name 相同
const SOP = 'docs/標準作業流程.md'
// 機台層級（scope: machine）的階段，狀態記在這個鍵底下
const MACHINE = '_machine'
// 驗收流程執行中與通過的圖示：桌面 App 用原生的 Svg 元件畫停止圖示（兩條直槓）與勾選；
// 沒有 Svg 的介面（終端機）退回文字。未開始、等工程師、未通過顯示按鈕
const ICON_COLOR = '#8a8a85'
const PASS_COLOR = '#16a34a'
const STOP_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
  '<rect x="4" y="3" width="2.5" height="10" rx="1" fill="' + ICON_COLOR + '"/>' +
  '<rect x="9.5" y="3" width="2.5" height="10" rx="1" fill="' + ICON_COLOR + '"/></svg>'
const CHECK_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">' +
  '<path d="M3.5 8.5 l3 3 l6 -7" fill="none" stroke="' + PASS_COLOR + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'

const TABS = [
  { key: 'status', label: '調機總覽' },
  { key: 'sop', label: '標準作業流程' },
  { key: 'record', label: '實驗紀錄' },
]
// 桌面 App 按鈕 hover 的底色，選中的分頁沿用（取自 /project-writer）
const HOVER = '#e5e5e4'
// 儀表板底色（取自 /project-writer），展開全文時用它蓋住底下截斷的那一行
const PANEL = '#f0f0ef'

// known = { state, proc, sop, set, records, checks, sets }；進度檔或程序定義缺一就是 null
// records[軸] 是這一軸目前實驗組的紀錄.json；checks[軸] 是工程、參數、採樣檔的檢核結果；sets 是目前這一軸的實驗組清單
let known = null
let tab = 0
// 上一次在畫面重畫時嘗試讀檔的時間（還沒讀到資料時，畫面重畫最多每個週期讀一次）
let lastLoad = 0
let turnId = null
// 實驗紀錄分頁的任務下拉選了「＋新增任務」，正在輸入名稱
let adding = false
const NEW_TASK = '__new__'

function axisDir(proc, axis) {
  return DATA + proc.machine + '/' + axis + '/'
}
function setDir(proc, axis, set) {
  return axisDir(proc, axis) + '實驗紀錄/' + set + '/'
}
function recordPath(proc, axis, set) {
  return setDir(proc, axis, set) + '紀錄.json'
}
function setOf(state) {
  return ((state && state.current) || {}).set || DEFAULT_SET
}

// USB：mod 自己查目前連著的三菱伺服驅動器（VID_06D3），不交給 AI 判斷。裝置清單裡「未連接」的舊紀錄不算
const USB_PS =
  "Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match 'VID_06D3' -and $_.Status -eq 'OK' } | ForEach-Object { $_.InstanceId }"
let usb = null
async function detectUsb($) {
  try {
    const r = await $.process.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', USB_PS], { timeoutMs: 20000 })
    const ids = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
    usb = { ok: r.exitCode === 0, ids, error: r.exitCode === 0 ? '' : String(r.stderr || '').trim(), at: Date.now() }
  } catch (err) {
    usb = { ok: false, ids: [], error: String(err), at: Date.now() }
  }
  return usb
}
function usbLine(u) {
  if (!u) return 'USB：偵測中'
  if (!u.ok) return 'USB：偵測失敗（' + u.error + '）'
  return u.ids.length ? 'USB：連著 ' + u.ids.length + ' 台三菱伺服驅動器' : 'USB：沒有連著三菱伺服驅動器，請確認 USB 線與驅動器電源'
}

// 交給 AI 的只有「在 MR Configurator2 建工程」這件事；路徑、哪幾軸缺工程、USB 有沒有連，都由 mod 查好寫進指示
let pendingBuild = false
function buildText(proc, axes, u, only) {
  return (
    'mod 已經查過：USB 連著 ' + u.ids.length + ' 台三菱伺服驅動器（' + u.ids.join('、') + '）；還沒有 MR Configurator2 工程的軸：' + axes.join('、') + '。' +
    '先問工程師這台驅動器帶的是哪幾軸（一台可能帶兩軸，例如 MR-J5W2），只為其中缺工程的軸建立工程，不要請工程師換插 USB。' +
    (only ? '工程師回答的軸不含 ' + only + ' 時，回報 ' + only + ' 的驅動器沒有連著，請工程師接上後再按一次「重試」，然後結束這一輪。' : '') +
    '每一軸在 MR Configurator2 新建工程：工作區位置設為本專案的 ' + axes.map((a) => axisDir(proc, a) + '工程/').join('、') + ' 中那一軸的資料夾，工程名稱用軸名，' +
    '機種從連線中的驅動器讀，讀不到就停下來問工程師，不要從舊工程或舊檔案推測。用 PowerShell 的 UI Automation（AutomationElement）操作。' +
    'MR Configurator2 不能把工作區設在這個資料夾時，停下來回報看到的選項，不要改放別處。' +
    '不要改 ' + STATE + ' 與 ' + DATA + ' 裡的其他檔案，那些由 mod 處理。建完回報建了哪幾軸，然後結束這一輪。'
  )
}

// /tune <機型>：由 mod 讀程序定義、寫進度檔、建立各軸的紀錄檔、檢查工程與 USB；只有缺工程且有驅動器連著時才請 AI 建工程
async function intake($, request) {
  // 不帶機型：沿用進度檔上次的程序，重開 App 後輸入 /tune 就直接回到儀表板，不經過 AI
  let machine = String(request || '').trim()
  if (!machine) {
    try {
      machine = String((await readJson($, STATE)).procedure || '')
    } catch (err) {
      machine = ''
    }
  }
  if (!machine) return '用法：/' + COMMAND + ' <機型>，例如 /' + COMMAND + ' WR403'
  const id = machine.toLowerCase()
  let proc
  try {
    proc = await loadProcedure($, id)
  } catch (err) {
    return '程序定義裡沒有 ' + machine + '：找不到 ' + PROCEDURES + id + '.json'
  }
  const axes = proc.axes || []
  if (!proc.machine || !axes.length) return PROCEDURES + id + '.json 沒有寫 machine 或 axes'
  let old = {}
  try {
    old = await readJson($, STATE)
  } catch (err) {
    old = {}
  }
  const same = old.procedure === id
  const set = same ? setOf(old) : DEFAULT_SET
  for (const axis of axes) {
    const path = recordPath(proc, axis, set)
    if (!(await $.fs.exists(path))) await $.fs.write(path, JSON.stringify({ procedure: id, items: {}, log: [], params: {} }, null, 2) + '\n')
  }
  const has = {}
  for (const axis of axes) has[axis] = Boolean(await findProject($, axisDir(proc, axis) + '工程/', 3))
  const built = axes.filter((a) => has[a])
  const missing = axes.filter((a) => !has[a])
  const cur = old.current || {}
  const first = (proc.stages || [])[0]
  const axis = same && cur.axis && has[cur.axis] ? cur.axis : built[0] || axes[0]
  const stage = same && axis === cur.axis && cur.stage ? cur.stage : first ? first.id : ''
  await $.fs.write(STATE, JSON.stringify({ procedure: id, current: { axis, stage, set, goal: same ? cur.goal || '' : '' } }, null, 2) + '\n')
  await loadKnown($)
  const summary = proc.machine + '：' + (built.length ? '有工程 ' + built.join('、') : '還沒有任何一軸有工程') + (missing.length ? '；缺工程 ' + missing.join('、') : '') + '。目前在 ' + axis + '。'
  if (!missing.length) return summary
  const u = await detectUsb($)
  if (!u.ids.length) return summary + usbLine(u) + '，接好後在實驗紀錄分頁按「重試」。'
  pendingBuild = true
  // command.run 這一輪結束前不能送出提示，排到下一個時間點再送
  $.clock.after(0, () => void $.prompt.submit({ text: buildText(proc, missing, u) }))
  return summary + usbLine(u) + '，交給 AI 在 MR Configurator2 建工程。'
}

// 實驗紀錄分頁的「重試」：mod 先查 USB，沒連就直接在面板上說，不送給 AI
async function retryProject($, axis) {
  const u = await detectUsb($)
  $.ui.invalidate('ui.render')
  if (!u.ids.length) {
    $.ui.toast(usbLine(u))
    return
  }
  pendingBuild = true
  void $.prompt.submit({ text: buildText(known.proc, [axis], u, axis) })
}

// 把一項驗收項目的步驟展開成編號清單：use 換成 blocks 裡的共用區塊，{layers} 換成層號
function expandSteps(proc, item) {
  const out = []
  for (const s of item.steps || []) {
    if (s.use) {
      for (const b of (proc.blocks || {})[s.use] || []) out.push({ ...b, do: String(b.do || '').split('{layers}').join(s.layers || '') })
    } else {
      out.push(s)
    }
  }
  return out
}

function stepLine(s, i) {
  const who = s.by === 'engineer' ? '［工程師］' : '［AI］'
  const extra = [
    s.choices ? '選項：' + s.choices.join('／') + (s.pass ? '（選「' + s.pass + '」才通過）' : '') : '',
    s.record ? '記錄：' + s.record : '',
    s.judge ? '判定：' + s.judge : '',
    s.source ? '依據：' + s.source : '',
  ].filter(Boolean)
  return i + 1 + '. ' + who + s.do + (extra.length ? '（' + extra.join('；') + '）' : '')
}

// 項次號對到紀錄檔 items 的鍵，給「把項次 N 改回未驗收」用
function itemIndex(proc) {
  return (proc.stages || [])
    .flatMap((s) => (s.criteria || []).map((x) => '項次 ' + x.no + ' = items["' + x.id + '"]'))
    .join('；')
}

// 過程紀錄的規則：每一步加一筆 log；畫面讀到的數值寫 read；存下的檔案寫 file（相對這組實驗資料夾），採樣檔不改檔名
function logRule(item) {
  return (
    '每做完一步或收到工程師回報，在同一個檔的 log 陣列最後加一筆 {"time":"ISO 時間","item":' + item.no + ',"step":步驟號,"by":"AI" 或 "工程師","read":"從畫面讀到的數值"}，不改舊的筆數；' +
    '存下檔案時這一筆加 "file":"相對這組實驗資料夾的路徑"：MS1811 匯出的 CSV 存進 採樣/，檔名照匯出時的名稱不改，這一筆再加 "params":{量測條件，例如層號、有片}；參數檔存進 參數/。'
  )
}

// 參數表：每一份參數存檔一列，欄位是程序定義 params 列出的參數中文名稱；AI 讀得到的值就代填
function tableRule(proc) {
  return (
    '再把這份存檔的參數值寫進同一個檔的 params["參數/<檔名>"]，格式 {"<參數中文名稱>":"值"}；欄名只用這些：' + (proc.params || []).join('、') +
    '；在 MR Configurator2 畫面上讀得到的才填，讀不到的不寫。'
  )
}

// 每一個實驗結果對應一份參數檔：判定並寫入驅動器之後，從驅動器讀出全部參數存檔，檔名寫進那一項的 param
function paramRule(proc, item, path) {
  const dir = path.slice(0, path.lastIndexOf('/') + 1)
  return (
    '判定並照「合格時寫入」或「不合格時寫入」寫進驅動器之後，從驅動器讀出全部參數，用 MR Configurator2 參數畫面的「保存」存進本專案的 ' + dir + '參數/，取一個新的檔名，不覆寫既有的檔案；' +
    'mod 會自動把這一項執行期間存進 參數/ 的最新檔案對應到這一項，不要自己寫 param。' + tableRule(proc) + '沒有存下參數檔，這一項的判定不算數。'
  )
}

// 驗收項目沒有自帶 steps 時，步驟、判定與寫入都照標準作業流程（proc.sop）裡「## 項次｜…」那一節做
function sopRunText(proc, axis, stage, item, path, from, answer) {
  return (
    '執行標準作業流程 ' + proc.sop + ' 的「## ' + item.no + '｜' + stage.name + '｜' + item.item + '」這一項（軸 ' + axis + '）。' +
    '先讀那一節，照它的「步驟」「判定」「合格時寫入」「不合格時寫入」做，不要增減。狀態寫在 ' + path + ' 的 items["' + item.id + '"]。\n' +
    (answer ? '工程師已完成第 ' + (from - 1) + ' 步，回報：「' + answer + '」。\n' : '') +
    '從第 ' + from + ' 步開始依序執行，規則：' +
    '（1）【AI】步驟由你直接操作這台電腦上的軟體：用 PowerShell 的 UI Automation（AutomationElement）讀可及性樹，以控制項類型與名稱找元素再操作，後面步驟依賴的結果要重讀一次確認；每做完一步，把該項的 step 改成下一步、note 寫目前在做什麼。' +
    '（2）輪到【問答】步驟時，把該項寫成 {"status":"waiting","step":步驟號,"wait":"工程師要做的事","choices":[該步驟 → 後面的選項]}，回覆裡用一句話寫出工程師要做的事，然後結束這一輪回覆；不要等待，也不要猜工程師的結果。步驟寫「回到第 N 步」時，step 設回 N 繼續。' +
    '（3）步驟全部做完，依「判定」判定，照「合格時寫入」或「不合格時寫入」寫入，再寫 {"status":"pass" 或 "fail","value":"判定用的實際數值與算式","note":"一句話"}。讀不到需要的數值就寫 fail，note 寫缺什麼，不准估計。' +
    '（4）寫入要求「把項次 N 改回未驗收」時，刪掉同一個檔裡那幾項的 items 紀錄；對照：' + itemIndex(proc) + '。' +
    '（5）寫入要求「停止本流程」時，寫 fail，note 寫明原因，不再做其他寫入。' +
    '（6）' + logRule(item) +
    '（7）' + paramRule(proc, item, path) +
    '（8）除了上面幾種，只改這一項、log 與 params；階段狀態由儀表板依各項判定自動算出。'
  )
}

// 按「開始」或工程師回報後送給 AI 的指示：從第 from 步做起，輪到工程師就把狀態寫成 waiting 並結束這一輪
function runText(proc, axis, stage, item, from, answer, path) {
  if (!item.steps && proc.sop) return sopRunText(proc, axis, stage, item, path, from, answer)
  const steps = expandSteps(proc, item)
  return (
    '執行驗收項目 ' + item.no + '「' + item.item + '」（軸 ' + axis + '、階段 ' + stage.name + '）。' +
    '狀態寫在 ' + path + ' 的 items["' + item.id + '"]。步驟：\n' +
    steps.map(stepLine).join('\n') + '\n' +
    (answer ? '工程師已完成第 ' + (from - 1) + ' 步，回報：「' + answer + '」。\n' : '') +
    '從第 ' + from + ' 步開始依序執行，規則：' +
    '（1）［AI］步驟由你直接操作這台電腦上的 MR Configurator2、MS1811、PickPlace Tuner：用 PowerShell 的 UI Automation（AutomationElement）讀可及性樹，以控制項類型與名稱找元素再操作，後面步驟依賴的結果要重讀一次確認；每做完一步，把該項的 step 改成下一步、note 寫目前在做什麼。' +
    '（2）輪到［工程師］步驟時，把該項寫成 {"status":"waiting","step":步驟號,"wait":"工程師要做的事（含層號）","choices":[選項]}（沒有選項就不寫 choices），回覆裡用一句話寫出工程師要做的事，然後結束這一輪回覆；不要等待，也不要猜工程師的結果。' +
    '（3）步驟要求背景記錄或背景加增益時，在交給工程師之前啟動一支背景 PowerShell 程式，定時讀或寫指定欄位並存到 scratch 檔；工程師回報後先停止它再讀結果。' +
    '（4）全部步驟做完，依判定式判定，寫 {"status":"pass" 或 "fail","value":"判定用的實際數值與算式","note":"一句話"}。讀不到需要的數值就寫 fail，note 寫缺什麼，不准估計。' +
    '（5）項次 11 未通過時，依程序定義的 routing 找出要回去的項次，寫進 note。' +
    '（6）' + logRule(item) +
    '（7）' + paramRule(proc, item, path) +
    '（8）只改這一項、log 與 params，其他欄位不動；階段狀態由儀表板依各項判定自動算出。' +
    (proc.safety ? '安全：' + proc.safety : '')
  )
}

// 一項已有判定、卻沒有對應的參數檔：請 AI 補存這一項當下的參數；檔案與這一項的對應由 mod 自動做
function paramText(proc, axis, set, item) {
  const dir = setDir(proc, axis, set)
  return (
    '補存 ' + axis + ' 項次 ' + item.no + '「' + item.item + '」這個實驗結果的參數檔：在 MR Configurator2 開 ' + axisDir(proc, axis) + '工程/ 裡的工程，從驅動器讀出全部參數，' +
    '用參數畫面的「保存」存進本專案的 ' + dir + '參數/，取一個新的檔名，不覆寫既有的檔案。用 PowerShell 的 UI Automation（AutomationElement）操作。' +
    '存好後 mod 會自動把這份檔案對應到這一項，不要自己寫 param。' + tableRule(proc)
  )
}

async function readJson($, path) {
  return JSON.parse(await $.fs.read(path))
}

// 讀程序定義並展開 extends：先找專案的 procedures/，找不到基底時退回外掛附帶的範本
async function loadProcedure($, id, depth) {
  let own
  try {
    own = await readJson($, PROCEDURES + id + '.json')
  } catch (err) {
    own = await readJson($, $.plugin.root + '/procedures/' + id + '.json')
  }
  if (!own.extends || (depth || 0) > 3) return own
  const base = await loadProcedure($, own.extends, (depth || 0) + 1)
  return {
    ...base,
    ...own,
    stages: own.stages || base.stages,
    tolerances: { ...(base.tolerances || {}), ...(own.tolerances || {}) },
    sources: { ...(base.sources || {}), ...(own.sources || {}) },
  }
}

// 上一次讀到的檔案內容；定時重讀時內容沒變就不重畫
let seen = ''

// 紀錄檔：還沒建立時當成空的；檔案在但不是合法 JSON 時，不能默默當成空的，記下錯誤讓面板顯示
async function readRecord($, path) {
  const empty = { items: {}, log: [], params: {}, started: {} }
  let text
  try {
    text = await $.fs.read(path)
  } catch (err) {
    return empty
  }
  try {
    const rec = JSON.parse(text)
    return { ...rec, items: rec.items || {}, log: rec.log || [], params: rec.params || {}, started: rec.started || {} }
  } catch (err) {
    return { ...empty, broken: '不是合法的 JSON（' + String(err.message || err) + '）' }
  }
}

// 紀錄檔的格式由 mod 規定：AI 寫錯的地方逐一列出，顯示在面板上，不讓它默默變成「未開始」或空白
const STATUSES = ['running', 'waiting', 'pass', 'fail']
function validateRecord(rec, proc) {
  if (rec.broken) return [rec.broken]
  const errors = []
  const ids = (proc.stages || []).flatMap((s) => (s.criteria || []).map((x) => x.id))
  for (const [id, r] of Object.entries(rec.items || {})) {
    if (!ids.includes(id)) errors.push('items 有程序定義裡沒有的項目「' + id + '」')
    if (!r || typeof r !== 'object') {
      errors.push('items["' + id + '"] 不是物件')
      continue
    }
    if (!STATUSES.includes(r.status)) errors.push('items["' + id + '"].status 是「' + r.status + '」，只能是 ' + STATUSES.join('、'))
    if (r.step !== undefined && !Number.isInteger(r.step)) errors.push('items["' + id + '"].step 不是整數')
    if (r.choices !== undefined && !Array.isArray(r.choices)) errors.push('items["' + id + '"].choices 不是陣列')
  }
  if (!Array.isArray(rec.log)) errors.push('log 不是陣列')
  const cols = proc.params || []
  for (const [file, row] of Object.entries(rec.params || {})) {
    if (!file.startsWith('參數/')) errors.push('params 的「' + file + '」不在 參數/ 底下')
    for (const name of Object.keys(row || {})) if (cols.length && !cols.includes(name)) errors.push('params 欄位「' + name + '」不在程序定義的參數清單')
  }
  return errors
}

// 列資料夾；不存在時回空陣列
async function listDir($, path) {
  try {
    return (await $.fs.list(path)) || []
  } catch (err) {
    return []
  }
}

// 工程檔：MR Configurator2 在 工程/ 底下自己分工作區與工程資料夾，往下找三層內的 Project.mr2
async function findProject($, dir, depth) {
  const entries = await listDir($, dir)
  if (entries.some((x) => x.kind === 'file' && x.name === PROJECT_FILE)) return dir + PROJECT_FILE
  if (depth <= 0) return ''
  // 子資料夾同時找，每一次讀檔都要經過 App，逐一找會很慢
  const found = await Promise.all(entries.filter((x) => x.kind === 'dir').map((x) => findProject($, dir + x.name + '/', depth - 1)))
  return found.find(Boolean) || ''
}

// 參數檔與實驗結果的對應由 mod 做：一項有判定、還沒對應到參數檔時，取這一項開始之後存進 參數/、還沒被別項用掉的最新檔案。
// 回傳有沒有改動 rec
function linkParams(proc, rec, entries) {
  const used = new Set(Object.values(rec.items || {}).map((r) => String((r && r.param) || '')).filter(Boolean))
  let changed = false
  for (const x of (proc.stages || []).flatMap((s) => s.criteria || [])) {
    const r = rec.items[x.id]
    if (!r || (r.status !== 'pass' && r.status !== 'fail')) continue
    const current = String(r.param || '')
    if (current && entries.some((f) => '參數/' + f.name === current)) continue
    const since = Number(rec.started[x.id] || 0)
    if (!since) continue
    const pick = entries
      .filter((f) => f.mtimeMs >= since && !used.has('參數/' + f.name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    if (!pick) continue
    r.param = '參數/' + pick.name
    used.add(r.param)
    changed = true
  }
  return changed
}

// 檢核一軸的資料：工程檔存在；每一個有判定的項次都對應到 參數/ 裡存在的參數檔；紀錄檔格式正確
async function checkData($, proc, axis, set, rec) {
  const dir = setDir(proc, axis, set)
  const [project, listed] = await Promise.all([findProject($, axisDir(proc, axis) + '工程/', 3), listDir($, dir + '參數/')])
  const entries = listed.filter((x) => x.kind === 'file')
  if (!rec.broken && linkParams(proc, rec, entries)) {
    const { broken, ...clean } = rec
    await $.fs.write(dir + '紀錄.json', JSON.stringify(clean, null, 2) + '\n')
  }
  const paramFiles = entries.map((x) => x.name)
  const results = (proc.stages || [])
    .flatMap((s) => s.criteria || [])
    .map((x) => ({ x, r: rec.items[x.id] || {} }))
    .filter(({ r }) => r.status === 'pass' || r.status === 'fail')
    .map(({ x, r }) => {
      const param = String(r.param || '')
      return { id: x.id, no: x.no, item: x.item, status: r.status, param, ok: param.startsWith('參數/') && paramFiles.includes(param.slice(3)) }
    })
  const paramOk = {}
  for (const p of results) paramOk[p.id] = p.ok
  const errors = validateRecord(rec, proc)
  const complete = Boolean(project) && results.every((p) => p.ok) && !errors.length
  return { project, results, paramOk, errors, complete }
}

// 進度檔、程序定義與標準作業流程一起讀，再讀每一軸目前任務的紀錄並檢核資料；標準作業流程讀不到時 sop 是 null，其餘照常顯示。
// 機型與軸取自進度檔的程序；階段與驗收項目取自目前這一軸、這個任務紀錄檔的 procedure（不同任務可以照不同程序做）
async function readAll($) {
  try {
    const state = await readJson($, STATE)
    const base = await loadProcedure($, state.procedure)
    const set = setOf(state)
    const current = (state.current || {}).axis
    const own = current ? (await readRecord($, recordPath(base, current, set))).procedure : ''
    const task = own && own !== state.procedure ? await loadProcedure($, own) : base
    const proc = { ...task, machine: base.machine, axes: base.axes, acceptance: task.acceptance || base.acceptance }
    let sop = null
    try {
      sop = await $.fs.read(SOP)
    } catch (err) {
      sop = null
    }
    // 各軸同時讀：每一次讀檔都要經過 App，逐軸讀會讓切分頁、重讀都慢好幾秒
    const axis = (state.current || {}).axis
    const axes = proc.axes || []
    const [pairs, listed] = await Promise.all([
      Promise.all(
        axes.map(async (a) => {
          const rec = await readRecord($, recordPath(proc, a, set))
          return [rec, await checkData($, proc, a, set, rec)]
        }),
      ),
      axis ? listDir($, axisDir(proc, axis) + '實驗紀錄/') : Promise.resolve([]),
    ])
    // 依程序定義的軸順序放進物件：完成先後不固定，順序一變，「內容有沒有變」的比對就會誤判，每次重讀都整個重畫，點擊會被吃掉
    const records = {}
    const checks = {}
    axes.forEach((a, i) => {
      records[a] = pairs[i][0]
      checks[a] = pairs[i][1]
    })
    const sets = listed.filter((x) => x.kind === 'dir').map((x) => x.name).sort()
    return { state, proc, sop, set, records, checks, sets }
  } catch (err) {
    return null
  }
}
async function loadKnown($) {
  known = await readAll($)
  seen = JSON.stringify(known)
  $.ui.invalidate('ui.render')
}

// 進度檔與標準作業流程可能被 Claude、使用者或另一個工作階段改掉；定時重讀，內容變了才重畫
async function reloadIfChanged($) {
  const next = await readAll($)
  const text = JSON.stringify(next)
  if (text === seen) return
  known = next
  seen = text
  $.ui.invalidate('ui.render')
}

// 定時重讀：clock.every 有一個週期被拒就整個停掉，所以改成每次跑完再排下一次，並記下最後一次跑的時間；
// 超過兩個週期沒有跑（排程被拒或中斷），下一次畫面重畫時重新排
const POLL_MS = 3000
let pollTimer = null
let lastPoll = 0
function armPoll($) {
  if (pollTimer && Date.now() - lastPoll < POLL_MS * 2) return
  if (pollTimer && pollTimer.cancel) pollTimer.cancel()
  lastPoll = Date.now()
  pollTimer = $.clock.after(POLL_MS, async () => {
    lastPoll = Date.now()
    pollTimer = null
    try {
      await reloadIfChanged($)
    } finally {
      armPoll($)
    }
  })
}

// 程序定義的查詢小工具
function stagesOf(scope) {
  return ((known && known.proc.stages) || []).filter((s) => (s.scope || 'axis') === scope)
}
function stageById(id) {
  return ((known && known.proc.stages) || []).find((s) => s.id === id)
}
// 階段狀態：有驗收項目的階段由 mod 依各項流程的判定算出，不交給 AI 寫——
// 全部通過才算通過，任一項未通過算未通過，有任一項開始過算進行中；沒有驗收項目的階段才讀進度檔的 status
function statusOf(owner, id) {
  const stage = stageById(id)
  const criteria = (stage && stage.criteria) || []
  if (criteria.length) {
    // 單軸的階段讀這一軸紀錄檔的 items；機台層級的階段沒有自己的資料目錄，沿用進度檔的 runs
    const runs =
      owner === MACHINE
        ? (((known && known.state.runs) || {})[owner + '/' + id]) || {}
        : (((known && known.records) || {})[owner] || {}).items || {}
    // 通過卻沒有對應的參數檔，判定不算數
    const paramOk = owner === MACHINE ? null : ((((known && known.checks) || {})[owner]) || {}).paramOk || {}
    const all = criteria.map((x) => {
      const st = (runs[x.id] || {}).status || 'idle'
      return st === 'pass' && paramOk && !paramOk[x.id] ? 'active' : st
    })
    if (all.every((s) => s === 'pass')) return 'pass'
    if (all.some((s) => s === 'fail')) return 'fail'
    return all.some((s) => s !== 'idle') ? 'active' : 'todo'
  }
  const st = (known && known.state.status) || {}
  return (st[owner] || {})[id] || 'todo'
}
// 一軸調完：每個階段都通過，而且工程、參數、採樣資料齊全；資料不全時判定不算數
function axisDone(axis) {
  const check = ((known && known.checks) || {})[axis]
  return stagesOf('axis').every((s) => statusOf(axis, s.id) === 'pass') && Boolean(check && check.complete)
}

// 一格：上一行淡色寫欄位，下一行粗體寫內容；沒有值時淡色 --
// clip 為 true 時內容只顯示一行，滑鼠停在格子上才展開全文（照 /project-writer 的 peek 做法）
function cell(ui, key, label, value, width, clip, flat) {
  const { Box, Text } = ui
  const body = value
    ? clip
      ? [
          Text({ key: key + '-value', bold: true, wrap: 'truncate', children: [String(value)] }),
          // 這個 Box 不能帶 key：引擎把 hover 綁在帶 key 的 Box 上，display none 的 Box 指標永遠碰不到
          Box({
            marginTop: -2,
            display: 'none',
            width: '100%',
            overflow: 'hidden',
            backgroundColor: PANEL,
            hover: { display: 'flex' },
            children: [Text({ key: key + '-full', bold: true, wrap: 'wrap', children: [String(value)] })],
          }),
        ]
      : [Text({ key: key + '-value', bold: true, wrap: 'wrap', children: [String(value)] })]
    : [Text({ key: key + '-value', dimColor: true, children: ['--'] })]
  return Box({
    key,
    flexDirection: 'column',
    width: width || '33%',
    // flat 的格子不畫外框，省下上下框線的高度；儀表板高度由引擎決定，超出就要捲動
    ...(flat ? {} : { borderStyle: 'round' }),
    paddingX: 1,
    children: [Text({ key: key + '-label', dimColor: true, wrap: 'truncate', children: [label] }), ...body],
  })
}

// 調整階段：全部軸依調整優先順序列出，調完的打勾；軸那一列代表第一個階段（慣量辨識），
// 目前的軸標底色並展開其餘階段（1.1 增益整定、1.2 共振抑制…），▶ 只標在目前所在的那一列；
// 機台層級的階段（多軸關卡、系統驗收）列在軸的後面
// 所有軸與階段都可以手動點選切換：點了就把進度檔的 current 移過去，不受多軸關卡限制（關卡只作提醒）
function axisList(ui) {
  const { Box, Text, Button } = ui
  const axes = known.proc.axes || []
  const c = known.state.current || {}
  const stages = stagesOf('axis')
  // 目前所在的那一列是純文字；其他列的名稱是按鈕（桌面 App 的按鈕畫 label，所以 label 就是列名）
  const line = (key, mark, text, opts) =>
    Box({
      key,
      flexDirection: 'row',
      gap: 1,
      ...(opts.indent ? { marginLeft: 2 } : {}),
      ...(opts.highlight ? { backgroundColor: HOVER } : {}),
      children: [
        Text({ key: key + '-mark', ...(opts.dim ? { dimColor: true } : {}), children: [mark] }),
        opts.onPress
          ? Button({ key: key + '-go', plain: true, label: text, dimColor: opts.dim, onPress: opts.onPress })
          : Text({ key: key + '-name', bold: opts.bold, wrap: 'truncate', ...(opts.dim ? { dimColor: true } : {}), children: [text] }),
      ],
    })
  const children = [Text({ key: 'axis-list-title', dimColor: true, children: ['調整階段'] })]
  // 軸那一列（大點）就是第一個階段（慣量辨識）；其餘階段是展開在底下的小點。▶ 只標在目前所在的那一列
  const [first, ...rest] = stages
  axes.forEach((axis, i) => {
    const done = axisDone(axis)
    const here = axis === c.axis
    const atAxis = here && Boolean(first) && c.stage === first.id
    children.push(
      line('axis-item-' + axis, done ? '✓' : atAxis ? '▶' : '　', i + 1 + '. ' + axis + (done || here ? '' : '（未完成）'), {
        highlight: here,
        bold: atAxis,
        dim: !here && !done,
        onPress: atAxis || !first ? null : () => ui.select(axis, first.id),
      }),
    )
    if (!here) return
    // 每個階段各佔一列；往復組的關係寫在程序定義的 pairs，不記輪次
    rest.forEach((s, k) => {
      const pass = statusOf(axis, s.id) === 'pass'
      const now = s.id === c.stage
      children.push(
        line('stage-item-' + axis + '-' + s.id, pass ? '✓' : now ? '▶' : '　', i + 1 + '.' + (k + 1) + ' ' + s.name + (pass || now ? '' : '（未完成）'), {
          indent: true,
          bold: now,
          dim: !pass && !now,
          onPress: now ? null : () => ui.select(axis, s.id),
        }),
      )
    })
  })
  // 機台層級的階段併成一列「整機：多軸 PB07 → 系統驗收」，面板高度有上限，每多一列都可能被切掉；
  // 輪到其中一個時，那一列只寫目前的階段並標出來
  const machine = stagesOf('machine')
  if (machine.length) {
    const current = machine.find((s) => s.id === c.stage)
    const pass = machine.every((s) => statusOf(MACHINE, s.id) === 'pass')
    const text = current ? '整機：' + current.name : '整機：' + machine.map((s) => s.name).join('→') + (pass ? '' : '（未完成）')
    children.push(line('machine-item', pass ? '✓' : current ? '▶' : '　', text, { highlight: Boolean(current), bold: Boolean(current), dim: !pass && !current }))
  }
  if (!axes.length) children.push(Text({ key: 'axis-list-empty', dimColor: true, children: ['程序定義沒有列出軸'] }))
  // 不畫外框，省下兩列高度
  return Box({ key: 'axis-list', flexDirection: 'column', paddingX: 1, children })
}

// 使用者點選某一軸或某個階段：只改進度檔的 current.axis／current.stage，其他欄位不動
async function selectStage($, axis, stageId) {
  try {
    const raw = await readJson($, STATE)
    raw.current = { ...(raw.current || {}), axis, stage: stageId || (raw.current || {}).stage }
    await $.fs.write(STATE, JSON.stringify(raw, null, 2) + '\n')
  } catch (err) {
    $.ui.toast('寫不進 ' + STATE)
  }
  await loadKnown($)
}

// 使用者在實驗紀錄分頁切換實驗組：只改進度檔的 current.set
async function selectSet($, set) {
  try {
    const raw = await readJson($, STATE)
    raw.current = { ...(raw.current || {}), set }
    await $.fs.write(STATE, JSON.stringify(raw, null, 2) + '\n')
  } catch (err) {
    $.ui.toast('寫不進 ' + STATE)
  }
  await loadKnown($)
}

// 新增任務：編號接在這一軸現有任務的最大號後面，程序沿用目前任務的；建好後切到新任務
async function createTask($, name) {
  const title = String(name || '').trim().replace(/[\\/:*?"<>|]/g, '')
  adding = false
  if (!title || !known) {
    $.ui.invalidate('ui.render')
    return
  }
  const axis = (known.state.current || {}).axis
  const max = Math.max(0, ...known.sets.map((s) => Number((/^[A-Z](\d+)_/.exec(s) || [])[1] || 0)))
  const set = 'A' + String(max + 1).padStart(2, '0') + '_' + title
  const procedure = (known.records[axis] || {}).procedure || known.state.procedure
  try {
    await $.fs.write(recordPath(known.proc, axis, set), JSON.stringify({ procedure, items: {}, log: [], params: {} }, null, 2) + '\n')
  } catch (err) {
    $.ui.toast('建不了任務 ' + set)
    await loadKnown($)
    return
  }
  await selectSet($, set)
}

// 參數表的一格被人改了：直接寫回這一軸目前任務的紀錄檔，不需要另外按儲存
async function setParam($, file, name, value) {
  let path = ''
  try {
    const cur = await currentRecord($)
    path = cur.path
    cur.rec.params[file] = { ...(cur.rec.params[file] || {}), [name]: value }
    if (!value) delete cur.rec.params[file][name]
    await $.fs.write(path, JSON.stringify(cur.rec, null, 2) + '\n')
  } catch (err) {
    $.ui.toast('寫不進 ' + (path || STATE))
  }
  await reloadIfChanged($)
}

// 目前階段的驗收項目與各自的流程狀態，狀態取自這一軸紀錄檔的 items；rec 不給時用畫面上讀到的紀錄
function currentCriteria(state, rec) {
  const s = state || known.state
  const c = s.current || {}
  const stage = stageById(c.stage)
  if (!stage) return { axis: c.axis, stage: null, items: [] }
  const items = (rec || ((known.records || {})[c.axis]) || { items: {} }).items || {}
  return { axis: c.axis, stage, items: (stage.criteria || []).map((x) => ({ ...x, run: items[x.id] || { status: 'idle' } })) }
}

// 目前這一軸、這組實驗的紀錄檔：軸與實驗組以進度檔當下的 current 為準，畫面過時也不會寫到別的項目
async function currentRecord($) {
  const raw = await readJson($, STATE)
  const c = raw.current || {}
  const path = recordPath(known.proc, c.axis, setOf(raw))
  const rec = await readRecord($, path)
  // 紀錄檔壞了就不寫，避免把壞掉的內容蓋成空的；錯誤顯示在面板上
  if (rec.broken) throw new Error(path + ' ' + rec.broken)
  return { raw, path, rec }
}

// 按「開始」「重做」：把這一項設成執行中、從第 1 步做起；按工程師的「完成」或選項：記下回報、從下一步接著做。
async function advanceItem($, critId, answer) {
  let text = ''
  let path = ''
  try {
    const cur = await currentRecord($)
    path = cur.path
    const { axis, stage, items } = currentCriteria(cur.raw, cur.rec)
    const item = items.find((x) => x.id === critId)
    if (!item) {
      $.ui.toast('這一項不在目前階段，已重新讀取進度')
      await loadKnown($)
      return
    }
    const prev = item.run
    const resume = answer !== undefined && prev.status === 'waiting'
    const from = resume ? (prev.step || 1) + 1 : 1
    cur.rec.items[critId] = { status: 'running', step: from, note: resume ? '工程師回報：' + answer : '開始', ...(resume ? { answer } : {}) }
    // 從第 1 步開始時記下時間：之後這段期間存進 參數/ 的檔案，由 mod 對應到這一項
    if (!resume) cur.rec.started[critId] = Date.now()
    await $.fs.write(path, JSON.stringify(cur.rec, null, 2) + '\n')
    text = runText(known.proc, axis, stage, item, from, resume ? answer : '', path)
  } catch (err) {
    $.ui.toast('寫不進 ' + (path || STATE))
  }
  await loadKnown($)
  if (text) void $.prompt.submit({ text })
}

// 按「存參數檔」：記下這一刻，之後存進 參數/ 的最新檔案由 mod 對應到這一項，再請 AI 去存
async function askParam($, critId) {
  let item = null
  try {
    const cur = await currentRecord($)
    item = currentCriteria(cur.raw, cur.rec).items.find((x) => x.id === critId)
    if (!item) return
    cur.rec.started[critId] = Date.now()
    await $.fs.write(cur.path, JSON.stringify(cur.rec, null, 2) + '\n')
  } catch (err) {
    $.ui.toast(String(err.message || err))
    return
  }
  await loadKnown($)
  void $.prompt.submit({ text: paramText(known.proc, known.state.current.axis, known.set, item) })
}

// 按停止圖示：中斷 AI 正在跑的這一輪，這一項回到未開始
async function stopItem($, critId) {
  if (turnId) {
    try {
      await $.turn.abort({ turnId })
    } catch (err) {
      // 這一輪已經結束，不必中斷
    }
    turnId = null
  }
  let path = ''
  try {
    const cur = await currentRecord($)
    path = cur.path
    delete cur.rec.items[critId]
    await $.fs.write(path, JSON.stringify(cur.rec, null, 2) + '\n')
  } catch (err) {
    $.ui.toast('寫不進 ' + (path || STATE))
  }
  await loadKnown($)
}

// 驗收項目：目前階段要通過的條件，每一項的名稱前面只有一個元件，依流程狀態換：
// 未開始是「開始」按鈕、AI 執行中是停止圖示、等工程師是「完成」或選項按鈕、通過是勾選圖示、未通過是「重試」按鈕；
// 通過卻沒有對應的參數檔時是「存參數檔」按鈕，存好才打勾。勾選只由流程的判定寫入。
// 執行到哪一步、工程師要做什麼，對話裡就看得到，面板不另外寫說明
function criteriaCell(ui) {
  const { Box, Text, Button, Svg } = ui
  const { items, axis } = currentCriteria()
  const paramOk = (((known.checks || {})[axis]) || {}).paramOk || {}
  const button = (key, label, onPress) => Button({ key, label, onPress })
  const icon = (key, source, alt, fallback, animated) =>
    Svg ? Svg({ key, source, alt, width: 16, height: 16, ...(animated ? { isInteractive: true } : {}) }) : Text({ key, children: [fallback] })
  // 執行中：停止圖示就是按鈕。按鈕只能放文字，圖片又會擋住點擊，
  // 所以停止圖示畫在底層，上面疊一個沒有外框、只有空白字元的按鈕接點擊
  const stopControl = (i, id) =>
    Svg
      ? Box({
          key: 'criteria-stop-box-' + i,
          position: 'relative',
          children: [
            Svg({ key: 'criteria-mark-' + i, source: STOP_SVG, alt: '停止', width: 16, height: 16 }),
            Box({
              key: 'criteria-stop-hit-' + i,
              position: 'absolute',
              top: 0,
              left: 0,
              children: [Button({ key: 'criteria-stop-' + i, plain: true, label: '　', onPress: () => ui.stop(id) })],
            }),
          ],
        })
      : button('criteria-stop-' + i, '停止', () => ui.stop(id))
  return Box({
    key: 'criteria',
    flexDirection: 'column',
    width: '100%',
    paddingX: 1,
    children: [
      Text({ key: 'criteria-label', dimColor: true, children: ['驗收項目'] }),
      ...(items.length
        ? items.flatMap((x, i) => {
            const r = x.run
            const front =
              r.status === 'running'
                ? [stopControl(i, x.id)]
                : r.status === 'pass' && !paramOk[x.id]
                  ? [button('criteria-param-' + i, '存參數檔', () => ui.askParam(x.id))]
                : r.status === 'pass'
                  ? [icon('criteria-mark-' + i, CHECK_SVG, '通過', '✓', false)]
                  : r.status === 'waiting'
                    ? (r.choices && r.choices.length ? r.choices : ['完成']).map((c, k) => button('criteria-choice-' + i + '-' + k, c, () => ui.advance(x.id, c)))
                    : r.status === 'fail'
                      ? [button('criteria-retry-' + i, '重試', () => ui.advance(x.id))]
                      : [button('criteria-start-' + i, '開始', () => ui.advance(x.id))]
            return [
              Box({
                key: 'criteria-' + i,
                flexDirection: 'row',
                gap: 1,
                children: [
                  // 前面的元件放在至少按鈕寬、置中的格子裡，記號與按鈕對齊同一欄
                  Box({ key: 'criteria-front-' + i, minWidth: 6, flexShrink: 0, flexDirection: 'row', gap: 1, justifyContent: 'center', alignItems: 'center', children: front }),
                  Box({ key: 'criteria-name-' + i, flexGrow: 1, flexShrink: 1, children: [Text({ key: 'criteria-item-' + i, bold: true, wrap: 'wrap', children: [String(x.item || '')] })] }),
                ],
              }),
            ]
          })
        : [Text({ key: 'criteria-empty', dimColor: true, children: ['--'] })]),
    ],
  })
}

// 調機總覽：左邊第一列受測機台與允收準則並排，下面是整列寬的驗收項目；右邊窄欄放調整階段
function statusView(ui) {
  const { Box } = ui
  const proc = known.proc
  const axes = proc.axes || []
  return Box({
    key: 'status',
    flexDirection: 'row',
    gap: 1,
    children: [
      Box({
        // 驗收項目帶按鈕，給它較寬的欄位，每一項排成一行；面板高度有上限，換行會把後面的項目擠出去
        key: 'status-grid',
        width: '65%',
        flexDirection: 'column',
        gap: 1,
        children: [
          Box({
            key: 'status-grid-1',
            flexDirection: 'row',
            gap: 1,
            children: [
              cell(ui, 'machine', '受測機台', proc.machine ? proc.machine + ' · ' + axes.length + ' 軸' : '', '50%', false, true),
              cell(ui, 'acceptance', '允收準則', proc.acceptance, '50%', false, true),
            ],
          }),
          criteriaCell(ui),
        ],
      }),
      Box({ key: 'status-axes', width: '35%', flexDirection: 'column', children: [axisList(ui)] }),
    ],
  })
}

// 標準作業流程：從 docs/標準作業流程.md 取出目前階段的每一項（「## 項次｜階段｜…」到下一個「## 」或「---」為止），照原文逐行顯示；
// 面板比內容矮時由引擎捲動
function sopSections(text, stageName) {
  const out = []
  let take = false
  for (const line of String(text).replace(/\r\n/g, '\n').split('\n')) {
    if (/^## /.test(line) || /^---\s*$/.test(line)) {
      const m = /^## [^｜]+｜([^｜]+)｜/.exec(line)
      take = Boolean(m) && m[1].trim() === stageName
    }
    if (take) out.push(line)
  }
  while (out.length && !out[out.length - 1].trim()) out.pop()
  return out
}

// 面板上不顯示「## 項次｜階段｜…」標題與「> 技能名」；每一項開頭改放調機總覽上同一項的驗收項目文字，
// 依項次號對到程序定義的驗收項目，對不到時用標題裡的驗收項目
function sopBlocks(lines, criteria) {
  const blocks = []
  for (const line of lines) {
    const head = /^## ([^｜]+)｜[^｜]+｜(.*)$/.exec(line)
    if (/^## /.test(line)) {
      const no = head ? head[1].trim() : ''
      const hit = (criteria || []).find((x) => String(x.no) === no)
      blocks.push({ title: hit ? hit.item : head ? head[2].trim() : '', body: [] })
    } else if (blocks.length && !/^> /.test(line)) blocks[blocks.length - 1].body.push(line)
  }
  return blocks.map((b) => ({ title: b.title, body: b.body.join('\n').trim() })).filter((b) => b.title || b.body)
}

// 每一項：驗收項目文字用 Text 粗體當標題（桌面 App 的 Markdown 畫中文標題不會加粗），其下照 markdown 渲染，項與項之間用分隔線
function sopView(ui) {
  const { Box, Text, Markdown } = ui
  const stage = stageById((known.state.current || {}).stage)
  const blocks = known.sop == null ? [] : sopBlocks(sopSections(known.sop, stage ? stage.name : ''), stage ? stage.criteria : [])
  const empty = known.sop == null ? '讀不到 ' + SOP : stage ? SOP + ' 沒有「' + stage.name + '」階段的項目' : '進度檔還沒有指向任何階段'
  const md = (key, text) => (Markdown ? Markdown({ key, text }) : Text({ key, wrap: 'wrap', children: [text] }))
  // 分隔線用 Text 畫：只有「---」的 Markdown 在桌面 App 會被當成空內容
  const children = blocks.flatMap((b, i) => [
    ...(i ? [Text({ key: 'sop-hr-' + i, dimColor: true, wrap: 'truncate', children: ['─'.repeat(200)] })] : []),
    ...(b.title ? [Text({ key: 'sop-title-' + i, bold: true, wrap: 'wrap', children: [b.title] })] : []),
    ...(b.body ? [md('sop-md-' + i, b.body)] : []),
  ])
  return Box({
    key: 'sop',
    flexDirection: 'column',
    paddingX: 1,
    children: children.length ? children : [Text({ key: 'sop-empty', dimColor: true, children: [empty] })],
  })
}
// 實驗紀錄：機型與軸依調機總覽目前選中的。先確認這一軸有工程：沒有就只顯示 MR Configurator2 的建立步驟與「重試」；
// 有工程才顯示任務下拉選單（最後一項是新增任務）與參數表。參數表每一列是一次參數存檔，每一欄是一個參數的中文名稱，
// 只顯示有值的欄；每一格都可以編輯，一改就寫回紀錄檔
const FILE_W = 22
const CELL_W = 12
function recordView(ui) {
  const { Box, Text, Button, Markdown, Select, Input } = ui
  const axis = (known.state.current || {}).axis
  const set = known.set
  const check = (known.checks || {})[axis]
  if (!axis || !check) return Box({ key: 'record', paddingX: 1, children: [Text({ key: 'record-empty', dimColor: true, children: ['進度檔還沒有指向任何軸'] })] })
  if (!check.project) {
    const where = axisDir(known.proc, axis).replace(/\//g, '\\') + '工程'
    // 每一行各自置中；選單與按鈕名稱用粗體
    const b = (key, s) => Text({ key, bold: true, children: [s] })
    const lines = [
      ['沒有找到工程。'],
      ['MR Configurator2：', b('record-missing-menu', '工程'), ' > ', b('record-missing-new', '新建'), '，工作區選「' + where + '」，'],
      ['工程名稱填「' + axis + '」，點擊', b('record-missing-ok', '確定'), '。'],
    ]
    // 像找不到網頁那樣：引導文字與「重試」在分頁中間置中
    return Box({
      key: 'record',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      paddingX: 1,
      paddingY: 1,
      gap: 1,
      width: '100%',
      children: [
        Box({
          key: 'record-missing',
          flexDirection: 'column',
          alignItems: 'center',
          children: lines.map((parts, i) => Text({ key: 'record-missing-' + i, children: parts })),
        }),
        // USB 是 mod 自己查的：沒有偵測過或超過 10 秒就再查一次
        Text({ key: 'record-usb', dimColor: true, children: [usbLine(ui.usb())] }),
        Box({ key: 'record-retry-row', justifyContent: 'center', children: [Button({ key: 'record-retry', label: '重試', onPress: () => ui.retry(axis) })] }),
      ],
    })
  }
  const sets = known.sets.includes(set) ? known.sets : [set, ...known.sets]
  const rec = known.records[axis] || { params: {} }
  const files = Object.keys(rec.params || {})
  const all = known.proc.params || []
  const filled = all.filter((name) => files.some((f) => String((rec.params[f] || {})[name] || '') !== ''))
  // 只顯示有值的欄；存檔都還沒有值時先給前四欄，讓人有地方填
  const cols = filled.length ? filled : all.slice(0, 4)
  const taskRow = Box({
    key: 'record-task',
    flexDirection: 'row',
    gap: 1,
    children: [
      Select
        ? Select({
            key: 'record-task-select',
            label: '任務',
            options: [...sets.map((x) => ({ value: x, label: x })), { value: NEW_TASK, label: '＋新增任務' }],
            value: adding ? NEW_TASK : set,
            onSelect: (value) => ui.pickTask(value),
          })
        : Text({ key: 'record-task-text', children: ['任務 ' + set] }),
      ...(adding && Input
        ? [Input({ key: 'record-task-name', placeholder: '任務名稱，例如 耦合疊加', submitLabel: '建立', autoFocus: true, onSubmit: (value) => ui.createTask(value) })]
        : []),
    ],
  })
  const head = Box({
    key: 'record-head',
    flexDirection: 'row',
    children: [
      Box({ key: 'record-head-file', width: FILE_W, flexShrink: 0, children: [Text({ key: 'record-head-file-text', dimColor: true, children: ['存檔'] })] }),
      ...cols.map((name) =>
        Box({ key: 'record-head-' + name, width: CELL_W, flexShrink: 0, children: [Text({ key: 'record-head-' + name + '-text', dimColor: true, wrap: 'truncate', children: [name] })] }),
      ),
    ],
  })
  const rows = files.map((f, r) =>
    Box({
      key: 'record-row-' + r,
      flexDirection: 'row',
      children: [
        Box({ key: 'record-row-' + r + '-file', width: FILE_W, flexShrink: 0, children: [Text({ key: 'record-row-' + r + '-file-text', wrap: 'truncate', children: [f] })] }),
        ...cols.map((name, c) =>
          Box({
            key: 'record-cell-' + r + '-' + c + '-box',
            width: CELL_W,
            flexShrink: 0,
            children: [
              Input
                ? Input({
                    key: 'record-cell-' + r + '-' + c,
                    value: String((rec.params[f] || {})[name] || ''),
                    onInput: (value) => ui.setParam(f, name, value),
                    onSubmit: (value) => ui.setParam(f, name, value),
                  })
                : Text({ key: 'record-cell-' + r + '-' + c, children: [String((rec.params[f] || {})[name] || '--')] }),
            ],
          }),
        ),
      ],
    }),
  )
  return Box({
    key: 'record',
    flexDirection: 'column',
    paddingX: 1,
    children: [
      taskRow,
      ...(files.length ? [head, ...rows] : [Text({ key: 'record-no-params', dimColor: true, children: ['還沒有參數存檔'] })]),
    ],
  })
}

function formatErrors(ui) {
  const { Text } = ui
  const axis = (known.state.current || {}).axis
  const errors = ((known.checks || {})[axis] || {}).errors || []
  if (!errors.length) return []
  return [
    Text({
      key: 'format-errors',
      color: 'red',
      wrap: 'wrap',
      children: [recordPath(known.proc, axis, known.set) + ' 格式錯誤：' + errors.join('；')],
    }),
  ]
}

export function register(on) {
  on('session.start', async ($, e, next) => {
    try {
      await $.command.register({
        name: COMMAND,
        description: '在輸入框上方顯示調機儀表板，依 procedures/ 的程序定義逐軸、逐階段引導伺服調機',
        argumentHint: '[機型，例如 WR403；不寫就沿用上次的]',
      })
    } catch (err) {
      $.ui.log('無法註冊 /' + COMMAND + '：' + err)
    }
    await loadKnown($)
    armPoll($)
    return next(e)
  })

  // /tune <機型>：進度檔、紀錄檔、工程與 USB 都由 mod 自己處理；只有缺工程且有驅動器連著時才請 AI 建工程
  on('command.run', { command: COMMAND }, async ($, e) => {
    return { text: await intake($, e.args || '') }
  }).catch(async () => ({ text: '/' + COMMAND + ' 執行失敗，進度檔沒有改動。' }))

  // 桌面 App 新工作階段的第一則訊息送出時，/tune 還沒註冊成指令（註冊在 session.start 裡）：
  // 使用者自己打的 /tune 在這裡攔下，由 mod 自己執行，不交給 AI
  on('prompt.submit', async ($, e, next) => {
    const m = /^\s*\/tune(?:\s+(.*))?\s*$/.exec(String(e.text || ''))
    // 只攔人打的：終端機、Remote Control、桌面 App（sdk）、無法標記的來源；外掛、排程、其他工作階段送來的照常
    const human = ['composer', 'bridge', 'sdk', 'unclassified']
    if (!m || (e.origin && e.origin.kind && !human.includes(e.origin.kind))) return next(e)
    let text
    try {
      text = await intake($, m[1] || '')
    } catch (err) {
      text = '/' + COMMAND + ' 執行失敗，進度檔沒有改動。'
    }
    $.ui.invalidate('ui.render')
    return { drop: text }
  })

  // 記下主對話正在跑的這一輪，「停止」「重來」要中斷它
  on('turn.start', async ($, e, next) => {
    turnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (!e.agentId && e.turnId === turnId) turnId = null
    if (!e.agentId) await loadKnown($)
    // AI 建完工程：目前的軸還沒有工程、別軸有時，由 mod 把目前的軸移到依程序順序第一個有工程的軸
    if (pendingBuild && !e.agentId) {
      pendingBuild = false
      const cur = (known && known.state.current) || {}
      const checks = (known && known.checks) || {}
      if (known && !(checks[cur.axis] || {}).project) {
        const built = (known.proc.axes || []).find((a) => (checks[a] || {}).project)
        const first = stagesOf('axis')[0]
        if (built) await selectStage($, built, first ? first.id : cur.stage)
      }
    }
    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // 定時重讀停掉了就在這裡重新排
    armPoll($)
    // 桌面 App 的新工作階段要等第一則訊息才觸發 session.start；畫面先要畫時就在這裡讀，不等
    if (!known && Date.now() - lastLoad > POLL_MS) {
      lastLoad = Date.now()
      known = await readAll($)
      seen = JSON.stringify(known)
    }
    if (!known) return next(e)
    const { Box, Text, Button, Svg, Markdown, Select, Input } = $.ui.resolve(e)
    // 按鈕的 onPress 要寫回進度檔與送出指示（$ 本身不能放進物件，只能包成閉包）
    const ui = {
      Box,
      Text,
      Button,
      Svg,
      Markdown,
      Select,
      Input,
      advance: (id, answer) => void advanceItem($, id, answer),
      stop: (id) => void stopItem($, id),
      select: (axis, stage) => void selectStage($, axis, stage),
      selectSet: (set) => void selectSet($, set),
      ask: (text) => void $.prompt.submit({ text }),
      // 任務下拉：選「＋新增任務」打開名稱輸入框；選其他任務就切過去並收起輸入框
      pickTask: (value) => {
        if (value === NEW_TASK) {
          adding = true
          $.ui.invalidate('ui.render')
        } else {
          adding = false
          void selectSet($, value)
        }
      },
      createTask: (name) => void createTask($, name),
      askParam: (id) => void askParam($, id),
      retry: (axis) => void retryProject($, axis),
      // 實驗紀錄分頁要顯示 USB 狀態：沒有查過或超過 10 秒就在背景再查，查完重畫
      usb: () => {
        if (!usb || Date.now() - usb.at > 10000) {
          usb = usb ? { ...usb, at: Date.now() } : null
          void detectUsb($).then(() => $.ui.invalidate('ui.render'))
        }
        return usb
      },
      setParam: (file, name, value) => void setParam($, file, name, value),
    }
    const theirs = await next(e)
    const children = [theirs]
    if (known) {
      const cur = TABS[tab]
      children.push(
        Box({
          flexDirection: 'column',
          borderStyle: 'round',
          paddingX: 1,
          // 分頁列與內容之間不留空行，面板高度有上限
          gap: 0,
          children: [
            Box({
              flexDirection: 'row',
              gap: 1,
              children: TABS.map((x, i) =>
                Box({
                  key: 'slot-' + x.key,
                  width: x.label.length * 2 + 6,
                  children: [
                    Box({
                      key: 'pill-' + x.key,
                      ...(i === tab ? { borderStyle: 'round', borderColor: HOVER, backgroundColor: HOVER } : {}),
                      paddingX: 1,
                      children: [
                        i === tab
                          ? Text({ key: 'tab-' + x.key, children: [x.label] })
                          : Button({
                              key: 'tab-' + x.key,
                              plain: true,
                              label: x.label,
                              children: [Text({ dimColor: true, children: [x.label] })],
                              // 切分頁：先用手上的資料立刻畫，再在背景重讀檔案，有變就再畫一次
                              onPress: () => {
                                tab = i
                                $.ui.invalidate('ui.render')
                                void reloadIfChanged($)
                              },
                            }),
                      ],
                    }),
                  ],
                }),
              ),
            }),
            // 目前這一軸的紀錄檔格式不對：每個分頁最上面都用紅字列出哪個檔、哪裡錯
            ...formatErrors(ui),
            ...(cur.key === 'status' ? [statusView(ui)] : []),
            ...(cur.key === 'sop' ? [sopView(ui)] : []),
            ...(cur.key === 'record' ? [recordView(ui)] : []),
          ],
        }),
      )
    }
    return Box({ flexDirection: 'column', children })
  })
}