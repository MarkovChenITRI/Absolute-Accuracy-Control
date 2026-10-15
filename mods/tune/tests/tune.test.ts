import { expect, mock, test } from 'claude-code/testing'

// 測試用的程序定義：基底 + 機型覆寫，結構與 mods/tune/procedures/mr-j5.json、wr403.json 相同（項目較少）
const BASE = {
  id: 'mr-j5',
  version: '6',
  safety: '項次 3 用測試片。',
  blocks: {
    place: [{ by: 'engineer', do: '在 RASeMIO 工業電腦開始放片進程，層號 {layers}；放完回報' }],
  },
  stages: [
    {
      id: 'inertia',
      name: '慣量辨識',
      scope: 'axis',
      criteria: [
        {
          id: 'inertia.range',
          no: 1,
          item: 'PB06 落在三個高度的推定值之間',
          steps: [{ by: 'ai', do: '讀 STEP2 的 PB06', record: '設定值', judge: '最小值 ≤ 設定值 ≤ 最大值' }],
        },
      ],
    },
    {
      id: 'gain',
      name: '增益整定',
      scope: 'axis',
      pair: 'resonance',
      criteria: [
        {
          id: 'gain.no-osc',
          no: 2,
          item: '伺服 ON 靜止與運轉無振動或異音',
          steps: [
            { use: 'place', layers: '1、13、25' },
            { by: 'engineer', do: '停止時與運轉中在現場看、聽', choices: ['有振動或異音', '沒有'], pass: '沒有' },
            { by: 'ai', do: '依工程師的回報判定' },
          ],
        },
      ],
    },
    {
      id: 'resonance',
      name: '共振抑制',
      scope: 'axis',
      pair: 'gain',
      criteria: [{ id: 'res.noise', no: 8, item: '靜止與運轉時無異音', steps: [{ use: 'place', layers: '1、13、25' }] }],
    },
    { id: 'suppression', name: '制振控制', scope: 'axis', pair: 'gain', barrier: true, criteria: [] },
  ],
}
const SOP_TEXT = [
  '# 標準作業流程',
  '',
  '## 共用規則',
  '- 規則一',
  '',
  '---',
  '',
  '## 1｜慣量辨識｜負載慣量比 PB06 在監視模式下穩定',
  '',
  '> inertia',
  '',
  '## 2｜增益整定｜速度控制增益 PB09 為振動發生值的 70–80%',
  '',
  '> gain-vg2-margin',
  '',
  '- 步驟：',
  '  1. 【AI】在 MR Configurator2 切到手動模式，讀出 PB06、PB09。',
  '',
  '## 3｜增益整定｜速度積分補償 PB10 為不振動範圍內的最小值',
  '',
  '> gain-vic-min',
  '',
  '- 判定：',
  '',
  '## 7｜共振抑制｜靜止與運轉時無振動或異音',
  '',
  '---',
  '',
  '## 待現場確認',
  '',
  '1. 問題一',
].join('\r\n')
const MACHINE = { id: 'wr403', extends: 'mr-j5', machine: 'WR403', axes: ['上台_A軸', '下台_A軸', '下台_B軸'], acceptance: '末端加速度 ≤ 0.3 g' }
const SET = 'A01_伺服調機'
const axisDir = (axis: string) => 'data/WR403/' + axis
const setDir = (axis: string) => axisDir(axis) + '/實驗紀錄/' + SET
const recPath = (axis: string) => setDir(axis) + '/紀錄.json'

// 測試用的檔案世界：進度檔、各軸 A01 任務的紀錄檔、其他檔案（相對路徑）、資料夾內容、另外的程序定義、
// 連著的 USB 裝置與原樣的檔案內容（raw，給格式錯誤的測試）；寫入會改回這裡
type Entry = { name: string; kind: string; mtimeMs?: number }
type World = { state: any; records: Record<string, any>; dirs: Record<string, Entry[]>; base: any; files: Record<string, any>; procs: Record<string, any>; usb: string[]; raw: Record<string, string> }
function world(state: any, records: Record<string, any> = {}, dirs: Record<string, Entry[]> = {}, base: any = BASE): World {
  return { state, records, dirs, base, files: {}, procs: {}, usb: [], raw: {} }
}
const file = (name: string, mtimeMs = 0) => ({ name, kind: 'file', mtimeMs })
const dir = (name: string) => ({ name, kind: 'dir' })
// 一軸工程齊全：工程/ 底下 MR Configurator2 自己分的工程資料夾裡有 Project.mr2
function projectDirs(axis: string) {
  return { [axisDir(axis) + '/工程']: [dir(axis)], [axisDir(axis) + '/工程/' + axis]: [file('Project.mr2')] }
}
// 一軸資料齊全：工程，以及 參數/ 裡的參數檔
function completeDirs(axis: string, params: string[] = ['WR403.prm2']) {
  return { ...projectDirs(axis), [setDir(axis) + '/參數']: params.map(file) }
}

