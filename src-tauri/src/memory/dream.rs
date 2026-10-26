// 记忆升级包（ROADMAP ③，v0.2.9）：语义召回 + 访问统计 + Dream 数值巩固。
//
// markdown 文件是真相源；本文件只为 memory-index.sqlite3 增加三张**新表**
// （memory_access_stats / memory_embeddings / memory_state，见 schema.rs
// ensure_memory_v5_tables），不进 rebuild 白名单也不在 DROP 列表，reconcile
// 重建后原样保留。canonical frontmatter 渲染器零改动。
//
// - 语义召回：embeddings ⋈ meta ⋈ stats 全量余弦（记忆受 500/作用域配额
//   约束，无需缓存层），打分公式对齐 docs/ROADMAP.md ③：
//   0.4×cos + 0.3×importance + 0.2×exp(-0.05×闲置天数) + 0.1×log(1+访问次数)/log(51)
//   检索即回写（last_accessed_at / access_count）——越常被想起越牢固，
//   这是 Dream 衰减不误杀活跃记忆的前提。
// - Dream：纯数值巩固（合并→衰减→遗忘，顺序固定），全程无 LLM；合并只留
//   keeper 原文，被吸收条目走 delete_inner 进 .trash（可手工恢复，audit
//   完整记录）。运行记录复用 memory_organize_runs（mode='dream'），与
//   organizer 共享单飞互斥。
// - 向量数学复用 crate::knowledge_index 的 helper（单一真值源，Red Check
//   同缝）。daily 不参与（日志型条目按天滚动，语义价值低且churn大）。

use crate::knowledge_index::{cosine_with_norm, f32_vec_to_le_bytes, le_bytes_to_f32_vec, l2_norm};

const DREAM_MERGE_THRESHOLD: f32 = 0.85;
const DREAM_DECAY_DAYS: i64 = 30;
const DREAM_DECAY_FACTOR: f32 = 0.8;
const DREAM_FORGET_DAYS: i64 = 180;
const DREAM_FORGET_IMPORTANCE: f32 = 0.15;
const IMPORTANCE_FLOOR: f32 = 0.05;
const IMPORTANCE_CEILING: f32 = 1.0;
const RECALL_WEIGHT_SIM: f32 = 0.4;
const RECALL_WEIGHT_IMPORTANCE: f32 = 0.3;
const RECALL_WEIGHT_DECAY: f32 = 0.2;
const RECALL_WEIGHT_FREQ: f32 = 0.1;
const RECALL_FREQ_LOG_DENOM: f32 = 51.0; // log(1+50)/log(51) ≈ 1：50 次封顶
const SEMANTIC_DEFAULT_TOP_K: usize = 5;
const SEMANTIC_MAX_TOP_K: usize = 20;
const EMBED_TEXT_MAX_CHARS: usize = 2000;

const STATE_KEY_EMBED_MODEL: &str = "embedding_model_id";
const STATE_KEY_EMBED_DIMS: &str = "embedding_dims";

