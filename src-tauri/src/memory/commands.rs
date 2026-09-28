// Tauri 命令包装：对齐 LA `crates/agent-gui/src-tauri/src/commands/integration/memory.rs`。
// 命令名、Args 形状（单结构体入参、serde camelCase 字段）与返回结构与 LA 完全一致；
// 差异仅在于单例获取方式：LA 用 `State<'_, Arc<MemoryStore>>`，本项目用 [`store`]。
// 全部命令经 spawn_blocking 调用，避免阻塞 tauri 异步运行时。
//
// TODO(phase2)：LA 的 `memory_search` 会把 chat_history 全文检索结果并入
// `history_matches`（chat_history::search_chat_history_for_memory_sync）；
// 本项目暂无对应服务，`history_matches` 恒为空数组，其余字段语义不变。

async fn memory_spawn_blocking<T, F>(command: &str, task: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|e| format!("{command} join 失败：{e}"))?
}

#[tauri::command]
pub async fn memory_list(args: MemoryListArgs) -> Result<MemoryListResponse, String> {
    memory_spawn_blocking("memory_list", move || store().list(args)).await
}

#[tauri::command]
pub async fn memory_read(args: MemoryReadArgs) -> Result<MemoryReadResponse, String> {
    memory_spawn_blocking("memory_read", move || store().read(args)).await
}

#[tauri::command]
pub async fn memory_search(args: MemorySearchArgs) -> Result<MemorySearchResponse, String> {
    memory_spawn_blocking("memory_search", move || store().search(args)).await
}

#[tauri::command]
pub async fn memory_write(args: MemoryWriteArgs) -> Result<MemoryMutationResponse, String> {
    memory_spawn_blocking("memory_write", move || store().write(args)).await
}

#[tauri::command]
pub async fn memory_update(args: MemoryUpdateArgs) -> Result<MemoryMutationResponse, String> {
    memory_spawn_blocking("memory_update", move || store().update(args)).await
}

#[tauri::command]
pub async fn memory_delete(args: MemoryDeleteArgs) -> Result<MemoryMutationResponse, String> {
    memory_spawn_blocking("memory_delete", move || store().delete(args)).await
}

#[tauri::command]
pub async fn memory_delete_project(
    args: MemoryDeleteProjectArgs,
) -> Result<MemoryDeleteProjectResponse, String> {
    memory_spawn_blocking("memory_delete_project", move || {
        store().delete_project(args)
    })
    .await
}

#[tauri::command]
pub async fn memory_accept(args: MemoryAcceptArgs) -> Result<MemoryMutationResponse, String> {
    memory_spawn_blocking("memory_accept", move || store().accept(args)).await
}

#[tauri::command]
pub async fn memory_apply_batch(args: MemoryBatchArgs) -> Result<MemoryBatchResponse, String> {
    memory_spawn_blocking("memory_apply_batch", move || store().apply_batch(args)).await
}

#[tauri::command]
pub async fn memory_organize_run_create(
    args: MemoryOrganizeRunCreateArgs,
) -> Result<MemoryOrganizeRunCreateResponse, String> {
    memory_spawn_blocking("memory_organize_run_create", move || {
        store().organize_run_create(args)
    })
    .await
}

#[tauri::command]
pub async fn memory_organize_run_update(
    args: MemoryOrganizeRunUpdateArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    memory_spawn_blocking("memory_organize_run_update", move || {
        store().organize_run_update(args)
    })
    .await
}

#[tauri::command]
pub async fn memory_organize_run_list(
    args: Option<MemoryOrganizeRunListArgs>,
) -> Result<MemoryOrganizeRunListResponse, String> {
    let resolved = args.unwrap_or_default();
    memory_spawn_blocking("memory_organize_run_list", move || {
        store().organize_run_list(resolved)
    })
    .await
}

#[tauri::command]
pub async fn memory_organize_run_read(
    args: MemoryOrganizeRunReadArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    memory_spawn_blocking("memory_organize_run_read", move || {
        store().organize_run_read(args)
    })
    .await
}

#[tauri::command]
pub async fn memory_organize_run_clear_history(
) -> Result<MemoryOrganizeRunClearHistoryResponse, String> {
    memory_spawn_blocking("memory_organize_run_clear_history", || {
        store().organize_run_clear_history()
    })
    .await
}

#[tauri::command]
pub async fn memory_organize_due_claim(
    args: MemoryOrganizeDueClaimArgs,
) -> Result<MemoryOrganizeDueClaimResponse, String> {
    memory_spawn_blocking("memory_organize_due_claim", move || {
        store().organize_due_claim(args)
    })
    .await
}

#[tauri::command]
pub async fn memory_organize_due_complete(
    args: MemoryOrganizeRunUpdateArgs,
) -> Result<Option<MemoryOrganizeRun>, String> {
    memory_spawn_blocking("memory_organize_due_complete", move || {
        store().organize_due_complete(args)
    })
    .await
}

#[tauri::command]
pub async fn memory_index_overview(workdir: Option<String>) -> Result<MemoryOverviewResponse, String> {
    memory_spawn_blocking("memory_index_overview", move || store().overview(workdir)).await
}

#[tauri::command]
pub async fn memory_paths_info() -> Result<MemoryPathsInfo, String> {
    memory_spawn_blocking("memory_paths_info", || store().paths_info()).await
}

#[tauri::command]
pub async fn memory_recent_rejections(
    args: Option<MemoryRecentRejectionsArgs>,
) -> Result<MemoryRecentRejectionsResponse, String> {
    let resolved = args.unwrap_or_default();
    memory_spawn_blocking("memory_recent_rejections", move || {
        store().recent_rejections(resolved)
    })
    .await
}

#[tauri::command]
pub async fn memory_today_local_date(rollover_hour: Option<u32>) -> Result<String, String> {
    Ok(store().today_local_date(rollover_hour))
}

#[tauri::command]
pub async fn memory_today_daily(
    rollover_hour: Option<u32>,
) -> Result<Option<MemoryReadResponse>, String> {
    memory_spawn_blocking("memory_today_daily", move || {
        store().today_daily(rollover_hour)
    })
    .await
}

#[tauri::command]
pub async fn memory_quota_summary(
    args: Option<MemoryQuotaSummaryArgs>,
) -> Result<MemoryQuotaSummaryResponse, String> {
    let resolved = args.unwrap_or_default();
    memory_spawn_blocking("memory_quota_summary", move || {
        store().quota_summary(resolved)
    })
    .await
}

#[tauri::command]
pub async fn memory_wipe_all() -> Result<MemoryPathsInfo, String> {
    memory_spawn_blocking("memory_wipe_all", || store().wipe_all()).await
}
