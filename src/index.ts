/**
 * dsh-session-explorer Host 装配层。
 *
 * - 打开/初始化 ~/.dsh/storages/session-explorer.sqlite（trigram FTS5 索引）
 * - RPC /dsh-session-explorer（loopback）
 * - 事件同步：agent/turn-stopping 增量 + 启动对账 + 手动 rebuild
 * - 依赖全部可选（ctx.get），服务缺失时降级为可报告错误，不让插件加载失败
 */

import { join, dirname } from 'node:path'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { SessionIndex, type SessionMeta } from './indexer.js'
import { fingerprintOf } from './indexer.js'
import { foldSession, foldTitle } from './transcript.js'
import { dispatch } from './rpc.js'
import type { ExplorerRpc, IndexHealth, IndexStatus, JumpReport, RebuildRequest, RebuildResponse, SyncResponse, TimelineNodeKind } from './protocol.js'

export const name = 'dsh-session-explorer'

/** RPC 通道名（client 侧共用）。 */
export const CHANNEL = '/dsh-session-explorer'

/* ------------------------------------------------------------------ *
 * Web RPC 通道。dsh 0.2.x 的 connection.rpc.handle 内部会读 owner.webServer
 * 并抛 `cannot get property "webServer" without inject`（本机实测），所以
 * 直接把通道挂到插件自己 inject 的 webServer 上，逐分支复刻 /api 的传输语义：
 *   POST <channel>/<endpoint>  body {rpcId, method, payload}
 *   → 200 {type:'server-response', rpcId, result} | 400/404/413/415/500
 * 与 dsh-pocket 的 lib/web-rpc.js 同款做法。
 * ------------------------------------------------------------------ */

const RPC_BODY_MAX = 8 * 1024 * 1024
const ENDPOINT_SEGMENT_PATTERN = /^[A-Za-z0-9_$.-]+$/
const INVALID_REQUEST_RPC_ID = 'invalid-request'
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1'])

type Probe = (message: string) => void
type RpcHandler = (endpoint: string, payload: unknown) => Promise<unknown>

interface HttpRequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  signal?: AbortSignal
  [Symbol.asyncIterator](): AsyncIterator<unknown>
}
interface HttpResponseLike {
  writableEnded: boolean
  writeHead(status: number, headers?: Record<string, string>): unknown
  write(chunk: unknown): boolean
  end(body?: string): unknown
  on(event: string, listener: () => void): unknown
  once(event: string, listener: () => void): unknown
  off(event: string, listener: () => void): unknown
}
interface FetchHandlerLike { fetch(request: Request): Promise<Response> }

function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  const bad = endpoint.split('/').some((seg) => seg === '' || seg === '.' || seg === '..' || !ENDPOINT_SEGMENT_PATTERN.test(seg))
  return bad ? undefined : endpoint
}

function serverResponseJson(rpcId: string, result: unknown): string {
  return JSON.stringify({ type: 'server-response', rpcId, result })
}

