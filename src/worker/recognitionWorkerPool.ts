import { MasterStore } from '../data/masterStore.ts';
import type { MainToWorkerMessage, WorkerToMainMessage } from '../types/worker.ts';
import type { RecognitionOutput } from './imageRecognizer.ts';
import { RecognitionAggregator } from './recognitionAggregator.ts';

interface WorkerLike {
  onmessage: ((e: MessageEvent<WorkerToMainMessage>) => void) | null;
  postMessage(message: MainToWorkerMessage, transfer?: Transferable[]): void;
  terminate(): void;
}

interface RecognitionWorkerPoolOptions {
  masterStore: MasterStore;
  poolSize?: number;
  workerFactory?: (index: number) => WorkerLike;
}

interface PendingFrame {
  seq: number;
  bitmap: ImageBitmap;
  timestamp: number;
  isStaticImage: boolean;
}

interface PendingRawResult {
  seq: number;
  output: RecognitionOutput;
  latencyMs: number;
  isStaticImage: boolean;
}

/**
 * 論理コア数に基づき 60FPS 以上のスループットを確保する Worker プールサイズを決定する。
 */
export function determineWorkerPoolSize(hardwareConcurrency?: number): number {
  const cores =
    typeof hardwareConcurrency === 'number' && hardwareConcurrency > 0
      ? hardwareConcurrency
      : typeof navigator !== 'undefined' && navigator.hardwareConcurrency
        ? navigator.hardwareConcurrency
        : 4;
  // Chromium では getImageData(1080x1920) の GPU リードバックが単一 GPU プロセスで直列化するため、
  // 3並列以上ではシーク復帰時のリードバック競合が起きやすい。2並列で 120+ FPS 相当を安定確保する。
  return cores >= 2 ? 2 : 1;
}

/**
 * 複数 Web Worker を並列稼働させて 60FPS 以上の認識スループットを確保し、
 * 非同期完了した結果を seq 順に並び替えて一貫した状態集約を行うプール。
 */
export class RecognitionWorkerPool {
  public onmessage: ((e: MessageEvent<WorkerToMainMessage>) => void) | null = null;

  private poolSize: number;
  private workerFactory: (index: number) => WorkerLike;
  private aggregator: RecognitionAggregator;
  private workers: WorkerLike[] = [];
  private readyWorkerIndices = new Set<number>();
  private failedWorkerIndices = new Set<number>();
  private idleQueue: number[] = [];
  private pendingFrames: PendingFrame[] = [];
  private inFlightMeta = new Map<number, { isStaticImage: boolean }>();
  private pendingResults = new Map<number, PendingRawResult>();
  private nextExpectedSeq = 1;
  private minValidSeq = 1;
  private lastDispatchedSeq = 0;
  private poolReadyEmitted = false;
  private isTerminated = false;

  constructor(options: RecognitionWorkerPoolOptions) {
    this.poolSize = Math.max(1, options.poolSize ?? determineWorkerPoolSize());
    this.aggregator = new RecognitionAggregator(options.masterStore);
    this.workerFactory =
      options.workerFactory ??
      (() =>
        new Worker(new URL('./recognitionWorker.ts', import.meta.url), {
          type: 'module',
        }));
  }

  public getPoolSize(): number {
    return this.poolSize;
  }

  public getIdleWorkerCount(): number {
    return this.idleQueue.length;
  }

  public postMessage(msg: MainToWorkerMessage, _transfer?: Transferable[]): void {
    if (this.isTerminated) {
      if (msg.type === 'frame') {
        msg.bitmap.close();
      }
      return;
    }

    switch (msg.type) {
      case 'init':
        this.initPool(msg.masterDataUrl);
        break;

      case 'frame': {
        this.lastDispatchedSeq = Math.max(this.lastDispatchedSeq, msg.seq);
        const isStatic = msg.isStaticImage ?? false;
        if (this.idleQueue.length > 0) {
          const workerIdx = this.idleQueue.shift()!;
          this.dispatchToWorker(workerIdx, {
            seq: msg.seq,
            bitmap: msg.bitmap,
            timestamp: msg.timestamp,
            isStaticImage: isStatic,
          });
        } else {
          this.pendingFrames.push({
            seq: msg.seq,
            bitmap: msg.bitmap,
            timestamp: msg.timestamp,
            isStaticImage: isStatic,
          });
        }
        break;
      }

      case 'reset':
        this.minValidSeq = this.lastDispatchedSeq + 1;
        this.nextExpectedSeq = this.minValidSeq;
        this.pendingResults.clear();
        while (this.pendingFrames.length > 0) {
          const dropped = this.pendingFrames.shift()!;
          dropped.bitmap.close();
          this.inFlightMeta.delete(dropped.seq);
          this.emit({ type: 'requestFrame', seq: dropped.seq });
        }
        this.aggregator.reset();
        break;
    }
  }

