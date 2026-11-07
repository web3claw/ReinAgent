/**
 * 链接收藏的纯函数（clipTools 的可测层，node --test 直跑）：
 * 文件名 slug 与 frontmatter 生成（与 Rust 侧 clip_slug 行为一致）。
 */

/** 文件名 slug：禁字符转 `-`、空白折叠、连续 `-` 收敛、限长 60、空标题兜底。 */
export function clipSlug(title: string): string {
  const cleaned = Array.from(title)
    .map((c) =>
      /[/\\:*?"<>|\n\r\t]|[\x00-\x1f]/.test(c) ? "-" : c,
    )
    .join("");
  let collapsed = cleaned.split(/\s+/).filter(Boolean).join("-");
  while (collapsed.includes("--")) {
    collapsed = collapsed.replace(/--/g, "-");
  }
  let slug = collapsed.replace(/^-+|-+$/g, "").replace(/-+\.+$/, "");
  slug = Array.from(slug).slice(0, 60).join("");
  while (slug.endsWith("-") || slug.endsWith(".")) {
    slug = slug.slice(0, -1);
  }
  return slug.trim().length > 0 ? slug : "untitled";
}

/** 今日日期（UTC，YYYY-MM-DD）——与 Rust 侧 clip_save 的日期口径一致。 */
export function clipToday(now = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** 收藏笔记的 frontmatter + 正文（clip_save 落盘内容的镜像，便于测试）。 */
export function clipFrontmatter(args: {
  title: string;
  summary: string;
  sourceUrl: string;
  site?: string;
  channel?: string;
  tags?: string[];
  now?: number;
}): string {
  const tagLine =
    args.tags && args.tags.length > 0
      ? `tags: [${args.tags.join(", ")}]\n`
      : "";
  const channel = args.channel ?? "unknown";
  return [
    "---",
    `title: ${args.title}`,
    `source_url: ${args.sourceUrl}`,
    `site: ${args.site ?? ""}`,
    `channel: ${channel}`,
    `clipped_at: ${new Date(args.now ?? Date.now()).toISOString()}`,
    tagLine,
    "---",
    "",
    `# ${args.title}`,
    "",
    args.summary.trim(),
    "",
    "---",
    `来源：${args.sourceUrl}`,
  ].join("\n");
}

/** 收藏笔记文件名：`YYYY-MM-DD-{slug}.md`。 */
export function clipFileName(title: string, now = Date.now()): string {
  return `${clipToday(now)}-${clipSlug(title)}.md`;
}