function hooks(w: World, $: any, on: any, sent?: string[]) {
  // hook 收到的是絕對路徑（Windows 用反斜線），一律換成斜線、以結尾比對
  const norm = (path: string) => String(path).replace(/\\/g, '/').replace(/\/$/, '')
  const axisOf = (path: string) => MACHINE.axes.find((a) => norm(path).endsWith('/' + recPath(a)))
  const fileOf = (path: string) => Object.keys(w.files).find((k) => norm(path).endsWith('/' + k))
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.read', ($$: any, e: any) => {
    const rawKey = Object.keys(w.raw).find((k) => norm(e.path).endsWith('/' + k))
    if (rawKey) return { value: w.raw[rawKey] }
    if (e.path.endsWith('session.json')) {
      if (!w.state) throw new Error('ENOENT ' + e.path)
      return { value: JSON.stringify(w.state) }
    }
    if (e.path.endsWith('wr403.json')) return { value: JSON.stringify(MACHINE) }
    if (e.path.endsWith('mr-j5.json')) return { value: JSON.stringify(w.base) }
    if (e.path.endsWith('標準作業流程.md')) return { value: SOP_TEXT }
    const id = Object.keys(w.procs).find((k) => e.path.endsWith(k + '.json'))
    if (id) return { value: JSON.stringify(w.procs[id]) }
    const axis = axisOf(e.path)
    if (axis && w.records[axis]) return { value: JSON.stringify(w.records[axis]) }
    const other = fileOf(e.path)
    if (other) return { value: JSON.stringify(w.files[other]) }
    throw new Error('ENOENT ' + e.path)
  })
  on('fs.write', ($$: any, e: any) => {
    const text = e.text ?? e.content
    const axis = axisOf(e.path)
    const other = fileOf(e.path)
    const p = norm(e.path)
    if (axis) w.records[axis] = JSON.parse(text)
    else if (other) w.files[other] = JSON.parse(text)
    else if (p.includes('/data/')) w.files[p.slice(p.indexOf('/data/') + 1)] = JSON.parse(text)
    else w.state = JSON.parse(text)
    return { value: undefined }
  })
  on('fs.exists', ($$: any, e: any) => {
    const p = norm(e.path)
    const axis = axisOf(e.path)
    return { value: Boolean((axis && w.records[axis]) || fileOf(e.path) || (p.endsWith('session.json') && w.state)) }
  })
  // mod 用 PowerShell 查 USB：回傳測試世界裡連著的裝置
  on('process.run', ($$: any, e: any) => ({ value: { exitCode: 0, stdout: w.usb.join('\r\n'), stderr: '' } }))
  on('fs.list', ($$: any, e: any) => {
    const key = Object.keys(w.dirs).find((k) => norm(e.path).endsWith('/' + k))
    if (key) return { value: w.dirs[key] }
    throw new Error('ENOENT ' + e.path)
  })
  if (sent) {
    on('prompt.submit', ($$: any, e: any) => {
      sent.push(e.text)
      return { text: e.text }
    })
  }
  on('turn.complete', () => ({ text: '' }))
}

async function mount(w: World, $: any, on: any, sent?: string[]) {
  hooks(w, $, on, sent)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  return $.ui.mount({ plugin: 'tune', component: 'AbovePrompt', surface: 'desktop', viewport: { columns: 100, rows: 30 }, props: {} } as any)
}

test('/tune <機型>：進度檔、各軸紀錄檔、工程檢查都由 mod 自己做；缺工程且 USB 有驅動器時才請 AI 建工程，指示裡寫好路徑與缺的軸', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  // 沒有進度檔；下台_A軸 已經有工程；USB 連著一台
  const w = world(null as any, {}, projectDirs('下台_A軸'))
  w.usb = ['USB\\VID_06D3&PID_01D0\\6&229898AC&0&4']
  hooks(w, $, on, sent)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out: any = await $.command.run({ command: 'tune', args: 'WR403' })
  await clock.settle()

  // 進度檔由 mod 寫：目前的軸是有工程的那一軸，階段是第一個，任務是 A01
  expect(w.state).toEqual({ procedure: 'wr403', current: { axis: '下台_A軸', stage: 'inertia', set: SET, goal: '' } })
  // 每一軸的紀錄檔由 mod 建
  for (const a of MACHINE.axes) expect(w.records[a]).toEqual({ procedure: 'wr403', items: {}, log: [], params: {} })
  expect(out.text).toContain('有工程 下台_A軸')
  expect(out.text).toContain('缺工程 上台_A軸、下台_B軸')
  expect(out.text).toContain('USB：連著 1 台')

  // 交給 AI 的只有建工程：mod 查好的 USB、缺工程的軸與各自的路徑都寫在指示裡
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('mod 已經查過：USB 連著 1 台三菱伺服驅動器')
  expect(sent[0]).toContain('還沒有 MR Configurator2 工程的軸：上台_A軸、下台_B軸')
  expect(sent[0]).toContain('data/WR403/上台_A軸/工程/')
  expect(sent[0]).toContain('先問工程師這台驅動器帶的是哪幾軸')
  expect(sent[0]).toContain('不要請工程師換插 USB')
  expect(sent[0]).toContain('不要改 mods/tune/.tune/session.json')

  // AI 建好下台_B軸 之後：mod 不再送東西；目前的軸本來就有工程，維持不動
  Object.assign(w.dirs, projectDirs('下台_B軸'))
  await $.turn.complete({ turnId: 't0', answer: '建好了。', isAborted: false, durationMs: 1 })
  await clock.settle()
  expect(sent.length).toBe(1)
  expect(w.state.current.axis).toBe('下台_A軸')
})

