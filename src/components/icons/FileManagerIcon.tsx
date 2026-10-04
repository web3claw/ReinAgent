/** 系统文件管理器入口图标——Windows 11 资源管理器风格（原创绘制，无版权问题）：
 *  深黄背夹 + 黄色主体 + 左下蓝色前袋（蓝色下缘略微探出主体，与 Win11 图标一致）。 */
export function FileManagerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="fmi-tab" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#F5BC4B" />
          <stop offset="1" stopColor="#E19E2E" />
        </linearGradient>
        <linearGradient id="fmi-front" x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#FFD873" />
          <stop offset="1" stopColor="#F2A63C" />
        </linearGradient>
        <linearGradient id="fmi-blue" x1="0" y1="0" x2="0.5" y2="1">
          <stop offset="0" stopColor="#5FB3F2" />
          <stop offset="1" stopColor="#2E7CD9" />
        </linearGradient>
      </defs>
      {/* 背夹（深黄） */}
      <path
        d="M3 10.3C3 8.75 4.25 7.5 5.8 7.5h5.9l2.3 2.3h12.2c1.55 0 2.8 1.25 2.8 2.8v3.4H3z"
        fill="url(#fmi-tab)"
      />
      {/* 黄色主体 */}
      <rect x="3" y="13" width="26" height="14.6" rx="2.7" fill="url(#fmi-front)" />
      {/* 蓝色前袋（左下，盖在黄色主体上，下缘探出） */}
      <rect x="3" y="17.6" width="13.6" height="10.6" rx="2.4" fill="url(#fmi-blue)" />
    </svg>
  );
}
