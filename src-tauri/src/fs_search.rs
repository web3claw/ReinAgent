//! fs_search —— 工作区文件检索工具（对齐 ZCode handlers/glob.ts、grep.ts 与
//! LiveAgent fsTools 的同类能力）。
//!
//! 两个命令：
//! - `fs_glob`：按 glob 模式匹配文件路径（`*` 不跨目录、`**` 跨目录、`?` 单字符）；
//! - `fs_grep`：按正则搜索文件内容，返回 `path/line/text`。
//!
//! 安全边界（与 fs_cmd 同思路）：解析后的根目录 canonicalize，遍历中的每个路径都
//! 必须仍在根之下（`strip_prefix` 校验，符号链接逃逸被拒绝）；跳过 `.git`/`node_modules`
//! 等大目录与二进制文件；结果条数有上限，截断情况如实回报（No-Fallback）。

use regex::RegexBuilder;
use serde::Serialize;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

/// 遍历时跳过的目录名（大目录/无意义目录）。
const SKIP_DIRS: &[&str] = &[".git", "node_modules", "target", "dist", ".next", ".venv", "__pycache__"];
/// 单次 glob 默认返回上限。
const GLOB_DEFAULT_LIMIT: usize = 500;
/// 单次 grep 默认命中上限。
const GREP_DEFAULT_LIMIT: usize = 200;
/// grep 单文件大小上限（超过视为不适合内容检索，跳过并计数）。
const GREP_MAX_FILE_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct GlobEntry {
    pub path: String,
    pub is_dir: bool,
}

#[derive(Serialize, Debug)]
pub struct GlobResult {
    pub entries: Vec<GlobEntry>,
    /// 命中总数超过 limit 时为 true（结果只含前 limit 条）。
    pub truncated: bool,
    /// 扫描的根目录（绝对路径，便于模型理解相对路径的基准）。
    pub root: String,
}

#[derive(Serialize, Debug)]
pub struct GrepHit {
    pub path: String,
    /// 1-based 行号。
    pub line: usize,
    pub text: String,
}

#[derive(Serialize, Debug)]
pub struct GrepResult {
    pub hits: Vec<GrepHit>,
    pub truncated: bool,
    /// 因二进制/超大/读取失败而跳过的文件数（如实回报，不静默）。
    pub skipped_files: usize,
    pub root: String,
}

/// 解析并校验检索根目录：canonicalize 后必须存在且是目录。
fn resolve_search_root(root: &str) -> Result<PathBuf, String> {
    let raw = Path::new(root.trim());
    if root.trim().is_empty() {
        return Err("fs_search: root 不能为空".into());
    }
    let canon = dunce::canonicalize(raw)
        .map_err(|e| format!("fs_search: 无法解析根目录 {}: {e}", raw.display()))?;
    if !canon.is_dir() {
        return Err(format!("fs_search: 根路径不是目录: {}", canon.display()));
    }
    Ok(canon)
}

/// 路径是否位于根目录之下（canonicalize 失败时按「不在」处理——保守拒绝）。
fn within_root(canon_root: &Path, candidate: &Path) -> bool {
    match dunce::canonicalize(candidate) {
        Ok(canon) => canon.starts_with(canon_root),
        Err(_) => false, // 不可解析（悬空链接等）：不纳入结果
    }
}

/// 把 glob 模式编译为正则（`**` 跨目录、`*` 不跨、`?` 单字符）。
/// 模式对**相对根目录的正斜杠路径**匹配（如 `src/**/*.ts`）。
fn glob_to_regex(pattern: &str) -> Result<regex::Regex, String> {
    let mut re = String::from("^");
    let chars: Vec<char> = pattern.replace('\\', "/").chars().collect();
    let mut i = 0;
    while i < chars.len() {
        match chars[i] {
            '*' => {
                if i + 1 < chars.len() && chars[i + 1] == '*' {
                    // `**/` → 任意层级（含零层）；裸 `**` → 任意字符
                    if i + 2 < chars.len() && chars[i + 2] == '/' {
                        re.push_str("(?:.*/)?");
                        i += 3;
                        continue;
                    }
                    re.push_str(".*");
                    i += 2;
                    continue;
                }
                re.push_str("[^/]*");
                i += 1;
            }
            '?' => {
                re.push_str("[^/]");
                i += 1;
            }
            c => {
                // 字符类/花括号不参与支持（glob 语义由 * / ** / ? 承担）：显式拒绝，
                // 避免 [unclosed 这类模式被静默当成普通文本匹配（No-Fallback）
                if c == '[' || c == ']' {
                    return Err(format!(
                        "fs_search: 不支持字符类 [ ] 的模式: {pattern}（可用 * / ** / ?）"
                    ));
                }
                if c == '{' || c == '}' {
                    return Err(format!(
                        "fs_search: 不支持花括号展开 {{ }} 的模式: {pattern}（可用 * / ** / ?）"
                    ));
                }
                if "^$.|+()".contains(c) {
                    re.push('\\');
                }
                re.push(c);
                i += 1;
            }
        }
    }
    re.push('$');
    regex::Regex::new(&re).map_err(|e| format!("fs_search: 非法模式 {pattern}: {e}"))
}