test('/tune <機型>：沒有連著驅動器時不交給 AI；全部軸都有工程時也不交給 AI；程序定義沒有的機型直接回報', async ($, on) => {
  const sent: string[] = []
  const clock = mock.clock(on)
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET, goal: '辨識負載慣量比 PB06' } })
  hooks(w, $, on, sent)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  let out: any = await $.command.run({ command: 'tune', args: 'WR403' })
  await clock.settle()
  expect(out.text).toContain('USB：沒有連著三菱伺服驅動器')
  expect(sent.length).toBe(0)
  // 同一個程序：保留原本的軸、階段與 goal
  expect(w.state.current).toEqual({ axis: '上台_A軸', stage: 'gain', set: SET, goal: '辨識負載慣量比 PB06' })

  Object.assign(w.dirs, projectDirs('上台_A軸'), projectDirs('下台_A軸'), projectDirs('下台_B軸'))
  out = await $.command.run({ command: 'tune', args: 'WR403' })
  await clock.settle()
  expect(out.text).not.toContain('缺工程')
  expect(sent.length).toBe(0)

  // 不帶機型：沿用進度檔上次的程序，不交給 AI
  out = await $.command.run({ command: 'tune', args: '' })
  await clock.settle()
  expect(out.text).toContain('WR403：有工程')
  expect(sent.length).toBe(0)

  out = await $.command.run({ command: 'tune', args: 'WR999' })
  expect(out.text).toContain('程序定義裡沒有 WR999')
})

test('/tune 新工作階段第一則訊息就是 /tune（指令還沒註冊）：mod 攔下來自己執行，不交給 AI', async ($, on) => {
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET, goal: '' } })
  hooks(w, $, on)
  let reachedModel = false
  on('prompt.submit', ($$: any, e: any) => {
    reachedModel = true
    return { text: e.text }
  })
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const r: any = await $.prompt.submit({ text: '/tune', origin: { kind: 'sdk' } } as any)
  expect(reachedModel).toBe(false)
  expect(r.drop).toContain('WR403：')
  // 一般訊息照常送出
  await $.prompt.submit({ text: '只回覆 OK', origin: { kind: 'sdk' } } as any)
  expect(reachedModel).toBe(true)
})

test('/tune 新工作階段還沒觸發 session.start 時，面板第一次要畫就自己讀檔，不會空白', async ($, on) => {
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET } })
  hooks(w, $, on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  const band = await $.ui.mount({ plugin: 'tune', component: 'AbovePrompt', surface: 'desktop', viewport: { columns: 100, rows: 30 }, props: {} } as any)
  expect(await band.find({ type: 'Text', text: /^WR403 · 3 軸$/ })).toBeDefined()
  band.unmount()
})

test('/tune 參數檔由 mod 對應：項次執行期間存進 參數/ 的最新檔案，判定之後自動寫進那一項的 param', async ($, on) => {
  const w = world(
    { procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET } },
    { 上台_A軸: { items: { 'gain.no-osc': { status: 'pass' } }, log: [], params: {}, started: { 'gain.no-osc': 1000 } } },
    // 舊檔 old 在項次開始之前；新檔 r2 在之後
    { ...projectDirs('上台_A軸'), [setDir('上台_A軸') + '/參數']: [file('old.prm2', 500), file('r2.prm2', 2000)] },
  )
  const band = await mount(w, $, on)
  expect(w.records['上台_A軸'].items['gain.no-osc'].param).toBe('參數/r2.prm2')
  // 對應好就算數：名稱前面是勾選，不是「存參數檔」
  const check: any = await band.find({ type: 'Svg' } as any)
  expect(check.props.alt).toBe('通過')
  band.unmount()
})

