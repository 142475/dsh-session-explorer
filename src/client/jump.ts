/**
 * client/jump.ts —— 打开原会话并定位到消息（基于引擎 DOM 契约）。
 *
 * 0.1.2 起 ui-chat 为每个轮次行标注稳定 data 属性，原生轮次导航 rail 即
 * 消费这套契约滚动；本模块做同款适配，把插件索引里的 (seq, turn) 带到
 * 真实会话视图。三级策略，逐级降级，全程静默失败：
 *  1. 目标行已渲染 → 直接按 flowTop-24 滚动（与引擎 landOnRow 完全同款）；
 *  2. 该轮未渲染（长会话分页）→ 模拟点击原生 rail 对应 mark，
 *     借引擎自身的 loadThrough 分页跳转；
 *  3. 契约不可用 → 仅切换会话（旧行为）。
 *
 * ⚠ data-chat-turn / data-chat-anchor-key / data-conversation-scroll 是引擎
 * 内部 DOM 契约，不是承诺接口；全部选择器落空时自动退化为纯 open。
 */

/** 插件索引里足以定位一条消息的信息。 */
export interface JumpTarget {
  /** 目标消息 seq（DSH 全局分配器，保留作扩展；当前定位按 turn）。 */
  seq: number
  /** 目标轮次号（插件索引折叠值；null 时退化为仅切换会话）。 */
  turn: number | null
  /** 命中文本探针（snippet 去省略号后的中段，用于行归属校验；可空）。 */
  probe?: string
  /** 目标消息时间戳（毫秒）。折叠/摘要行没有正文，但一定会渲染这条时间，是最可靠的定位锚点。 */
  time?: number | null
}

