/**
 * indexer.ts —— 插件自有的 SQLite FTS5 trigram 索引（读模型）。
 *
 * 数据库位置由 host 解析（~/.dsh/storages/session-explorer.sqlite），本模块
 * 只收路径，不依赖 cordis。安全策略：
 * - application_id + user_version 双校验，外来/版本不匹配的库直接拒开；
 * - 文件权限 0600（含 -wal/-shm）；
 * - 每会话 upsert = 事务内先 'delete' FTS 行再重插（external content 表）。
 */

import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import type {
  IndexableMessage,
  MessageHit,
  PreviewPage,
  TimelineNode,
  TimelineNodeKind,
  TimelineTurn,
  TimelineMessageSummary,
  IndexStatus,
  MessageKind,
} from './protocol.js'
import { makeSnippet } from './transcript.js'

/** 私有库标记。 */
export const DB_APP_ID = 0x44534530 // 'DSE0'
/** 结构版本：schema 变更时 +1。v5 = 物理去重（正文表 + 会话归属映射）。 */
export const DB_USER_VERSION = 5

/** 每会话元数据（同步层传入）。 */
export interface SessionMeta {
  sessionId: string
  title: string | null
  cwd: string | null
  createdAt: number
  updatedAt: number
  /** 源日志指纹（增量重建判断内容是否变化）；未提供时写入 null。 */
  logFingerprint?: string | null
  /** 源日志 revision（engine listSnapshots 的轻量变更 token；O(1) 快速 diff）。 */
  logRevision?: string | null
  /** 主代理 / 子代理分类（header.origin === "subagent" 或 parentSession 有值 → child）。 */
  kind?: TimelineNodeKind
  parentSessionId?: string | null
}

/** djb2 字符串哈希（轻量、稳定，不追求密码学强度）。 */
function djb2(text: string): number {
  let hash = 5381
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0
  }
  return hash >>> 0
}

/** 从折叠后的消息计算源日志指纹（内容变化 → 指纹变化）。 */
export function fingerprintOf(messages: IndexableMessage[]): string {
  if (messages.length === 0) return '0:0:0:0'
  let contentHash = 5381
  let lastSeq = 0
  let lastTime = 0
  for (const message of messages) {
    // 只哈希 textMain/textTool，避免 sessionId/turn 等不影响检索的字段造成无谓重刷
    contentHash = ((contentHash << 5) + contentHash + djb2(message.textMain)) | 0
    contentHash = ((contentHash << 5) + contentHash + djb2(message.textTool)) | 0
    if (message.seq > lastSeq) {
      lastSeq = message.seq
      lastTime = message.time
    }
  }
  return messages.length + ':' + lastSeq + ':' + lastTime + ':' + (contentHash >>> 0)
}

