import { useState, useEffect, useRef } from 'react';
import { Eye, EyeOff, Play, Pause } from 'lucide-react';
import { CaptureSourceType } from '../capture/captureManager.ts';

interface CapturePreviewProps {
  captureSource: CaptureSourceType;
  getVideoElement: () => HTMLVideoElement | null;
  getStaticImageBitmap: () => ImageBitmap | null;
  onTogglePlayPause: () => void;
  onSeekVideo: (timeSec: number) => void;
  onFileDrop: (file: File) => void;
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function CapturePreview({
  captureSource,
  getVideoElement,
  getStaticImageBitmap,
  onTogglePlayPause,
  onSeekVideo,
  onFileDrop,
}: CapturePreviewProps) {
  const [isOpen, setIsOpen] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const lastReportedTimeRef = useRef(0);
  const lastDrawnVideoTimeRef = useRef(-1);
  const drawnImageBitmapRef = useRef<ImageBitmap | null>(null);

  const maxPreviewHeight = 190;

  useEffect(() => {
    if (!isOpen || captureSource === 'idle') {
      drawnImageBitmapRef.current = null;
      lastDrawnVideoTimeRef.current = -1;
      return;
    }

    const drawStaticImageOnce = () => {
      const canvas = canvasRef.current;
      const img = getStaticImageBitmap();
      if (!canvas || !img) return false;
      if (drawnImageBitmapRef.current === img) return true;

      const ctx = canvas.getContext('2d');
      if (!ctx) return false;
      const iw = img.width;
      const ih = img.height;
      if (iw > 0 && ih > 0) {
        const targetH = maxPreviewHeight;
        const targetW = Math.round(targetH * (iw / ih));
        if (canvas.width !== targetW || canvas.height !== targetH) {
          canvas.width = targetW;
          canvas.height = targetH;
        }
        ctx.drawImage(img, 0, 0, targetW, targetH);
        drawnImageBitmapRef.current = img;
        return true;
      }
      return false;
    };

    if (captureSource === 'image') {
      drawnImageBitmapRef.current = null;
      if (drawStaticImageOnce()) {
        return;
      }
    }

    const intervalId = setInterval(() => {
      if (captureSource === 'image') {
        if (drawStaticImageOnce()) {
          clearInterval(intervalId);
        }
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const video = getVideoElement();
      if ((captureSource === 'live' || captureSource === 'video') && video && video.readyState >= 2) {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const shouldDraw =
          captureSource === 'live' ||
          !video.paused ||
          Math.abs(video.currentTime - lastDrawnVideoTimeRef.current) >= 0.001;

        if (shouldDraw && vw > 0 && vh > 0) {
          const targetH = maxPreviewHeight;
          const targetW = Math.round(targetH * (vw / vh));
          if (canvas.width !== targetW || canvas.height !== targetH) {
            canvas.width = targetW;
            canvas.height = targetH;
          }
          ctx.drawImage(video, 0, 0, targetW, targetH);
          lastDrawnVideoTimeRef.current = video.currentTime;
        }

        if (captureSource === 'video') {
          const vTime = video.currentTime;
          if (Math.abs(vTime - lastReportedTimeRef.current) >= 0.25) {
            lastReportedTimeRef.current = vTime;
            setCurrentTime(vTime);
          }
          const vDur = video.duration || 0;
          setDuration((prev) => (Math.abs(prev - vDur) > 0.5 ? vDur : prev));
          const vPlay = !video.paused;
          setIsPlaying((prev) => (prev !== vPlay ? vPlay : prev));
        }
      }
    }, 100);

    return () => clearInterval(intervalId);
  }, [captureSource, getVideoElement, getStaticImageBitmap, isOpen]);

  const handleTogglePlay = () => {
    onTogglePlayPause();
    const video = getVideoElement();
    if (video) setIsPlaying(!video.paused);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    onSeekVideo(val);
    lastReportedTimeRef.current = val;
    setCurrentTime(val);
  };

  const sourceLabel =
    captureSource === 'live'
      ? 'ライブウィンドウ共有'
      : captureSource === 'video'
      ? '動画再生'
      : captureSource === 'image'
      ? '静止画'
      : '待機中';

  return (
    <section className="uma-window overflow-hidden text-xs">
      <div className="uma-bar px-3 py-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-extrabold text-xs truncate">キャプチャ / 動画・画像ドロップ</span>
          <span className="text-[10px] bg-white/90 text-[#5b4333] px-1.5 py-0.5 rounded font-bold shrink-0 leading-none">
            ({sourceLabel})
          </span>
        </div>

        <button
          onClick={() => setIsOpen(!isOpen)}
          className="text-white/95 hover:text-white p-0.5 shrink-0 z-10"
          title={isOpen ? 'プレビューを非表示' : 'プレビューを表示'}
        >
          {isOpen ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
        </button>
      </div>

      {isOpen && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
            const file = e.dataTransfer.files?.[0];
            if (file) onFileDrop(file);
          }}
          className={`p-2 transition ${
            isDragOver ? 'bg-[#ecfccb]' : 'bg-white'
          }`}
        >
          {captureSource !== 'idle' ? (
            <div className="w-full flex flex-col items-center">
              <div className="relative w-full flex items-center justify-center bg-[#eeecf2] rounded border border-[#d6d3dc] p-1 max-h-[198px] overflow-hidden">
                <canvas
                  ref={canvasRef}
                  className="max-h-[190px] max-w-full object-contain rounded-sm"
                />
                {isDragOver && (
                  <div className="absolute inset-0 bg-[#ecfccb]/90 flex items-center justify-center text-[#3c8604] font-extrabold text-xs">
                    ドロップして読み込み
                  </div>
                )}
              </div>

              {captureSource === 'video' && duration > 0 && (
                <div className="w-full flex items-center gap-1.5 mt-1.5 text-[#5b4333] text-[11px] font-bold">
                  <button
                    onClick={handleTogglePlay}
                    className="uma-btn p-1"
                    title={isPlaying ? '一時停止' : '再生'}
                  >
                    {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                  </button>
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={0.1}
                    value={currentTime}
                    onChange={handleSeek}
                    className="flex-1 accent-[#76c30f] cursor-pointer h-1.5 bg-[#e4e1ea] rounded"
                  />
                  <span className="font-mono text-[10px] shrink-0 tabular-nums text-[#7f6958]">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <div className="border border-dashed border-[#c6c3cc] rounded bg-[#f8f7fa] py-4 px-2 text-center">
              <p className="text-[11px] text-[#5b4333] font-bold">
                動画 (.mp4) または画像 (.png) をドロップ
              </p>
              <p className="text-[10px] text-[#7f6958] mt-0.5">
                または上の「ウィンドウ共有」で実機画面を共有
              </p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
