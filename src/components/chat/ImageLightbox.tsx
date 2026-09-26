import { X } from "lucide-react";

/** 图片全屏放大预览（Lightbox）：点遮罩或 X 关闭。Composer 与消息气泡共用。 */
export function ImageLightbox({
  src,
  name,
  onClose,
}: {
  src: string;
  name?: string;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-[100] bg-black/85 flex items-center justify-center cursor-zoom-out"
      onClick={onClose}
    >
      <img
        src={src}
        alt={name}
        className="max-w-[94vw] max-h-[94vh] object-contain rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      <button
        type="button"
        className="absolute top-4 right-4 w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors cursor-pointer"
        title="关闭"
        onClick={(e) => {
          e.stopPropagation();
          onClose();
        }}
      >
        <X className="w-5 h-5" />
      </button>
      {name && (
        <span className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1 rounded-lg bg-black/60 text-white text-xs font-mono">
          {name}
        </span>
      )}
    </div>
  );
}