test('/tune 紀錄檔格式錯誤：每個分頁最上面用紅字列出哪個檔、哪裡錯；壞掉的 JSON 不會被當成空的蓋掉', async ($, on) => {
  const sent: string[] = []
  const w = world(
    { procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET } },
    { 上台_A軸: { items: { 'gain.no-osc': { status: 'done', step: '2' }, 'nope.x': { status: 'pass' } }, log: [], params: { '參數/a.prm2': { 亂寫的欄: '1' } } } },
  )
  w.base = { ...BASE, params: ['速度控制增益'] }
  const band = await mount(w, $, on, sent)
  const err: any = await band.find({ type: 'Text', text: /格式錯誤/ })
  expect(err.props.color).toBe('red')
  expect(JSON.stringify(err)).toContain('status 是「done」')
  expect(JSON.stringify(err)).toContain('step 不是整數')
  expect(JSON.stringify(err)).toContain('程序定義裡沒有的項目「nope.x」')
  expect(JSON.stringify(err)).toContain('欄位「亂寫的欄」')

  // JSON 壞掉：顯示錯誤，按「開始」也不寫檔
  w.raw[recPath('上台_A軸')] = '{ "items": { '
  await $.turn.complete({ turnId: 't0', answer: '', isAborted: false, durationMs: 1 })
  expect(JSON.stringify(await band.find({ type: 'Text', text: /格式錯誤/ }))).toContain('不是合法的 JSON')
  const before = JSON.stringify(w.records['上台_A軸'])
  await band.press({ key: 'criteria-start-0' })
  expect(JSON.stringify(w.records['上台_A軸'])).toBe(before)
  expect(sent.length).toBe(0)
  band.unmount()
})
test('/tune 調整階段：軸那一列代表慣量辨識，目前軸展開其餘階段，▶ 只標一處；一軸要判定全過且資料齊全才打勾', async ($, on) => {
  const w = world(
    { procedure: 'wr403', current: { axis: '下台_A軸', stage: 'resonance' }, status: { 上台_A軸: { suppression: 'pass' } } },
    {
      上台_A軸: {
        items: {
          'inertia.range': { status: 'pass', param: '參數/p1.prm2' },
          'gain.no-osc': { status: 'pass', param: '參數/p2.prm2' },
          'res.noise': { status: 'pass', param: '參數/p3.prm2' },
        },
        log: [],
      },
      下台_A軸: { items: { 'inertia.range': { status: 'pass', param: '參數/q1.prm2' } }, log: [] },
      下台_B軸: { items: { 'inertia.range': { status: 'pass' }, 'gain.no-osc': { status: 'pass' }, 'res.noise': { status: 'pass' } }, log: [] },
    },
    // 上台_A軸 每個實驗結果都有參數檔；下台_B軸 判定全過但沒有參數檔
    { ...completeDirs('上台_A軸', ['p1.prm2', 'p2.prm2', 'p3.prm2']), ...completeDirs('下台_A軸', ['q1.prm2']), ...projectDirs('下台_B軸') },
  )
  w.state.status.下台_B軸 = { suppression: 'pass' }
  const band = await mount(w, $, on)

  expect(await band.find({ type: 'Text', text: /^調整階段$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /^1\. 上台_A軸$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^✓$/ })).toBeDefined()
  // 目前軸在小點（共振抑制）上：軸那一列可以點回慣量辨識，不畫 ▶
  expect(await band.find({ type: 'Button', text: /^2\. 下台_A軸$/ })).toBeDefined()
  expect(await band.find({ key: 'axis-item-下台_A軸-mark', text: /▶/ } as any)).toBeUndefined()
  // 資料不全：判定全過也不算調完
  expect(await band.find({ type: 'Button', text: /^3\. 下台_B軸（未完成）$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /^2\.1 增益整定（未完成）$/ })).toBeDefined()
  const here: any = await band.find({ type: 'Text', text: /^2\.2 共振抑制$/ })
  expect(here.props.bold).toBe(true)
  expect(await band.find({ type: 'Text', text: /⇄|輪|整機|系統驗收/ })).toBeUndefined()
  expect(await band.find({ key: 'stage-item-下台_A軸-inertia-go' } as any)).toBeUndefined()

  expect(await band.find({ type: 'Text', text: /^WR403 · 3 軸$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^末端加速度 ≤ 0\.3 g$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^靜止與運轉時無異音$/ })).toBeDefined()
  expect(await band.find({ key: 'criteria-start-0' } as any)).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^[☐☑☒]$/ })).toBeUndefined()
  band.unmount()
})

