import type { MainToWorkerMessage, WorkerToMainMessage } from '../types/worker.ts';
import { ImageRecognizer, TemplatesData, type RecognitionOutput } from './imageRecognizer.ts';

// Web Worker context
const ctx: Worker = self as any;

let imageRecognizer: ImageRecognizer | null = null;
let isInitialized = false;

async function initWorker(masterDataUrl: string) {
  try {
    // templates.json のロード
    const templatesUrl = masterDataUrl.replace('skill_master.json', 'templates.json');
    const res = await fetch(templatesUrl);
    if (!res.ok) {
      throw new Error(`Failed to load templates from ${templatesUrl}: ${res.statusText}`);
    }
    const templatesData: TemplatesData = await res.json();
    imageRecognizer = new ImageRecognizer(templatesData);
    imageRecognizer.warmup();

    if (typeof OffscreenCanvas !== 'undefined') {
      // 標準縦画面解像度で OffscreenCanvas と getImageData リードバック経路を事前確保し初回スパイクを防ぐ
      cachedCanvas = new OffscreenCanvas(1080, 1920);
      cachedCtx = cachedCanvas.getContext('2d', { willReadFrequently: true });
      cachedCtx?.fillRect(0, 0, 4, 4);
      cachedCtx?.getImageData(0, 0, 1080, 1920);
    }

    isInitialized = true;
    const readyMsg: WorkerToMainMessage = { type: 'ready' };
    ctx.postMessage(readyMsg);
  } catch (err: any) {
    const logMsg: WorkerToMainMessage = {
      type: 'log',
      level: 'error',
      message: `Worker init failed: ${err.message}`,
    };
    ctx.postMessage(logMsg);
  }
}

let cachedCanvas: OffscreenCanvas | null = null;
let cachedCtx: OffscreenCanvasRenderingContext2D | null = null;

function createFallbackOutput(): RecognitionOutput {
  return {
    screenType: '育成完了確認（ホーム画面）',
    screenMode: 'idle',
    skillPoint: 0,
    cards: [],
  };
}

async function processFrame(seq: number, bitmap: ImageBitmap) {
  const startTime = performance.now();
  const width = bitmap.width;
  const height = bitmap.height;

  // OffscreenCanvas の再利用（毎フレーム確保によるメモリ肥大化を防止）
  if (!cachedCanvas || cachedCanvas.width !== width || cachedCanvas.height !== height) {
    cachedCanvas = new OffscreenCanvas(width, height);
    cachedCtx = cachedCanvas.getContext('2d', { willReadFrequently: true });
  }

  const offCtx = cachedCtx;

  if (!offCtx || !imageRecognizer) {
    bitmap.close();
    const emptyMsg: WorkerToMainMessage = {
      type: 'rawResult',
      seq,
      output: createFallbackOutput(),
      latencyMs: Math.round(performance.now() - startTime),
    };
    ctx.postMessage(emptyMsg);
    return;
  }

  let output: RecognitionOutput = createFallbackOutput();

  try {
    offCtx.drawImage(bitmap, 0, 0);
    const imgData = offCtx.getImageData(0, 0, width, height);
    const pixels = imgData.data;

    // 100% 精度検証済みの ImageRecognizer を実行
    output = imageRecognizer.recognize({
      data: pixels,
      width,
      height,
    });
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const logMsg: WorkerToMainMessage = {
      type: 'log',
      level: 'error',
      message: `Worker frame recognition failed (seq=${seq}): ${errMsg}`,
    };
    ctx.postMessage(logMsg);
  } finally {
    // 例外発生時も ImageBitmap リークと pool モードの順序待ちデッドロックを防ぐ
    bitmap.close();
  }

  const latencyMs = Math.round(performance.now() - startTime);
  const rawMsg: WorkerToMainMessage = {
    type: 'rawResult',
    seq,
    output,
    latencyMs,
  };
  ctx.postMessage(rawMsg);
}

ctx.onmessage = async (e: MessageEvent<MainToWorkerMessage>) => {
  const msg = e.data;
  switch (msg.type) {
    case 'init':
      await initWorker(msg.masterDataUrl);
      break;
    case 'frame':
      if (isInitialized) {
        await processFrame(msg.seq, msg.bitmap);
      } else {
        msg.bitmap.close();
      }
      break;
  }
};