/** bundle-entry 注入的 sessions 服务子集（client sessions 服务）。 */
export interface JumpSessionsLike {
  open?: (id: string) => void
  /** 打开健康的目录子代理（父地址必填；引擎拒绝直接 open 子会话）。 */
  openSubagent?: (address: { parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' }) => void
  /** 拉取某父会话的直接子代理目录（写入 sessions.list.subagentsByParent）。 */
  refreshSubagents?: (parentSessionId: string) => Promise<void>
  /** 刷新 Host 权威会话列表（判定子会话前补拉一次，防快照缺行）。 */
  refresh?: () => Promise<void>
  /** useSessions 标准 feed（current = 当前选中会话 id）。 */
  list?: { getSnapshot?: () => {
    current?: string
    phase?: string
    /** 引擎会话摘要（origin === 'subagent' 即子会话；子会话判定以此为准）。 */
    byId?: Record<string, { origin?: string; parentId?: string }>
    /** 直接目录快照，按父会话 id 索引；entries[].mode 即子会话打开方式。 */
    subagentsByParent?: Record<string, { state?: string; entries?: Array<{ kind?: string; id?: string; mode?: string }> }>
  } }
  /** 引擎会话事件窗口（借用已 retain 的 binding；判断目标 seq 是否在已加载窗口内）。 */
  binding?: (id: string) => unknown
}

/** bundle-entry 注入的 uiWorkspace 服务子集（0.2.x 官方「选中会话并展示对话」入口）。 */
export interface JumpUiWorkspaceLike {
  /** SessionId 或子代理地址；本插件传前者，或 {parentSessionId, childSessionId}。 */
  openSession?: (target: unknown) => void
}

/** jump 请求。 */
export interface JumpRequest {
  sessionId: string
  target: JumpTarget
  /** 目标会话是子代理会话（打开必须走 openSubagent 父地址）。 */
  child?: boolean
  /** 子代理会话的父会话 id；child === true 时必传，缺失则放弃打开（防引擎 loud-fail）。 */
  parentSessionId?: string | null
}

export interface JumpMessages {
  /** 目标会话不在引擎会话列表（刷新后仍未找到）。 */
  notInList: string
  /** 打开会话时引擎报错。 */
  openFailed: string
}

export interface JumpOptions {
  /** 会话切换被引擎确认后调用（关面板；已是目标会话时立即调用）。 */
  onClose?: () => void
  /** 降级/失败时的用户可见提示（面板内 notice 条；不传则保持静默）。 */
  onNotice?: (message: string) => void
  /** 提示文案（App 层按 locale 提供；缺省用英文兜底）。 */
  messages?: JumpMessages
  /** 0.2.x 客户端会话切换入口（ctx.uiWorkspace）；缺失时退回旧 sessions.open。 */
  uiWorkspace?: JumpUiWorkspaceLike
}

const DEFAULT_MESSAGES: JumpMessages = {
  notInList: 'Cannot jump: this session is not in the current session list (created elsewhere, archived, or deleted). The sidebar was refreshed but it was not found.',
  openFailed: 'Failed to open session: ',
}

const SCROLLER_SELECTOR = '[data-conversation-scroll]'
const TURN_ATTR = 'data-chat-turn'
/** 引擎 landOnRow 的阅读线偏移：行顶滚到距滚动口顶部 24px。 */
const READING_OFFSET = 24
/** 等待目标会话渲染的轮询间隔与上限。 */
const POLL_INTERVAL_MS = 100
const POLL_DEADLINE_MS = 6000
/** 目标行渲染后等待版式稳定（骨架屏/分页收敛）的时间片。 */
const SETTLE_MS = 200
/** 目标不在渲染窗口时按引擎事件窗口比例寻址：轮数上限与每步等待（含点「加载更早」拉历史）。 */
const SEEK_ROUNDS = 8
const SEEK_STEP_MS = 220
// 0.2.x 会话流是分页窗口：目标消息常常不在 DOM 里，需要反复点「加载更早」把它滚进窗口。
// 实测每次点击约多载 2~4k 字符历史，60 轮 ≈ 20 万字符；超出则放弃并保留「仅切换」。
const EARLIER_ROUNDS = 60
const EARLIER_STEP_MS = 350
const TEXT_PROBE_MS = 1200

/** 与引擎 flowTop 一致：行顶相对滚动口顶部的偏移。 */
function flowTop(row: HTMLElement, scrollport: HTMLElement): number {
  return row.getBoundingClientRect().top - scrollport.getBoundingClientRect().top
}

/** 滚动口：显式容器优先，回退最近可滚祖先（与引擎 scrollerOf 同思路）。 */
function scrollerOf(list: HTMLElement): HTMLElement | null {
  const explicit = document.querySelector<HTMLElement>(SCROLLER_SELECTOR)
  if (explicit !== null && explicit.contains(list)) return explicit
  let cursor: HTMLElement | null = list.parentElement
  while (cursor !== null) {
    const style = window.getComputedStyle(cursor)
    if (/(auto|scroll)/.test(style.overflowY) && cursor.scrollHeight > cursor.clientHeight) return cursor
    cursor = cursor.parentElement
  }
  return null
}

/** 消息列表根：最后一个 chat flow 的父容器。 */
function chatList(): HTMLElement | null {
  const flows = document.querySelectorAll<HTMLElement>('[data-chat-flow]')
  for (let i = flows.length - 1; i >= 0; i -= 1) {
    const flow = flows[i]
    if (flow.parentElement !== null) return flow.parentElement
  }
  return null
}

/**
 * 0.2.x 会话滚动口：per-turn 行契约（data-chat-flow / data-chat-turn / 轮次导航）已被
 * 引擎移除，改用 `data-conversation-session`（在滚动口的祖先内容容器上）认目标会话。
 */
function conversationScroller(sessionId: string): HTMLElement | null {
  let match: HTMLElement | null = null
  for (const scroller of document.querySelectorAll<HTMLElement>(SCROLLER_SELECTOR)) {
    const host = scroller.closest<HTMLElement>('[data-conversation-session]')
      ?? scroller.querySelector<HTMLElement>('[data-conversation-session]')
    const rendered = host?.getAttribute('data-conversation-session') ?? null
    if (rendered === sessionId) match = scroller
    else if (rendered === null && match === null) match = scroller
  }
  return match
}

/** 归一化文本（引擎渲染折叠连续空白，探针必须同样折叠才能命中）。 */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().toLowerCase()
}

/** 去掉探针里的 markdown 标点（渲染后的 DOM 文本不含这些字符）。 */
function plainProbe(probe: string): string {
  return probe.replace(/[*_`~#>|[\]]/g, '').replace(/\s+/g, ' ').trim()
}

/** 自顶向下找「最小包含探针」的元素：每层只进第一个命中的子节点。 */
function deepestMatch(root: HTMLElement, needle: string): HTMLElement | null {
  if (!normalizeText(root.textContent ?? '').includes(needle)) return null
  let current = root
  for (;;) {
    let next: HTMLElement | null = null
    for (const child of Array.from(current.children) as HTMLElement[]) {
      if (child.hasAttribute('hidden')) continue
      if (normalizeText(child.textContent ?? '').includes(needle)) { next = child; break }
    }
    if (next === null) return current
    current = next
  }
}

/** 0.2.x 定位：按命中片段在会话流里找目标节点（无 per-turn 行契约可用）。 */
function findRowByProbe(scroller: HTMLElement, probe?: string): HTMLElement | null {
  const raw = normalizeText(probe ?? '')
  if (raw.length < 4) return null
  for (const needle of [raw, normalizeText(plainProbe(probe ?? ''))]) {
    if (needle.length < 4) continue
    const hit = deepestMatch(scroller, needle)
    if (hit !== null && hit !== scroller) return hit
  }
  return null
}

/** 与引擎 landOnRow 同款落点 + 复用面板内的闪烁动画。 */
function landOnRow(row: HTMLElement, scroller: HTMLElement): void {
  scroller.scrollTop += flowTop(row, scroller) - READING_OFFSET
  row.classList.remove('sex-message-hit-flash')
  // 强制 reflow 后重挂动画，保证同一目标可重复触发
  void row.offsetWidth
  row.classList.add('sex-message-hit-flash')
}

/** 等待取到值的谓词（超时返回 null）。 */
function waitForValue<T>(read: () => T | null, deadlineMs: number): Promise<T | null> {
  const first = read()
  if (first !== null) return Promise.resolve(first)
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      const value = read()
      if (value !== null || Date.now() - started > deadlineMs) {
        window.clearInterval(timer)
        resolve(value)
      }
    }, POLL_INTERVAL_MS)
  })
}

/** 去掉片段首尾省略号，得到可用于文本探针的中段（导出供 TimelineView 复用）。 */
export function probeFromSnippet(snippet: string): string {
  // FTS 片段形如 `前文…命中…后文`：只剥首尾省略号会留下中间的省略号，
  // 探针于是横跨两段不连续文本，永远命中不了 DOM（「定位不对 / 找不到」的根因之一）。
  // 所以按省略号切开、取最长的一段；同时把正文里残留的 JSON 转义（\n、\t、\"）还原成真实字符。
  let best = ''
  for (const segment of snippet.split(/…|\.\.\./)) {
    const clean = segment
      .replace(/\\[nrt]/g, ' ')
      .replace(/\\"/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
    if (clean.length > best.length) best = clean
  }
  // 归一化空白：引擎渲染折叠连续空白，探针必须同样折叠才能命中
  const text = best.replace(/\s+/g, ' ').trim()
  // 探针要「足够长」：16 字的短探针在重复话术的会话里会命中别的消息（定位到错误的那条）。
  // 长的唯一性强，匹配侧再做「长 → 短」降级，兼顾 markdown/空白差异。
  const limit = 48
  if (text.length <= limit) return text
  const start = Math.max(0, Math.floor((text.length - limit) / 2))
  return text.slice(start, start + limit)
}

/** 目标轮次的全部已渲染行（按 DOM 顺序，跳过 hidden）。 */
function rowsOfTurn(list: HTMLElement, turn: number): HTMLElement[] {
  const rows: HTMLElement[] = []
  for (const row of list.querySelectorAll<HTMLElement>(`[${TURN_ATTR}]`)) {
    if (Number(row.getAttribute(TURN_ATTR)) === turn && !row.hasAttribute('hidden')) rows.push(row)
  }
  return rows
}

/**
 * 在行文本里校验探针（可选步骤：命中即确认行归属）。
 * 探针为空、或任何一行包含探针，都视为通过。
 */
function probeMatches(list: HTMLElement, turn: number, probe?: string): boolean {
  const needle = probe?.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!needle) return true
  return rowsOfTurn(list, turn).some((row) => row.textContent?.replace(/\s+/g, ' ').toLowerCase().includes(needle) ?? false)
}

/**
 * 原生 rail 的目标轮 mark：按 aria-label 解析轮次号
 * （zh：跳转到第 N 轮 / 加载并跳转到第 N 轮 / 第 N 轮；
 *   en：Jump to turn N / Load and jump to turn N / Turn N）。
 */
export function railMarkForTurn(turn: number, doc: Document = document): HTMLElement | null {
  const nav = doc.querySelector('nav[aria-label="轮次导航"], nav[aria-label="Turn navigation"]')
  if (nav === null) return null
  const marks = nav.querySelectorAll<HTMLElement>('button[type="button"]')
  const patterns: RegExp[] = [
    /(?:load and )?jump to turn\s*(\d+)|(?:加载并)?跳转到第\s*(\d+)\s*轮/i,
    /(?:^|\s)turn\s*(\d+)|(?:^|\s)第\s*(\d+)\s*轮/i,
  ]
  for (const pattern of patterns) {
    for (const mark of marks) {
      const label = mark.getAttribute('aria-label') ?? ''
      const match = pattern.exec(label)
      const value = match?.[1] ?? match?.[2]
      if (value !== undefined && Number(value) === turn) return mark
    }
  }
  return null
}

/**
 * 面板内定位：滚动详情列表到目标消息并闪烁高亮（不离开面板）。
 * TimelineView 命中 badge 用；返回是否找到了目标行。
 */
export function scrollToPanelMessage(list: HTMLElement, seq: number, probe?: string): boolean {
  const items = list.querySelectorAll<HTMLElement>('[data-mseq]')
  let row: HTMLElement | null = null
  for (const item of items) {
    if (Number(item.dataset.mseq) === seq) { row = item; break }
  }
  // seq 未命中（摘要被折叠/会话截断）：退化为文本探针匹配
  if (row === null) {
    const needle = probe?.trim().toLowerCase()
    if (needle) {
      for (const item of items) {
        if (item.textContent?.toLowerCase().includes(needle)) { row = item; break }
      }
    }
  }
  if (row === null) return false
  const scroller = list.closest<HTMLElement>('.sex-session-detail')
  if (scroller === null) return false
  const scrollerRect = scroller.getBoundingClientRect()
  const rowTop = row.getBoundingClientRect().top
  const sticky = scroller.querySelector<HTMLElement>('.sex-scroll-time-anchor')
  const top = scroller.scrollTop + rowTop - scrollerRect.top - (sticky !== null ? sticky.offsetHeight + 8 : 0)
  scroller.scrollTo({ top: Math.max(0, top), behavior: 'auto' })
  row.classList.remove('sex-message-hit-flash')
  // 强制 reflow 后重挂动画，保证同一目标可重复触发
  void row.offsetWidth
  row.classList.add('sex-message-hit-flash')
  return true
}

/** 等待谓词成立；超时返回 false。 */
function waitFor(predicate: () => boolean, deadlineMs: number): Promise<boolean> {
  if (predicate()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const started = Date.now()
    const timer = window.setInterval(() => {
      if (predicate() || Date.now() - started > deadlineMs) {
        window.clearInterval(timer)
        resolve(predicate())
      }
    }, POLL_INTERVAL_MS)
  })
}

/** 连续两帧矩形一致 → 版式稳定。 */
function rowSettled(row: HTMLElement): Promise<boolean> {
  let last = row.getBoundingClientRect()
  return waitFor(() => {
    const next = row.getBoundingClientRect()
    const stable = next.top === last.top && next.height === last.height
    last = next
    return stable
  }, SETTLE_MS)
}

/**
 * 切换到目标会话（自动路由主/子代理两种打开方式）。
 * 主会话：必须先确认 id 在引擎列表快照里再 open——引擎 manager.select 对
 * 列表外 id loud-throw（unknown session），刚启动/列表未拉完/会话已归档时
 * 直接 open 就是那颗雷。
 * 子会话判定以引擎 sessions.list 摘要为准（origin === 'subagent' 且 parentId 有值），
 * 不依赖插件 host 半（索引字段要重启才生效，引擎快照 client 即时可读）：
 * 引擎拒绝直接 open 子会话（session/agent-busy），必须 openSubagent(父地址)；
 * mode 从父会话的直接目录解析——快照里没有就先 refreshSubagents 拉一次再等投影，
 * 官方 ui-subagent 同款。目录拉不到 / 条目不健康 → 静默放弃（不赌，防 loud-fail）。
 * @returns 'switched' 已发出切换 | 'unknown' 会话不在引擎列表（刷新后仍缺）| 'unsupported' 无对应 API
 */
/** 引擎会话事件窗口（sessions.binding(id).eventSource.getSnapshot()）。 */
interface JumpEventWindow {
  entries: readonly unknown[]
  hasMore: boolean
}

function eventWindow(sessions: JumpSessionsLike, sessionId: string): JumpEventWindow | null {
  const binding = sessions.binding?.(sessionId) as { eventSource?: { getSnapshot?: () => unknown } } | undefined
  const snapshot = binding?.eventSource?.getSnapshot?.() as { entries?: unknown; hasMore?: unknown } | undefined
  const entries = snapshot?.entries
  if (!Array.isArray(entries)) return null
  return { entries, hasMore: snapshot?.hasMore === true }
}

/** 目标 seq 在事件窗口里的下标（-1 = 尚未加载）。 */
function seqIndexOf(entries: readonly unknown[], seq: number): number {
  return entries.findIndex((entry) => {
    const event = (entry as { event?: { seq?: unknown } } | null)?.event
    return typeof event?.seq === 'number' && event.seq === seq
  })
}

/** 「加载更早」控件的候选文案（跟随界面语言）。 */
const EARLIER_TEXTS = ['加载更早', '更早的消息', '显示更早', 'Load earlier', 'Load more', 'Earlier']

/** 引擎在会话流里渲染的绝对时间戳文案（中/英/ISO 三种常见形态都试一遍）。 */
function clockLabels(time: number): string[] {
  const date = new Date(time)
  const month = date.getMonth() + 1
  const day = date.getDate()
  const hh = String(date.getHours()).padStart(2, '0')
  const mm = String(date.getMinutes()).padStart(2, '0')
  return [
    month + '月' + day + '日 ' + hh + ':' + mm,
    month + '/' + day + ' ' + hh + ':' + mm,
  ]
}

/**
 * 按渲染出来的时间戳定位。会话流把旧轮次折叠成摘要行，正文不在 DOM 里（文本探针必然失败），
 * 但时间戳一定会渲染 —— 所以时间是最可靠的行锚点，文本探针只作为加严校验。
 */
function findByClock(scroller: HTMLElement, time: number | null | undefined): HTMLElement | null {
  if (typeof time !== 'number' || !Number.isFinite(time)) return null
  // 只认带日期的长文案（「M月D日 HH:MM」「M/D HH:MM」）。裸 HH:MM 在页面里到处都是（时钟、耗时、
  // 代码片段），而今天发的消息引擎又只渲染 HH:MM ⇒ 短文案没有区分力：宁可「不落点」也不落错位置。
  const long = clockLabels(time).slice(0, 2)
  const walk = (node: HTMLElement): HTMLElement | null => {
    for (const child of Array.from(node.children) as HTMLElement[]) {
      if (child.children.length === 0) {
        const text = (child.textContent ?? '').trim()
        if (long.some((label) => text === label || text.endsWith(label))) return child
        continue
      }
      const found = walk(child)
      if (found !== null) return found
    }
    return null
  }
  return walk(scroller)
}

/** 探针候选：长 → 短。长的唯一性强，短的抗 markdown/空白差异（长探针一个都不中时才降级）。 */
function probeCandidates(probe: string | undefined): string[] {
  if (probe === undefined) return []
  const raw = probe.replace(/\s+/g, ' ').trim()
  const plain = normalizeText(plainProbe(raw))
  const out: string[] = []
  for (const base of [raw, plain]) {
    if (base.length === 0) continue
    for (const size of [base.length, 40, 28, 16]) {
      if (size > base.length || size < 8) continue
      const piece = base.slice(0, size)
      if (!out.includes(piece)) out.push(piece)
    }
  }
  return out
}

/** 滚动口里所有含探针文本的叶子节点，按「离视口中心最近、且尽量在视口内」挑一个。 */
function nearestRowByProbe(scroller: HTMLElement, needle: string | undefined): HTMLElement | null {
  const candidates = probeCandidates(needle)
  if (candidates.length === 0) return null
  const box = scroller.getBoundingClientRect()
  const center = box.top + box.height / 2
  const leaves = Array.from(scroller.querySelectorAll<HTMLElement>('*')).filter(
    (el) => el.childElementCount === 0 && el.getClientRects().length > 0,
  )
  // 先用最长的探针找；同一长度里挑离视口中心最近的（虚拟列表会把远端的行留在 DOM 里，盒子只是占位值）。
  for (const candidate of candidates) {
    let best: HTMLElement | null = null
    let bestScore = Number.POSITIVE_INFINITY
    for (const el of leaves) {
      if (!(el.textContent ?? '').includes(candidate)) continue
      const rect = el.getBoundingClientRect()
      if (rect.bottom <= box.top || rect.top >= box.bottom) continue
      const score = Math.abs(rect.top + rect.height / 2 - center)
      if (score < bestScore) {
        bestScore = score
        best = el
      }
    }
    if (best !== null) return best
  }
  return null
}

/** 点「加载更早」，把更早的事件载入窗口（长会话只渲染末尾一屏）。 */
function clickLoadEarlier(): boolean {
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('button, [role="button"], a'))) {
    const text = (el.textContent ?? '').trim()
    if (text.length === 0 || text.length > 40) continue
    if (EARLIER_TEXTS.some((candidate) => text.includes(candidate))) {
      el.click()
      return true
    }
  }
  return false
}

async function switchSession(sessions: JumpSessionsLike, request: JumpRequest, ui?: JumpUiWorkspaceLike): Promise<'switched' | 'unknown' | 'unsupported'> {
  const { sessionId } = request
  // 0.2.x 客户端：官方会话切换入口是 ctx.uiWorkspace.openSession(SessionId | SubagentAddress)；
  // 旧 sessions.open/openSubagent 在 0.2.0-rc.2 已不存在（缺失时下面的旧路径会静默降级）。
  if (typeof ui?.openSession === 'function') {
    const target = request.child === true && request.parentSessionId != null && request.parentSessionId !== ''
      ? { parentSessionId: request.parentSessionId, childSessionId: sessionId }
      : sessionId
    try {
      ui.openSession(target)
      return 'switched'
    } catch { /* 官方入口拒绝 → 继续走旧路径判定 */ }
  }
  const snapshot = (): { byId?: Record<string, { origin?: string; parentId?: string }>; subagentsByParent?: Record<string, { state?: string; entries?: Array<{ kind?: string; id?: string; mode?: string }> }> } =>
    sessions.list?.getSnapshot?.() ?? {}
  const parentOf = (id: string): string | undefined => {
    // 1) 引擎摘要（主会话行 + 当前寻址的子代理路由）
    const summary = snapshot().byId?.[id]
    if (summary?.origin === 'subagent' && typeof summary.parentId === 'string' && summary.parentId.length > 0) {
      return summary.parentId
    }
    // 2) 已拉取过的父目录快照反查（byId 不含未打开过的子会话）
    for (const [parentId, catalog] of Object.entries(snapshot().subagentsByParent ?? {})) {
      if ((catalog?.entries ?? []).some((item) => item?.id === id)) return parentId
    }
    return undefined
  }
  const requestParent = request.child === true && request.parentSessionId != null && request.parentSessionId !== ''
    ? request.parentSessionId
    : undefined

  // 列表未含该 id（或快照 phase 还在 pending）→ 先 refresh 再等它出现
  const known = (): boolean => snapshot().byId?.[sessionId] !== undefined || parentOf(sessionId) !== undefined || requestParent !== undefined
  if (!known() && typeof sessions.refresh === 'function') {
    try { await sessions.refresh() } catch { /* refresh 失败 → 继续走 known 判定 */ }
    if (!known()) await waitFor(known, 4000)
  }
  const parentSessionId = parentOf(sessionId) ?? requestParent

  if (parentSessionId === undefined) {
    // 引擎列表里确认没有（刷新+等待后仍缺）→ 不赌 open（引擎会 loud-throw）
    if (!known() && sessions.list?.getSnapshot?.()?.byId?.[sessionId] === undefined) return 'unknown'
    if (typeof sessions.open !== 'function') return 'unsupported'
    sessions.open(sessionId)
    return 'switched'
  }
  if (typeof sessions.openSubagent !== 'function') return 'unsupported'
  const readEntry = (): { mode: string } | undefined => {
    const catalog = snapshot().subagentsByParent?.[parentSessionId]
    const entry = (catalog?.entries ?? []).find(
      (item) => item?.kind === 'child' && item?.id === sessionId && (item?.mode === 'one-shot' || item?.mode === 'continuable'),
    )
    return entry !== undefined ? { mode: entry.mode } : undefined
  }

  // 快照里已有目录 → 直接用；否则拉一次目录再等快照投影更新
  let entry = readEntry()
  if (entry === undefined && typeof sessions.refreshSubagents === 'function') {
    try { await sessions.refreshSubagents(parentSessionId) } catch { return 'unknown' }
    const resolved = await waitFor(() => readEntry() !== undefined, 3000)
    entry = resolved ? readEntry() : undefined
  }
  if (entry === undefined) return 'unknown'
  sessions.openSubagent({ parentSessionId, childSessionId: sessionId, mode: entry.mode as 'one-shot' | 'continuable' })
  return 'switched'
}

/**
 * 打开原会话并尽量定位到目标消息。永不 reject——失败转为 'failed' 并通过
 * onNotice 给出可见提示（App 层渲染面板内 notice 条；面板保持打开）。
 * @returns 'scrolled' 直接滚动定位 | 'rail' 借 rail 分页跳转 | 'opened' 仅切换
 *   | 'failed' 打开失败（未切换，面板未关）
 */
/**
 * 临时诊断（验证完删除）：把定位结果上报给 host，host 写进 `%TEMP%\se-probe.log`。
 * 首选 `bundle-entry` 注入的引擎 RPC 上报器（与搜索同一条通道，已证实可用）；
 * 未注入时退回裸 fetch，用来对照两条通道各自是否通。
 */
export type JumpReporter = (report: { stage: string; sessionId: string; seq?: number; probe?: string; detail?: string }) => void

let jumpReporter: JumpReporter | null = null

/** 由 bundle-entry 注入引擎 RPC 上报器。 */
export function setJumpReporter(next: JumpReporter | null): void {
  jumpReporter = next
}

/** 裸 fetch 上报（诊断对照用）。 */
export function reportJumpFetch(stage: string, sessionId: string, extra?: { seq?: number; probe?: string; detail?: string }): void {
  try {
    void fetch('/dsh-session-explorer/jumpReport', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        rpcId: 'jump-' + Date.now().toString(36),
        method: 'jumpReport',
        payload: { stage, sessionId, ...extra },
      }),
    }).catch(() => undefined)
  } catch {
    // 诊断失败不影响定位
  }
}

export function reportJump(stage: string, sessionId: string, extra?: { seq?: number; probe?: string; detail?: string }): void {
  if (jumpReporter !== null) {
    try {
      jumpReporter({ stage, sessionId, ...extra })
      return
    } catch {
      // 落到裸 fetch
    }
  }
  reportJumpFetch(stage, sessionId, extra)
}

/** 定位失败时的现场快照：滚动口数量、已渲染会话 id、命中文本是否在 DOM 里。 */
function jumpDiagnostics(probe: string): string {
  try {
    const scrollers = document.querySelectorAll('[data-conversation-scroll]').length
    const sessions = [...document.querySelectorAll('[data-conversation-session]')]
      .map((node) => node.getAttribute('data-conversation-session') ?? '?')
      .slice(0, 4)
      .join(',')
    const text = document.body?.innerText ?? ''
    return (
      'scrollers=' + String(scrollers) +
      ' sessions=' + sessions +
      ' bodyChars=' + String(text.length) +
      ' probeInBody=' + String(probe.length >= 4 && text.includes(probe))
    )
  } catch (error) {
    return 'diagnostics failed: ' + (error instanceof Error ? error.message : String(error))
  }
}

export async function jumpToSession(
  sessions: JumpSessionsLike,
  request: JumpRequest,
  options: JumpOptions = {},
): Promise<'scrolled' | 'rail' | 'opened' | 'failed'> {
  const { sessionId, target } = request
  const messages = options.messages ?? DEFAULT_MESSAGES
  const notice = (message: string): 'failed' => {
    options.onNotice?.(message)
    return 'failed'
  }
  // 0.2.x 客户端 sessions 服务没有 list feed（只有 retain/search/fork/…）：
  // 拿不到 current 时不等待选中投影，直接交给下面的 DOM 就绪探针判定。
  const snapshotOf = sessions?.list?.getSnapshot
  const canTrackCurrent = typeof snapshotOf === 'function'
  const currentOf = (): string | undefined => (canTrackCurrent ? snapshotOf?.()?.current : undefined)
  const wasOnSession = canTrackCurrent && currentOf() === sessionId

  let switched: 'switched' | 'unknown' | 'unsupported'
  try {
    switched = await switchSession(sessions, request, options.uiWorkspace)
  } catch (error) {
    // 引擎仍有未知 loud-fail（契约变化）：接住并可见提示，不让 unhandled rejection 静默飞
    reportJump('switch-threw', sessionId, { probe: target.probe, detail: error instanceof Error ? error.message : String(error) })
    return notice(messages.openFailed + (error instanceof Error ? error.message : String(error)))
  }
  if (switched === 'unknown') {
    reportJump('switch-unknown', sessionId, { probe: target.probe, detail: jumpDiagnostics(target.probe ?? '') })
    return notice(messages.notInList)
  }
  if (switched === 'unsupported') {
    reportJump('switch-unsupported', sessionId, { probe: target.probe })
    return 'failed'
  }
  // 切换请求已被引擎接受（或已是目标会话）→ 现在才关面板
  options.onClose?.()

  // 0.2.x 主路径：引擎已移除 per-turn 行契约（data-chat-flow / data-chat-turn / 轮次导航）。
  // 定位一律优先按 seq（文本片段会被引用/摘要里的同文命中，不可靠），不可用才退回文本探针。
  {
    const scroller = await waitForValue(() => conversationScroller(sessionId), POLL_DEADLINE_MS)
    if (scroller === null) {
      reportJump('no-scroller', sessionId, { probe: target.probe, detail: jumpDiagnostics(target.probe ?? '') })
      return 'opened'
    }
    // 1) 按引擎事件窗口里的 seq 位置寻址（虚拟列表近似线性），必要时先点「加载更早」。
    for (let round = 0; round < SEEK_ROUNDS; round += 1) {
      const win = eventWindow(sessions, sessionId)
      if (win === null) break
      const index = seqIndexOf(win.entries, target.seq)
      if (index < 0) {
        if (!win.hasMore) {
          reportJump('seek-no-seq', sessionId, { probe: target.probe, seq: target.seq, detail: 'entries=' + String(win.entries.length) + ' hasMore=false' })
          break
        }
        const clicked = clickLoadEarlier()
        reportJump('seek-load-earlier', sessionId, {
          probe: target.probe,
          seq: target.seq,
          detail: 'round=' + String(round) + ' clicked=' + String(clicked) + ' entries=' + String(win.entries.length),
        })
        scroller.scrollTop = 0
        await new Promise((resolve) => setTimeout(resolve, SEEK_STEP_MS))
        continue
      }
      const span = Math.max(1, scroller.scrollHeight - scroller.clientHeight)
      const base = Math.round((index / Math.max(1, win.entries.length)) * span)
      for (const offset of [0, -1, 1, -2, 2, -3, 3]) {
        scroller.scrollTop = Math.max(0, base + offset * Math.round(scroller.clientHeight * 0.6))
        await new Promise((resolve) => setTimeout(resolve, SEEK_STEP_MS))
        const clockRow = findByClock(scroller, target.time)
        if (clockRow !== null) {
          await rowSettled(clockRow)
          landOnRow(clockRow, scroller)
          reportJump('scrolled-clock', sessionId, {
            probe: target.probe,
            seq: target.seq,
            detail: 'round=' + String(round) + ' idx=' + String(index) + '/' + String(win.entries.length) + ' off=' + String(offset) + ' top=' + String(Math.round(scroller.scrollTop)) + ' ' + jumpDiagnostics(target.probe ?? ''),
          })
          return 'scrolled'
        }
        const row = nearestRowByProbe(scroller, target.probe)
        if (row !== null) {
          await rowSettled(row)
          landOnRow(row, scroller)
          reportJump('scrolled-seek', sessionId, {
            probe: target.probe,
            seq: target.seq,
            detail: 'round=' + String(round) + ' idx=' + String(index) + '/' + String(win.entries.length) + ' off=' + String(offset) + ' top=' + String(Math.round(scroller.scrollTop)) + ' ' + jumpDiagnostics(target.probe ?? ''),
          })
          return 'scrolled'
        }
      }
      reportJump('seek-miss', sessionId, {
        probe: target.probe,
        seq: target.seq,
        detail: 'round=' + String(round) + ' idx=' + String(index) + '/' + String(win.entries.length) + ' hasMore=' + String(win.hasMore) + ' span=' + String(span) + ' ' + jumpDiagnostics(target.probe ?? ''),
      })
      if (!win.hasMore) break
      scroller.scrollTop = 0
      await new Promise((resolve) => setTimeout(resolve, SEEK_STEP_MS))
    }
    // 2) 引擎窗口不可用（无 binding / 无 seq）→ 文本探针 + 反复「加载更早」把目标滚进渲染窗口
    const findAnywhere = (): HTMLElement | null => {
      for (const needle of probeCandidates(target.probe)) {
        const hit = findRowByProbe(scroller, needle)
        if (hit !== null) return hit
      }
      return null
    }
    // 有目标时间戳时只认时间戳锚点：文本探针（snippet 中段）在重复话术会话里会命中别的消息，
    // 把「没找到」伪装成「定位成功」（用户看到的「停在底部」就是这么来的）。
    const anchorOnly = typeof target.time === 'number' && Number.isFinite(target.time)
    let row = await waitForValue(() => findByClock(scroller, target.time) ?? (anchorOnly ? null : findAnywhere()), TEXT_PROBE_MS)
    for (let round = 0; row === null && round < EARLIER_ROUNDS; round += 1) {
      if (!clickLoadEarlier()) {
        reportJump('earlier-exhausted', sessionId, {
          probe: target.probe,
          seq: target.seq,
          detail: 'round=' + String(round) + ' ' + jumpDiagnostics(target.probe ?? ''),
        })
        break
      }
      await new Promise((resolve) => setTimeout(resolve, EARLIER_STEP_MS))
      row = findByClock(scroller, target.time) ?? (anchorOnly ? null : findAnywhere())
      if (round % 5 === 4) {
        reportJump('earlier-round', sessionId, {
          probe: target.probe,
          seq: target.seq,
          detail: 'round=' + String(round + 1) + ' ' + jumpDiagnostics(target.probe ?? ''),
        })
      }
    }
    if (row !== null) {
      await rowSettled(row)
      landOnRow(row, scroller)
      reportJump('scrolled-text', sessionId, {
        probe: target.probe,
        detail: 'top=' + String(Math.round(scroller.scrollTop)) + ' ' + jumpDiagnostics(target.probe ?? ''),
      })
      return 'scrolled'
    }
    reportJump('probe-miss', sessionId, { probe: target.probe, seq: target.seq, detail: jumpDiagnostics(target.probe ?? '') })
  }

  // 0.2.x 客户端没有 sessions.list feed（canTrackCurrent=false）：旧 per-turn 兜底永远等不到
  // 选中投影，只会白等 6 秒再报 not-selected。直接按「仅切换」返回。
  if (!canTrackCurrent) {
    reportJump('legacy-skipped', sessionId, { probe: target.probe })
    return 'opened'
  }

  // 旧契约兜底（0.1.x）：目标轮次号不可用 → 没有可定位凭据，保持旧「仅切换」行为
  const turn = target.turn
  if (turn === null || !Number.isSafeInteger(turn) || turn < 0) {
    reportJump('no-turn', sessionId, { probe: target.probe })
    return 'opened'
  }

  // 等待目标会话成为当前会话（sessions 服务同步更新；已是目标会话则跳过）
  if (!wasOnSession && canTrackCurrent) {
    const selected = await waitFor(() => currentOf() === sessionId, POLL_DEADLINE_MS)
    if (!selected) {
      reportJump('not-selected', sessionId, { probe: target.probe })
      return 'opened'
    }
  }

  // 等待新会话聊天流就绪：目标行已渲染，或原生 rail 已挂载（长会话分页态）。
  // 轮询避免单帧误判（React 提交/历史加载时序不定，旧 DOM 残留一瞬同理）。
  const ready = waitFor(() => {
    const list = chatList()
    if (list === null) return false
    return rowsOfTurn(list, turn).length > 0 || railMarkForTurn(turn) !== null
  }, POLL_DEADLINE_MS)
  if (!(await ready)) {
    reportJump('not-ready', sessionId, { probe: target.probe, detail: jumpDiagnostics(target.probe ?? '') })
    return 'opened'
  }
  const list = chatList()
  if (list === null) {
    reportJump('no-chatlist', sessionId, { probe: target.probe })
    return 'opened'
  }

  // 1) 目标行已渲染 → 与引擎 landOnRow 同款滚动（探针校验行归属，防旧 DOM 误配）
  const rows = rowsOfTurn(list, turn)
  if (rows.length > 0 && probeMatches(list, turn, target.probe)) {
    const el = scrollerOf(list)
    if (el !== null) {
      await rowSettled(rows[0])
      // 同 turn 多行时，优先滚到探针命中的那一行（轮中部的工具/回复消息），
      // 探针为空或全轮无命中才退回轮首（原生 rail 的落点口径）。
      let targetRow = rows[0]
      const needle = target.probe?.replace(/\s+/g, ' ').trim().toLowerCase()
      if (needle) {
        const hit = rows.find((row) => row.textContent?.replace(/\s+/g, ' ').toLowerCase().includes(needle))
        if (hit !== undefined) targetRow = hit
      }
      el.scrollTop += flowTop(targetRow, el) - READING_OFFSET
      reportJump('scrolled-legacy', sessionId, { probe: target.probe })
      return 'scrolled'
    }
  }

  // 2) 未渲染 → 模拟点击原生 rail 对应 mark，借引擎 loadThrough 分页
  const mark = railMarkForTurn(turn)
  if (mark !== null) {
    mark.click()
    reportJump('rail', sessionId, { probe: target.probe })
    return 'rail'
  }

  // 3) 契约缺失 → 仅切换会话
  reportJump('opened-final', sessionId, { probe: target.probe, detail: jumpDiagnostics(target.probe ?? '') })
  return 'opened'
}