/// glob 文件匹配（相对路径用正斜杠，Windows 亦然——模型预期统一风格）。
#[tauri::command]
pub async fn fs_glob(
    root: String,
    pattern: String,
    limit: Option<usize>,
) -> Result<GlobResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canon_root = resolve_search_root(&root)?;
        let matcher = glob_to_regex(&pattern)?;
        let max = limit.unwrap_or(GLOB_DEFAULT_LIMIT).clamp(1, 5000);

        let mut entries: Vec<GlobEntry> = Vec::new();
        let mut truncated = false;
        for entry in WalkDir::new(&canon_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                // 跳过黑名单目录（不进入其子树）
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir() && SKIP_DIRS.contains(&name.as_ref()))
            })
            .filter_map(|e| e.ok())
        {
            if entry.path() == canon_root {
                continue;
            }
            let rel = match entry.path().strip_prefix(&canon_root) {
                Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                Err(_) => continue, // 理论上不可达（WalkDir 从根出发）
            };
            if !matcher.is_match(&rel) {
                continue;
            }
            // 安全校验：符号链接可能指向根之外，逐条复核
            if !within_root(&canon_root, entry.path()) {
                continue;
            }
            if entries.len() >= max {
                truncated = true;
                break;
            }
            entries.push(GlobEntry {
                path: rel,
                is_dir: entry.file_type().is_dir(),
            });
        }
        entries.sort_by(|a, b| a.path.cmp(&b.path));
        Ok(GlobResult {
            entries,
            truncated,
            root: canon_root.display().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 二进制探测（与 fs_cmd::looks_like_binary 同口径：NUL 字节或控制字符占比 > 0.3）。
fn looks_like_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(2048)];
    if head.iter().any(|&b| b == 0) {
        return true;
    }
    let sample_len = bytes.len().min(8192);
    if sample_len == 0 {
        return false;
    }
    let control = bytes[..sample_len]
        .iter()
        .filter(|&&b| b < 9 || (b > 13 && b < 32))
        .count();
    (control as f64) / (sample_len as f64) > 0.3
}

