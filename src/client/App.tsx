/**
 * client/App.tsx —— 主面板：搜索 / 时间线 / 预览 三视图切换 + 索引状态。
 */

import { useState, useEffect, useCallback, createElement } from 'react'
import type { ExplorerClient, PanelStore } from './store.js'
import { envelopeError, usePanelStore } from './store.js'
import { SearchView } from './views/SearchView.js'
import { TimelineView } from './views/TimelineView.js'
import { PreviewView } from './views/PreviewView.js'
import { jumpToSession, probeFromSnippet, reportJump, type JumpSessionsLike, type JumpUiWorkspaceLike } from './jump.js'
import type { IndexStatus, MessageHit, TimelineNode, TimelineTurnsResponse } from '../protocol.js'
import { useI18n, type LocaleServiceLike } from './i18n.js'

export interface AppProps {
  client: ExplorerClient
  store: PanelStore
  /** 打开真实会话（由 bundle-entry 注入）。 */
  onOpenSession: (sessionId: string) => void
  /** bundle-entry 注入的 sessions 服务（带锚点跳原会话用）。 */
  sessions?: JumpSessionsLike
  /** bundle-entry 注入的 uiWorkspace 服务（0.2.x 官方会话切换入口）。 */
  uiWorkspace?: JumpUiWorkspaceLike
  onClose: () => void
  /** DSH 平台 Tooltip 组件（由 bundle-entry 从 primitives seed 注入）。 */
  Tooltip?: unknown
  /** DSH Host locale 服务（由 bundle-entry 注入；缺省回退 navigator.language）。 */
  locale?: LocaleServiceLike
}

type View =
  | { name: 'search' }
  | { name: 'timeline' }
  | { name: 'preview'; sessionId: string; seq: number }

