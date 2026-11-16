import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { HeaderBar } from './components/HeaderBar.tsx';
import { ConditionPanel } from './components/ConditionPanel.tsx';
import { OptimizationPanel } from './components/OptimizationPanel.tsx';
import { RecognizedSkillsPanel } from './components/RecognizedSkillsPanel.tsx';
import { CapturePreview } from './components/CapturePreview.tsx';
import { UsageModal } from './components/UsageModal.tsx';

import { MasterStore } from './data/masterStore.ts';
import { CaptureManager, CaptureSourceType } from './capture/captureManager.ts';
import { SkillSolverAdapter } from './solver/solverAdapter.ts';
import { RecognitionWorkerPool } from './worker/recognitionWorkerPool.ts';
import {
  ScreenMode,
  AptitudeState,
  AptitudeRank,
  DetectedSkillItem,
  SkillState,
} from './types/recognition.ts';
import { PlayableCardItem, ScenarioItem } from './types/master.ts';
import { SolverResult } from './types/solver.ts';
import { MainToWorkerMessage, WorkerToMainMessage } from './types/worker.ts';

// デフォルト適性: すべて G
const DEFAULT_APTITUDES: AptitudeState = {
  turf: 'G',
  dirt: 'G',
  short: 'G',
  mile: 'G',
  middle: 'G',
  long: 'G',
  nige: 'G',
  senkou: 'G',
  sashi: 'G',
  oikomi: 'G',
};

const APTITUDE_KEYS: (keyof AptitudeState)[] = [
  'turf',
  'dirt',
  'short',
  'mile',
  'middle',
  'long',
  'nige',
  'senkou',
  'sashi',
  'oikomi',
];

function mergeAptitudesIfChanged(
  prev: AptitudeState,
  incoming: Partial<AptitudeState>
): AptitudeState {
  let changed = false;
  for (const key of APTITUDE_KEYS) {
    const val = incoming[key];
    if (val !== undefined && val !== prev[key]) {
      changed = true;
      break;
    }
  }
  if (!changed) return prev;
  return { ...prev, ...incoming };
}