/// 内容检索。
///
/// @param include 可选 glob 过滤（对相对路径匹配，如 `src/**/*.ts`）
#[tauri::command]
pub async fn fs_grep(
    root: String,
    pattern: String,
    include: Option<String>,
    ignore_case: Option<bool>,
    limit: Option<usize>,
) -> Result<GrepResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let canon_root = resolve_search_root(&root)?;
        let re = RegexBuilder::new(&pattern)
            .case_insensitive(ignore_case.unwrap_or(false))
            .build()
            .map_err(|e| format!("fs_search: 非法正则 {pattern}: {e}"))?;
        let include_matcher = match include.as_deref() {
            Some(pat) if !pat.trim().is_empty() => Some(glob_to_regex(pat)?),
            _ => None,
        };
        let max = limit.unwrap_or(GREP_DEFAULT_LIMIT).clamp(1, 2000);

        let mut hits: Vec<GrepHit> = Vec::new();
        let mut truncated = false;
        let mut skipped_files = 0usize;

        'outer: for entry in WalkDir::new(&canon_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|e| {
                let name = e.file_name().to_string_lossy();
                !(e.file_type().is_dir() && SKIP_DIRS.contains(&name.as_ref()))
            })
            .filter_map(|e| e.ok())
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let rel = match entry.path().strip_prefix(&canon_root) {
                Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
                Err(_) => continue,
            };
            if let Some(matcher) = &include_matcher {
                if !matcher.is_match(&rel) {
                    continue;
                }
            }
            if !within_root(&canon_root, entry.path()) {
                continue;
            }
            let meta = match std::fs::metadata(entry.path()) {
                Ok(m) => m,
                Err(_) => {
                    skipped_files += 1;
                    continue;
                }
            };
            if meta.len() > GREP_MAX_FILE_BYTES {
                skipped_files += 1;
                continue;
            }
            let bytes = match std::fs::read(entry.path()) {
                Ok(b) => b,
                Err(_) => {
                    skipped_files += 1;
                    continue;
                }
            };
            if looks_like_binary(&bytes) {
                skipped_files += 1;
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (idx, line) in text.lines().enumerate() {
                if !re.is_match(line) {
                    continue;
                }
                if hits.len() >= max {
                    truncated = true;
                    break 'outer;
                }
                hits.push(GrepHit {
                    path: rel.clone(),
                    line: idx + 1,
                    // 单行超长裁剪（如压缩后的 JSON）：保留前 400 字符，避免结果爆炸
                    text: if line.chars().count() > 400 {
                        let head: String = line.chars().take(400).collect();
                        format!("{head}…")
                    } else {
                        line.to_string()
                    },
                });
            }
        }
        Ok(GrepResult {
            hits,
            truncated,
            skipped_files,
            root: canon_root.display().to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_root(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("reinagent-fssearch-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("src").join("deep")).unwrap();
        fs::create_dir_all(dir.join("node_modules").join("pkg")).unwrap();
        fs::write(dir.join("src").join("a.ts"), "export const a = 1;\n// TODO: fix\n").unwrap();
        fs::write(dir.join("src").join("deep").join("b.tsx"), "export function B() {}\n").unwrap();
        fs::write(dir.join("src").join("c.md"), "hello world\nTODO: docs\n").unwrap();
        fs::write(dir.join("node_modules").join("pkg").join("x.ts"), "TODO: ignored\n").unwrap();
        fs::write(dir.join("bin.dat"), [0u8, 1, 2, 3, 0, 5]).unwrap();
        dir
    }

    fn glob_sync(root: &Path, pattern: &str, limit: Option<usize>) -> GlobResult {
        tauri::async_runtime::block_on(fs_glob(
            root.display().to_string(),
            pattern.to_string(),
            limit,
        ))
        .unwrap()
    }

    fn grep_sync(root: &Path, pattern: &str, include: Option<&str>) -> GrepResult {
        grep_sync_opts(root, pattern, include, None)
    }

    fn grep_sync_opts(
        root: &Path,
        pattern: &str,
        include: Option<&str>,
        ignore_case: Option<bool>,
    ) -> GrepResult {
        tauri::async_runtime::block_on(fs_grep(
            root.display().to_string(),
            pattern.to_string(),
            include.map(|s| s.to_string()),
            ignore_case,
            None,
        ))
        .unwrap()
    }

    #[test]
    fn glob_star_does_not_cross_dirs_starstar_does() {
        let root = tmp_root("glob-semantics");
        let star = glob_sync(&root, "src/*.ts", None);
        assert_eq!(star.entries.len(), 1, "* 不应跨目录");
        assert_eq!(star.entries[0].path, "src/a.ts");

        let starstar = glob_sync(&root, "src/**/*.ts*", None);
        let paths: Vec<_> = starstar.entries.iter().map(|e| e.path.clone()).collect();
        assert!(paths.contains(&"src/a.ts".to_string()));
        assert!(paths.contains(&"src/deep/b.tsx".to_string()), "** 应跨目录");
        assert!(!paths.contains(&"src/c.md".to_string()), "扩展名过滤应生效");
    }

    #[test]
    fn glob_skips_blacklisted_dirs() {
        let root = tmp_root("glob-skip");
        let all = glob_sync(&root, "**/*.ts", None);
        let paths: Vec<_> = all.entries.iter().map(|e| e.path.clone()).collect();
        assert!(
            !paths.iter().any(|p| p.contains("node_modules")),
            "node_modules 必须被跳过，实际: {paths:?}"
        );
    }

    #[test]
    fn glob_limit_truncates_and_reports() {
        let root = tmp_root("glob-limit");
        let limited = glob_sync(&root, "**/*", Some(1));
        assert_eq!(limited.entries.len(), 1);
        assert!(limited.truncated, "超限必须如实回报 truncated");
    }

    #[test]
    fn glob_rejects_empty_and_missing_root() {
        let err = tauri::async_runtime::block_on(fs_glob(
            "".into(),
            "*.ts".into(),
            None,
        ))
        .unwrap_err();
        assert!(err.contains("不能为空"), "空 root 应明确报错: {err}");

        let missing = std::env::temp_dir().join("reinagent-fssearch-definitely-missing");
        let err2 = tauri::async_runtime::block_on(fs_glob(
            missing.display().to_string(),
            "*.ts".into(),
            None,
        ))
        .unwrap_err();
        assert!(err2.contains("无法解析根目录"), "不存在的 root 应明确报错: {err2}");
    }

    #[test]
    fn glob_bad_pattern_reports_error() {
        let root = tmp_root("glob-bad");
        // 未闭合字符类：必须明确报错而不是当普通文本静默匹配（No-Fallback）
        let err = tauri::async_runtime::block_on(fs_glob(
            root.display().to_string(),
            "[unclosed".into(),
            None,
        ))
        .unwrap_err();
        assert!(
            err.contains("不支持字符类") || err.contains("非法模式"),
            "非法 glob 应明确报错: {err}"
        );
        // 花括号展开同样不支持（显式拒绝）
        let err2 = tauri::async_runtime::block_on(fs_glob(
            root.display().to_string(),
            "{a,b}.ts".into(),
            None,
        ))
        .unwrap_err();
        assert!(err2.contains("不支持花括号"), "花括号应报错: {err2}");
    }

    #[test]
    fn grep_finds_matches_with_line_numbers() {
        let root = tmp_root("grep-basic");
        let result = grep_sync(&root, "TODO", None);
        let keys: Vec<_> = result
            .hits
            .iter()
            .map(|h| (h.path.as_str(), h.line))
            .collect();
        assert!(keys.contains(&("src/a.ts", 2)), "命中与行号应正确: {keys:?}");
        assert!(keys.contains(&("src/c.md", 2)), "多文件命中应齐全: {keys:?}");
        assert!(
            !result.hits.iter().any(|h| h.path.contains("node_modules")),
            "黑名单目录不应参与 grep"
        );
    }

    #[test]
    fn grep_include_filter_and_case_insensitive() {
        let root = tmp_root("grep-filter");
        // include 过滤生效：大写 TODO 只命中 ts 文件
        let only_ts = grep_sync(&root, "TODO", Some("**/*.ts"));
        assert!(
            !only_ts.hits.is_empty() && only_ts.hits.iter().all(|h| h.path.ends_with(".ts")),
            "include 过滤应生效且命中 ts 文件: {:?}",
            only_ts.hits
        );
        // 默认（不传 ignore_case）= 大小写敏感：小写 todo 不命中大写 TODO
        let default_sensitive = grep_sync(&root, "todo", Some("**/*.ts"));
        assert_eq!(default_sensitive.hits.len(), 0, "默认应大小写敏感");
        // 显式 ignore_case=true：小写命中大写
        let insensitive = grep_sync_opts(&root, "todo", Some("**/*.ts"), Some(true));
        assert!(!insensitive.hits.is_empty(), "ignore_case=true 应命中");

        // markdown 文件：大写命中 1 条，小写（敏感模式）0 条
        let md_upper = grep_sync_opts(&root, "TODO", Some("**/*.md"), Some(false));
        assert_eq!(md_upper.hits.len(), 1);
        let md_lower = grep_sync_opts(&root, "todo", Some("**/*.md"), Some(false));
        assert_eq!(md_lower.hits.len(), 0, "大小写敏感模式下小写不应命中");
    }

    #[test]
    fn grep_skips_binary_and_reports_count() {
        let root = tmp_root("grep-binary");
        let result = grep_sync(&root, "TODO", None);
        assert!(result.skipped_files >= 1, "二进制文件应被跳过并计数: {}", result.skipped_files);
    }

    #[test]
    fn grep_limit_truncates() {
        let root = tmp_root("grep-limit");
        let limited = tauri::async_runtime::block_on(fs_grep(
            root.display().to_string(),
            "TODO".into(),
            None,
            None,
            Some(1),
        ))
        .unwrap();
        assert_eq!(limited.hits.len(), 1);
        assert!(limited.truncated);
    }

    #[test]
    fn grep_bad_regex_reports_error() {
        let root = tmp_root("grep-bad");
        let err = tauri::async_runtime::block_on(fs_grep(
            root.display().to_string(),
            "(".into(),
            None,
            None,
            None,
        ))
        .unwrap_err();
        assert!(err.contains("非法正则"), "非法正则应报错: {err}");
    }
}
