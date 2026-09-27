/**
 * attachments —— 发送载荷的附件折算（单一真源，Composer 与编辑重发共用）。
 * 对齐 LiveAgent 口径：图片 + 视觉模型 → 原生 image block 内联；
 * 图片 + 非视觉模型 → 降级为「无法查看」路径引用；文件 → [Attached file] 行。
 */

export interface ComposerImageInput {
  base64: string;
  mimeType: string;
}

export interface UserAttachmentRef {
  path: string;
  name: string;
  kind: "image" | "file";
  previewUrl?: string;
}

/**
 * 把附件列表折算为发送载荷：
 * - 返回 `payload`（文本 + 文件附件的路径引用行）与 `imageInputs`（原生 image block）；
 * - 图片读取失败时如实降级为路径引用（No-Fallback：不静默丢弃）。
 */
export async function buildOutgoingPayload(
  text: string,
  attachments: UserAttachmentRef[],
  supportsImage: boolean,
): Promise<{ payload: string; imageInputs: ComposerImageInput[] }> {
  let payload = text;
  const imageInputs: ComposerImageInput[] = [];
  if (attachments.length > 0) {
    const { invoke } = await import("@tauri-apps/api/core");
    const fileLines: string[] = [];
    for (const a of attachments) {
      if (a.kind === "image") {
        if (supportsImage) {
          try {
            const res = await invoke<{ mime: string; base64: string }>(
              "fs_read_attachment_base64",
              { path: a.path },
            );
            imageInputs.push({ base64: res.base64, mimeType: res.mime });
          } catch (err) {
            console.warn("[attachment] inline read failed:", err);
            payload += `\n\n[Attached image: ${a.path}]`;
          }
        } else {
          // 非视觉模型：无法直接看图，降级为路径引用
          payload += `\n\n[The user attached an image: ${a.path}. The current model does not support vision input, so the image content cannot be viewed.]`;
        }
      } else {
        fileLines.push(`[Attached file: ${a.path}]`);
      }
    }
    if (fileLines.length > 0) {
      payload += `\n\n${fileLines.join("\n")}`;
    }
  }
  return { payload, imageInputs };
}