test('/tune 所有軸與階段都可以點選切換：點了只改進度檔的 current，目前所在的那一列不是按鈕', async ($, on) => {
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'inertia', set: SET, goal: '辨識負載慣量比 PB06' } })
  const band = await mount(w, $, on)
  expect(await band.find({ key: 'axis-item-上台_A軸-go' } as any)).toBeUndefined()
  expect(await band.find({ key: 'stage-item-上台_A軸-inertia-go' } as any)).toBeUndefined()

  await band.press({ key: 'stage-item-上台_A軸-suppression-go' })
  expect(w.state.current.stage).toBe('suppression')
  expect(w.state.current.goal).toBe('辨識負載慣量比 PB06')
  expect(w.state.current.set).toBe(SET)

  await band.press({ key: 'stage-item-上台_A軸-gain-go' })
  expect(w.state.current.stage).toBe('gain')

  await band.press({ key: 'axis-item-下台_B軸-go' })
  expect(w.state.current.axis).toBe('下台_B軸')
  expect(w.state.current.stage).toBe('inertia')
  await band.press({ key: 'stage-item-下台_B軸-gain-go' })
  expect(w.state.current.stage).toBe('gain')
  await band.press({ key: 'axis-item-下台_B軸-go' })
  expect(w.state.current.stage).toBe('inertia')
  band.unmount()
})

test('/tune 驗收項目按「開始」交給 AI，狀態寫在這一軸的紀錄檔；輪到工程師時顯示選項，選了之後從下一步接著做，做完才判定', async ($, on) => {
  const sent: string[] = []
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain' } })
  const band = await mount(w, $, on, sent)
  const item = () => w.records['上台_A軸'].items['gain.no-osc']

  await band.press({ key: 'criteria-start-0' })
  expect(item().status).toBe('running')
  expect(w.state.runs).toBeUndefined()
  expect(sent[0]).toContain('執行驗收項目 2「伺服 ON 靜止與運轉無振動或異音」')
  expect(sent[0]).toContain(recPath('上台_A軸') + ' 的 items["gain.no-osc"]')
  expect(sent[0]).toContain('1. ［工程師］在 RASeMIO 工業電腦開始放片進程，層號 1、13、25')
  expect(sent[0]).toContain('2. ［工程師］停止時與運轉中在現場看、聽（選項：有振動或異音／沒有（選「沒有」才通過））')
  expect(sent[0]).toContain('從第 1 步開始')
  expect(sent[0]).toContain('"status":"waiting"')
  // 過程紀錄：每一步加一筆 log；採樣檔存進 採樣/、不改檔名
  expect(sent[0]).toContain('log 陣列最後加一筆')
  expect(sent[0]).toContain('採樣/，檔名照匯出時的名稱不改')
  expect(sent[0]).toContain('項次 3 用測試片。')

  await $.turn.complete({ turnId: 't0', answer: '執行中。', isAborted: false, durationMs: 1 })
  const stopIcon: any = await band.find({ type: 'Svg' } as any)
  expect(stopIcon.props.alt).toBe('停止')
  expect(await band.find({ key: 'criteria-stop-0' } as any)).toBeDefined()

  w.records['上台_A軸'].items['gain.no-osc'] = { status: 'waiting', step: 2, wait: '現場看、聽有沒有振動或異音', choices: ['有振動或異音', '沒有'] }
  await $.turn.complete({ turnId: 't1', answer: '等工程師。', isAborted: false, durationMs: 1 })
  expect(await band.find({ type: 'Svg' } as any)).toBeUndefined()
  expect(await band.find({ type: 'Button', text: /^沒有$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /等工程師/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^1\.1 增益整定$/ })).toBeDefined()

  await band.press({ key: 'criteria-choice-0-1' })
  expect(item().status).toBe('running')
  expect(item().answer).toBe('沒有')
  expect(item().step).toBe(3)
  expect(sent[1]).toContain('工程師已完成第 2 步，回報：「沒有」')
  expect(sent[1]).toContain('從第 3 步開始')

  // 判定之後要存參數檔：指示裡寫明存進 參數/、把檔名寫進 param
  expect(sent[1]).toContain(setDir('上台_A軸') + '/參數/')
  expect(sent[1]).toContain('不要自己寫 param')
  expect(typeof w.records['上台_A軸'].started['gain.no-osc']).toBe('number')

  // 通過但還沒有參數檔：不打勾，名稱前面是「存參數檔」
  w.records['上台_A軸'].items['gain.no-osc'] = { status: 'pass', value: '工程師回報：沒有' }
  await $.turn.complete({ turnId: 't2', answer: '通過。', isAborted: false, durationMs: 1 })
  expect(await band.find({ type: 'Svg' } as any)).toBeUndefined()
  await band.press({ key: 'criteria-param-0' })
  expect(sent[2]).toContain('補存 上台_A軸 項次 2')

  // 參數檔存好：打勾
  w.records['上台_A軸'].items['gain.no-osc'] = { status: 'pass', value: '工程師回報：沒有', param: '參數/r2.prm2' }
  w.dirs[setDir('上台_A軸') + '/參數'] = [file('r2.prm2')]
  await $.turn.complete({ turnId: 't3', answer: '存好了。', isAborted: false, durationMs: 1 })
  const check: any = await band.find({ type: 'Svg' } as any)
  expect(check.props.alt).toBe('通過')
  expect(await band.find({ type: 'Button', text: /^(重試|重做|開始|存參數檔)$/ })).toBeUndefined()

  w.records['上台_A軸'].items['gain.no-osc'] = { status: 'fail', value: '工程師回報：有振動或異音' }
  await $.turn.complete({ turnId: 't4', answer: '未通過。', isAborted: false, durationMs: 1 })
  await band.press({ key: 'criteria-retry-0' })
  expect(item().status).toBe('running')
  expect(sent[3]).toContain('從第 1 步開始')
  band.unmount()
})