export function App({ client, store, onOpenSession, sessions, uiWorkspace, onClose, Tooltip, locale }: AppProps) {
  const panel = usePanelStore(store)
  const { t } = useI18n(locale)
  const [view, setView] = useState<View>({ name: 'search' })
  const [timeline, setTimeline] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; nodes: TimelineNode[]; error: string | null }>({ status: 'idle', nodes: [], error: null })
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  const [turns, setTurns] = useState<{ status: 'idle' | 'loading' | 'ready' | 'error'; data: TimelineTurnsResponse | null; error: string | null }>({ status: 'idle', data: null, error: null })
  const [indexStatus, setIndexStatus] = useState<IndexStatus | null>(null)
  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildResult, setRebuildResult] = useState<string | null>(null)
  const [rebuildDialog, setRebuildDialog] = useState<{ open: boolean; health: { healthy: boolean; problems: string[] } | null; checking: boolean; mode: 'incremental' | 'full' }>({ open: false, health: null, checking: false, mode: 'incremental' })

  const loadTimeline = useCallback(async (options: Record<string, unknown> = {}) => {
    setTimeline({ status: 'loading', nodes: [], error: null })
    try {
      const res = await client.timeline({ ...options, limit: 500 })
      if (!res.ok) {
        setTimeline({ status: 'error', nodes: [], error: envelopeError(res) || 'timeline failed' })
        return
      }
      setTimeline({ status: 'ready', nodes: res.value ?? [], error: null })
    } catch (error) {
      setTimeline({ status: 'error', nodes: [], error: String(error) })
    }
  }, [client])

  const loadTurns = useCallback(async (sessionId: string) => {
    setSelectedSessionId(sessionId)
    // 空串 = 折叠详情（再次点击同一卡片），不发 RPC
    if (sessionId === '') {
      setTurns({ status: 'idle', data: null, error: null })
      return
    }
    setTurns({ status: 'loading', data: null, error: null })
    try {
      const res = await client.turns(sessionId, 300)
      if (!res.ok) {
        setTurns({ status: 'error', data: null, error: envelopeError(res) || 'turns failed' })
        return
      }
      setTurns({ status: 'ready', data: res.value ?? null, error: null })
    } catch (error) {
      setTurns({ status: 'error', data: null, error: String(error) })
    }
  }, [client])

  const loadIndexStatus = useCallback(async () => {
    try {
      const res = await client.indexStatus()
      if (res.ok && res.value) setIndexStatus(res.value)
    } catch { /* 非关键 */ }
  }, [client])

  useEffect(() => {
    if (!panel.open) return
    void (async () => {
      // 面板打开时同步一次（live 会话最新消息 + 未索引新会话），再刷新状态
      try { await client.sync() } catch { /* 非关键 */ }
      await loadIndexStatus()
    })()
  }, [panel.open, loadIndexStatus, client])

  const doRebuild = useCallback(async (mode: 'incremental' | 'full') => {
    setRebuildDialog((d) => ({ ...d, open: false }))
    setRebuilding(true)
    setRebuildResult(null)
    try {
      const res = await client.rebuild(mode)
      if (res.ok) {
        const r = res.value
        const parts: string[] = []
        if (r) {
          if (mode === 'incremental') {
            parts.push(
              t('addedCount', { n: r.added ?? 0 }),
              t('removedCount', { n: r.removed ?? 0 }),
              t('refreshedCount', { n: r.refreshed ?? 0 }),
              t('skippedCount', { n: r.skipped ?? 0 }),
            )
          }
          parts.push(t('succeededCount', { n: r.succeeded ?? 0 }), t('failedCount', { n: r.failed ?? 0 }))
          const firstFailure = r.failures?.[0]?.error
          if (r.failed > 0) parts.push(t('firstFailure', { msg: firstFailure ?? t('unknownError') }))
        }
        setRebuildResult((mode === 'incremental' ? t('rebuildDoneIncremental') : t('rebuildDoneFull')) + parts.join(t('seqSep')))
      } else {
        setRebuildResult(t('rebuildFailed') + (envelopeError(res) || t('unknownError')))
      }
      await loadTimeline()
      await loadIndexStatus()
    } catch (error) {
      setRebuildResult(t('rebuildFailed') + String(error))
    } finally {
      setRebuilding(false)
    }
  }, [client, loadTimeline, loadIndexStatus, t])

  // 打开重建 dialog：先做健康检查
  const openRebuildDialog = useCallback(() => {
    setRebuildDialog({ open: true, health: null, checking: true, mode: 'incremental' })
    void (async () => {
      try {
        const res = await client.healthCheck()
        if (res.ok && res.value) {
          const health = res.value
          setRebuildDialog((d) => ({ ...d, checking: false, health, mode: health.healthy ? 'incremental' : 'full' }))
        } else {
          setRebuildDialog((d) => ({ ...d, checking: false, health: { healthy: false, problems: [envelopeError(res) || t('healthCheckFailed')] }, mode: 'full' }))
        }
      } catch (error) {
        setRebuildDialog((d) => ({ ...d, checking: false, health: { healthy: false, problems: [String(error)] }, mode: 'full' }))
      }
    })()
  }, [client, t])

  const openTimeline = useCallback(() => {
    setView({ name: 'timeline' })
    void loadTimeline()
  }, [loadTimeline])

  const openPreview = useCallback((sessionId: string, seq: number | null) => {
    // 时间线节点点击没有 seq → 用 0 占位不生效？时间线预览改为会话级概览：
    // 这里统一把无 seq 视为 preview(null)，由 App 处理。
    if (seq === null) {
      // 无 seq：直接跳真实会话更符合预期
      onOpenSession(sessionId)
      return
    }
    setView({ name: 'preview', sessionId, seq })
  }, [onOpenSession])

  const openPreviewFromHit = useCallback((hit: MessageHit) => {
    setView({ name: 'preview', sessionId: hit.sessionId, seq: hit.seq })
  }, [])

  /** 跳转失败/降级的面板内可见提示（成功则面板关闭，用户直接落到会话）。 */
  const [jumpNotice, setJumpNotice] = useState<string | null>(null)
  const clearJumpNotice = useCallback(() => { setJumpNotice(null) }, [])

  /** 带锚点跳原会话：切换会话并尽量定位到命中消息（主/子代理自动路由）。 */
  const openSessionAt = useCallback((hit: { sessionId: string; seq: number; turn: number | null; snippet: string; child?: boolean; parentSessionId?: string | null }) => {
    setJumpNotice(null)
    reportJump('click-openSessionAt', hit.sessionId, { probe: probeFromSnippet(hit.snippet) })
    void jumpToSession(sessions ?? {}, {
      sessionId: hit.sessionId,
      target: { seq: hit.seq, turn: hit.turn, probe: probeFromSnippet(hit.snippet), time: hit.time },
      child: hit.child === true,
      parentSessionId: hit.parentSessionId ?? null,
    }, {
      onClose: () => { store.close() },
      onNotice: (message) => { setJumpNotice(message) },
      messages: {
        notInList: t('jumpNotInList'),
        openFailed: t('jumpOpenFailed'),
      },
      uiWorkspace,
    }).catch((error: unknown) => {
      reportJump('jump-threw', hit.sessionId, {
        probe: probeFromSnippet(hit.snippet),
        detail: error instanceof Error ? error.message : String(error),
      })
    })
  }, [sessions, uiWorkspace, store, t])

  if (!panel.open) return null

  return (
    <div className="sex-app">
      <div className="sex-header">
        <button type="button" className="sex-back" aria-label={t('backToSessionAria')} onClick={onClose}>
          <span aria-hidden="true">‹</span>
          <span>{t('backToSession')}</span>
        </button>
        <div className="sex-tabs">
          <button
            type="button"
            className={'sex-tab' + (view.name === 'search' ? ' sex-tab-on' : '')}
            onClick={() => { setView({ name: 'search' }) }}
          >
            {t('searchTab')}
          </button>
          <button
            type="button"
            className={'sex-tab' + (view.name === 'timeline' ? ' sex-tab-on' : '')}
            onClick={openTimeline}
          >
            {t('timelineTab')}
          </button>
        </div>
        <div className="sex-header-right">
          {indexStatus && (
            <span className={'sex-status' + (indexStatus.staleSessions > 0 ? ' sex-status-stale' : '')}>
              {t('indexedStatus', { indexed: indexStatus.indexedSessions, total: indexStatus.totalSessions })}
              {indexStatus.staleSessions > 0 ? ' · ' + t('staleStatus', { n: indexStatus.staleSessions }) : ''}
              {indexStatus.failedSessions > 0 ? ' · ' + t('failedStatus', { n: indexStatus.failedSessions }) : ''}
            </span>
          )}
          {Tooltip
            ? createElement(Tooltip as never, {
                label: t('helpTooltip'),
                side: 'bottom',
                delayMs: 300,
                maxWidth: 320,
                children: createElement('span', { className: 'sex-help-icon', 'aria-label': t('helpAria') }, '?'),
              })
            : createElement('span', {
                className: 'sex-help-icon',
                title: t('helpAria'),
                'aria-label': t('helpAria'),
              }, '?')}
          <button type="button" className="sex-mini-btn" disabled={rebuilding} onClick={openRebuildDialog}>
            {rebuilding ? t('rebuildingBtn') : t('rebuildBtn')}
          </button>
        </div>
      </div>
      {rebuildResult && <div className="sex-notice">{rebuildResult}</div>}
      {jumpNotice && (
        <div className="sex-notice sex-notice-warn" role="status">
          <span>{jumpNotice}</span>
          <button type="button" className="sex-mini-btn" onClick={clearJumpNotice}>{t('dismiss')}</button>
        </div>
      )}
      <div className="sex-body">
        {view.name === 'search' && <SearchView client={client} onPreview={openPreviewFromHit} onOpenSession={openSessionAt} locale={locale} />}
        {view.name === 'timeline' && (timeline.status === 'loading'
          ? <div className="sex-empty">{t('loadingTimeline')}</div>
          : timeline.status === 'error'
            ? <div className="sex-error">{timeline.error}</div>
            : <TimelineView
            nodes={timeline.nodes}
            selectedSessionId={selectedSessionId}
            turns={turns}
            onSelectSession={loadTurns}
            onDrillTurn={onOpenSession}
            onPreview={openPreview}
            locale={locale}
          />)}
        {view.name === 'preview' && (
          <PreviewView
            client={client}
            sessionId={view.sessionId}
            seq={view.seq}
            onBack={() => { setView({ name: 'search' }) }}
            onOpenSession={openSessionAt}
            locale={locale}
          />
        )}
      </div>
      {rebuildDialog.open && (
        <div className="sex-modal-backdrop" onClick={() => { if (!rebuilding) setRebuildDialog((d) => ({ ...d, open: false })) }}>
          <div className="sex-modal" onClick={(event) => { event.stopPropagation() }}>
            <div className="sex-modal-title">{t('dialogTitle')}</div>
            {rebuildDialog.checking ? (
              <div className="sex-modal-hint">{t('checkingHealth')}</div>
            ) : (
              <>
                {rebuildDialog.health && !rebuildDialog.health.healthy && (
                  <div className="sex-modal-warn">
                    {t('healthFailed')}
                    {rebuildDialog.health.problems.map((p) => <div key={p}>• {p}</div>)}
                    <div>{t('healthFailedHint')}</div>
                  </div>
                )}
                {rebuildDialog.health?.healthy && (
                  <div className="sex-modal-hint">{t('healthOk')}</div>
                )}
                <label className="sex-radio-row">
                  <input
                    type="radio"
                    name="rebuild-mode"
                    checked={rebuildDialog.mode === 'incremental'}
                    onChange={() => { setRebuildDialog((d) => ({ ...d, mode: 'incremental' })) }}
                    disabled={rebuilding}
                  />
                  <span>
                    <strong>{t('incrementalLabel')}</strong>{t('incrementalRecommended')}
                    <span className="sex-modal-sub">{t('incrementalDesc')}</span>
                  </span>
                </label>
                <label className="sex-radio-row">
                  <input
                    type="radio"
                    name="rebuild-mode"
                    checked={rebuildDialog.mode === 'full'}
                    onChange={() => { setRebuildDialog((d) => ({ ...d, mode: 'full' })) }}
                    disabled={rebuilding}
                  />
                  <span>
                    <strong>{t('fullLabel')}</strong>{t('fullSlow')}
                    <span className="sex-modal-sub">{t('fullDesc')}</span>
                  </span>
                </label>
              </>
            )}
            <div className="sex-modal-footer">
              <button type="button" className="sex-mini-btn" onClick={() => { setRebuildDialog((d) => ({ ...d, open: false })) }} disabled={rebuilding}>{t('cancel')}</button>
              <button type="button" className="sex-mini-btn sex-primary-btn" disabled={rebuilding || rebuildDialog.checking} onClick={() => { void doRebuild(rebuildDialog.mode) }}>
                {rebuilding ? t('rebuildingBtn') : t('startRebuild')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
