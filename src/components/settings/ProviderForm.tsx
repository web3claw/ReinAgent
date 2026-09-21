import { defaultCatalogEntry } from "../../lib/providers/catalog";
import { catalogOptions, validateProviderConfig } from "../../lib/providers/modelFactory";
import type { Settings } from "../../lib/settings/store";
import type { SettingsStatus } from "../../lib/settings/useSettings";

/**
 * 目录驱动的派生量都是**模块级常量**：`CATALOG` 来自 pi-ai 官方目录、运行期不变，
 * 没有必要每次渲染都重算（`catalogOptions()` 每次新建数组、`defaultCatalogEntry()` 每次 find+回退）。
 */
const MODELS = catalogOptions();
const AUTHORITATIVE_BASE_URL = defaultCatalogEntry().baseUrl;

/**
 * 设置面板（S3 收编了 S2 的临时配置条）。
 * 字段：API Key（密码框）/ 模型（下拉，取 catalog）/ baseUrl（可编辑）。
 * 任意改动即通过 onChange 更新内存态，并由 useSettings 自动持久化。
 */
export function ProviderForm({
  settings,
  status,
  onChange,
}: {
  settings: Settings;
  status: SettingsStatus;
  onChange: (patch: Partial<Settings>) => void;
}) {
  // 实时校验 baseUrl 形状：拦下「忘写协议头」这类错误，不等请求失败才提示。
  // （validateProviderConfig 对空串返回 null——留空即走默认，不算错。）
  const baseUrlError = validateProviderConfig({ baseUrl: settings.baseUrl });

  return (
    <section className="settings-panel" aria-label="设置">
      <div className="settings-head">
        <h2 className="settings-title">设置</h2>
        <span className={`settings-persist ${status.persistent ? "" : "settings-persist-warn"}`}>
          {!status.ready ? "正在加载…" : status.persistent ? "已启用本地持久化" : "仅内存（未持久化）"}
        </span>
      </div>

      {status.warning ? <div className="settings-warning">⚠ {status.warning}</div> : null}

      <label className="field">
        <span className="field-label">DeepSeek API Key</span>
        <input
          className="field-input"
          type="password"
          autoComplete="off"
          spellCheck={false}
          placeholder="留空则使用演示模式（合成数据）"
          value={settings.apiKey}
          onChange={(event) => onChange({ apiKey: event.target.value })}
        />
      </label>

      <label className="field">
        <span className="field-label">模型</span>
        <select
          className="field-input"
          value={settings.modelId}
          onChange={(event) => onChange({ modelId: event.target.value })}
        >
          {MODELS.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span className="field-label">baseUrl</span>
        <input
          className={`field-input${baseUrlError ? " field-input-invalid" : ""}`}
          spellCheck={false}
          type="url"
          aria-invalid={baseUrlError ? true : undefined}
          placeholder={`留空使用默认：${AUTHORITATIVE_BASE_URL}（注意不带 /v1）`}
          value={settings.baseUrl}
          onChange={(event) => onChange({ baseUrl: event.target.value })}
        />
        {baseUrlError ? <span className="field-error">{baseUrlError}</span> : null}
      </label>
    </section>
  );
}
