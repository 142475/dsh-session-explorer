# Handoff: session-explorer SQLite 膨胀 + 会话分组调查 (2026-09-09)

> 面向接手开发的 agent。事实均来自一手取证(sqlite3 直查 + 源码定位),非猜测。
> 相关会话: session-explorer-1 (已删, uuid 含 06142e9c-… 等多条历史)、session-explorer-2。
> 现场时间: 2026-09-09 12:08~12:10, 宿主 dsh web (deepseek-harness) 正常运行中。

## TL;DR
1. **删除会话的代码路径是干净的** —— 无需修删除逻辑。
2. **真正的技术债: `session-explorer.sqlite` 已达 859MB**,其中 `messages_fts_data` 615MB + `messages` 248MB;只有 797 sessions / 44 万 messages。FTS5 **trigram** 索引是体积大头,且疑似**无任何自动 checkpoint/VACUUM 策略**。
3. **需排查的疑点**:
   - FTS trigram 索引为何如此巨大(615MB / 44 万行 ≈ 1.4KB/行)? 是否合理?
   - 是否存在**同一会话重复索引**或**极端大文本消息**造成放大?
   - 是否有 `wal_checkpoint` / `VACUUM` / `optimize` 的定期策略? 目前源码未发现。
   - "未分组"会话的判定逻辑在哪(疑似宿主 ACP 侧而非插件)?

## 一手数据 (2026-09-09 12:09, sqlite3 CLI 直查)
```
库:        /root/.dsh/storages/session-explorer.sqlite
库大小:    859MB (900,481,024 B)
WAL:       29MB (未 checkpoint, 609 页)
sessions:  797
messages:  441,331 → dbstat 中 437,510 (差异来自并发写入)
孤儿消息:  0 (已删除 session 无残留,证明 deleteSession 干净)

PRAGMA freelist_count:  8959 页 (~35MB 可回收)
PRAGMA page_size:       4096
journal_mode:           wal

每表占用 (dbstat, bytes / pages):
  messages_fts_data   615,526,400 / 150,275  ← 大头
  messages            248,164,352 / 60,587
  idx_messages_session_seq  24,645,632 / 6,017
  idx_messages_time          7,352,320 / 1,795
  messages_fts_docsize       5,197,824 / 1,269
  messages_fts_idx           1,167,360 / 285
  sessions                    196,608 / 48

messages 行长统计: avg(text_main+text_tool)=341 B, max=23,315 B
```

### 关键观察
- **不是碎片为主**: freelist 只占 ~35MB;大头是 `messages_fts_data`(FTS5 的 trigram 倒排内容表)。trigram 会把每个 ≥3 字符的连续三字符组都建 token,对中文/长文本放大倍数极大。
- FTS5 建表 SQL(源码 indexer.ts:104-108):
  ```sql
  CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text_main, text_tool,
      content='messages',
      content_rowid='rowid',
      tokenize='trigram'
    )
  ```
- sqlite3 CLI 报 `no such tokenizer: trigram` 是 CLI 编译缺 tokenizer,**不代表运行时坏**(宿主 node 的 sqlite 若带 trigram 则可正常查)。验证需用插件实际运行的 better-sqlite3。

## 代码位置
- 插件仓库: `/root/proj/dsh-proj/dsh-session-explorer`(本地有未提交改动,见下)
- `src/indexer.ts`(555 行): 全部 SQLite/FTS 逻辑
  - L78-110: sessions/messages/`messages_fts` 建表(trigram)
  - L196-230: 单条消息插入(upsert messages + FTS)
  - L251-260: `deleteSession()` —— 事务内先 FTS 'delete' 再删 messages/sessions,已确认干净
  - L297-330: FTS 查询(GROUP BY + bm25)
  - L522+: `healthCheck()` 只做 integrity_check + 表存在 + FTS 可查,无体积/维护项
- `src/index.ts`(443 行): 事件同步(agent/turn-stopping 增量 + 启动对账 + 手动 rebuild)
  - L247-290: rebuild 逻辑(全量/单会话)
- **全仓 grep 未见**: `VACUUM` / `wal_checkpoint` / `PRAGMA optimize` / 定期维护 —— 疑似缺失

## 疑似问题 & 建议排查顺序
1. **FTS 膨胀** (P1): 44 万消息 × trigram → 615MB 是否预期? 若中文为主,trigram 的放大可能失控。可选方向:
   - 实测 `INSERT INTO messages_fts(messages_fts) VALUES('optimize')` 后体积变化
   - 对比方案: 换 `tokenize='unicode61'`(中文需自行分词) 或保留 trigram 但加维护
   - 评估是否真的需要全消息 FTS(43 万行搜索场景)
2. **缺少自动维护** (P2): 加启动/空闲时 `wal_checkpoint(TRUNCATE)` + 低频 `VACUUM` 或 `optimize`;建议低频(如启动后延迟 + 每 N 小时),避免与写入争锁。
3. **重复索引 / 重复会话** (P2): 库里有多个同名 "session-explorer-1"(不同 uuid, message_count 3821~5122),需确认是历史重命名残留还是重复索引 bug。同 cwd 多会话正常(每次运行新 uuid),但要确认 rebuild 是否对同一 log 重复插入。
4. **分组/未分组语义** (P3): 插件的 session 列表分组(未分组/文件夹)逻辑在 host 还是 client? 查 `TimelineView.tsx` / `store.ts` 未见分组词,疑似 host ACP 侧按 cwd 聚合 —— 需开发确认删除会话后"未分组"如何产生/消除。

## 环境注意
- 插件本地仓库 **有未提交改动**(M: App.tsx / bundle-entry.ts / i18n.ts / styles.css / PreviewView / SearchView / TimelineView / index.ts / indexer.ts / protocol.ts)——宿主当前运行的很可能是这些改到一半的源码,排查时先 `git diff` 确认基线,避免把 WIP 当已发布行为。
- 已发布 tag: `v0.4.2`(HEAD 之后有 2 个 docs commit,工作区仍有 M 改动未提交)。
- DB 正在被宿主 dsh web(pid 2387345, 127.0.0.1:3080)持有打开(-wal/-shm)。**不要直接 VACUUM 正在被写的库**(会锁/损坏风险);需在插件停写窗口或复制副本上实验。
- 复现/验证建议: 复制 DB 到临时目录实验 VACUUM/optimize,勿在线上库直接跑破坏性命令。

## 交付物建议
- 一份根因说明: 615MB FTS 是否合理 + 是否加维护策略
- 若需改代码: 维护策略(低频 checkpoint/vacuum) + 相关单测
- 分组语义的结论(host vs plugin)记录在此文档或 issue