/** bm25 列权重：text_main 10 倍于 text_tool。 */
const RANK = 'bm25(messages_fts, 10.0, 1.0)'

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    cwd TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    tool_count INTEGER NOT NULL DEFAULT 0,
    parent_session_id TEXT,
    subagent_kind TEXT NOT NULL DEFAULT 'main',
    indexed_at INTEGER NOT NULL,
    log_fingerprint TEXT,
    log_revision TEXT,
    error TEXT
  ) WITHOUT ROWID`,
  // v5 物理去重：唯一正文行（fork/续接会话共享父历史 → 同一 (seq,kind,正文)
  // 只存一份，归属关系见 session_messages）。content_key = seq:kind:text_main
  // 的哈希键（搜索层原 GROUP BY 口径的物理化）。
  `CREATE TABLE IF NOT EXISTS messages (
    content_id INTEGER PRIMARY KEY,
    content_key TEXT NOT NULL UNIQUE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    time INTEGER NOT NULL,
    turn INTEGER,
    text_main TEXT NOT NULL DEFAULT '',
    text_tool TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE IF NOT EXISTS session_messages (
    session_id TEXT NOT NULL,
    content_id INTEGER NOT NULL,
    PRIMARY KEY (session_id, content_id)
  ) WITHOUT ROWID`,
  // ⚠ 反查归属（按 content_id 找 session）是搜索热路径；缺此索引时 SQLite
  // 全表扫 session_messages（810 会话 × 5.5 万映射 ≈ 670ms/查询）。
  `CREATE INDEX IF NOT EXISTS idx_session_messages_content ON session_messages(content_id)`,
  `CREATE INDEX IF NOT EXISTS idx_session_messages_session ON session_messages(session_id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_time ON messages(time)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
    text_main, text_tool,
    content='messages',
    content_rowid='rowid',
    tokenize='trigram'
  )`,
]

/** 消息内容键：搜索层去重口径（seq+kind+正文）的物理主键。 */
function contentKeyOf(message: IndexableMessage): string {
  return message.seq + ':' + message.kind + ':' + message.textMain
}

export interface SearchOptions {
  kinds?: MessageKind[]
  from?: number
  to?: number
  cwd?: string
  limit?: number
  offset?: number
}

export interface PreviewOptions {
  before?: number
  after?: number
}

export class SessionIndex {
  private db: DatabaseSync
  readonly path: string

  private constructor(db: DatabaseSync, path: string) {
    this.db = db
    this.path = path
  }

  /** 打开（必要时初始化）索引库；拒绝外来/版本不符的库。 */
  static open(path: string): SessionIndex {
    const existed = fs.existsSync(path)
    const db = new DatabaseSync(path)
    try {
      const appId = (db.prepare('PRAGMA application_id').get() as { application_id: number }).application_id
      const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      if (existed) {
        if (appId !== DB_APP_ID) {
          db.close()
          throw new Error(`refusing foreign sqlite file (application_id=${appId}): ${path}`)
        }
        // 仅支持向前迁移；版本高于当前实现（或低于 v1）拒绝
        if (userVersion > DB_USER_VERSION || userVersion < 1) {
          db.close()
          throw new Error(`refusing version mismatch (user_version=${userVersion}, want ${DB_USER_VERSION}): ${path}`)
        }
      } else {
        db.exec(`PRAGMA application_id = ${DB_APP_ID}`)
        db.exec(`PRAGMA user_version = ${DB_USER_VERSION}`)
      }
      db.exec('PRAGMA journal_mode = WAL')
      db.exec('PRAGMA synchronous = NORMAL')
      // v4 → v5 迁移：旧 messages 表按 session 存（有 session_id 列、无 content_key），
      // 必须在跑 SCHEMA 前改表（messages 表结构不同，CREATE IF NOT EXISTS 会静默跳过）。
      if (existed && userVersion >= 1 && userVersion < 5) {
        SessionIndex.migrateV4ToV5(db)
        // 迁移删除约 8 成物理重复行，空间留在 freelist；VACUUM 才真正归还磁盘
        // （895MB 实测 → 164MB）。失败不阻塞启动，可日后手动维护。
        try { db.exec('VACUUM') } catch { /* 大库 VACUUM 失败不阻塞 */ }
      }
      for (const stmt of SCHEMA) db.exec(stmt)
      // Schema reconciliation is intentionally column-based, not version-only.
      // A v4 database may have been stamped before parent_session_id was introduced;
      // repair missing columns even when user_version already equals DB_USER_VERSION.
      if (existed && userVersion >= 1) {
        const columns = db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        const has = (name: string) => columns.some((column) => column.name === name)
        if (!has('log_fingerprint')) db.exec('ALTER TABLE sessions ADD COLUMN log_fingerprint TEXT')
        if (!has('log_revision')) db.exec('ALTER TABLE sessions ADD COLUMN log_revision TEXT')
        if (!has('error')) db.exec('ALTER TABLE sessions ADD COLUMN error TEXT')
        if (!has('parent_session_id')) db.exec('ALTER TABLE sessions ADD COLUMN parent_session_id TEXT')
        if (!has('subagent_kind')) db.exec("ALTER TABLE sessions ADD COLUMN subagent_kind TEXT NOT NULL DEFAULT 'main'")
        if (userVersion < DB_USER_VERSION) db.exec(`PRAGMA user_version = ${DB_USER_VERSION}`)
      }

      const index = new SessionIndex(db, path)
      index.chmod()
      return index
    } catch (error) {
      try { db.close() } catch { /* already closed */ }
      throw error
    }
  }

  /**
   * v4 → v5 物理去重迁移：旧 messages（每 session 一份正文）改为
   * messages（唯一正文）+ session_messages（归属映射）。在打开事务里
   * 重命名旧表 → 建新表 → INSERT SELECT 去重回填 → 重建 FTS → 清旧表。
   * 数据量 44 万行级别时约需数十秒；失败整体回滚，库保持 v4 可回退。
   */
  private static migrateV4ToV5(db: DatabaseSync): void {
    db.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE messages RENAME TO messages_v4;
      DROP TABLE IF EXISTS messages_fts;
    `)
    for (const stmt of SCHEMA) db.exec(stmt)
    db.exec(`
      INSERT INTO messages(content_key, seq, kind, time, turn, text_main, text_tool)
      SELECT seq || ':' || kind || ':' || text_main, seq, kind, time, turn, text_main, text_tool
      FROM messages_v4
      GROUP BY seq, kind, text_main
      HAVING MIN(rowid) = rowid;

      INSERT INTO session_messages(session_id, content_id)
      SELECT v.session_id, m.content_id
      FROM messages_v4 v
      JOIN messages m ON m.seq = v.seq AND m.kind = v.kind AND m.text_main = v.text_main;

      INSERT INTO messages_fts(rowid, text_main, text_tool)
      SELECT content_id, text_main, text_tool FROM messages;

      DROP TABLE messages_v4;
      PRAGMA user_version = ${DB_USER_VERSION};
      COMMIT;
    `)
  }

  /** 0600 权限（主文件 + WAL 附属文件）。 */
  private chmod(): void {
    for (const suffix of ['', '-wal', '-shm']) {
      const file = this.path + suffix
      if (fs.existsSync(file)) {
        try { fs.chmodSync(file, 0o600) } catch { /* best effort */ }
      }
    }
  }

  close(): void {
    this.db.close()
  }

  /** FTS5 查询串转义：双引号包裹并转义内部引号。 */
  static quoteQuery(raw: string): string {
    return '"' + raw.replaceAll('"', '""') + '"'
  }

  /** LIKE 模式转义（% _ \）。 */
  static escapeLike(raw: string): string {
    return raw.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  }

  /** 查询是否短于 trigram 最小 token 长度（3 个 code point）。 */
  static isShortQuery(raw: string): boolean {
    return [...raw.replace(/\s+/g, '')].length < 3
  }

  /** 全量替换一个会话的索引行（事务）：正文 upsert + 归属重建 + FTS 增量维护。 */
  upsertSession(meta: SessionMeta, messages: IndexableMessage[]): void {
    const now = Date.now()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      // 1) 摘掉该会话现有归属；正文若无任何归属者则连正文与 FTS 行一起删
      const orphans = this.db.prepare(`
        SELECT m.content_id, m.text_main, m.text_tool FROM messages m
        WHERE m.content_id IN (SELECT content_id FROM session_messages WHERE session_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM session_messages sm2
            WHERE sm2.content_id = m.content_id AND sm2.session_id != ?
          )`).all(meta.sessionId, meta.sessionId) as Array<{ content_id: number; text_main: string; text_tool: string }>
      for (const orphan of orphans) {
        this.db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, text_main, text_tool)
          VALUES ('delete', ?, ?, ?)`).run(orphan.content_id, orphan.text_main, orphan.text_tool)
        this.db.prepare('DELETE FROM messages WHERE content_id = ?').run(orphan.content_id)
      }
      this.db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(meta.sessionId)

      // 2) 正文 upsert + 归属 + FTS 增量插入（仅新正文行进 FTS）
      const insertMessage = this.db.prepare(`INSERT INTO messages(content_key, seq, kind, time, turn, text_main, text_tool)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(content_key) DO NOTHING`)
      const findId = this.db.prepare('SELECT content_id FROM messages WHERE content_key = ?')
      const insertFts = this.db.prepare('INSERT INTO messages_fts(rowid, text_main, text_tool) VALUES (?, ?, ?)')
      const linkMessage = this.db.prepare('INSERT OR IGNORE INTO session_messages(session_id, content_id) VALUES (?, ?)')
      let toolCount = 0
      for (const message of messages) {
        const key = contentKeyOf(message)
        // changes>0 = 正文新插入；0 = 已由其他会话先入库（FTS 已有，跳过）。
        // ⚠ 不能用 SELECT ... FROM messages_fts WHERE rowid 判定——external-content
        // 模式下该查询透传 content 表，永远"存在"，会导致倒排漏写、MATCH 全空。
        const { changes } = insertMessage.run(key, message.seq, message.kind, message.time, message.turn, message.textMain, message.textTool) as { changes: number }
        const contentId = Number((findId.get(key) as { content_id: number }).content_id)
        linkMessage.run(meta.sessionId, contentId)
        if (changes > 0) {
          insertFts.run(contentId, message.textMain, message.textTool)
        }
        if (message.kind === 'tool') toolCount++
      }

      this.db.prepare(`INSERT INTO sessions(session_id, title, cwd, created_at, updated_at, message_count, tool_count, parent_session_id, subagent_kind, indexed_at, log_fingerprint, log_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          title = excluded.title, cwd = excluded.cwd, created_at = excluded.created_at,
          updated_at = excluded.updated_at, message_count = excluded.message_count,
          tool_count = excluded.tool_count, parent_session_id = excluded.parent_session_id, subagent_kind = excluded.subagent_kind,
          indexed_at = excluded.indexed_at,
          log_fingerprint = excluded.log_fingerprint, log_revision = excluded.log_revision,
          error = NULL`)
        .run(meta.sessionId, meta.title, meta.cwd, meta.createdAt, meta.updatedAt, messages.length, toolCount, meta.parentSessionId ?? null, meta.kind ?? 'main', now, meta.logFingerprint ?? null, meta.logRevision ?? null)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 删除一个会话的索引行：归属清除 + 孤儿正文与 FTS 行清除。 */
  deleteSession(sessionId: string): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const orphans = this.db.prepare(`
        SELECT m.content_id, m.text_main, m.text_tool FROM messages m
        WHERE m.content_id IN (SELECT content_id FROM session_messages WHERE session_id = ?)
          AND NOT EXISTS (
            SELECT 1 FROM session_messages sm2
            WHERE sm2.content_id = m.content_id AND sm2.session_id != ?
          )`).all(sessionId, sessionId) as Array<{ content_id: number; text_main: string; text_tool: string }>
      for (const orphan of orphans) {
        this.db.prepare(`INSERT INTO messages_fts(messages_fts, rowid, text_main, text_tool)
          VALUES ('delete', ?, ?, ?)`).run(orphan.content_id, orphan.text_main, orphan.text_tool)
        this.db.prepare('DELETE FROM messages WHERE content_id = ?').run(orphan.content_id)
      }
      this.db.prepare('DELETE FROM session_messages WHERE session_id = ?').run(sessionId)
      this.db.prepare('DELETE FROM sessions WHERE session_id = ?').run(sessionId)
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 消息级全文检索。 */
  search(query: string, options: SearchOptions = {}): { items: MessageHit[]; nextOffset: number | null } {
    const q = query.trim()
    if (!q) return { items: [], nextOffset: null }
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200)
    const offset = options.offset ?? 0

    const short = SessionIndex.isShortQuery(q)
    const where: string[] = short
      ? ['(m.text_main LIKE ? ESCAPE \'\\\' OR m.text_tool LIKE ? ESCAPE \'\\\')']
      : ['messages_fts MATCH ?']
    const params: (string | number)[] = short
      ? [`%${SessionIndex.escapeLike(q)}%`, `%${SessionIndex.escapeLike(q)}%`]
      : [SessionIndex.quoteQuery(q)]
    if (options.kinds && options.kinds.length > 0) {
      where.push(`m.kind IN (${options.kinds.map(() => '?').join(',')})`)
      params.push(...options.kinds)
    }
    if (typeof options.from === 'number') {
      where.push('m.time >= ?')
      params.push(options.from)
    }
    if (typeof options.to === 'number') {
      where.push('m.time <= ?')
      params.push(options.to)
    }
    if (options.cwd) {
      where.push('s.cwd = ?')
      params.push(options.cwd)
    }

    // 物理去重后正文唯一，但同一正文可归属多个会话（fork/续接共享父历史）。
    // 展示语义：每条正文只出一行，归属取 indexed_at 最新的会话（原 GROUP BY 口径）。
    // 性能：FTS 分支先取候选 rowid（内层 LIMIT 随翻页扩大），窗口函数只跑小集合——
    // 对 5886 命中从 ~950ms 降到 ~17ms；非 FTS（短词）分支同构。
    const candidateBudget = (offset + limit) * 8
    // short（LIKE）分支的首条件消耗 params[0..1] 两个占位符；FTS 分支只消耗 1 个。
    const extraWhere = where.slice(1)
    const extraParams = short ? params.slice(2) : params.slice(1)
    const extraClause = extraWhere.length > 0 ? 'WHERE ' + extraWhere.join(' AND ') : ''
    const rows = (short
      ? this.db.prepare(`SELECT * FROM (
          SELECT
            sm.session_id, m.seq, m.kind, m.time, m.turn,
            m.text_main, m.text_tool,
            s.title, s.cwd, s.subagent_kind, s.parent_session_id,
            ROW_NUMBER() OVER (
              PARTITION BY m.content_id
              ORDER BY s.indexed_at DESC, s.title IS NULL
            ) AS rn,
            COALESCE(s.indexed_at, 0) AS indexed_at,
            0 AS rank
          FROM (
            SELECT rowid FROM messages
            WHERE (text_main LIKE ? ESCAPE '\\' OR text_tool LIKE ? ESCAPE '\\') LIMIT ?
          ) cand
          JOIN messages m ON m.rowid = cand.rowid
          JOIN session_messages sm ON sm.content_id = m.content_id
          LEFT JOIN sessions s ON s.session_id = sm.session_id
          ${extraClause}
        ) WHERE rn = 1
        ORDER BY indexed_at DESC, time DESC
        LIMIT ? OFFSET ?`).all(params[0], params[0], candidateBudget, ...extraParams, limit + 1, offset)
      : this.db.prepare(`SELECT * FROM (
          SELECT
            sm.session_id, m.seq, m.kind, m.time, m.turn,
            m.text_main, m.text_tool,
            s.title, s.cwd, s.subagent_kind, s.parent_session_id,
            ROW_NUMBER() OVER (
              PARTITION BY m.content_id
              ORDER BY s.indexed_at DESC, s.title IS NULL
            ) AS rn,
            COALESCE(s.indexed_at, 0) AS indexed_at,
            0 AS rank
          FROM (
            SELECT rowid FROM messages_fts WHERE messages_fts MATCH ? LIMIT ?
          ) cand
          JOIN messages m ON m.rowid = cand.rowid
          JOIN session_messages sm ON sm.content_id = m.content_id
          LEFT JOIN sessions s ON s.session_id = sm.session_id
          ${extraClause}
        ) WHERE rn = 1
        ORDER BY indexed_at DESC, time DESC
        LIMIT ? OFFSET ?`).all(params[0], candidateBudget, ...extraParams, limit + 1, offset)) as Array<Record<string, unknown>>

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const items: MessageHit[] = page.map((row) => {
      const textMain = String(row.text_main ?? '')
      const textTool = String(row.text_tool ?? '')
      const lowerQ = q.toLowerCase()
      const mainHit = textMain.toLowerCase().includes(lowerQ)
      const field: 'main' | 'tool' = mainHit ? 'main' : 'tool'
      const source = field === 'main' ? textMain : textTool
      return {
        sessionId: String(row.session_id),
        seq: Number(row.seq),
        kind: row.kind as MessageKind,
        time: Number(row.time),
        turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
        sessionTitle: row.title === null || row.title === undefined ? null : String(row.title),
        cwd: row.cwd === null || row.cwd === undefined ? null : String(row.cwd),
        snippet: makeSnippet(source, q),
        hitField: field,
        child: row.subagent_kind === 'child',
        parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
      }
    })
    return { items, nextOffset: hasMore ? offset + limit : null }
  }

  /** 会话总览：摘要 + 过滤（不加载完整消息）。 */
  timeline(options: { from?: number; to?: number; limit?: number; query?: string; kinds?: TimelineNodeKind[]; cwd?: string; sort?: 'updated' | 'created' | 'messages' } = {}): TimelineNode[] {
    const limit = Math.min(Math.max(options.limit ?? 500, 1), 1000)
    const where: string[] = []
    const params: (number | string)[] = []
    if (typeof options.from === 'number') { where.push('updated_at >= ?'); params.push(options.from) }
    if (typeof options.to === 'number') { where.push('updated_at <= ?'); params.push(options.to) }
    if (options.cwd !== undefined && options.cwd !== '') { where.push("cwd LIKE ? ESCAPE '\\'"); params.push('%' + SessionIndex.escapeLike(options.cwd) + '%') }
    const kinds = options.kinds?.filter(k => k === 'main' || k === 'child') ?? []
    if (kinds.length === 1) { where.push('subagent_kind = ?'); params.push(kinds[0]) }
    const q = options.query?.trim()
    if (q !== undefined && q !== '') {
      const like = '%' + SessionIndex.escapeLike(q) + '%'
      where.push("(COALESCE(title, '') LIKE ? ESCAPE '\\' OR COALESCE(cwd, '') LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\')")
      params.push(like, like, like)
    }
    const order = options.sort === 'created' ? 'created_at DESC' : options.sort === 'messages' ? 'message_count DESC, updated_at DESC' : 'updated_at DESC'
    const rows = this.db.prepare(`SELECT session_id, title, cwd, created_at, updated_at, message_count, tool_count, subagent_kind, parent_session_id
      FROM sessions
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY ${order} LIMIT ?`).all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((row) => this.timelineNode(row))
  }

  private timelineNode(row: Record<string, unknown>): TimelineNode {
    const sessionId = String(row.session_id)
    const messages = this.db.prepare(`SELECT m.seq, m.kind, m.time, m.turn, m.text_main, m.text_tool
      FROM session_messages sm JOIN messages m ON m.content_id = sm.content_id
      WHERE sm.session_id = ? ORDER BY m.time ASC, m.seq ASC LIMIT 1`).all(sessionId) as Array<Record<string, unknown>>
    const latest = this.db.prepare(`SELECT m.seq, m.kind, m.time, m.turn, m.text_main, m.text_tool
      FROM session_messages sm JOIN messages m ON m.content_id = sm.content_id
      WHERE sm.session_id = ? ORDER BY m.time DESC, m.seq DESC LIMIT 1`).all(sessionId) as Array<Record<string, unknown>>
    const summary = (r: Record<string, unknown> | undefined): TimelineMessageSummary | null => r === undefined ? null : ({
      seq: Number(r.seq), kind: r.kind as MessageKind, time: Number(r.time), turn: r.turn == null ? null : Number(r.turn),
      text: String(r.text_main || r.text_tool || '').slice(0, 240),
    })
    return {
      sessionId, title: row.title == null ? null : String(row.title), cwd: row.cwd == null ? null : String(row.cwd),
      createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), messageCount: Number(row.message_count), toolCount: Number(row.tool_count),
      kind: row.subagent_kind === 'child' ? 'child' : 'main', parentSessionId: row.parent_session_id == null ? null : String(row.parent_session_id),
      firstMessage: summary(messages[0]), latestMessage: summary(latest[0]),
    }
  }

  /** 单会话二级时间线：按 turn 聚合的消息序列（时间升序）。 */
  turns(sessionId: string, limit = 200): TimelineTurn[] {
    const cap = Math.min(Math.max(limit, 1), 500)
    const rows = this.db.prepare(`SELECT m.seq, m.kind, m.time, m.turn, m.text_main, m.text_tool
      FROM session_messages sm JOIN messages m ON m.content_id = sm.content_id
      WHERE sm.session_id = ? ORDER BY m.time ASC, m.seq ASC LIMIT ?`).all(sessionId, cap) as Array<Record<string, unknown>>
    return rows.map((row) => ({
      seq: Number(row.seq),
      kind: (row.kind as MessageKind),
      time: Number(row.time),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      // tool 条目正文在 text_tool（工具名/参数/错误摘要）；其余类型在 text_main。
      text: String(row.text_main || row.text_tool || '').slice(0, 200),
    }))
  }

  /** 预览页：焦点消息 + 相邻窗口。 */
  preview(sessionId: string, seq: number, options: PreviewOptions = {}): PreviewPage | null {
    const before = Math.min(Math.max(options.before ?? 20, 0), 50)
    const after = Math.min(Math.max(options.after ?? 20, 0), 50)

    const focus = this.db.prepare(`SELECT m.seq, m.kind, m.time, m.turn, m.text_main, m.text_tool
      FROM session_messages sm JOIN messages m ON m.content_id = sm.content_id
      WHERE sm.session_id = ? AND m.seq = ?`).get(sessionId, seq) as Record<string, unknown> | undefined
    if (!focus) return null

    const beforeRows = this.db.prepare(`SELECT m.seq, m.kind, m.time, m.turn, m.text_main, m.text_tool
      FROM session_messages sm JOIN messages m ON m.content_id = sm.content_id
      WHERE sm.session_id = ? AND m.seq < ? ORDER BY m.seq DESC LIMIT ?`)
      .all(sessionId, seq, before) as Array<Record<string, unknown>>
    const afterRows = this.db.prepare(`SELECT m.seq, m.kind, m.time, m.turn, m.text_main, m.text_tool
      FROM session_messages sm JOIN messages m ON m.content_id = sm.content_id
      WHERE sm.session_id = ? AND m.seq > ? ORDER BY m.seq ASC LIMIT ?`)
      .all(sessionId, seq, after) as Array<Record<string, unknown>>

    const session = this.db.prepare('SELECT title, cwd, subagent_kind, parent_session_id FROM sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined

    const toMessage = (row: Record<string, unknown>): IndexableMessage => ({
      sessionId: String(row.session_id),
      seq: Number(row.seq),
      kind: row.kind as MessageKind,
      time: Number(row.time),
      turn: row.turn === null || row.turn === undefined ? null : Number(row.turn),
      textMain: String(row.text_main ?? ''),
      textTool: String(row.text_tool ?? ''),
    })

    return {
      sessionId,
      sessionTitle: session?.title === null || session?.title === undefined ? null : String(session?.title ?? null),
      cwd: session?.cwd === null || session?.cwd === undefined ? null : String(session?.cwd ?? null),
      child: session?.subagent_kind === 'child',
      parentSessionId: session?.parent_session_id == null ? null : String(session.parent_session_id),
      focus: toMessage(focus),
      context: [...beforeRows.reverse(), ...afterRows].map(toMessage),
    }
  }

  /** 索引健康状态（与外部已知会话列表对比）。 */
  indexStatus(knownSessionIds: string[]): IndexStatus {
    const indexedRows = this.db.prepare('SELECT session_id, indexed_at, error FROM sessions').all() as Array<Record<string, unknown>>
    const known = new Set(knownSessionIds)
    const failedIds = new Set<string>()
    const indexedOk = new Set<string>()
    for (const row of indexedRows) {
      const id = String(row.session_id)
      if (row.error !== null && row.error !== undefined) failedIds.add(id)
      else indexedOk.add(id)
    }
    // 待同步 = 磁盘有但既未成功索引、也未标记失败
    const stale = knownSessionIds.filter((id) => !indexedOk.has(id) && !failedIds.has(id))
    // 幽灵 = 索引里有（成功或失败）但磁盘已不存在
    const ghost = indexedRows.filter((row) => !known.has(String(row.session_id)))
    let lastSyncAt: number | null = null
    for (const row of indexedRows) {
      const value = Number(row.indexed_at)
      if (lastSyncAt === null || value > lastSyncAt) lastSyncAt = value
    }
    // 成功索引数只算「磁盘存在」的（排除幽灵），避免 337/336 溢出
    const indexedSessions = knownSessionIds.filter((id) => indexedOk.has(id)).length
    return {
      totalSessions: knownSessionIds.length,
      indexedSessions,
      staleSessions: stale.length,
      failedSessions: failedIds.size,
      lastSyncAt,
      ghostSessions: ghost.length,
    }
  }

  /** 会话的索引行数（测试/诊断用）。 */
  countMessages(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM session_messages WHERE session_id = ?').get(sessionId) as { n: number }
    return row.n
  }

  /** 会话元数据快照（同步层判断是否过期用）。 */
  sessionMeta(sessionId: string): { indexedAt: number; messageCount: number } | null {
    const row = this.db.prepare('SELECT indexed_at, message_count FROM sessions WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined
    if (!row) return null
    return { indexedAt: Number(row.indexed_at), messageCount: Number(row.message_count) }
  }

  /** 记录一个会话索引失败（损坏等），供 indexStatus 区分「待同步」与「损坏」。 */
  markFailed(sessionId: string, error: string): void {
    this.db.prepare(`INSERT INTO sessions(session_id, title, cwd, created_at, updated_at, message_count, tool_count, indexed_at, error)
      VALUES (?, NULL, NULL, 0, 0, 0, 0, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET error = excluded.error, indexed_at = excluded.indexed_at`)
      .run(sessionId, Date.now(), error)
  }

  /** 读当前索引的全部 session_id → 指纹映射（增量重建 diff 用）。 */
  listFingerprints(): Map<string, string | null> {
    const rows = this.db.prepare('SELECT session_id, log_fingerprint FROM sessions').all() as Array<Record<string, unknown>>
    const map = new Map<string, string | null>()
    for (const row of rows) map.set(String(row.session_id), row.log_fingerprint === null || row.log_fingerprint === undefined ? null : String(row.log_fingerprint))
    return map
  }

  /** 读当前索引的全部 session_id → revision 映射（增量重建快速 diff 用）。 */
  listRevisions(): Map<string, string | null> {
    const rows = this.db.prepare('SELECT session_id, log_revision FROM sessions').all() as Array<Record<string, unknown>>
    const map = new Map<string, string | null>()
    for (const row of rows) map.set(String(row.session_id), row.log_revision === null || row.log_revision === undefined ? null : String(row.log_revision))
    return map
  }

  /** 索引库健康检查：integrity + 关键表存在 + FTS 可查询。 */
  healthCheck(): { healthy: boolean; problems: string[] } {
    const problems: string[] = []
    try {
      const integrity = this.db.prepare('PRAGMA integrity_check').all() as Array<Record<string, unknown>>
      const ok = integrity.every((row) => String(row.integrity_check) === 'ok')
      if (!ok) problems.push('integrity_check failed')
    } catch (error) {
      problems.push('integrity_check error: ' + (error instanceof Error ? error.message : String(error)))
    }
    try {
      this.db.prepare('SELECT COUNT(*) FROM messages').get()
      this.db.prepare('SELECT COUNT(*) FROM messages_fts').get()
    } catch (error) {
      problems.push('required tables missing/unreadable: ' + (error instanceof Error ? error.message : String(error)))
    }
    return { healthy: problems.length === 0, problems }
  }

  /** 清空全部索引（全量重建前的原子 reset）。 */
  reset(): void {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec(`INSERT INTO messages_fts(messages_fts, rowid, text_main, text_tool)
        SELECT 'delete', rowid, text_main, text_tool FROM messages`)
      this.db.exec('DELETE FROM messages')
      this.db.exec('DELETE FROM session_messages')
      this.db.exec('DELETE FROM sessions')
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 索引库维护：FTS merge/optimize 回收倒排空洞 + WAL checkpoint 截断。
   * 在同步事务完成后调用（低频：增量同步后 / rebuild 后），避开写高峰。
   * 失败静默（维护是尽力而为，不影响主流程）。
   */
  maintain(): { optimized: boolean; checkpointed: boolean } {
    let optimized = false
    let checkpointed = false
    try {
      this.db.exec(`INSERT INTO messages_fts(messages_fts) VALUES('optimize')`)
      optimized = true
    } catch { /* FTS optimize 失败不影响主流程 */ }
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      checkpointed = true
    } catch { /* WAL 可能被并发读占用 */ }
    return { optimized, checkpointed }
  }
}
