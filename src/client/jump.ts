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

/** 去掉片段首尾省略号，得到可用于文本探针的中段（导出供 TimelineView 复用）。 */
export function probeFromSnippet(snippet: string): string {
  let text = snippet.trim()
  if (text.startsWith('…')) text = text.slice(1)
  if (text.endsWith('…')) text = text.slice(0, -1)
  // 归一化空白：引擎渲染折叠连续空白，探针必须同样折叠才能命中
  text = text.replace(/\s+/g, ' ').trim()
  // 探针取中段且足够短，避免跨行空白差异导致匹配失败
  return text.length > 24 ? text.slice(4, 20) : text
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
async function switchSession(sessions: JumpSessionsLike, request: JumpRequest): Promise<'switched' | 'unknown' | 'unsupported'> {
  const { sessionId } = request
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
  const currentOf = (): string | undefined => sessions?.list?.getSnapshot?.()?.current
  const wasOnSession = currentOf() === sessionId

  let switched: 'switched' | 'unknown' | 'unsupported'
  try {
    switched = await switchSession(sessions, request)
  } catch (error) {
    // 引擎仍有未知 loud-fail（契约变化）：接住并可见提示，不让 unhandled rejection 静默飞
    return notice(messages.openFailed + (error instanceof Error ? error.message : String(error)))
  }
  if (switched === 'unknown') return notice(messages.notInList)
  if (switched === 'unsupported') return 'failed'
  // 切换请求已被引擎接受（或已是目标会话）→ 现在才关面板
  options.onClose?.()

  // 目标轮次号不可用 → 没有可定位凭据，保持旧「仅切换」行为
  const turn = target.turn
  if (turn === null || !Number.isSafeInteger(turn) || turn < 0) return 'opened'

  // 等待目标会话成为当前会话（sessions 服务同步更新；已是目标会话则跳过）
  if (!wasOnSession) {
    const selected = await waitFor(() => currentOf() === sessionId, POLL_DEADLINE_MS)
    if (!selected) return 'opened'
  }

  // 等待新会话聊天流就绪：目标行已渲染，或原生 rail 已挂载（长会话分页态）。
  // 轮询避免单帧误判（React 提交/历史加载时序不定，旧 DOM 残留一瞬同理）。
  const ready = waitFor(() => {
    const list = chatList()
    if (list === null) return false
    return rowsOfTurn(list, turn).length > 0 || railMarkForTurn(turn) !== null
  }, POLL_DEADLINE_MS)
  if (!(await ready)) return 'opened'
  const list = chatList()
  if (list === null) return 'opened'

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
      return 'scrolled'
    }
  }

  // 2) 未渲染 → 模拟点击原生 rail 对应 mark，借引擎 loadThrough 分页
  const mark = railMarkForTurn(turn)
  if (mark !== null) {
    mark.click()
    return 'rail'
  }

  // 3) 契约缺失 → 仅切换会话
  return 'opened'
}
