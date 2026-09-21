/** 空会话状态：引导用户开始对话，并区分演示模式 / 真实模式。 */
export function EmptyState({ demo }: { demo: boolean }) {
  return (
    <div className="empty-state">
      <h2 className="empty-title">开始对话</h2>
      <p className="empty-text">
        {demo
          ? "当前为演示模式：回复由合成数据产生，未连接真实模型。在顶部填入 DeepSeek API Key 后即可连接真实模型。"
          : "输入你的问题，助手会以打字机效果流式回复。"}
      </p>
    </div>
  );
}