test('/tune 執行中時，名稱前面的停止圖示就是按鈕：按下中斷這一輪、這一項回到未開始', async ($, on) => {
  const sent: string[] = []
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain' } })
  const band = await mount(w, $, on, sent)
  expect(await band.find({ key: 'criteria-stop-0' } as any)).toBeUndefined()

  await band.press({ key: 'criteria-start-0' })
  await $.turn.complete({ turnId: 't0', answer: '執行中。', isAborted: false, durationMs: 1 })
  expect(await band.find({ key: 'criteria-stop-0' } as any)).toBeDefined()
  expect(await band.find({ type: 'Button', text: /^(停止|重來)$/ })).toBeUndefined()

  await band.press({ key: 'criteria-stop-0' })
  expect(w.records['上台_A軸'].items['gain.no-osc']).toBeUndefined()
  expect(sent.length).toBe(1)
  expect(await band.find({ key: 'criteria-start-0' } as any)).toBeDefined()
  band.unmount()
})

test('/tune 階段狀態由各項判定算出：全部通過打勾、任一項未通過算未通過，AI 寫的 status 不算；通過但沒有參數檔不算', async ($, on) => {
  const w = world(
    { procedure: 'wr403', current: { axis: '上台_A軸', stage: 'inertia' }, status: { 上台_A軸: { gain: 'todo', resonance: 'pass' } } },
    { 上台_A軸: { items: { 'gain.no-osc': { status: 'pass', param: '參數/p2.prm2' }, 'res.noise': { status: 'fail' } }, log: [] } },
    completeDirs('上台_A軸', ['p2.prm2']),
  )
  const band = await mount(w, $, on)
  expect(await band.find({ type: 'Button', text: /^1\.1 增益整定$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /^1\.2 共振抑制（未完成）$/ })).toBeDefined()

  // 參數檔不在 參數/ 裡：增益整定不再算通過
  w.dirs[setDir('上台_A軸') + '/參數'] = []
  await $.turn.complete({ turnId: 't0', answer: '', isAborted: false, durationMs: 1 })
  expect(await band.find({ type: 'Button', text: /^1\.1 增益整定（未完成）$/ })).toBeDefined()
  band.unmount()
})