// ==================== DTO ====================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEmbedScanEntry {
    pub scope: String,
    pub workdir_hash: String,
    pub slug: String,
    pub body_hash: String,
    pub memory_type: String,
    pub embed_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEmbedStoredRow {
    pub scope: String,
    pub workdir_hash: String,
    pub slug: String,
    pub body_hash: String,
    pub dims: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEmbedScanResponse {
    pub entries: Vec<MemoryEmbedScanEntry>,
    pub stored: Vec<MemoryEmbedStoredRow>,
    pub model_id: String,
    pub dims: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEntryKey {
    pub scope: String,
    #[serde(default)]
    pub workdir_hash: String,
    pub slug: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEmbedUpsertItem {
    pub scope: String,
    #[serde(default)]
    pub workdir_hash: String,
    pub slug: String,
    pub body_hash: String,
    pub embedding: Vec<f32>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEmbedUpsertArgs {
    pub items: Vec<MemoryEmbedUpsertItem>,
    pub model_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySemanticSearchArgs {
    pub query_embedding: Vec<f32>,
    #[serde(default)]
    pub top_k: Option<usize>,
    /// 当前工作区（project 作用域过滤）；None = 仅 global
    #[serde(default)]
    pub workdir: Option<String>,
    /// 会话作用域检索键（taskId；None/空 = 不含 session 路）
    #[serde(default)]
    pub session_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySemanticHit {
    pub scope: String,
    pub workdir_hash: String,
    pub slug: String,
    pub memory_type: String,
    pub description: String,
    pub headline: String,
    pub score: f32,
    pub importance: f32,
    pub access_count: i64,
    /// 正文节选（命中后按条读文件，≤500 字符）
    pub body_excerpt: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDreamArgs {
    #[serde(default)]
    pub dry_run: bool,
    /// 'manual' | 'scheduled'（organize_runs trigger 枚举）
    #[serde(default)]
    pub trigger: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDreamReport {
    pub dry_run: bool,
    pub merged: usize,
    pub decayed: usize,
    pub forgotten: usize,
    pub remaining: usize,
    pub duration_ms: i64,
    pub run_id: Option<String>,
    /// dry_run 时的计划明细（keeper ← absorbed）
    pub planned_merges: Vec<MemoryDreamMergePlan>,
    pub skipped_reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDreamMergePlan {
    pub keeper: MemoryEntryKey,
    pub keeper_importance: f32,
    pub absorbed: Vec<MemoryEntryKey>,
}

// ==================== 纯函数（Red Check 缝）====================

/// 召回打分。`days_idle` = 距上次访问的天数（无访问记录时调用方回退 updated_at）。
fn recall_score(
    similarity: f32,
    importance: f32,
    days_idle: f32,
    access_count: i64,
) -> f32 {
    let decay = (-0.05f32 * days_idle.max(0.0)).exp();
    let freq = (1.0 + access_count.max(0) as f32).ln() / RECALL_FREQ_LOG_DENOM.ln();
    RECALL_WEIGHT_SIM * similarity
        + RECALL_WEIGHT_IMPORTANCE * importance.clamp(0.0, IMPORTANCE_CEILING)
        + RECALL_WEIGHT_DECAY * decay
        + RECALL_WEIGHT_FREQ * freq
}

fn importance_default_for_type(memory_type: &str) -> f32 {
    match memory_type {
        "user" => 0.8,
        "feedback" => 0.7,
        "project" => 0.6,
        _ => 0.5,
    }
}

/// Dream 贪心聚类（纯函数，测试缝）：rows 按 importance 降序消费，
/// 与已有簇代表余弦 ≥ threshold 即入簇，否则自立新簇。
/// 返回：每簇（代表下标, 成员下标们）。跨 (scope, workdir_hash) 不合并
/// （调用方先按组拆分）。
fn dream_cluster(
    rows: &[DreamRow],
    threshold: f32,
) -> Vec<Vec<usize>> {
    let mut clusters: Vec<Vec<usize>> = Vec::new();
    for (idx, row) in rows.iter().enumerate() {
        let mut joined = false;
        for cluster in &mut clusters {
            let rep = &rows[cluster[0]];
            let sim = cosine_with_norm(&row.embedding, &rep.embedding, l2_norm(&rep.embedding));
            if sim >= threshold {
                cluster.push(idx);
                joined = true;
                break;
            }
        }
        if !joined {
            clusters.push(vec![idx]);
        }
    }
    clusters
}

/// Dream 内部行（已 join meta+stats）
#[derive(Debug, Clone)]
struct DreamRow {
    scope: String,
    workdir_hash: String,
    slug: String,
    importance: f32,
    access_count: i64,
    last_accessed_at: i64,
    created_at: i64,
    embedding: Vec<f32>,
}

fn dream_scope_rank(scope: &str) -> u8 {
    if scope == "global" {
        0
    } else {
        1
    }
}

// ==================== Store 实现 ====================

impl MemoryStore {
    fn dream_state_get(conn: &rusqlite::Connection, key: &str) -> Result<Option<String>, String> {
        conn.query_row(
            "SELECT value FROM memory_state WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|e| format!("读取 memory_state 失败：{e}"))
    }

    fn dream_state_set(conn: &rusqlite::Connection, key: &str, value: &str) -> Result<(), String> {
        conn.execute(
            "INSERT INTO memory_state (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, value],
        )
        .map_err(|e| format!("写入 memory_state 失败：{e}"))?;
        Ok(())
    }

    /// 扫描全部可嵌入记忆（非 daily）+ 现有向量行。正文按 path_for_meta 读文件
    /// 并剥 frontmatter；embed_text = headline + description + body（截 2000 字符）。
    pub fn embed_scan(&self) -> Result<MemoryEmbedScanResponse, String> {
        let conn = self.lock_conn()?;
        let metas = load_all_meta(&conn)?;
        let mut entries = Vec::new();
        for meta in &metas {
            if meta.memory_type == "daily" || meta.archived {
                continue;
            }
            let path = self.path_for_meta(meta)?;
            let raw = match fs_read_to_string(&path) {
                Some(raw) => raw,
                None => continue, // 文件缺失：索引滞后，等 reconcile 自愈
            };
            let body = split_frontmatter(&raw).1;
            let mut embed_text = format!("{}\n{}\n{}", meta.headline, meta.description, body);
            if embed_text.len() > EMBED_TEXT_MAX_CHARS {
                embed_text = embed_text.chars().take(EMBED_TEXT_MAX_CHARS).collect();
            }
            let body_hash = to_hex(&Sha256::digest(body.as_bytes()));
            entries.push(MemoryEmbedScanEntry {
                scope: meta.scope.clone(),
                workdir_hash: meta.workdir_hash.clone(),
                slug: meta.slug.clone(),
                body_hash,
                memory_type: meta.memory_type.clone(),
                embed_text,
            });
        }
        let mut stored = Vec::new();
        let mut stmt = conn
            .prepare(
                "SELECT scope, workdir_hash, slug, body_hash, dims FROM memory_embeddings",
            )
            .map_err(|e| format!("读取记忆向量失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok(MemoryEmbedStoredRow {
                    scope: row.get(0)?,
                    workdir_hash: row.get(1)?,
                    slug: row.get(2)?,
                    body_hash: row.get(3)?,
                    dims: row.get(4)?,
                })
            })
            .map_err(|e| format!("读取记忆向量失败：{e}"))?;
        for row in mapped {
            stored.push(row.map_err(|e| format!("读取记忆向量行失败：{e}"))?);
        }
        let model_id = Self::dream_state_get(&conn, STATE_KEY_EMBED_MODEL)?.unwrap_or_default();
        let dims = Self::dream_state_get(&conn, STATE_KEY_EMBED_DIMS)?
            .and_then(|v| v.parse().ok());
        Ok(MemoryEmbedScanResponse {
            entries,
            stored,
            model_id,
            dims,
        })
    }

    pub fn embed_upsert(&self, args: MemoryEmbedUpsertArgs) -> Result<usize, String> {
        if args.items.is_empty() {
            return Ok(0);
        }
        if args.model_id.trim().is_empty() {
            return Err("memory_embed_upsert 缺少 model_id".to_string());
        }
        let dims = args.items.first().map(|i| i.embedding.len()).unwrap_or(0);
        if dims == 0 {
            return Err("memory_embed_upsert 收到空向量".to_string());
        }
        let mut conn = self.lock_conn()?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("开启记忆向量事务失败：{e}"))?;
        let existing_model = Self::dream_state_get(&tx, STATE_KEY_EMBED_MODEL)?;
        if let Some(existing) = existing_model {
            if existing != args.model_id {
                return Err(format!(
                    "记忆 embedding 模型已变更（索引：{existing}，本次：{}）——请清空记忆向量后重建",
                    args.model_id
                ));
            }
        }
        let existing_dims: Option<i64> =
            Self::dream_state_get(&tx, STATE_KEY_EMBED_DIMS)?.and_then(|v| v.parse().ok());
        if let Some(existing) = existing_dims {
            if existing != dims as i64 {
                return Err(format!(
                    "记忆 embedding 维度已变更（索引：{existing}，本次：{dims}）——请清空记忆向量后重建"
                ));
            }
        }
        let now = now_ms();
        for item in &args.items {
            if item.embedding.len() != dims {
                return Err(format!(
                    "记忆向量维度不一致（{} vs {dims}）：{}",
                    item.embedding.len(),
                    item.slug
                ));
            }
            tx.execute(
                "INSERT INTO memory_embeddings (scope, workdir_hash, slug, body_hash, embedding, dims, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(scope, workdir_hash, slug) DO UPDATE SET
                    body_hash = excluded.body_hash,
                    embedding = excluded.embedding,
                    dims = excluded.dims,
                    updated_at = excluded.updated_at",
                params![
                    item.scope,
                    item.workdir_hash,
                    item.slug,
                    item.body_hash,
                    f32_vec_to_le_bytes(&item.embedding),
                    dims as i64,
                    now,
                ],
            )
            .map_err(|e| format!("写入记忆向量失败：{e}"))?;
        }
        Self::dream_state_set(&tx, STATE_KEY_EMBED_MODEL, args.model_id.trim())?;
        Self::dream_state_set(&tx, STATE_KEY_EMBED_DIMS, &dims.to_string())?;
        tx.commit()
            .map_err(|e| format!("提交记忆向量事务失败：{e}"))?;
        Ok(args.items.len())
    }

    pub fn embed_delete_keys(&self, keys: &[MemoryEntryKey]) -> Result<usize, String> {
        let conn = self.lock_conn()?;
        let mut deleted = 0;
        for key in keys {
            deleted += conn
                .execute(
                    "DELETE FROM memory_embeddings WHERE scope=?1 AND workdir_hash=?2 AND slug=?3",
                    params![key.scope, key.workdir_hash, key.slug],
                )
                .map_err(|e| format!("删除记忆向量失败：{e}"))?;
        }
        Ok(deleted)
    }

    /// 语义检索 + 回写一体。scope 过滤 = global ∪ project(当前 workdir)。
    /// 命中即回写 last_accessed_at / access_count（正反馈，Dream 衰减依赖）。
    pub fn semantic_search(&self, args: MemorySemanticSearchArgs) -> Result<Vec<MemorySemanticHit>, String> {
        if args.query_embedding.is_empty() {
            return Err("记忆语义检索查询向量为空".to_string());
        }
        let top_k = args.top_k.unwrap_or(SEMANTIC_DEFAULT_TOP_K).clamp(1, SEMANTIC_MAX_TOP_K);
        let workdir_hash = match args.workdir.as_deref() {
            Some(workdir) if !workdir.trim().is_empty() => Some(workdir_hash(workdir)?),
            _ => None,
        };
        // 会话作用域（v2 尾巴 ③）：三路并集 = global ∪ project(workdir) ∪ session(taskId)
        let session_hash = args
            .session_id
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(session_hash);
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT e.scope, e.workdir_hash, e.slug, e.embedding, e.dims,
                       m.type, m.description, m.headline, m.updated_at,
                       COALESCE(s.importance, 0.5), COALESCE(s.access_count, 0),
                       COALESCE(s.last_accessed_at, 0)
                FROM memory_embeddings e
                JOIN memory_meta m
                    ON m.scope = e.scope AND m.workdir_hash = e.workdir_hash AND m.slug = e.slug
                LEFT JOIN memory_access_stats s
                    ON s.scope = e.scope AND s.workdir_hash = e.workdir_hash AND s.slug = e.slug
                WHERE m.type != 'daily' AND m.archived = 0
                  AND (m.scope = 'global'
                       OR (m.scope = 'project' AND m.workdir_hash = ?1)
                       OR (?2 IS NOT NULL AND m.scope = 'session' AND m.workdir_hash = ?2))
                "#,
            )
            .map_err(|e| format!("记忆语义检索查询失败：{e}"))?;
        let mapped = stmt
            .query_map(params![workdir_hash.as_deref().unwrap_or(""), session_hash.as_deref()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, f64>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                ))
            })
            .map_err(|e| format!("记忆语义检索查询失败：{e}"))?;

        let now = now_ms();
        struct Scored {
            hit: MemorySemanticHit,
        }
        let mut scored: Vec<Scored> = Vec::new();
        for row in mapped {
            let (scope, whash, slug, bytes, dims, memory_type, description, headline, updated_at, importance, access_count, last_accessed_at) =
                row.map_err(|e| format!("读取记忆语义行失败：{e}"))?;
            if dims as usize != args.query_embedding.len() {
                continue; // 混维行跳过（state 守卫已挡主流场景，这里兜底）
            }
            let embedding = le_bytes_to_f32_vec(&bytes);
            let sim = cosine_with_norm(&args.query_embedding, &embedding, 1.0);
            let last = if last_accessed_at > 0 { last_accessed_at } else { updated_at };
            let days_idle = ((now - last).max(0) / 86_400_000) as f32;
            let score = recall_score(sim, importance as f32, days_idle, access_count);
            scored.push(Scored {
                hit: MemorySemanticHit {
                    scope,
                    workdir_hash: whash,
                    slug,
                    memory_type,
                    description,
                    headline,
                    score,
                    importance: importance as f32,
                    access_count,
                    body_excerpt: String::new(),
                },
            });
        }
        if scored.is_empty() {
            return Ok(Vec::new());
        }
        if scored.len() > top_k {
            scored.select_nth_unstable_by(top_k - 1, |a, b| b.hit.score.total_cmp(&a.hit.score));
            scored.truncate(top_k);
        }
        scored.sort_by(|a, b| b.hit.score.total_cmp(&a.hit.score));

        // 正文节选：只对 top-K 命中按条读文件（≤500 字符）
        for item in scored.iter_mut() {
            let meta = MemoryMeta {
                slug: item.hit.slug.clone(),
                scope: item.hit.scope.clone(),
                workdir_hash: item.hit.workdir_hash.clone(),
                workdir_path: None,
                memory_type: item.hit.memory_type.clone(),
                description: item.hit.description.clone(),
                headline: item.hit.headline.clone(),
                date_local: None,
                created_at: 0,
                updated_at: 0,
                append_count: 0,
                archived: false,
                unreviewed: false,
                confidence: String::new(),
                file_size: 0,
            };
            if let Ok(path) = self.path_for_meta(&meta) {
                if let Some(raw) = fs_read_to_string(&path) {
                    let body = split_frontmatter(&raw).1;
                    let mut excerpt = body.trim().chars().take(500).collect::<String>();
                    if body.trim().chars().count() > 500 {
                        excerpt.push_str("…[truncated]");
                    }
                    item.hit.body_excerpt = excerpt;
                }
            }
        }

        // 回写（正反馈）
        for item in &scored {
            conn.execute(
                "INSERT INTO memory_access_stats (scope, workdir_hash, slug, importance, access_count, last_accessed_at)
                 VALUES (?1, ?2, ?3, 0.5, 1, ?4)
                 ON CONFLICT(scope, workdir_hash, slug) DO UPDATE SET
                    last_accessed_at = ?4,
                    access_count = memory_access_stats.access_count + 1",
                params![item.hit.scope, item.hit.workdir_hash, item.hit.slug, now],
            )
            .map_err(|e| format!("记忆召回回写失败：{e}"))?;
        }
        Ok(scored.into_iter().map(|s| s.hit).collect())
    }

    /// Dream 数值巩固：合并（贪心聚类 ≥0.85，组内=同 scope+workdir_hash）→
    /// 衰减（闲置 >30d 且 importance>0.05 → ×0.8）→ 遗忘（闲置 >180d 且
    /// importance<0.15 → delete_inner 进 .trash）。dry_run 只出计划。
    pub fn dream_run(&self, args: MemoryDreamArgs) -> Result<MemoryDreamReport, String> {
        let started = now_ms();
        let trigger = match args.trigger.as_deref() {
            Some("scheduled") => "scheduled",
            _ => "manual",
        };
        // 单飞互斥（与 organizer 共享 active run 检查）
        let created = self.organize_run_create(MemoryOrganizeRunCreateArgs {
            trigger: trigger.to_string(),
            due_at: None,
            model: None,
            scope: Some("all".to_string()),
            mode: Some("dream".to_string()),
        })?;
        if !created.accepted {
            return Err("memory dream 被拒绝：已有整理/巩固任务在运行".to_string());
        }
        let run_id = created
            .run
            .as_ref()
            .map(|r| r.run_id.clone())
            .ok_or_else(|| "memory dream run 缺失".to_string())?;

        let outcome = self.dream_execute(&run_id, args.dry_run);
        let duration_ms = now_ms() - started;
        match outcome {
            Ok(report) => {
                let _ = self.organize_run_update(MemoryOrganizeRunUpdateArgs {
                    run_id: run_id.clone(),
                    status: Some(if args.dry_run { "skipped" } else { "succeeded" }.to_string()),
                    started_at: Some(started),
                    finished_at: Some(now_ms()),
                    merged_count: Some(report.merged as i64),
                    deleted_count: Some((report.forgotten + report.merged) as i64),
                    dry_run: Some(args.dry_run),
                    final_summary: Some(format!(
                        "dream merged={} decayed={} forgotten={}",
                        report.merged, report.decayed, report.forgotten
                    )),
                    report: Some(json!({
                        "kind": "dream",
                        "dryRun": args.dry_run,
                        "merged": report.merged,
                        "decayed": report.decayed,
                        "forgotten": report.forgotten,
                        "remaining": report.remaining,
                        "plannedMerges": report.planned_merges,
                    })),
                    ..Default::default()
                });
                Ok(MemoryDreamReport { duration_ms, run_id: Some(run_id), ..report })
            }
            Err(err) => {
                let _ = self.organize_run_update(MemoryOrganizeRunUpdateArgs {
                    run_id,
                    status: Some("failed".to_string()),
                    finished_at: Some(now_ms()),
                    error: Some(err.clone()),
                    ..Default::default()
                });
                Err(err)
            }
        }
    }

    fn dream_execute(&self, run_id: &str, dry_run: bool) -> Result<MemoryDreamReport, String> {
        let _ = run_id;
        let rows = self.dream_gather_rows()?;
        let remaining_before = rows.len();

        // ---- ① 合并：按 (scope, workdir_hash) 分组贪心聚类 ----
        let mut groups: HashMap<String, Vec<DreamRow>> = HashMap::new();
        let mut ordered: Vec<&DreamRow> = rows.iter().collect();
        ordered.sort_by(|a, b| {
            b.importance
                .total_cmp(&a.importance)
                .then_with(|| dream_scope_rank(&a.scope).cmp(&dream_scope_rank(&b.scope)))
                .then_with(|| a.created_at.cmp(&b.created_at))
        });
        for row in ordered {
            let key = format!("{}\u{0}{}", row.scope, row.workdir_hash);
            groups.entry(key).or_default().push(row.clone());
        }
        let mut planned_merges: Vec<MemoryDreamMergePlan> = Vec::new();
        let mut absorbed_keys: Vec<MemoryEntryKey> = Vec::new();
        let mut keeper_updates: Vec<(MemoryEntryKey, f32, i64, i64)> = Vec::new();
        for group in groups.values() {
            for cluster in dream_cluster(group, DREAM_MERGE_THRESHOLD) {
                if cluster.len() < 2 {
                    continue;
                }
                let keeper = &group[cluster[0]];
                let absorbed_rows: Vec<&DreamRow> =
                    cluster[1..].iter().map(|&i| &group[i]).collect();
                let keeper_imp = keeper.importance;
                let sum_access: i64 = absorbed_rows.iter().map(|r| r.access_count).sum();
                let latest_access = absorbed_rows
                    .iter()
                    .map(|r| r.last_accessed_at)
                    .max()
                    .unwrap_or(0);
                for absorbed in absorbed_rows {
                    absorbed_keys.push(MemoryEntryKey {
                        scope: absorbed.scope.clone(),
                        workdir_hash: absorbed.workdir_hash.clone(),
                        slug: absorbed.slug.clone(),
                    });
                }
                keeper_updates.push((
                    MemoryEntryKey {
                        scope: keeper.scope.clone(),
                        workdir_hash: keeper.workdir_hash.clone(),
                        slug: keeper.slug.clone(),
                    },
                    (keeper_imp + 0.05).min(IMPORTANCE_CEILING),
                    sum_access,
                    latest_access,
                ));
                planned_merges.push(MemoryDreamMergePlan {
                    keeper: MemoryEntryKey {
                        scope: keeper.scope.clone(),
                        workdir_hash: keeper.workdir_hash.clone(),
                        slug: keeper.slug.clone(),
                    },
                    keeper_importance: keeper_imp,
                    absorbed: absorbed_keys
                        .iter()
                        .filter(|k| k.slug != keeper.slug)
                        .cloned()
                        .collect(),
                });
            }
        }

        // ---- ② 衰减 / ③ 遗忘 计划（吸收者除外）----
        let now = now_ms();
        let absorbed_set: std::collections::HashSet<(String, String, String)> = absorbed_keys
            .iter()
            .map(|k| (k.scope.clone(), k.workdir_hash.clone(), k.slug.clone()))
            .collect();
        let mut decay_plans: Vec<(MemoryEntryKey, f32)> = Vec::new();
        let mut forget_plans: Vec<MemoryEntryKey> = Vec::new();
        for row in &rows {
            let key = (row.scope.clone(), row.workdir_hash.clone(), row.slug.clone());
            if absorbed_set.contains(&key) {
                continue;
            }
            let last = if row.last_accessed_at > 0 { row.last_accessed_at } else { row.created_at };
            let days_idle = (now - last).max(0) / 86_400_000;
            if days_idle > DREAM_FORGET_DAYS && row.importance < DREAM_FORGET_IMPORTANCE {
                forget_plans.push(MemoryEntryKey {
                    scope: row.scope.clone(),
                    workdir_hash: row.workdir_hash.clone(),
                    slug: row.slug.clone(),
                });
            } else if days_idle > DREAM_DECAY_DAYS && row.importance > IMPORTANCE_FLOOR {
                decay_plans.push((
                    MemoryEntryKey {
                        scope: row.scope.clone(),
                        workdir_hash: row.workdir_hash.clone(),
                        slug: row.slug.clone(),
                    },
                    (row.importance * DREAM_DECAY_FACTOR).max(IMPORTANCE_FLOOR),
                ));
            }
        }

        let merged = absorbed_keys.len();
        let forgotten = forget_plans.len();
        let decayed = decay_plans.len();
        let remaining = remaining_before - merged - forgotten;
        if dry_run {
            return Ok(MemoryDreamReport {
                dry_run: true,
                merged,
                decayed,
                forgotten,
                remaining,
                duration_ms: 0,
                run_id: None,
                planned_merges,
                skipped_reason: None,
            });
        }

        // ---- 应用（合并 → 衰减 → 遗忘，顺序固定）----
        for key in &absorbed_keys {
            self.delete_inner(
                MemoryDeleteArgs {
                    slug: key.slug.clone(),
                    scope: key.scope.clone(),
                    workdir: None,
                    workdir_hash: Some(key.workdir_hash.clone()),
                    actor: Some("reconcile".to_string()),
                    reason: Some("dream: merged into keeper".to_string()),
                    conversation_id: None,
                    model: None,
                },
                Some("memory-dream".to_string()),
            )?;
        }
        for (key, importance, access_add, latest_access) in &keeper_updates {
            self.dream_stats_apply_merge(key, *importance, *access_add, *latest_access)?;
        }
        for (key, importance) in &decay_plans {
            self.dream_stats_apply_decay(key, *importance)?;
        }
        for key in &forget_plans {
            self.delete_inner(
                MemoryDeleteArgs {
                    slug: key.slug.clone(),
                    scope: key.scope.clone(),
                    workdir: None,
                    workdir_hash: Some(key.workdir_hash.clone()),
                    actor: Some("reconcile".to_string()),
                    reason: Some("dream: forgotten (idle & low importance)".to_string()),
                    conversation_id: None,
                    model: None,
                },
                Some("memory-dream".to_string()),
            )?;
        }
        // 被吸收/遗忘条目的向量与统计行随 delete_inner 级联清理
        Ok(MemoryDreamReport {
            dry_run: false,
            merged,
            decayed,
            forgotten,
            remaining,
            duration_ms: 0,
            run_id: None,
            planned_merges,
            skipped_reason: None,
        })
    }

    /// Dream 汇总行：embeddings ⋈ meta ⋈ stats（全作用域，非 daily）。
    fn dream_gather_rows(&self) -> Result<Vec<DreamRow>, String> {
        let conn = self.lock_conn()?;
        let mut stmt = conn
            .prepare(
                r#"
                SELECT e.scope, e.workdir_hash, e.slug, e.embedding,
                       m.created_at,
                       COALESCE(s.importance, 0.5), COALESCE(s.access_count, 0),
                       COALESCE(s.last_accessed_at, 0)
                FROM memory_embeddings e
                JOIN memory_meta m
                    ON m.scope = e.scope AND m.workdir_hash = e.workdir_hash AND m.slug = e.slug
                LEFT JOIN memory_access_stats s
                    ON s.scope = e.scope AND s.workdir_hash = e.workdir_hash AND s.slug = e.slug
                WHERE m.type != 'daily' AND m.archived = 0
                "#,
            )
            .map_err(|e| format!("Dream 汇总查询失败：{e}"))?;
        let mapped = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, f64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                ))
            })
            .map_err(|e| format!("Dream 汇总查询失败：{e}"))?;
        let mut out = Vec::new();
        for row in mapped {
            let (scope, workdir_hash, slug, bytes, created_at, importance, access_count, last_accessed_at) =
                row.map_err(|e| format!("Dream 汇总行读取失败：{e}"))?;
            out.push(DreamRow {
                scope,
                workdir_hash,
                slug,
                importance: importance as f32,
                access_count,
                last_accessed_at,
                created_at,
                embedding: le_bytes_to_f32_vec(&bytes),
            });
        }
        Ok(out)
    }

    fn dream_stats_apply_merge(
        &self,
        key: &MemoryEntryKey,
        importance: f32,
        access_add: i64,
        latest_access: i64,
    ) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "UPDATE memory_access_stats
             SET importance = ?4, access_count = access_count + ?5,
                 last_accessed_at = MAX(COALESCE(last_accessed_at, 0), ?6)
             WHERE scope=?1 AND workdir_hash=?2 AND slug=?3",
            params![key.scope, key.workdir_hash, key.slug, importance, access_add, latest_access],
        )
        .map_err(|e| format!("Dream keeper 统计更新失败：{e}"))?;
        Ok(())
    }

    fn dream_stats_apply_decay(&self, key: &MemoryEntryKey, importance: f32) -> Result<(), String> {
        let conn = self.lock_conn()?;
        conn.execute(
            "INSERT INTO memory_access_stats (scope, workdir_hash, slug, importance, access_count, last_accessed_at)
             VALUES (?1, ?2, ?3, ?4, 0, 0)
             ON CONFLICT(scope, workdir_hash, slug) DO UPDATE SET importance = ?4",
            params![key.scope, key.workdir_hash, key.slug, importance],
        )
        .map_err(|e| format!("Dream 衰减更新失败：{e}"))?;
        Ok(())
    }
}