  public terminate(): void {
    this.isTerminated = true;
    while (this.pendingFrames.length > 0) {
      const f = this.pendingFrames.shift()!;
      f.bitmap.close();
    }
    this.pendingResults.clear();
    this.inFlightMeta.clear();
    this.idleQueue = [];
    for (const w of this.workers) {
      w.terminate();
    }
    this.workers = [];
  }

  private initPool(masterDataUrl: string): void {
    for (let i = 0; i < this.poolSize; i++) {
      const worker = this.workerFactory(i);
      const workerIdx = i;
      worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
        this.handleWorkerMessage(workerIdx, e.data);
      };
      this.workers.push(worker);
      worker.postMessage({ type: 'init', masterDataUrl, mode: 'pool' });
    }
  }

  private dispatchToWorker(workerIdx: number, frame: PendingFrame): void {
    const worker = this.workers[workerIdx];
    if (!worker || this.isTerminated) {
      frame.bitmap.close();
      return;
    }
    this.inFlightMeta.set(frame.seq, { isStaticImage: frame.isStaticImage });
    worker.postMessage(
      {
        type: 'frame',
        seq: frame.seq,
        bitmap: frame.bitmap,
        timestamp: frame.timestamp,
        isStaticImage: frame.isStaticImage,
      },
      [frame.bitmap]
    );
  }

  private handleWorkerMessage(workerIdx: number, msg: WorkerToMainMessage): void {
    if (this.isTerminated) return;

    switch (msg.type) {
      case 'ready': {
        if (!this.readyWorkerIndices.has(workerIdx)) {
          this.readyWorkerIndices.add(workerIdx);
          if (this.pendingFrames.length > 0) {
            const nextFrame = this.pendingFrames.shift()!;
            this.dispatchToWorker(workerIdx, nextFrame);
          } else {
            this.pushIdleWorker(workerIdx);
          }
          this.maybeEmitPoolReady();
        }
        break;
      }

      case 'rawResult': {
        const meta = this.inFlightMeta.get(msg.seq);
        this.inFlightMeta.delete(msg.seq);

        if (this.pendingFrames.length > 0) {
          const nextFrame = this.pendingFrames.shift()!;
          this.dispatchToWorker(workerIdx, nextFrame);
        } else {
          this.pushIdleWorker(workerIdx);
          // 完了クレジットを 1 つ返却して次フレームの供給を許可
          this.emit({ type: 'requestFrame', seq: msg.seq + 1 });
        }

        if (msg.seq < this.minValidSeq) {
          return;
        }

        this.pendingResults.set(msg.seq, {
          seq: msg.seq,
          output: msg.output,
          latencyMs: msg.latencyMs,
          isStaticImage: meta?.isStaticImage ?? false,
        });
        this.drainOrderedResults();
        break;
      }

      case 'log':
        if (msg.level === 'error' && !this.readyWorkerIndices.has(workerIdx)) {
          this.failedWorkerIndices.add(workerIdx);
          this.maybeEmitPoolReady();
        }
        this.emit(msg);
        break;
    }
  }

  private maybeEmitPoolReady(): void {
    if (this.poolReadyEmitted) return;
    if (
      this.readyWorkerIndices.size + this.failedWorkerIndices.size >= this.workers.length &&
      this.readyWorkerIndices.size > 0
    ) {
      this.poolReadyEmitted = true;
      this.emit({ type: 'ready' });
      // アイドル状態の各 Worker 分だけ初期クレジットを供給
      for (let i = 0; i < this.idleQueue.length; i++) {
        this.emit({ type: 'requestFrame', seq: 0 });
      }
    }
  }

  private drainOrderedResults(): void {
    while (this.pendingResults.has(this.nextExpectedSeq)) {
      const item = this.pendingResults.get(this.nextExpectedSeq)!;
      this.pendingResults.delete(this.nextExpectedSeq);

      const aggregated = this.aggregator.processOutput(item.output, item.isStaticImage);
      this.emit({
        type: 'recognitionResult',
        seq: item.seq,
        screenMode: aggregated.screenMode,
        detectedSkillPoint: aggregated.detectedSkillPoint,
        detectedAptitudes: aggregated.detectedAptitudes,
        detectedCardId: aggregated.detectedCardId,
        detectedAwakeningLevel: aggregated.detectedAwakeningLevel,
        detectedSkills: aggregated.detectedSkills,
        latencyMs: item.latencyMs,
      });
      this.nextExpectedSeq++;
    }
  }

  private pushIdleWorker(workerIdx: number): void {
    // プライマリWorker（若番）を優先使用して cardNameCache ヒット率と OffscreenCanvas 局所性を高め、
    // 処理時間が周期を超えた場合のみセカンダリWorkerへ負荷を逃がす
    this.idleQueue.push(workerIdx);
    this.idleQueue.sort((a, b) => a - b);
  }

  private emit(msg: WorkerToMainMessage): void {
    this.onmessage?.({ data: msg } as MessageEvent<WorkerToMainMessage>);
  }
}
