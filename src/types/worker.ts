import type { ScreenMode, AptitudeState, DetectedSkillItem } from './recognition.ts';
import type { RecognitionOutput } from '../worker/imageRecognizer.ts';

// Main -> Worker messages
export type MainToWorkerMessage =
  | { type: 'init'; masterDataUrl: string; mode?: 'pool' }
  | { type: 'frame'; seq: number; bitmap: ImageBitmap; timestamp: number; isStaticImage?: boolean }
  | { type: 'reset' };

// Worker -> Main messages
export type WorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'requestFrame'; seq: number }
  | {
      type: 'recognitionResult';
      seq: number;
      screenMode: ScreenMode;
      detectedSkillPoint?: number;
      detectedAptitudes?: Partial<AptitudeState>;
      detectedCardId?: number;
      detectedSkills: DetectedSkillItem[];
      latencyMs: number;
    }
  | {
      type: 'rawResult';
      seq: number;
      output: RecognitionOutput;
      latencyMs: number;
    }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; message: string };
