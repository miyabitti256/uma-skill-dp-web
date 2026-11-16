import { outwardEvenCropRect, type CropRect } from './evenCrop.ts';

export type CaptureSourceType = 'live' | 'video' | 'image' | 'idle';

interface CaptureCallbacks {
  onFrameCaptured: (bitmap: ImageBitmap, timestamp: number) => void;
  onSourceChanged: (source: CaptureSourceType) => void;
  onError: (err: Error) => void;
  onWindowValidated?: (label: string) => void;
}

interface WindowValidationResult {
  isValid: boolean;
  displayLabel: string;
  errorMessage?: string;
}

/**
 * 共有対象のウィンドウ・画面のバリデーション
 * @param label MediaStreamTrack.label
 * @param displaySurface MediaTrackSettings.displaySurface
 */
export function validateCaptureTarget(
  label: string,
  displaySurface?: string
): WindowValidationResult {
  const normLabel = (label || '').trim();

  // 1. 画面全体 (monitor) または ブラウザタブ (browser) の誤選択を排除
  const isMonitorOrBrowser =
    displaySurface === 'monitor' ||
    displaySurface === 'browser' ||
    /^(screen:|web-contents-media-stream:|tab:)/i.test(normLabel);

  if (isMonitorOrBrowser) {
    return {
      isValid: false,
      displayLabel: normLabel || `画面全体/タブ (${displaySurface})`,
      errorMessage:
        '画面全体またはブラウザタブが選択されています。『umamusume (DMM版)』または『UmamusumePrettyDerby_Jpn (Steam版)』の「ウィンドウ」を選択してください。',
    };
  }

  // 2. Chromium 内部 DesktopMediaID (例: "window:132548:0" や "window") の場合
  // Chromium (Chrome, Edge 等) はプライバシー保護のため track.label にウィンドウ名を設定せず
  // "window:<HWND>:<aura_id>" を返すため、displaySurface === 'window' または "window:..." なら正当なウィンドウとして承認する
  const isChromiumWindowId = /^window(:\d+:\d+)?$/i.test(normLabel);
  if (isChromiumWindowId || (!normLabel && displaySurface === 'window')) {
    return {
      isValid: true,
      displayLabel: 'ウマ娘ウィンドウ (共有中)',
    };
  }

  // 3. Firefox や Electron 等で実際の OS ウィンドウタイトルが取得できる場合
  // DMM版 ("umamusume"), Steam版 ("UmamusumePrettyDerby_Jpn" / "UmamusumePrettyDerby"), 日本語 ("ウマ娘" / "ウマ娘 プリティーダービー")
  const isKnownUmamusume =
    /^(umamusume|umamusumeprettyderby(_jpn)?|.*ウマ娘.*)$/i.test(normLabel);

  if (isKnownUmamusume) {
    return {
      isValid: true,
      displayLabel: normLabel,
    };
  }

  // 4. 明示的なウィンドウタイトルが取得され、かつウマ娘ではない場合 (例: "Discord", "Visual Studio Code" 等)
  return {
    isValid: false,
    displayLabel: normLabel,
    errorMessage: `ウマ娘以外のウィンドウが選択されています（検出対象: "${normLabel}"）。『umamusume (DMM版)』または『UmamusumePrettyDerby_Jpn (Steam版)』のウィンドウを選択してください。`,
  };
}

export class CaptureManager {
  private currentSource: CaptureSourceType = 'idle';
  private stream: MediaStream | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private availableWorkerSlots = 0;
  private isSupplying = false;
  private imagePendingSupply = false;
  private callbacks: CaptureCallbacks;
  private pollIntervalId: ReturnType<typeof setInterval> | null = null;
  private pendingSupplyTimer: ReturnType<typeof setTimeout> | null = null;
  private staticImageBitmap: ImageBitmap | null = null;
  private nextFrameTargetTime = 0;
  private lastSuppliedVideoTime = -1;

  constructor(callbacks: CaptureCallbacks) {
    this.callbacks = callbacks;
  }

  public getCurrentSource(): CaptureSourceType {
    return this.currentSource;
  }

  public getVideoElement(): HTMLVideoElement | null {
    return this.videoElement;
  }

  public getStaticImageBitmap(): ImageBitmap | null {
    return this.staticImageBitmap;
  }

  public seekVideo(timeSec: number): void {
    if (this.videoElement) {
      this.videoElement.currentTime = timeSec;
    }
  }

  public togglePlayPause(): void {
    if (this.videoElement) {
      if (this.videoElement.paused) {
        this.videoElement.play().catch(() => {});
      } else {
        this.videoElement.pause();
      }
    }
  }