test('/tune 三個分頁；標準作業流程分頁照原文顯示目前階段的每一項', async ($, on) => {
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain' } })
  const band = await mount(w, $, on)
  expect(await band.find({ type: 'Button', text: /^標準作業流程$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', text: /^實驗紀錄$/ })).toBeDefined()

  await band.press({ key: 'tab-sop' })
  // 每一項開頭是調機總覽上同一項的驗收項目文字，用粗體 Text：項次 2 對到程序定義，項次 3 程序定義沒有就用標題裡的文字
  const t0: any = await band.find({ type: 'Text', text: /^伺服 ON 靜止與運轉無振動或異音$/ })
  expect(t0.props.bold).toBe(true)
  const t1: any = await band.find({ type: 'Text', text: /^速度積分補償 PB10 為不振動範圍內的最小值$/ })
  expect(t1.props.bold).toBe(true)
  const md: any = await band.find({ key: 'sop-md-0' } as any)
  expect(md.props.text).toContain('1. 【AI】在 MR Configurator2 切到手動模式，讀出 PB06、PB09。')
  // 原本的 ## 標題、> 技能名、別的階段都不顯示；兩項之間有分隔線
  const all = JSON.stringify(await band.findAll({ type: 'Markdown' } as any))
  expect(all).not.toMatch(/## |> gain-|慣量辨識|共振抑制|共用規則|待現場確認/)
  expect(await band.find({ type: 'Text', text: /^─+$/ })).toBeDefined()
  expect(await band.find({ key: 'criteria-start-0' } as any)).toBeUndefined()
  band.unmount()
})

test('/tune 實驗紀錄分頁：沒有工程時只顯示 MR Configurator2 的建立步驟與「重試」，不顯示任務與參數表', async ($, on) => {
  const sent: string[] = []
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain' } }, {}, { [axisDir('上台_A軸') + '/實驗紀錄']: [dir(SET)] })
  const band = await mount(w, $, on, sent)
  await band.press({ key: 'tab-record' })

  expect(await band.find({ type: 'Text', text: /^沒有找到工程。$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'MR Configurator2：工程 > 新建，工作區選「data\\WR403\\上台_A軸\\工程」，' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: '工程名稱填「上台_A軸」，點擊確定。' })).toBeDefined()
  expect(await band.find({ key: 'record-task-select' } as any)).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^還沒有參數存檔$/ })).toBeUndefined()

  // USB 狀態是 mod 自己查的；沒連著時按「重試」不交給 AI
  expect(await band.find({ type: 'Text', text: /^USB：沒有連著三菱伺服驅動器/ })).toBeDefined()
  await band.press({ key: 'record-retry' })
  expect(sent.length).toBe(0)

  // 接上之後按「重試」：只為這一軸請 AI 建工程，指示裡寫好路徑
  w.usb = ['USB\\VID_06D3&PID_01D0\\6&229898AC&0&4']
  await band.press({ key: 'record-retry' })
  expect(sent[0]).toContain('還沒有 MR Configurator2 工程的軸：上台_A軸')
  expect(sent[0]).toContain('data/WR403/上台_A軸/工程/')
  expect(sent[0]).toContain('工程師回答的軸不含 上台_A軸 時')
  expect(sent[0]).toContain('不要改放別處')
  band.unmount()
})

test('/tune 實驗紀錄分頁：任務下拉選單（可新增）與參數表；每列一次存檔、每欄一個參數，只顯示有值的欄，改了就存', async ($, on) => {
  const w = world(
    { procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET } },
    { 上台_A軸: { procedure: 'wr403', items: {}, log: [], params: {} } },
    { ...projectDirs('上台_A軸'), [axisDir('上台_A軸') + '/實驗紀錄']: [dir(SET), dir('B01_耦合疊加')] },
  )
  w.base = { ...BASE, params: ['負載慣量比', '速度控制增益', '速度積分補償', '位置控制增益', '模型控制增益'] }
  const band = await mount(w, $, on)
  await band.press({ key: 'tab-record' })

  // 任務是下拉選單，最後一項是新增任務；不顯示機型與軸
  const select: any = await band.find({ key: 'record-task-select' } as any)
  expect(select.props.value).toBe(SET)
  expect(select.props.options.map((o: any) => o.label)).toEqual([SET, 'B01_耦合疊加', '＋新增任務'])
  expect(await band.find({ type: 'Text', text: /WR403|上台_A軸/ })).toBeUndefined()
  expect(await band.find({ type: 'Text', text: /^還沒有參數存檔$/ })).toBeDefined()

  // 兩次存檔：只顯示有值的欄
  w.records['上台_A軸'].params = {
    '參數/x1.prm2': { 負載慣量比: '3.21', 速度控制增益: '120' },
    '參數/x2.prm2': { 負載慣量比: '3.21', 速度控制增益: '126', 速度積分補償: '18.5' },
  }
  await $.turn.complete({ turnId: 't0', answer: '', isAborted: false, durationMs: 1 })
  expect(await band.find({ type: 'Text', text: /^參數\/x2\.prm2$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^速度積分補償$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^位置控制增益$/ })).toBeUndefined()
  const cell: any = await band.find({ key: 'record-cell-1-1' } as any)
  expect(cell.props.value).toBe('126')

  // 人改一格：一改就寫回紀錄檔，不必另外按儲存
  await band.input({ key: 'record-cell-0-1', text: '118', kind: 'change' })
  expect(w.records['上台_A軸'].params['參數/x1.prm2'].速度控制增益).toBe('118')

  // 新增任務：選「＋新增任務」出現輸入框，Enter 建立；編號接在最大號後面，程序沿用目前任務的
  await band.select({ key: 'record-task-select', value: '__new__' })
  expect(await band.find({ key: 'record-task-name' } as any)).toBeDefined()
  await band.input({ key: 'record-task-name', text: '耦合疊加' })
  const created = w.files[axisDir('上台_A軸') + '/實驗紀錄/A02_耦合疊加/紀錄.json']
  expect(created).toEqual({ procedure: 'wr403', items: {}, log: [], params: {} })
  expect(w.state.current.set).toBe('A02_耦合疊加')
  expect(await band.find({ key: 'record-task-name' } as any)).toBeUndefined()
  band.unmount()
})

