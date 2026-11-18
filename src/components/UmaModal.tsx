import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';

interface UmaModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  titleId: string;
  maxWidthClass?: string;
  children: ReactNode;
}

/**
 * ウマ娘風ウィンドウ枠を用いた共通モーダルシェル。
 */
export function UmaModal({
  isOpen,
  onClose,
  title,
  titleId,
  maxWidthClass = 'max-w-lg',
  children,
}: UmaModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/45 p-3"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
    >
      <div
        className={`uma-window w-full ${maxWidthClass} overflow-hidden shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="uma-bar px-3 py-1.5 flex items-center justify-between">
          <h2 id={titleId} className="text-sm font-extrabold">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-white/95 hover:text-white p-0.5 rounded"
            aria-label="モーダルを閉じる"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3.5 bg-[#f4f3f1] space-y-2.5 text-xs text-[#5b4333] leading-relaxed">
          {children}

          <div className="flex justify-end pt-1">
            <button
              type="button"
              onClick={onClose}
              className="uma-btn-green px-5 py-1 text-xs font-extrabold"
            >
              閉じる
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