/// 读文件（不存在返回 None）——独立小包装便于测试。
fn fs_read_to_string(path: &std::path::Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

// ==================== 测试 ====================

#[cfg(test)]
mod dream_tests {
    use super::*;

    fn row(scope: &str, slug: &str, embedding: Vec<f32>, importance: f32, created_at: i64) -> DreamRow {
        DreamRow {
            scope: scope.to_string(),
            workdir_hash: String::new(),
            slug: slug.to_string(),
            importance,
            access_count: 0,
            last_accessed_at: 0,
            created_at,
            embedding,
        }
    }

    #[test]
    fn recall_score_weights_and_bounds() {
        // 相似度 1、重要度 1、当天访问、50 次封顶 → 满分 1.0
        let full = recall_score(1.0, 1.0, 0.0, 50);
        assert!((full - 1.0).abs() < 1e-4, "满分应为 1.0，实际 {full}");
        // 闲置越久衰减项越小（30 天 ≈ 0.223）
        let idle30 = recall_score(0.0, 0.0, 30.0, 0);
        let expected_decay = 0.2 * (-0.05f32 * 30.0).exp();
        assert!((idle30 - expected_decay).abs() < 1e-4);
        // 负闲置天数不产生增益
        assert!(recall_score(0.0, 0.0, -100.0, 0) <= 0.21);
    }

    #[test]
    fn dream_cluster_nontrivial_distribution() {
        // ⚠ Red Check 教训：阈值破坏必须能被非平凡分布捕捉——
        // a≈b（0.99）、c 居中（0.93）、d 远（0.55）。阈值 0.85 → {a,b,c},{d}；
        // 若阈值被破坏成 0.1 → 全并一簇；0.99 → 各自成簇。
        let a = vec![1.0f32, 0.0, 0.0];
        let b = vec![0.99, 0.05, 0.0];
        let c = vec![0.93, 0.12, 0.0];
        let d = vec![0.55, 0.5, 0.0];
        let rows = vec![
            row("global", "a", a, 0.9, 1),
            row("global", "b", b, 0.8, 2),
            row("global", "c", c, 0.7, 3),
            row("global", "d", d, 0.6, 4),
        ];
        let clusters = dream_cluster(&rows, DREAM_MERGE_THRESHOLD);
        assert_eq!(clusters.len(), 2, "期望 a/b/c 与 d 两簇，实际 {:?}", clusters);
        assert_eq!(clusters[0].len(), 3, "首簇应为 a,b,c 三成员");
        assert_eq!(clusters[1].len(), 1);
        // 阈值提到 0.999（a/b 余弦 ≈0.9988）→ 全部散开
        assert_eq!(dream_cluster(&rows, 0.999).len(), 4);
        // 阈值归零 → 全并一簇
        assert_eq!(dream_cluster(&rows, 0.1).len(), 1);
    }

    #[test]
    fn importance_default_by_type() {
        assert!((importance_default_for_type("user") - 0.8).abs() < 1e-6);
        assert!((importance_default_for_type("feedback") - 0.7).abs() < 1e-6);
        assert!((importance_default_for_type("project") - 0.6).abs() < 1e-6);
        assert!((importance_default_for_type("reference") - 0.5).abs() < 1e-6);
    }
}


#[cfg(test)]
mod dream_store_tests {
    use super::*;

    fn test_store() -> MemoryStore {
        let temp = tempfile::tempdir().expect("tempdir");
        let root = temp.path().join("memory");
        std::fs::create_dir_all(&root).expect("root dirs");
        let db_path = root.join(DB_FILENAME);
        let conn = open_memory_connection(&db_path).expect("open db");
        let store = MemoryStore {
            root,
            db_path,
            conn: Mutex::new(conn),
            mutation_lock: Mutex::new(()),
        };
        std::mem::forget(temp);
        store
    }

    #[allow(clippy::field_reassign_with_default)]
    fn write_args(slug: &str, mtype: &str, description: &str, body: &str, importance: Option<f32>) -> MemoryWriteArgs {
        let mut args = MemoryWriteArgs {
            slug: String::new(),
            scope: String::new(),
            workdir: None,
            memory_type: String::new(),
            description: String::new(),
            body: String::new(),
            actor: None,
            conversation_id: None,
            model: None,
            evidence: None,
            importance: None,
        };
        args.slug = slug.to_string();
        args.scope = "global".to_string();
        args.memory_type = mtype.to_string();
        args.description = description.to_string();
        args.body = body.to_string();
        args.actor = Some("user".to_string());
        args.importance = importance;
        args
    }

    #[test]
    fn embed_scan_upsert_search_writeback_flow() {
        let store = test_store();
        store
            .write(write_args(
                "alpha-pref",
                "user",
                "用户偏好深色主题",
                "用户长期偏好深色主题,讨厌亮色刺眼界面。",
                Some(0.8),
            ))
            .expect("write alpha");
        store
            .write(write_args(
                "beta-note",
                "reference",
                "无关的参考条目",
                "完全不同方向的参考资料内容。",
                None,
            ))
            .expect("write beta");

        let scan = store.embed_scan().expect("scan");
        assert_eq!(scan.entries.len(), 2, "非 daily 两条都应可嵌入");
        assert!(scan.stored.is_empty());
        let alpha_entry = scan.entries.iter().find(|e| e.slug == "alpha-pref").expect("alpha");
        assert!(alpha_entry.embed_text.contains("深色主题"), "embed_text 应含正文");

        store
            .embed_upsert(MemoryEmbedUpsertArgs {
                items: vec![
                    MemoryEmbedUpsertItem {
                        scope: "global".into(),
                        workdir_hash: String::new(),
                        slug: "alpha-pref".into(),
                        body_hash: alpha_entry.body_hash.clone(),
                        embedding: vec![1.0, 0.0],
                    },
                    MemoryEmbedUpsertItem {
                        scope: "global".into(),
                        workdir_hash: String::new(),
                        slug: "beta-note".into(),
                        body_hash: "hash-beta".into(),
                        embedding: vec![0.0, 1.0],
                    },
                ],
                model_id: "test-model".into(),
            })
            .expect("upsert");

        let err = store
            .embed_upsert(MemoryEmbedUpsertArgs {
                items: vec![MemoryEmbedUpsertItem {
                    scope: "global".into(),
                    workdir_hash: String::new(),
                    slug: "alpha-pref".into(),
                    body_hash: "h".into(),
                    embedding: vec![1.0, 0.0],
                }],
                model_id: "other-model".into(),
            })
            .expect_err("model change must fail");
        assert!(err.contains("模型已变更"), "实际：{err}");

        let hits = store
            .semantic_search(MemorySemanticSearchArgs {
                query_embedding: vec![1.0, 0.05],
                top_k: Some(2),
                session_id: None,
                workdir: None,
            })
            .expect("search");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].slug, "alpha-pref");
        assert!((hits[0].importance - 0.8).abs() < 1e-6, "显式重要度应生效");
        let first_access = hits[0].access_count;

        let hits2 = store
            .semantic_search(MemorySemanticSearchArgs {
                query_embedding: vec![1.0, 0.05],
                top_k: Some(2),
                session_id: None,
                workdir: None,
            })
            .expect("search again");
        assert_eq!(hits2[0].access_count, first_access + 1, "检索应回写访问次数");
    }

    #[test]
    fn dream_merges_decays_and_forgets_with_dry_run() {
        let store = test_store();
        store
            .write(write_args("keeper-mem", "user", "keeper 描述", "keeper 正文内容。", Some(0.8)))
            .expect("write keeper");
        store
            .write(write_args("absorbed-mem", "user", "重复的偏好描述", "用户偏好深色主题的另一段表述。", Some(0.75)))
            .expect("write absorbed");
        store
            .write(write_args("stale-mem", "reference", "陈旧低价值条目", "很久不用的内容。", Some(0.1)))
            .expect("write stale");

        let scan = store.embed_scan().expect("scan");
        assert_eq!(scan.entries.len(), 3);
        let vec_of = |slug: &str| -> Vec<f32> {
            match slug {
                "keeper-mem" => vec![1.0, 0.0],
                "absorbed-mem" => vec![0.995, 0.02],
                _ => vec![0.0, 1.0],
            }
        };
        store
            .embed_upsert(MemoryEmbedUpsertArgs {
                items: scan
                    .entries
                    .iter()
                    .map(|e| MemoryEmbedUpsertItem {
                        scope: e.scope.clone(),
                        workdir_hash: e.workdir_hash.clone(),
                        slug: e.slug.clone(),
                        body_hash: e.body_hash.clone(),
                        embedding: vec_of(&e.slug),
                    })
                    .collect(),
                model_id: "test-model".into(),
            })
            .expect("upsert");

        // stale-mem 拨到 200 天前且低重要度 → 遗忘象限
        {
            let conn = store.lock_conn().expect("conn");
            let old = now_ms() - 200 * 86_400_000;
            conn.execute(
                "UPDATE memory_access_stats SET last_accessed_at = ?1, importance = 0.1 WHERE slug = 'stale-mem'",
                params![old],
            )
            .expect("age stale");
            conn.execute(
                "UPDATE memory_access_stats SET last_accessed_at = ?1 WHERE slug = 'keeper-mem'",
                params![now_ms()],
            )
            .expect("freshen keeper");
        }

        let dry = store
            .dream_run(MemoryDreamArgs { dry_run: true, trigger: Some("manual".into()) })
            .expect("dry run");
        assert!(dry.dry_run);
        assert_eq!(dry.merged, 1, "keeper/absorbed 应合并");
        assert_eq!(dry.forgotten, 1, "stale 应进遗忘计划");
        let scan_after_dry = store.embed_scan().expect("scan after dry");
        assert_eq!(scan_after_dry.entries.len(), 3, "dry_run 不得动真实数据");

        let real = store
            .dream_run(MemoryDreamArgs { dry_run: false, trigger: Some("manual".into()) })
            .expect("real run");
        assert_eq!(real.merged, 1);
        assert_eq!(real.forgotten, 1);
        let scan_after = store.embed_scan().expect("scan after");
        assert_eq!(scan_after.entries.len(), 1, "合并+遗忘后应剩 keeper 1 条");
        let slugs: Vec<&str> = scan_after.entries.iter().map(|e| e.slug.as_str()).collect();
        assert!(slugs.contains(&"keeper-mem"), "keeper 应保留");
        assert!(!slugs.contains(&"absorbed-mem"), "absorbed 应被合并");
        assert!(!slugs.contains(&"stale-mem"), "stale 应被遗忘");

        let hits = store
            .semantic_search(MemorySemanticSearchArgs {
                query_embedding: vec![1.0, 0.0],
                top_k: Some(5),
                session_id: None,
                workdir: None,
            })
            .expect("search keeper");
        assert_eq!(hits[0].slug, "keeper-mem");
        assert!((hits[0].importance - 0.85).abs() < 1e-6, "keeper importance 应 +0.05");

        let trash = store.root.join("global").join(".trash");
        assert!(trash.exists(), ".trash 应存在");
        let trash_count = std::fs::read_dir(&trash).expect("read trash").count();
        assert_eq!(trash_count, 2, "absorbed+stale 应都在回收站");
    }
}
