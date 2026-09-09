/**
 * test/jump.test.ts —— jump 纯函数单测（probeFromSnippet / railMarkForTurn）。
 * DOM 依赖部分用最小 stub 模拟，不引入 jsdom。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { probeFromSnippet, railMarkForTurn, jumpToSession } from '../src/client/jump.js'

// ── probeFromSnippet ────────────────────────────────────────

test('probeFromSnippet: strips leading/trailing ellipses', () => {
  assert.equal(probeFromSnippet('…hello world'), 'hello world')
  assert.equal(probeFromSnippet('hello world…'), 'hello world')
  assert.equal(probeFromSnippet('…hello world…'), 'hello world')
})

test('probeFromSnippet: keeps short text as-is', () => {
  assert.equal(probeFromSnippet('短文本'), '短文本')
  assert.equal(probeFromSnippet('abcdefghij1234567890abcd'), 'abcdefghij1234567890abcd') // 恰好 24 字符
})

test('probeFromSnippet: extracts middle slice for long text', () => {
  const text = 'A'.repeat(30) + 'needle' + 'B'.repeat(30)
  assert.equal(probeFromSnippet(text), text.slice(4, 20))
})

test('probeFromSnippet: empty string stays empty', () => {
  assert.equal(probeFromSnippet(''), '')
  assert.equal(probeFromSnippet('…'), '')
})

// ── railMarkForTurn（stub DOM，中文/英文 aria-label + 轮次号解析） ──

interface FakeMark { attrs: Record<string, string>; clicked: number }

function makeDocWithMarks(marks: FakeMark[]): {
  doc: Document
  clickedMarks: FakeMark[]
} {
  const clickedMarks: FakeMark[] = []
  const elements: Array<{ getAttribute: (name: string) => string | null; click: () => void; mark: FakeMark }> = []
  for (const mark of marks) {
    const el = {
      getAttribute: (name: string) => mark.attrs[name] ?? null,
      click: () => { mark.clicked += 1; clickedMarks.push(mark) },
      mark,
    }
    elements.push(el)
  }
  const nav = {
    querySelectorAll: () => elements,
  }
  const doc = {
    querySelector: (selector: string) => {
      if (selector.includes('nav[')) return nav
      return null
    },
  } as unknown as Document
  return { doc, clickedMarks }
}

test('railMarkForTurn: matches zh loaded-turn label', () => {
  const { doc, clickedMarks } = makeDocWithMarks([
    { attrs: { 'aria-label': '跳转到第 3 轮' }, clicked: 0 },
  ])
  const mark = railMarkForTurn(3, doc)
  assert.ok(mark !== null)
  mark.click()
  assert.equal(clickedMarks.length, 1)
})

test('railMarkForTurn: matches zh unloaded-turn label', () => {
  const { doc } = makeDocWithMarks([
    { attrs: { 'aria-label': '加载并跳转到第 7 轮' }, clicked: 0 },
  ])
  assert.ok(railMarkForTurn(7, doc) !== null)
})

test('railMarkForTurn: matches en labels', () => {
  const { doc } = makeDocWithMarks([
    { attrs: { 'aria-label': 'Jump to turn 5' }, clicked: 0 },
    { attrs: { 'aria-label': 'Load and jump to turn 9' }, clicked: 0 },
  ])
  assert.ok(railMarkForTurn(5, doc) !== null)
  assert.ok(railMarkForTurn(9, doc) !== null)
})

test('railMarkForTurn: no match returns null (turn not on rail)', () => {
  const { doc } = makeDocWithMarks([
    { attrs: { 'aria-label': '跳转到第 1 轮' }, clicked: 0 },
    { attrs: { 'aria-label': '跳转到第 2 轮' }, clicked: 0 },
  ])
  assert.equal(railMarkForTurn(42, doc), null)
})

test('railMarkForTurn: missing nav returns null', () => {
  const doc = { querySelector: () => null } as unknown as Document
  assert.equal(railMarkForTurn(1, doc), null)
})

test('railMarkForTurn: does not confuse turn 2 with turn 21', () => {
  const { doc } = makeDocWithMarks([
    { attrs: { 'aria-label': '跳转到第 21 轮' }, clicked: 0 },
  ])
  // 精确匹配 2 不应命中 21
  assert.equal(railMarkForTurn(2, doc), null)
  assert.ok(railMarkForTurn(21, doc) !== null)
})

// ── jumpToSession：会话路由守卫（unknown 分支不赌 open） ─────────

/** 构造最小 sessions 服务 stub。 */
function makeSessions(opts: { byId?: Record<string, unknown>; refresh?: boolean } = {}): {
  sessions: Record<string, unknown>
  calls: string[]
} {
  const calls: string[] = []
  const sessions = {
    open: (id: string) => { calls.push('open:' + id) },
    refresh: opts.refresh === true ? async () => {} : undefined,
    list: { getSnapshot: () => ({ current: undefined, byId: opts.byId ?? {} }) },
  }
  return { sessions, calls }
}

test('jumpToSession: session missing from list → failed + notice, open() NOT called', async () => {
  const { sessions, calls } = makeSessions({ byId: {} })
  const notices: string[] = []
  const result = await jumpToSession(sessions as never, {
    sessionId: 'ghost-1',
    target: { seq: 1, turn: 1 },
  }, { onNotice: (m) => notices.push(m), messages: { notInList: 'NOT_IN_LIST', openFailed: 'OPEN_FAILED' } })
  assert.equal(result, 'failed')
  assert.equal(calls.length, 0, 'must not call open() for unknown session (engine loud-throws)')
  assert.ok(notices[0]?.includes('NOT_IN_LIST'))
})

test('jumpToSession: session in list → open() called + onClose fires', async () => {
  const { sessions, calls } = makeSessions({ byId: { 's-1': {} } })
  let closed = false
  const result = await jumpToSession(sessions as never, {
    sessionId: 's-1',
    target: { seq: 1, turn: null },
  }, { onClose: () => { closed = true } })
  assert.equal(result, 'opened')
  assert.deepEqual(calls, ['open:s-1'])
  assert.equal(closed, true)
})

test('jumpToSession: engine open() throws → failed + openFailed notice (no unhandled rejection)', async () => {
  const sessions = {
    open: () => { throw new Error('sessions.select: unknown session x') },
    list: { getSnapshot: () => ({ current: undefined, byId: { 's-1': {} } }) },
  }
  const notices: string[] = []
  const result = await jumpToSession(sessions as never, {
    sessionId: 's-1',
    target: { seq: 1, turn: null },
  }, { onNotice: (m) => notices.push(m), messages: { notInList: 'NOT_IN_LIST', openFailed: 'OPEN_FAILED' } })
  assert.equal(result, 'failed')
  assert.ok(notices[0]?.includes('OPEN_FAILED'))
  assert.ok(notices[0]?.includes('unknown session'))
})