test('/tune 切分頁時先重讀檔案；定時重讀在第一次更新之後仍持續', async ($, on) => {
  const clock = mock.clock(on)
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET } }, { 上台_A軸: { items: {}, log: [], params: {} } }, { [axisDir('上台_A軸') + '/實驗紀錄']: [dir(SET)] })
  const band = await mount(w, $, on)
  await clock.settle()

  // 工程在畫面畫好之後才建好：切到實驗紀錄分頁就看得到，不必等定時重讀或下一輪對話
  Object.assign(w.dirs, projectDirs('上台_A軸'))
  await band.press({ key: 'tab-record' })
  await clock.settle()
  expect(await band.find({ key: 'record-task-select' } as any)).toBeDefined()

  // 檔案連續改兩次，每次都在一個週期內反映出來
  w.state = { ...w.state, current: { ...w.state.current, axis: '下台_A軸' } }
  await clock.advance(3000)
  expect(await band.find({ type: 'Text', text: /^沒有找到工程。$/ })).toBeDefined()
  w.state = { ...w.state, current: { ...w.state.current, axis: '上台_A軸' } }
  await clock.advance(3000)
  expect(await band.find({ key: 'record-task-select' } as any)).toBeDefined()
  w.state = { ...w.state, current: { ...w.state.current, axis: '下台_A軸' } }
  await clock.advance(3000)
  expect(await band.find({ type: 'Text', text: /^沒有找到工程。$/ })).toBeDefined()
  band.unmount()
})

test('/tune 切換任務：調機總覽改照那個任務紀錄檔的 procedure 與 items', async ($, on) => {
  const w = world(
    { procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain', set: SET } },
    {},
    { ...projectDirs('上台_A軸'), [axisDir('上台_A軸') + '/實驗紀錄']: [dir(SET), dir('B01_耦合疊加')] },
  )
  w.procs.b01 = { id: 'b01', stages: [{ id: 'gain', name: '耦合疊加', scope: 'axis', criteria: [{ id: 'sum.ratio', no: 1, item: '同動末端加速度接近單動的加權和', steps: [] }] }] }
  w.files[axisDir('上台_A軸') + '/實驗紀錄/B01_耦合疊加/紀錄.json'] = { procedure: 'b01', items: {}, log: [] }
  const band = await mount(w, $, on)
  expect(await band.find({ type: 'Text', text: /^伺服 ON 靜止與運轉無振動或異音$/ })).toBeDefined()

  await band.press({ key: 'tab-record' })
  await band.select({ key: 'record-task-select', value: 'B01_耦合疊加' })
  expect(w.state.current.set).toBe('B01_耦合疊加')
  await band.press({ key: 'tab-status' })
  expect(await band.find({ type: 'Text', text: /^同動末端加速度接近單動的加權和$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /^伺服 ON 靜止與運轉無振動或異音$/ })).toBeUndefined()
  band.unmount()
})

test('/tune 驗收項目沒有自帶步驟時，按「開始」送出照標準作業流程那一節執行的指示', async ($, on) => {
  const sent: string[] = []
  const SOP_BASE = {
    id: 'mr-j5',
    sop: 'docs/標準作業流程.md',
    stages: [
      { id: 'inertia', name: '慣量辨識', scope: 'axis', criteria: [{ id: 'inertia.pb06', no: 1, item: '負載慣量比 PB06 在監視模式下穩定' }] },
      { id: 'gain', name: '增益整定', scope: 'axis', criteria: [{ id: 'gain.pb09', no: 3, item: '速度控制增益 PB09 為振動發生值的 70–80%' }] },
    ],
  }
  const w = world({ procedure: 'wr403', current: { axis: '上台_A軸', stage: 'gain' } }, {}, {}, SOP_BASE)
  const band = await mount(w, $, on, sent)
  await band.press({ key: 'criteria-start-0' })
  expect(w.records['上台_A軸'].items['gain.pb09'].status).toBe('running')
  expect(sent[0]).toContain('docs/標準作業流程.md 的「## 3｜增益整定｜速度控制增益 PB09 為振動發生值的 70–80%」')
  expect(sent[0]).toContain('項次 1 = items["inertia.pb06"]')
  expect(sent[0]).toContain(recPath('上台_A軸') + ' 的 items["gain.pb09"]')
  band.unmount()
})

test('/tune 沒有進度檔或程序定義時，不畫儀表板', async ($, on) => {
  on('command.register', () => ({ value: undefined }))
  on('session.start', () => ({ cwd: '/work' }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['drawn by Claude Code'] }))
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  const band = await $.ui.mount({ plugin: 'tune', component: 'AbovePrompt', surface: 'desktop', viewport: { columns: 100, rows: 30 }, props: {} } as any)
  expect(await band.find({ type: 'Text', text: /^受測機台$/ })).toBeUndefined()
  band.unmount()
})