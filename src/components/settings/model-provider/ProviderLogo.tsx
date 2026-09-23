import { Cpu } from "lucide-react";

export function ProviderLogo({
  id,
  className = "w-5 h-5",
}: {
  id: string;
  className?: string;
}) {
  switch (id) {
    case "deepseek":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className}>
          <circle cx="12" cy="12" r="11" fill="#4D6BFE" />
          <path
            d="M7 14.5c2-3 5-4.5 8-2.5 1.5 1 2 2.5 2 2.5s-2.5-.5-4.5 1c-2 1.5-4 1-5.5-1z"
            fill="#ffffff"
          />
          <circle cx="9" cy="11" r="1.2" fill="#ffffff" />
        </svg>
      );
    case "openai":
      return (
        <svg viewBox="0 0 24 24" fill="currentColor" className={className}>
          <path d="M22.28 9.37a5.99 5.99 0 0 0-.52-4.87 6.07 6.07 0 0 0-6.49-2.83 6.06 6.06 0 0 0-4.7-2.3 6.13 6.13 0 0 0-5.8 4.22 6.03 6.03 0 0 0-3.8 2.76 6.07 6.07 0 0 0 .73 7.03 5.98 5.98 0 0 0 .52 4.87 6.08 6.08 0 0 0 6.5 2.83 6.04 6.04 0 0 0 4.69 2.3 6.13 6.13 0 0 0 5.8-4.22 6.03 6.03 0 0 0 3.8-2.76 6.06 6.06 0 0 0-.73-7.03zm-7.6 11.96a4.57 4.57 0 0 1-2.91-1.05l.13-.08 4.82-2.78a.77.77 0 0 0 .39-.67v-6.8l2.05 1.18a.07.07 0 0 1 .04.05v6.58a4.58 4.58 0 0 1-4.52 3.57zm-10.4-4.5a4.54 4.54 0 0 1-.55-3.05l.13.08 4.82 2.79a.78.78 0 0 0 .78 0l5.89-3.4v2.37a.08.08 0 0 1-.03.07l-5.7 3.3a4.58 4.58 0 0 1-5.34-2.16zm-1.1-9.67a4.57 4.57 0 0 1 2.36-2l.14.07 4.82 2.78a.78.78 0 0 0 .78 0l5.9-3.4-2.06-1.19a.08.08 0 0 1-.04-.06H8.56a4.58 4.58 0 0 0-5.38 3.8zm14.73 4.25-5.9 3.4-5.89-3.4 5.9-3.4 5.89 3.4zm1.94-1.39-4.82-2.78a.78.78 0 0 0-.78 0l-5.9 3.4V8.27a.08.08 0 0 1 .03-.07l5.7-3.3a4.58 4.58 0 0 1 5.77 4.82zm2.08 5.76a4.57 4.57 0 0 1-2.36 2l-.14-.07-4.82-2.78a.78.78 0 0 0-.78 0l-5.9 3.4v-2.37a.08.08 0 0 1 .04-.06l5.7-3.3a4.58 4.58 0 0 1 8.26 3.18z" />
        </svg>
      );
    case "anthropic":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className}>
          <rect width="24" height="24" rx="5" fill="#D97706" />
          <path
            d="M13.8 6.5h2.4L20 17.5h-2.3l-.9-2.6h-3.9l-.9 2.6H9.7L13.8 6.5zm1.5 6.6l-1.3-3.8-1.3 3.8h2.6z"
            fill="#ffffff"
          />
          <path
            d="M6.2 17.5L4 11.6h2.2l1.2 3.5 1.2-3.5h2.2l-2.2 5.9H6.2z"
            fill="#ffffff"
            opacity="0.8"
          />
        </svg>
      );
    case "gemini":
      return (
        <svg viewBox="0 0 24 24" fill="none" className={className}>
          <path
            d="M12 2C12 7.52 7.52 12 2 12C7.52 12 12 16.48 12 22C12 16.48 16.48 12 22 12C16.48 12 12 7.52 12 2Z"
            fill="url(#gemini-grad)"
          />
          <defs>
            <linearGradient id="gemini-grad" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">
              <stop stopColor="#1A73E8" />
              <stop offset="0.5" stopColor="#8AB4F8" />
              <stop offset="1" stopColor="#9333EA" />
            </linearGradient>
          </defs>
        </svg>
      );
    case "ollama":
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className={className}>
          <path d="M10 4a3 3 0 0 0-3 3v2a4 4 0 0 0-2 3.5v2a3.5 3.5 0 0 0 7 0v-1h4v1a3.5 3.5 0 0 0 7 0v-2A4 4 0 0 0 21 9V7a3 3 0 0 0-3-3h-8z" />
          <circle cx="8.5" cy="8.5" r="1" fill="currentColor" />
          <circle cx="15.5" cy="8.5" r="1" fill="currentColor" />
          <path d="M12 13v2" />
        </svg>
      );
    default:
      return <Cpu className={className} />;
  }
}