function App() {
  // マスタデータ
  const [cards, setCards] = useState<PlayableCardItem[]>([]);
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [isDataLoaded, setIsDataLoaded] = useState(false);

  // キャプチャ & パフォーマンス
  const [captureSource, setCaptureSource] = useState<CaptureSourceType>('idle');
  const [screenMode, setScreenMode] = useState<ScreenMode>('idle');
  const [fps, setFps] = useState(0);
  const [latencyMs, setLatencyMs] = useState(0);
  const [isUsageOpen, setIsUsageOpen] = useState(false);

  // 育成条件（初期値: SP=0, 適性=すべてG）
  const [availableSp, setAvailableSp] = useState<number>(0);
  const [isSpAutoDetected, setIsSpAutoDetected] = useState(false);
  const [aptitudes, setAptitudes] = useState<AptitudeState>(DEFAULT_APTITUDES);
  const [isAptitudeLocked, setIsAptitudeLocked] = useState(false);
  const [selectedCardId, setSelectedCardId] = useState<number | undefined>(undefined);
  const [isCardAutoDetected, setIsCardAutoDetected] = useState(false);
  const [selectedScenarioId, setSelectedScenarioId] = useState<number | undefined>(undefined);
  const [connectedWindowLabel, setConnectedWindowLabel] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // スキル & ソルバー
  const [skills, setSkills] = useState<DetectedSkillItem[]>([]);
  const [solverResult, setSolverResult] = useState<SolverResult | null>(null);

  // 参照オブジェクト（レンダー中の読み書き禁止）
  const workerRef = useRef<RecognitionWorkerPool | null>(null);
  const captureManagerRef = useRef<CaptureManager | null>(null);
  const solverAdapterRef = useRef<SkillSolverAdapter | null>(null);
  const frameCountRef = useRef(0);
  const latencySumRef = useRef(0);
  const lastFpsCalcRef = useRef(0);
  const frameSeqRef = useRef(0);
  const lastDetectedSkillsRef = useRef<DetectedSkillItem[] | null>(null);

  // 1. 初期ロード (マスタデータ)
  useEffect(() => {
    const store = MasterStore.getInstance();
    store
      .load('/data/skill_master.json')
      .then((data) => {
        setCards(data.cards);
        setScenarios(data.scenarios);
        if (data.scenarios.length > 0) {
          setSelectedScenarioId(data.scenarios[data.scenarios.length - 1].id);
        }
        solverAdapterRef.current = new SkillSolverAdapter(store);
        setIsDataLoaded(true);
      })
      .catch((err) => {
        console.error('Failed to load master data:', err);
      });
  }, []);

  // 2. Web Worker Pool 初期化と PULL型フレーム供給接続
  useEffect(() => {
    if (!isDataLoaded) return;

    lastFpsCalcRef.current = performance.now();
    const worker = new RecognitionWorkerPool({
      masterStore: MasterStore.getInstance(),
    });
    workerRef.current = worker;

    worker.onmessage = (e: MessageEvent<WorkerToMainMessage>) => {
      const msg = e.data;
      switch (msg.type) {
        case 'ready':
          console.info(`[Main] Recognition Worker is ready (pool=${worker.getPoolSize()})`);
          break;

        case 'requestFrame':
          captureManagerRef.current?.onPullFrameRequest();
          break;

        case 'recognitionResult': {
          setScreenMode((prev) => (prev === msg.screenMode ? prev : msg.screenMode));

          frameCountRef.current++;
          latencySumRef.current += msg.latencyMs;
          const now = performance.now();
          if (lastFpsCalcRef.current === 0) {
            lastFpsCalcRef.current = now;
          } else if (now - lastFpsCalcRef.current >= 500) {
            setFps(Math.round((frameCountRef.current * 1000) / (now - lastFpsCalcRef.current)));
            setLatencyMs(Math.round(latencySumRef.current / frameCountRef.current));
            frameCountRef.current = 0;
            latencySumRef.current = 0;
            lastFpsCalcRef.current = now;
          }

          if (msg.detectedSkillPoint !== undefined) {
            setAvailableSp((prev) => (prev === msg.detectedSkillPoint ? prev : msg.detectedSkillPoint!));
            setIsSpAutoDetected((prev) => (prev ? prev : true));
          }

          if (msg.screenMode === 'chara_detail' && msg.detectedAptitudes) {
            const incomingApt = msg.detectedAptitudes as Partial<AptitudeState>;
            setAptitudes((prev) => mergeAptitudesIfChanged(prev, incomingApt));
            setIsAptitudeLocked((prev) => (prev ? prev : true));
          }

          if (msg.detectedCardId) {
            setSelectedCardId((prev) => (prev === msg.detectedCardId ? prev : msg.detectedCardId));
            setIsCardAutoDetected((prev) => (prev ? prev : true));
          }

          // スキルリストの蓄積更新（参照同一フレームは O(1) スキップ・イミュータブル更新）
          if (msg.detectedSkills.length > 0 && msg.detectedSkills !== lastDetectedSkillsRef.current) {
            lastDetectedSkillsRef.current = msg.detectedSkills;
            const incomingSkills = msg.detectedSkills;
            setSkills((prev) => {
              const prevMap = new Map<number, DetectedSkillItem>();
              for (const p of prev) prevMap.set(p.id, p);

              let hasChanged = prev.length !== incomingSkills.length;
              const nextList: DetectedSkillItem[] = [];

              for (const s of incomingSkills) {
                const existing = prevMap.get(s.id);
                if (existing) {
                  const isRefreshed = s.lastSeenTimestamp > existing.lastSeenTimestamp;
                  const nextState = isRefreshed ? s.state : existing.state;
                  const nextCost = isRefreshed ? s.recognizedCost : existing.recognizedCost;
                  const nextTs = isRefreshed ? s.lastSeenTimestamp : existing.lastSeenTimestamp;

                  if (nextState !== existing.state || nextCost !== existing.recognizedCost) {
                    hasChanged = true;
                  }
                  if (
                    nextState === existing.state &&
                    nextCost === existing.recognizedCost &&
                    nextTs === existing.lastSeenTimestamp
                  ) {
                    nextList.push(existing);
                  } else {
                    nextList.push({
                      ...existing,
                      state: nextState,
                      recognizedCost: nextCost,
                      lastSeenTimestamp: nextTs,
                    });
                  }
                } else {
                  hasChanged = true;
                  nextList.push(s);
                }
              }

              return hasChanged ? nextList : prev;
            });
          }
          break;
        }

        case 'log':
          console.log(`[Worker:${msg.level}]`, msg.message);
          break;
      }
    };

    const initMsg: MainToWorkerMessage = {
      type: 'init',
      masterDataUrl: '/data/skill_master.json',
    };
    worker.postMessage(initMsg);

    const capture = new CaptureManager({
      onFrameCaptured: (bitmap: ImageBitmap, timestamp: number) => {
        const frameMsg: MainToWorkerMessage = {
          type: 'frame',
          seq: ++frameSeqRef.current,
          bitmap,
          timestamp,
          isStaticImage: captureManagerRef.current?.getCurrentSource() === 'image',
        };
        worker.postMessage(frameMsg, [bitmap]);
      },
      onSourceChanged: (source: CaptureSourceType) => {
        setCaptureSource(source);
        if (source === 'idle') {
          setScreenMode('idle');
          setFps(0);
          setLatencyMs(0);
          frameCountRef.current = 0;
          latencySumRef.current = 0;
          lastFpsCalcRef.current = performance.now();
          setConnectedWindowLabel(null);
        }
      },
      onWindowValidated: (label: string) => {
        setConnectedWindowLabel(label);
        setErrorMessage(null);
      },
      onError: (err: Error) => {
        console.error('[Capture] Error:', err);
        setErrorMessage(err.message);
      },
    });
    captureManagerRef.current = capture;

    return () => {
      capture.stopCapture();
      worker.terminate();
      workerRef.current = null;
      captureManagerRef.current = null;
    };
  }, [isDataLoaded]);

  // 進化可能フラグをマスタ・選択中ウマ娘・シナリオから純粋導出
  const effectiveSkills = useMemo(() => {
    if (!isDataLoaded || skills.length === 0) return skills;
    const store = MasterStore.getInstance();
    let changed = false;
    const next = skills.map((s) => {
      const canEvolve = store.isSkillEvolvable(s.id, selectedCardId, selectedScenarioId);
      if (canEvolve !== s.canEvolve) {
        changed = true;
        return { ...s, canEvolve };
      }
      return s;
    });
    return changed ? next : skills;
  }, [skills, selectedCardId, selectedScenarioId, isDataLoaded]);

  // 3. ソルバー計算の実行
  useEffect(() => {
    const timerId = window.setTimeout(() => {
      if (!solverAdapterRef.current) return;

      const lockedIds = effectiveSkills.filter((s) => s.isLocked).map((s) => s.id);
      const excludedIds = effectiveSkills.filter((s) => s.isExcluded).map((s) => s.id);

      solverAdapterRef.current
        .solve(effectiveSkills, {
          availableSp,
          aptitudes,
          selectedCardId,
          selectedScenarioId,
          lockedSkillIds: lockedIds,
          excludedSkillIds: excludedIds,
        })
        .then((res) => {
          setSolverResult(res);
        })
        .catch((err) => {
          console.error('[Solver] Solve error:', err);
        });
    }, 60);

    return () => window.clearTimeout(timerId);
  }, [effectiveSkills, availableSp, aptitudes, selectedCardId, selectedScenarioId]);

  // 操作ハンドラ
  const handleStartLive = useCallback(async () => {
    try {
      await captureManagerRef.current?.startLiveCapture();
    } catch (err) {
      console.warn('Live capture canceled or failed:', err);
    }
  }, []);

  const handleStopCapture = useCallback(() => {
    captureManagerRef.current?.stopCapture();
  }, []);

  const handleImportFile = useCallback(async (file: File) => {
    const isVideo = file.type.startsWith('video/') || /\.(mp4|webm|mov|mkv)$/i.test(file.name);
    const isImage = file.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp)$/i.test(file.name);
    if (isVideo) {
      await captureManagerRef.current?.loadVideoFile(file);
    } else if (isImage) {
      await captureManagerRef.current?.loadImageFile(file);
    }
  }, []);

  const getVideoElement = useCallback(() => {
    return captureManagerRef.current?.getVideoElement() ?? null;
  }, []);

  const getStaticImageBitmap = useCallback(() => {
    return captureManagerRef.current?.getStaticImageBitmap() ?? null;
  }, []);

  const handleTogglePlayPause = useCallback(() => {
    captureManagerRef.current?.togglePlayPause();
  }, []);

  const handleSeekVideo = useCallback((timeSec: number) => {
    captureManagerRef.current?.seekVideo(timeSec);
  }, []);

  const handleAptitudeChange = useCallback((field: keyof AptitudeState, rank: AptitudeRank) => {
    setAptitudes((prev) => ({ ...prev, [field]: rank }));
    setIsAptitudeLocked(false);
  }, []);

  const handleCardSelect = useCallback((id: number) => {
    setSelectedCardId(id || undefined);
    setIsCardAutoDetected(false);
  }, []);

  const handleScenarioSelect = useCallback((id: number) => {
    setSelectedScenarioId(id || undefined);
  }, []);

  const handleApplySkill = useCallback((skillId: number) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, state: 'acquired' as SkillState } : s))
    );
  }, []);

  const handleToggleLock = useCallback((skillId: number) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, isLocked: !s.isLocked } : s))
    );
  }, []);

  const handleToggleExclude = useCallback((skillId: number) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, isExcluded: !s.isExcluded } : s))
    );
  }, []);

  const handleSkillStateChange = useCallback((skillId: number, state: SkillState) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, state } : s))
    );
  }, []);

  const handleSkillCostChange = useCallback((skillId: number, newCost: number) => {
    setSkills((prev) =>
      prev.map((s) => (s.id === skillId ? { ...s, recognizedCost: newCost } : s))
    );
  }, []);

  const handleClearSkills = useCallback(() => {
    lastDetectedSkillsRef.current = null;
    setSkills([]);
    frameCountRef.current = 0;
    latencySumRef.current = 0;
    lastFpsCalcRef.current = performance.now();
    workerRef.current?.postMessage({ type: 'reset' } as MainToWorkerMessage);
  }, []);

  const handleOpenUsage = useCallback(() => {
    setIsUsageOpen(true);
  }, []);

  const handleCloseUsage = useCallback(() => {
    setIsUsageOpen(false);
  }, []);

  return (
    <div className="flex flex-col min-h-screen lg:h-screen text-[#5b4333]">
      {/* 1. ヘッダー操作バー (タイトルなし) */}
      <HeaderBar
        captureSource={captureSource}
        screenMode={screenMode}
        fps={fps}
        latencyMs={latencyMs}
        connectedWindowLabel={connectedWindowLabel}
        onStartLive={handleStartLive}
        onStopCapture={handleStopCapture}
        onImportFile={handleImportFile}
        onOpenUsage={handleOpenUsage}
      />

      {errorMessage && (
        <div className="bg-[#fff1f2] border-b border-[#fda4af] px-3 py-1.5 text-xs text-[#9f1239] flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 font-bold">
            <span>ウィンドウ共有エラー:</span>
            <span>{errorMessage}</span>
          </div>
          <button
            onClick={() => setErrorMessage(null)}
            className="uma-btn px-2 py-0.5 text-xs font-bold"
          >
            閉じる
          </button>
        </div>
      )}

      {/* メインワークスペース: 左サイドバー(条件・プレビュー) + 右2ペイン(推奨・認識済) */}
      <main className="flex-1 p-2.5 flex flex-col lg:flex-row gap-2.5 max-w-[1440px] mx-auto w-full min-h-0">
        {/* 左サイドバー: 育成条件 & ミニプレビュー */}
        <aside className="w-full lg:w-[330px] xl:w-[350px] shrink-0 flex flex-col gap-2.5 lg:overflow-y-auto">
          <ConditionPanel
            availableSp={availableSp}
            onSpChange={setAvailableSp}
            isSpAutoDetected={isSpAutoDetected}
            aptitudes={aptitudes}
            onAptitudeChange={handleAptitudeChange}
            isAptitudeLocked={isAptitudeLocked}
            cards={cards}
            selectedCardId={selectedCardId}
            onCardSelect={handleCardSelect}
            isCardAutoDetected={isCardAutoDetected}
            scenarios={scenarios}
            selectedScenarioId={selectedScenarioId}
            onScenarioSelect={handleScenarioSelect}
          />

          <CapturePreview
            captureSource={captureSource}
            getVideoElement={getVideoElement}
            getStaticImageBitmap={getStaticImageBitmap}
            onTogglePlayPause={handleTogglePlayPause}
            onSeekVideo={handleSeekVideo}
            onFileDrop={handleImportFile}
          />
        </aside>

        {/* 右メインエリア: 左=最適推奨 / 右=認識済みスキル一覧 */}
        <div className="flex-1 min-w-0 grid grid-cols-1 xl:grid-cols-2 gap-2.5 min-h-0">
          <OptimizationPanel
            solverResult={solverResult}
            availableSp={availableSp}
            onApplySkill={handleApplySkill}
            onToggleLock={handleToggleLock}
            onToggleExclude={handleToggleExclude}
          />

          <RecognizedSkillsPanel
            skills={effectiveSkills}
            onSkillStateChange={handleSkillStateChange}
            onSkillCostChange={handleSkillCostChange}
            onToggleLock={handleToggleLock}
            onToggleExclude={handleToggleExclude}
            onClearSkills={handleClearSkills}
          />
        </div>
      </main>

      <UsageModal isOpen={isUsageOpen} onClose={handleCloseUsage} />
    </div>
  );
}
export default App;
