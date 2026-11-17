import { useRef } from 'react';
import { Bug, HelpCircle } from 'lucide-react';
import { ScreenMode } from '../types/recognition.ts';
import { CaptureSourceType } from '../capture/captureManager.ts';

interface HeaderBarProps {
  captureSource: CaptureSourceType;
  screenMode: ScreenMode;
  fps: number;
  latencyMs: number;
  connectedWindowLabel?: string | null;
  onStartLive: () => void;
  onStopCapture: () => void;
  onImportFile: (file: File) => void;
  onOpenUsage: () => void;
}

function getScreenModeBadge(mode: ScreenMode, source: CaptureSourceType) {
  switch (mode) {
    case 'normal':
      return {
        text: '通常表示',
        classes: 'bg-[#f1fbe8] text-[#3c8604] border-[#76c30f]',
        dot: 'bg-[#64c112]',
      };
    case 'compact':
      return {
        text: '説明省略',
        classes: 'bg-[#edf7ff] text-[#0369a1] border-[#60a5fa]',
        dot: 'bg-[#0ea5e9]',
      };
    case 'chara_detail':
      return {
        text: '適性詳細',
        classes: 'bg-[#fdf2f8] text-[#be185d] border-[#f472b6]',
        dot: 'bg-[#ec4899]',
      };
    default:
      if (source !== 'idle') {
        return {
          text: '解析中 (ホーム/他)',
          classes: 'bg-[#fffbeb] text-[#b45309] border-[#f59e0b]',
          dot: 'bg-[#f59e0b]',
        };
      }
      return {
        text: '待機中',
        classes: 'bg-[#f4f3f1] text-[#7a6858] border-[#c6c3cc]',
        dot: 'bg-[#9ca3af]',
      };
  }
}

export function HeaderBar({
  captureSource,
  screenMode,
  fps,
  latencyMs,
  connectedWindowLabel,
  onStartLive,
  onStopCapture,
  onImportFile,
  onOpenUsage,
}: HeaderBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const modeBadge = getScreenModeBadge(screenMode, captureSource);

  return (
    <header className="uma-header-bar px-3 py-1.5 flex flex-wrap items-center justify-between gap-2 sticky top-0 z-50">
      {/* 左側: キャプチャ操作（タイトルなし） */}
      <div className="flex items-center gap-2 flex-wrap">
        {captureSource === 'idle' ? (
          <button
            onClick={onStartLive}
            className="uma-btn px-3 py-1 text-xs font-extrabold"
            title="ウマ娘ウィンドウを画面共有してリアルタイム認識"
          >
            ウィンドウ共有
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <button
              onClick={onStopCapture}
              className="uma-btn-pink px-3 py-1 text-xs font-extrabold"
            >
              停止
            </button>
            {connectedWindowLabel && (
              <div className="hidden md:flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-bold rounded bg-white/95 border border-[#4e9606] text-[#3c8604]">
                <span className="w-2 h-2 rounded-full bg-[#64c112]" />
                <span className="truncate max-w-[200px]" title={connectedWindowLabel}>
                  {connectedWindowLabel}
                </span>
              </div>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="video/mp4,video/webm,image/png,image/jpeg"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              onImportFile(file);
              e.target.value = '';
            }
          }}
        />

        <button
          onClick={() => fileInputRef.current?.click()}
          className="uma-btn px-3 py-1 text-xs font-bold"
          title="動画 (.mp4 / .webm) や画像 (.png / .jpg) を読み込み"
        >
          動画/画像読込
        </button>
      </div>

      {/* 右側: 計測ステータス & 画面モード */}
      <div className="flex items-center gap-1.5 text-xs">
        <div className="flex items-center gap-1.5 text-[#5b4333] bg-white/95 px-2.5 py-0.5 rounded border border-[#599c08] font-mono font-bold tabular-nums">
          <span>{fps} FPS</span>
          <span className="text-[#c6c3cc]">|</span>
          <span>{latencyMs}ms</span>
        </div>

        <div
          className={`px-2.5 py-0.5 rounded border font-bold flex items-center gap-1.5 ${modeBadge.classes}`}
        >
          <span className={`w-2 h-2 rounded-full ${modeBadge.dot}`} />
          {modeBadge.text}
        </div>

        <button
          type="button"
          onClick={onOpenUsage}
          className="uma-btn px-2.5 py-1 text-xs font-extrabold flex items-center gap-1"
          title="使い方を確認"
        >
          <HelpCircle className="w-3.5 h-3.5 text-[#56b308]" />
          使い方
        </button>

        <a
          href="https://github.com/miyabitti256/uma-skill-dp-web/issues/new"
          target="_blank"
          rel="noopener noreferrer"
          className="uma-btn px-2.5 py-1 text-xs font-bold flex items-center gap-1"
          title="GitHub Issues でバグや要望を報告"
        >
          <Bug className="w-3.5 h-3.5 text-[#e43f8c]" />
          バグ報告はこちら
        </a>
      </div>
    </header>
  );
}