  /**
   * ライブウィンドウ共有を開始
   */
  public async startLiveCapture(): Promise<void> {
    this.stopCapture();

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: {
          displaySurface: 'window',
          frameRate: { ideal: 60, max: 60 },
          ...({ cursor: 'never' } as any),
        },
        audio: false,
        ...({
          preferCurrentTab: false,
          selfBrowserSurface: 'exclude',
          surfaceSwitching: 'include',
          monitorTypeSurfaces: 'exclude',
        } as any),
      });

      const track = stream.getVideoTracks()[0];
      const label = track?.label || '';
      const settings = (track?.getSettings ? track.getSettings() : {}) as MediaTrackSettings & {
        displaySurface?: string;
      };

      // 共有ウィンドウ名バリデーション
      const validation = validateCaptureTarget(label, settings.displaySurface);
      if (!validation.isValid) {
        stream.getTracks().forEach((t) => t.stop());
        const err = new Error(validation.errorMessage!);
        this.callbacks.onError(err);
        this.stopCapture();
        throw err;
      }

      this.stream = stream;
      this.currentSource = 'live';

      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      this.videoElement = video;

      await video.play();

      stream.getVideoTracks()[0].onended = () => {
        this.stopCapture();
      };

      this.callbacks.onWindowValidated?.(validation.displayLabel);
      this.callbacks.onSourceChanged('live');
      this.startFrameLoop();
      // ソース準備完了時に待機中なら直ちに1フレーム目を供給
      this.supplyNextFrame();
    } catch (err: any) {
      this.callbacks.onError(err);
      this.stopCapture();
      throw err;
    }
  }

  /**
   * ローカル動画ファイルをインポートして検証再生
   */
  public async loadVideoFile(file: File | Blob): Promise<void> {
    this.stopCapture();

    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.src = url;
    this.videoElement = video;
    this.currentSource = 'video';

    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve();
      video.onerror = () => reject(new Error('Failed to load video file'));
    });

    await video.play();
    this.callbacks.onSourceChanged('video');
    this.startFrameLoop();
    // ロード完了時に待機中なら直ちに1フレーム目を供給
    this.supplyNextFrame();
  }

  /**
   * ローカル静止画ファイルをインポートして検証
   */
  public async loadImageFile(file: File | Blob): Promise<void> {
    this.stopCapture();

    const bitmap = await createImageBitmap(file);
    this.staticImageBitmap = bitmap;
    this.currentSource = 'image';
    this.imagePendingSupply = true;
    this.callbacks.onSourceChanged('image');

    // 静止画ロード完了時に Worker が待機中なら直ちに供給
    this.supplyNextFrame();
  }

  /**
   * Worker からのフレーム要求（PULL型クレジット通知）を処理
   */
  public onPullFrameRequest(slots = 1): void {
    this.availableWorkerSlots += Math.max(1, slots);
    this.supplyNextFrame();
  }

  /**
   * バックグラウンドスロットリングを回避するフレームポーリングループを開始
   */
  private startFrameLoop(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }

    // 8ms 間隔のフォールバックポーリングとドリフト補正タイマーを併用し、60FPS 周期を安定維持する
    this.pollIntervalId = setInterval(() => {
      this.supplyNextFrame();
    }, 8);
  }

  /**
   * 次の1フレームを取得してコールバックへ渡す
   */
  private async supplyNextFrame(): Promise<void> {
    if (this.availableWorkerSlots <= 0 || this.isSupplying || this.currentSource === 'idle') {
      return;
    }

    if (this.currentSource === 'image' && this.staticImageBitmap) {
      if (!this.imagePendingSupply) {
        return;
      }
      this.isSupplying = true;
      this.availableWorkerSlots--;
      this.imagePendingSupply = false;
      try {
        const copyBitmap = await createImageBitmap(this.staticImageBitmap);
        this.callbacks.onFrameCaptured(copyBitmap, performance.now());
      } catch (err: any) {
        this.availableWorkerSlots++;
        this.callbacks.onError(err);
      } finally {
        this.isSupplying = false;
      }
      return;
    }

    if (
      (this.currentSource === 'live' || this.currentSource === 'video') &&
      this.videoElement &&
      this.videoElement.readyState >= 2
    ) {
      const video = this.videoElement;

      // 動画シーク中はデコーダが完了していないため、ストールを招く ImageBitmap 切り出しを抑止する
      if (this.currentSource === 'video' && video.seeking) {
        this.nextFrameTargetTime = 0;
        return;
      }

      // 動画一時停止中は同一フレームの無駄な再供給を行わない（シーク発生時のみ再送）
      if (this.currentSource === 'video' && video.paused) {
        if (this.lastSuppliedVideoTime >= 0 && Math.abs(video.currentTime - this.lastSuppliedVideoTime) < 0.001) {
          return;
        }
      }

      const width = video.videoWidth;
      const height = video.videoHeight;
      if (width === 0 || height === 0) return;

      const now = performance.now();
      const FRAME_INTERVAL_MS = 1000 / 60;
      const TIMER_JITTER_TOLERANCE_MS = 1.5;
      const MIN_BURST_GUARD_MS = 1;

      if (this.nextFrameTargetTime === 0) {
        this.nextFrameTargetTime = now + FRAME_INTERVAL_MS;
      } else if (now < this.nextFrameTargetTime - TIMER_JITTER_TOLERANCE_MS) {
        if (this.pendingSupplyTimer === null) {
          const remaining = this.nextFrameTargetTime - now;
          // 1ms 早くタイマーを設定してブラウザタイマーの正方向ジッターを吸収する
          const delay = Math.max(1, Math.floor(remaining - 1));
          this.pendingSupplyTimer = setTimeout(() => {
            this.pendingSupplyTimer = null;
            this.supplyNextFrame();
          }, delay);
        }
        return;
      } else {
        const advanced = this.nextFrameTargetTime + FRAME_INTERVAL_MS;
        // 通常のタイマージッターは固定刻みで相殺し、シーク等で遅延が蓄積した場合は現在時刻へ再同期して連続バースト送出を防ぐ
        this.nextFrameTargetTime =
          advanced <= now + MIN_BURST_GUARD_MS ? now + FRAME_INTERVAL_MS : advanced;
      }

      if (this.pendingSupplyTimer !== null) {
        clearTimeout(this.pendingSupplyTimer);
        this.pendingSupplyTimer = null;
      }

      this.isSupplying = true;
      this.availableWorkerSlots--;
      this.lastSuppliedVideoTime = video.currentTime;

      try {
        // 偶数アラインメントクロップ処理 (Firefox/Geckoの奇数境界制約対応)
        const cropRect: CropRect = { x: 0, y: 0, width, height };
        const alignedRect = outwardEvenCropRect(cropRect, { width, height }) || cropRect;

        // 2D Canvas への二重コピーを排除し、video 要素から直接 ImageBitmap を生成する
        const bitmap = await createImageBitmap(
          video,
          alignedRect.x,
          alignedRect.y,
          alignedRect.width,
          alignedRect.height
        );
        this.callbacks.onFrameCaptured(bitmap, performance.now());
      } catch (err: any) {
        this.availableWorkerSlots++;
        this.callbacks.onError(err);
      } finally {
        this.isSupplying = false;
        this.scheduleNextVideoSupply();
      }
    }
  }

  private scheduleNextVideoSupply(): void {
    if (
      this.availableWorkerSlots > 0 &&
      this.pendingSupplyTimer === null &&
      (this.currentSource === 'live' || this.currentSource === 'video')
    ) {
      const delay = Math.max(1, Math.floor(this.nextFrameTargetTime - performance.now() - 1));
      this.pendingSupplyTimer = setTimeout(() => {
        this.pendingSupplyTimer = null;
        this.supplyNextFrame();
      }, delay);
    }
  }

  /**
   * キャプチャを停止しリソースを解放
   */
  public stopCapture(): void {
    if (this.pollIntervalId !== null) {
      clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
    if (this.pendingSupplyTimer !== null) {
      clearTimeout(this.pendingSupplyTimer);
      this.pendingSupplyTimer = null;
    }

    this.nextFrameTargetTime = 0;
    this.lastSuppliedVideoTime = -1;

    if (this.stream) {
      this.stream.getTracks().forEach((track) => track.stop());
      this.stream = null;
    }

    if (this.videoElement) {
      this.videoElement.pause();
      const oldSrc = this.videoElement.src;
      // Detach src/srcObject and reset media loader before revoking blob URL so Chromium does not log net::ERR_FILE_NOT_FOUND
      this.videoElement.srcObject = null;
      this.videoElement.removeAttribute?.('src');
      this.videoElement.load?.();
      if (oldSrc && oldSrc.startsWith('blob:')) {
        URL.revokeObjectURL(oldSrc);
      }
      this.videoElement = null;
    }

    if (this.staticImageBitmap) {
      this.staticImageBitmap.close();
      this.staticImageBitmap = null;
    }

    // 注意: this.availableWorkerSlots はリセットしない。
    // Worker がフレーム待ちの状態でユーザーが新たな動画や画像を読み込んだ際に、
    // 即座に最初のフレームを供給できるようにするため。
    this.imagePendingSupply = false;
    this.currentSource = 'idle';
    this.callbacks.onSourceChanged('idle');
  }
}
