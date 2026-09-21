import { useState } from "react";
import "./styles/global.css";
import { useConversation } from "./lib/chat/useConversation";
import { useSettings } from "./lib/settings/useSettings";
import { MessageList } from "./components/chat/MessageList";
import { Composer } from "./components/chat/Composer";
import { EmptyState } from "./components/chat/EmptyState";
import { ProviderForm } from "./components/settings/ProviderForm";
import { DEFAULT_SYSTEM_PROMPT } from "./lib/providers/runAgentTurn";

export default function App() {
  const { settings, status, update } = useSettings();
  // 未手动切换前，演示模式（无 Key）默认展开设置，方便直接填 Key。
  const [settingsOpen, setSettingsOpen] = useState<boolean | null>(null);

  const isDemo = settings.apiKey.trim().length === 0;
  const source = isDemo ? "faux" : "deepseek";
  const showSettings = settingsOpen ?? isDemo;

  const { state, send, stop, clear, isStreaming } = useConversation({
    source,
    config: { apiKey: settings.apiKey, modelId: settings.modelId, baseUrl: settings.baseUrl },
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
  });

  return (
    <div className="app">
      <header className="topbar">
        <h1 className="topbar-title">ReinAgent</h1>
        <div className="topbar-right">
          <span className={`badge ${isDemo ? "badge-demo" : ""}`}>
            {isDemo ? "演示模式 · 合成数据" : "已连接真实模型"}
          </span>
          {state.messages.length > 0 ? (
            // 多轮上下文会随对话无限增长；提供显式清空入口（clear 会中断在途轮次并重置）。
            <button type="button" className="btn btn-ghost" onClick={clear}>
              新对话
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => setSettingsOpen(!showSettings)}
          >
            {showSettings ? "收起设置" : "设置"}
          </button>
        </div>
      </header>

      {showSettings ? <ProviderForm settings={settings} status={status} onChange={update} /> : null}

      {isDemo ? (
        <div className="demo-banner">
          ⚠ 演示模式 · 合成数据，未连接真实模型。填入 API Key 后切换为真实调用。
        </div>
      ) : null}

      {state.messages.length === 0 ? (
        <EmptyState demo={isDemo} />
      ) : (
        <MessageList messages={state.messages} />
      )}

      <Composer isStreaming={isStreaming} onSend={send} onStop={stop} />
    </div>
  );
}