function badRequest(rpcId: string, message: string): Response {
  return new Response(
    serverResponseJson(rpcId, { ok: false, error: { code: 'bad-request', message, details: { issues: [] } } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function rpcFetchHandler(channel: string, handler: RpcHandler, probe: Probe): FetchHandlerLike {
  return {
    async fetch(request: Request): Promise<Response> {
      const endpoint = endpointFromPath(channel, new URL(request.url).pathname)
      if (request.method !== 'POST' || endpoint === undefined) return new Response('not found', { status: 404 })
      const mediaType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (mediaType !== 'application/json') return new Response('content type must be application/json', { status: 415 })
      let body: { rpcId?: unknown; method?: unknown; payload?: unknown }
      try {
        body = (await request.json()) as typeof body
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : INVALID_REQUEST_RPC_ID
      const method = typeof body?.method === 'string' ? body.method : null
      if (rpcId === INVALID_REQUEST_RPC_ID || method === null) return badRequest(INVALID_REQUEST_RPC_ID, 'invalid client-request message')
      if (method !== endpoint) return badRequest(rpcId, `method ${JSON.stringify(method)} does not match endpoint ${JSON.stringify(endpoint)}`)
      try {
        const result = await handler(endpoint, body.payload)
        return new Response(serverResponseJson(rpcId, result), { status: 200, headers: { 'content-type': 'application/json' } })
      } catch (error) {
        probe('rpc ' + endpoint + ' failed: ' + errorOf(error))
        return new Response('handler failure: ' + String(error), { status: 500 })
      }
    },
  }
}

async function httpBridge(req: HttpRequestLike, res: HttpResponseLike, fetchHandler: FetchHandlerLike, maxBodyBytes: number): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const declared = req.headers['content-length']
  if (declared !== undefined && Number(declared) > maxBodyBytes) {
    res.writeHead(413, { connection: 'close' })
    res.end()
    return
  }
  const chunks: Buffer[] = []
  let received = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    received += buf.length
    if (received > maxBodyBytes) {
      res.writeHead(413, { connection: 'close' })
      res.end()
      return
    }
    chunks.push(buf)
  }
  const host = Array.isArray(req.headers.host) ? req.headers.host[0] : req.headers.host
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string') headers[key] = value
  const init: RequestInit = { method: req.method ?? 'GET', headers, signal: abort.signal }
  if (chunks.length > 0) init.body = Buffer.concat(chunks)
  const response = await fetchHandler.fetch(new Request(`http://${host ?? '127.0.0.1'}${req.url ?? '/'}`, init))
  const outHeaders: Record<string, string> = {}
  response.headers.forEach((value, key) => { outHeaders[key] = value })
  res.writeHead(response.status, outHeaders)
  if (response.body === null) {
    res.end()
    return
  }
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    if (!res.write(chunk)) {
      await new Promise<void>((resolve) => {
        const done = (): void => { res.off('drain', done); res.off('close', done); resolve() }
        res.once('drain', done)
        res.once('close', done)
      })
    }
    if (res.writableEnded) break
  }
  res.end()
}

function isTrustedLoopbackRequest(req: HttpRequestLike): boolean {
  const raw = req.headers.host
  const host = Array.isArray(raw) ? raw[0] : raw
  if (host === undefined) return false
  if (!LOOPBACK_HOSTNAMES.has(host.split(':')[0] ?? '')) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  const value = Array.isArray(origin) ? origin[0] : origin
  try {
    return new URL(value ?? '').host === host
  } catch {
    return false
  }
}

function mountWebRoute(web: WebLike, channel: string, handler: RpcHandler, probe: Probe): (() => void) | null {
  const webServer = web.webServer
  if (!webServer || typeof webServer.register !== 'function') return null
  const connection = web.connection
  const fetchHandler = rpcFetchHandler(channel, handler, probe)
  const route = {
    kind: 'prefix',
    path: channel,
    handler: async (req: HttpRequestLike, res: HttpResponseLike): Promise<void> => {
      // requestRejection 是类方法：必须以方法形式调用；抽成裸函数会丢 this → 一律 403
      let rejection: number | undefined
      if (typeof connection?.requestRejection === 'function') {
        try {
          rejection = connection.requestRejection(req)
        } catch {
          rejection = 403
        }
      } else if (!isTrustedLoopbackRequest(req)) {
        rejection = 403
      }
      if (rejection !== undefined) {
        res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      await httpBridge(req, res, fetchHandler, RPC_BODY_MAX)
    },
  }
  // register 对重复的 (kind, path) 会抛错（composition 级契约），兜住避免拖垮整个 fiber
  let registered: unknown
  try {
    registered = webServer.register(route)
  } catch (error) {
    probe('webServer.register THREW: ' + errorOf(error))
    return null
  }
  probe('webServer.register: ' + typeof registered)
  if (typeof registered === 'function') {
    return () => {
      try {
        ;(registered as () => void)()
      } catch {
        /* 已清理 */
      }
    }
  }
  return () => {}
}

/** 索引库路径：~/.dsh/storages/session-explorer.sqlite。 */
export function indexPath(): string {
  const storages = dshHomePath('storages')
  mkdirSync(storages, { recursive: true, mode: 0o700 })
  return join(storages, 'session-explorer.sqlite')
}

interface EventLike {
  type?: string
  seq?: number
  time?: number
  data?: Record<string, unknown>
}
interface SessionEventLike { [key: string]: unknown }

interface SessionHeaderLike {
  id?: unknown
  createdAt?: number
  cwd?: string
  origin?: unknown
  parentSession?: unknown
}

interface SessionSnapshotLike { header?: SessionHeaderLike; revision?: unknown; id?: unknown }
interface SessionHandleLike {
  read?: (options?: { signal?: AbortSignal }) => Promise<unknown>
  close?: () => unknown
}
interface PersistenceLike {
  listSnapshots?: () => Promise<SessionSnapshotLike[]>
  list?: () => Promise<SessionSnapshotLike[]>
  stat?: (id: string) => Promise<SessionSnapshotLike | undefined>
  open?: (id: string, access: 'read' | 'write', options?: { signal?: AbortSignal }) => Promise<SessionHandleLike>
  inspect?: (id: string) => Promise<{ meta: SessionHeaderLike; events: SessionEventLike[] }>
}

/** 老核心有 inspect()，0.2 核心只有 open(id,'read')；两者都能读会话。 */
function canRead(persistence: PersistenceLike | undefined): persistence is PersistenceLike {
  return typeof persistence?.inspect === 'function' || typeof persistence?.open === 'function'
}

/** 列表条目既可能是 snapshot 包装，也可能是裸 header。 */
function idOf(entry: unknown): string | null {
  const value = entry as (SessionSnapshotLike & SessionHeaderLike) | undefined
  return sessionIdOf(value?.header?.id ?? value?.id)
}

/** sessionId → revision 映射（listSnapshots 轻量快照，O(1) 不读日志）。 */
async function listSnapshotRevisions(persistence: PersistenceLike): Promise<Map<string, string> | null> {
  const list = persistence.listSnapshots ?? persistence.list
  if (!list) return null
  const snapshots = await list.call(persistence)
  const map = new Map<string, string>()
  for (const snapshot of snapshots ?? []) {
    const id = idOf(snapshot)
    const rev = typeof snapshot.revision === 'string' ? snapshot.revision : String(snapshot.revision ?? '')
    if (id && rev) map.set(id, rev)
  }
  return map
}

interface SessionsLike {
  get?: (id: string) => { id?: unknown } | undefined
}

interface AgentLike {
  session?: { id?: unknown }
  ctx?: {
    on?: (event: string, listener: (payload?: unknown) => void) => () => void
    effect?: (dispose: () => unknown, label: string) => void
  }
}

interface AgentsLike {
  roots?: () => AgentLike[]
}

interface ConnectionLike {
  rpc?: {
    handle: (channel: string, handler: unknown) => () => void | unknown
  }
  requestRejection?: (request: unknown) => number | undefined
}

interface WebLike {
  connection?: ConnectionLike
  webServer?: { register?: (route: unknown) => unknown }
}

interface CtxLike {
  get: (service: string) => unknown
  inject: (services: string[], fn: (web: WebLike) => void) => void
  effect: (dispose: () => unknown, label: string) => void
  on: (event: string, listener: (payload?: unknown) => void) => () => void
  logger?: { warn?: (msg: string) => void }
}

const sessionIdOf = (id: unknown): string | null => (typeof id === 'string' && id.length > 0 ? id : null)

/** header 从 stat() 拿，退化为 list() 里找。 */
async function readHeader(persistence: PersistenceLike, id: string): Promise<SessionHeaderLike> {
  try {
    const snapshot = await persistence.stat?.(id)
    if (snapshot?.header) return snapshot.header
  } catch { /* 头信息尽力而为 */ }
  try {
    for (const snapshot of (await persistence.list?.()) ?? []) {
      if (idOf(snapshot) === id) return snapshot.header ?? {}
    }
  } catch { /* 头信息尽力而为 */ }
  return {}
}

/** 读一个会话的 meta + events：新核心 open(id,'read')，老核心 inspect(id)。 */
async function readSession(persistence: PersistenceLike, id: string): Promise<{ meta: SessionHeaderLike; events: SessionEventLike[] }> {
  if (typeof persistence.inspect === 'function') {
    const inspection = await persistence.inspect(id)
    return { meta: inspection?.meta ?? {}, events: (inspection?.events ?? []) as SessionEventLike[] }
  }
  const handle = await persistence.open!(id, 'read')
  try {
    const result: unknown = await handle.read?.()
    const events = (Array.isArray(result) ? result : (result as { events?: SessionEventLike[] } | undefined)?.events ?? []) as SessionEventLike[]
    return { meta: await readHeader(persistence, id), events }
  } finally {
    if (typeof handle.close === 'function') await handle.close()
  }
}

/** 主代理 / 子代理分类：origin === 'subagent' 优先，其次 parentSession 有值。 */
function kindOf(header: SessionHeaderLike): TimelineNodeKind {
  if (header.origin === 'subagent') return 'child'
  if (typeof header.parentSession === 'string' && header.parentSession.length > 0) return 'child'
  return 'main'
}


/** 同步一个会话的最新日志。 */
async function syncSession(index: SessionIndex, persistence: PersistenceLike, sessionId: string, revision?: string | null): Promise<boolean> {
  const inspection = await readSession(persistence, sessionId)
  if (!inspection) return false
  const events = (inspection.events ?? []) as SessionEventLike[]
  const folded = foldSession(sessionId, events as never[])
  const title = foldTitle(events as never[])
  const meta: SessionMeta = {
    sessionId,
    title,
    cwd: typeof inspection.meta?.cwd === 'string' ? inspection.meta.cwd : null,
    createdAt: typeof inspection.meta?.createdAt === 'number' ? inspection.meta.createdAt : 0,
    updatedAt: Date.now(),
    kind: kindOf(inspection.meta ?? {}),
    parentSessionId: typeof inspection.meta?.parentSession === 'string' ? inspection.meta.parentSession : null,
    logFingerprint: fingerprintOf(folded.messages),
    logRevision: revision ?? null,
  }
  index.upsertSession(meta, folded.messages)
  return true
}

/** 列出所有已知会话 id（优先 snapshot 列表，降级 header 列表）。 */
async function listSessionIds(persistence: PersistenceLike): Promise<string[]> {
  const list = persistence.listSnapshots ?? persistence.list
  if (!list) return []
  const ids: string[] = []
  for (const entry of (await list.call(persistence)) ?? []) {
    const id = idOf(entry)
    if (id) ids.push(id)
  }
  return ids
}

function errorOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function apply(ctx: CtxLike) {
  let index: SessionIndex | null = null
  let disposed = false
  let syncing: Promise<void> | null = null
  const warned: string[] = []

  const warnOnce = (key: string, message: string) => {
    if (!warned.includes(key)) {
      warned.push(key)
      ctx.logger?.warn?.('[dsh-session-explorer] ' + message)
    }
  }

  // TEMP 探针（验证用，验证后删除）
  const probe = (message: string) => {
    try {
      appendFileSync(join(process.env.TEMP ?? '.', 'se-probe.log'), new Date().toISOString() + ' ' + message + '\n')
    } catch {}
  }
  probe('apply called')

  // 实时获取 persistence：cordis 树并发装配下，本 entry apply 执行时
  // session-persistence-jsonl 可能尚未 mount（alpha.4+ 装配时序变化）；
  // closure 快照会把 undefined 永久捕获，导致 sync 静默失效、rebuild 报错。
  const persistenceOf = (): PersistenceLike | undefined =>
    ctx.get('sessionPersistence') as PersistenceLike | undefined
  const agentsOf = () => (ctx.get('agents') as AgentsLike | undefined)?.roots?.() ?? []

  try {
    index = SessionIndex.open(indexPath())
  } catch (error) {
    ctx.logger?.warn?.('[dsh-session-explorer] index unavailable: ' + errorOf(error))
    index = null
  }

  // 面板打开时同步：live 会话 + 从未索引的新会话（串行，量小安全）。
  const syncNow = async (): Promise<SyncResponse> => {
    const persistence = persistenceOf()
    if (!canRead(persistence)) return { synced: 0, failed: 0 }
    const targets = new Set<string>()
    for (const agent of agentsOf()) {
      const id = sessionIdOf(agent.session?.id)
      if (id !== null) targets.add(id)
    }
    try {
      for (const id of await listSessionIds(persistence)) {
        const snap = index?.sessionMeta(id)
        if (!snap || snap.indexedAt === 0) targets.add(id)
      }
    } catch (error) {
      warnOnce('sync-list', 'sync session listing failed: ' + errorOf(error))
    }
    let synced = 0
    let failed = 0
    const revisions = await listSnapshotRevisions(persistence)
    for (const id of targets) {
      try {
        await syncSession(index!, persistence, id, revisions?.get(id) ?? null)
        synced++
      } catch (error) {
        failed++
        const message = errorOf(error)
        warnOnce('sync-' + id, 'sync failed for ' + id + ': ' + message)
        try { index?.markFailed(id, message) } catch { /* 记录失败尽力而为 */ }
      }
    }
    return { synced, failed }
  }

  const handlers: ExplorerRpc = {
    search: async (request) => {
      if (!index) throw new Error('index unavailable')
      return index.search(request.query, request)
    },
    timeline: async (request) => {
      if (!index) throw new Error('index unavailable')
      return index.timeline(request ?? {})
    },
    turns: async (request) => {
      if (!index) throw new Error('index unavailable')
      return { sessionId: request.sessionId, turns: index.turns(request.sessionId, request.limit) }
    },
    preview: async (request) => {
      if (!index) throw new Error('index unavailable')
      return index.preview(request.sessionId, request.seq, request)
    },
    indexStatus: async (): Promise<IndexStatus> => {
      if (!index) throw new Error('index unavailable')
      const persistence = persistenceOf()
      const ids = persistence ? await listSessionIds(persistence) : []
      return index.indexStatus(ids)
    },
    sync: async (): Promise<SyncResponse> => {
      if (!index) throw new Error('index unavailable')
      return syncNow()
    },
    healthCheck: async (): Promise<IndexHealth> => {
      if (!index) throw new Error('index unavailable')
      return index.healthCheck()
    },
    jumpReport: async (request: JumpReport): Promise<{ ok: true }> => {
      probe(
        'jump ' + request.stage +
          ' session=' + request.sessionId +
          ' seq=' + String(request.seq ?? '') +
          ' probe=' + String(request.probe ?? '') +
          ' detail=' + String(request.detail ?? ''),
      )
      return { ok: true as const }
    },
    rebuild: async (request: RebuildRequest): Promise<RebuildResponse> => {
      if (!index) throw new Error('index unavailable')
      const persistence = persistenceOf()
      if (!canRead(persistence)) {
        throw new Error('sessionPersistence read API is not available (service not mounted yet)')
      }
      const ids = await listSessionIds(persistence)
      const failures: RebuildResponse['failures'] = []
      const mode = request.mode
      let added = 0
      let removed = 0
      let refreshed = 0
      let skipped = 0
      let succeeded = 0
      let failed = 0

      const rebuildOne = async (id: string, revision?: string | null): Promise<void> => {
        try {
          if (await syncSession(index!, persistence, id, revision)) succeeded++
          else failed++
        } catch (error) {
          failed++
          const message = errorOf(error)
          failures.push({ sessionId: id, indexed: false, error: message })
          try { index!.markFailed(id, message) } catch { /* 记录失败尽力而为 */ }
        }
      }

      if (mode === 'full') {
        // 全量：清库后逐会话重建（严格串行，一次只驻留一个会话内存，防 OOM）
        index.reset()
        const revisions = await listSnapshotRevisions(persistence)
        for (const id of ids) {
          if (disposed) break
          await rebuildOne(id, revisions?.get(id) ?? null)
        }
        added = succeeded
      } else {
        // 增量：revision 快速 diff（O(1)）+ 幽灵清理 + 变化会话重刷（严格串行）
        const known = new Set(ids)
        const revisions = await listSnapshotRevisions(persistence)
        const storedRevisions = index.listRevisions()
        const storedFingerprints = index.listFingerprints()
        // 1) 幽灵：索引有但磁盘无 → 删除
        for (const id of storedRevisions.keys()) {
          if (!known.has(id)) {
            try {
              index.deleteSession(id)
              removed++
            } catch (error) {
              failures.push({ sessionId: id, indexed: false, error: 'ghost delete failed: ' + errorOf(error) })
            }
          }
        }
        // 2) 逐会话：revision 相同 → 跳过（不 inspect）；不同/缺失 → 重刷
        for (const id of ids) {
          if (disposed) break
          const currentRev = revisions?.get(id) ?? null
          const storedRev = storedRevisions.get(id)
          const storedFp = storedFingerprints.get(id)
          // 已索引过，且有 revision 且与当前一致 → 直接跳过（快速路径）
          if (storedRev !== undefined && storedRev !== null && currentRev !== null && storedRev === currentRev) {
            skipped++
            continue
          }
          // 其余情况：未索引 / revision 变化 / revision 缺失（老库）→ 重刷
          try {
            if (await syncSession(index!, persistence, id, currentRev)) {
              if (storedRev === undefined || storedFp === undefined) added++
              else refreshed++
              succeeded++
            } else {
              failed++
            }
          } catch (error) {
            failed++
            const message = errorOf(error)
            failures.push({ sessionId: id, indexed: false, error: message })
            try { index!.markFailed(id, message) } catch { /* 尽力而为 */ }
          }
        }
      }
      // 重建后做一次 FTS optimize + WAL 截断（大事务写入后回收膨胀）
      try { index.maintain() } catch { /* 维护尽力而为 */ }
      return { mode, total: ids.length, added, removed, refreshed, skipped, succeeded, failed, failures }
    },
  }

  const onTurnStopping = (payload?: unknown) => {
    const persistence = persistenceOf()
    if (!index || !canRead(persistence) || syncing) return
    const agent = payload as AgentLike | undefined
    const id = sessionIdOf(agent?.session?.id)
    if (!id) return
    const run = syncSession(index, persistence, id)
      .then(() => {})
      .catch((error) => warnOnce('sync-' + id, 'incremental sync failed for ' + id + ': ' + errorOf(error)))
      .finally(() => {
        syncing = null
      })
    syncing = run
  }

  const attachAgent = (agent: AgentLike) => {
    const agentCtx = agent.ctx
    if (!agentCtx?.on || !agentCtx?.effect) return
    const id = sessionIdOf(agent.session?.id)
    if (!id) return
    agentCtx.effect(() => {
      const stopTurn = agentCtx.on!('agent/turn-stopping', onTurnStopping)
      const stopStatus = agentCtx.on!('agent/status', onTurnStopping)
      return () => {
        stopTurn()
        stopStatus()
      }
    }, 'dsh-session-explorer.turn(' + id + ')')
  }

  const stopCreated = ctx.on('agent/created', (payload) => {
    const agent = (payload as { agent?: AgentLike } | undefined)?.agent
    if (agent) attachAgent(agent)
  })

  // 启动期 persistence 可能晚于本 entry mount：给一轮有限等待。
  const waitForPersistence = async (deadlineMs: number): Promise<PersistenceLike | undefined> => {
    if (canRead(persistenceOf())) return persistenceOf()
    const started = Date.now()
    while (Date.now() - started < deadlineMs && !disposed) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      if (canRead(persistenceOf())) return persistenceOf()
    }
    return persistenceOf()
  }

  // 首个 persistence 就绪后补挂既有 roots 的事件监听（apply 时可能还没就绪）。
  void (async () => {
    const persistence = await waitForPersistence(10_000)
    if (!canRead(persistence) || disposed) return
    for (const agent of (ctx.get('agents') as AgentsLike | undefined)?.roots?.() ?? []) attachAgent(agent)
  })()

  // 启动对账：把新出现的会话索引起来（失败不阻塞；等 persistence 就绪再跑）。
  void (async () => {
    if (!index) return
    const persistence = await waitForPersistence(10_000)
    probe('reconcile: canRead=' + String(canRead(persistence)))
    if (!canRead(persistence)) {
      warnOnce('persistence', 'sessionPersistence not mounted within 10s; sync/rebuild disabled for this boot')
      return
    }
    try {
      const ids = await listSessionIds(persistence)
      probe('reconcile: ids=' + String(ids.length))
      for (const id of ids) {
        if (disposed) return
        const snap = index.sessionMeta(id)
        if (snap && snap.indexedAt > 0) continue // 已索引；过期以 turn-stopping 增量纠正
        try {
          await syncSession(index, persistence, id)
          probe('reconcile: synced ' + id)
        } catch (error) {
          probe('reconcile: ' + id + ' FAILED: ' + errorOf(error))
          warnOnce('reconcile-' + id, 'reconciliation failed for ' + id + ': ' + errorOf(error))
        }
      }
      probe('reconcile: loop finished')
    } catch (error) {
      probe('reconcile: outer error ' + errorOf(error))
      warnOnce('reconcile', 'reconciliation failed: ' + errorOf(error))
    }
  })()

  let disposeRpc: (() => void) | null = null
  ctx.inject(['connection', 'webServer'], (web) => {
    const handler: RpcHandler = async (endpoint, payload) => dispatch(handlers, endpoint, payload)
    const mounted = mountWebRoute(web as unknown as WebLike, CHANNEL, handler, probe)
    if (mounted) {
      probe('web route mounted on ' + CHANNEL)
      disposeRpc = mounted
      return
    }
    // 兜底：没有 webServer.register 的老版 dsh 走 rpc.handle
    const rpc = web.connection?.rpc
    if (!rpc) {
      probe('no webServer.register and no rpc.handle')
      return
    }
    try {
      const dispose = rpc.handle(CHANNEL, handler)
      if (typeof dispose === 'function') disposeRpc = dispose as () => void
      probe('rpc.handle fallback ok')
    } catch (error) {
      probe('rpc.handle fallback THREW: ' + errorOf(error))
    }
  })

  return async () => {
    disposed = true
    stopCreated()
    disposeRpc?.()
    if (syncing) await syncing.catch(() => {})
    index?.close()
    index = null
  }
}
