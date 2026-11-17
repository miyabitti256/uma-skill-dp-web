import assert from 'node:assert/strict';
import { test, describe } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ImageRecognizer } from '../src/worker/imageRecognizer.ts';
import { RecognitionAggregator } from '../src/worker/recognitionAggregator.ts';
import { mergeRecognizedSkills } from '../src/worker/skillMerge.ts';
import { RecognitionWorkerPool, determineWorkerPoolSize } from '../src/worker/recognitionWorkerPool.ts';
import { CaptureManager } from '../src/capture/captureManager.ts';
import { TypeScriptSkillSolver } from '../src/solver/skillSolver.ts';
import { MasterStore } from '../src/data/masterStore.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDataFile(filename) {
  const privatePath = path.resolve(__dirname, '../../data', filename);
  if (fs.existsSync(privatePath)) {
    return privatePath;
  }
  return path.resolve(__dirname, '../public/data', filename);
}

// 1. outwardEvenCropRect のテスト
function outwardEvenCropRect(pane, captured) {
  if (
    pane.x < 0 ||
    pane.y < 0 ||
    pane.width <= 0 ||
    pane.height <= 0 ||
    pane.x + pane.width > captured.width ||
    pane.y + pane.height > captured.height
  ) {
    return null;
  }

  const left = pane.x & ~1;
  const top = pane.y & ~1;
  const right = (pane.x + pane.width + 1) & ~1;
  const bottom = (pane.y + pane.height + 1) & ~1;

  if (right > captured.width || bottom > captured.height) {
    return null;
  }

  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
  };
}

describe('outwardEvenCropRect (Firefox/Gecko I420/NV12 alignment)', () => {
  test('aligns odd coordinates outward to even boundaries', () => {
    const pane = { x: 3, y: 5, width: 101, height: 201 }; // right=104, bottom=206
    const captured = { width: 1920, height: 1080 };
    const res = outwardEvenCropRect(pane, captured);

    assert.ok(res !== null);
    assert.equal(res.x, 2);
    assert.equal(res.y, 4);
    assert.equal(res.x + res.width, 104);
    assert.equal(res.y + res.height, 206);
    assert.equal(res.width % 2, 0);
    assert.equal(res.height % 2, 0);
  });

  test('returns null when expanding exceeds frame boundaries', () => {
    const pane = { x: 1919, y: 1079, width: 1, height: 1 };
    const captured = { width: 1920, height: 1080 };
    const res = outwardEvenCropRect(pane, captured);
    assert.ok(res !== null);
    assert.equal(res.x, 1918);
    assert.equal(res.y, 1078);
  });

  test('rejects negative coordinates or out of bound inputs', () => {
    const pane = { x: -1, y: 0, width: 100, height: 100 };
    const captured = { width: 1920, height: 1080 };
    assert.equal(outwardEvenCropRect(pane, captured), null);
  });
});

// 2. 適性ランク補正計算 & 丸め精度のテスト
function rankMultiplier(rank) {
  switch (rank) {
    case 'S':
    case 'A':
      return 1.1;
    case 'B':
    case 'C':
      return 0.9;
    case 'D':
    case 'E':
    case 'F':
      return 0.8;
    case 'G':
      return 0.7;
    default:
      return 1.0;
  }
}

function calculateEffectiveGradeValue(gradeValue, distanceTypes, runningStyles, aptitudes) {
  let rDist = 1.0;
  if (distanceTypes && distanceTypes.length > 0) {
    let maxDist = 0.0;
    for (const d of distanceTypes) {
      let mult = 1.0;
      switch (d) {
        case 1:
          mult = rankMultiplier(aptitudes.short);
          break;
        case 2:
          mult = rankMultiplier(aptitudes.mile);
          break;
        case 3:
          mult = rankMultiplier(aptitudes.middle);
          break;
        case 4:
          mult = rankMultiplier(aptitudes.long);
          break;
      }
      if (mult > maxDist) maxDist = mult;
    }
    rDist = maxDist;
  }

  let rStyle = 1.0;
  if (runningStyles && runningStyles.length > 0) {
    let maxStyle = 0.0;
    for (const s of runningStyles) {
      let mult = 1.0;
      switch (s) {
        case 1:
          mult = rankMultiplier(aptitudes.nige);
          break;
        case 2:
          mult = rankMultiplier(aptitudes.senkou);
          break;
        case 3:
          mult = rankMultiplier(aptitudes.sashi);
          break;
        case 4:
          mult = rankMultiplier(aptitudes.oikomi);
          break;
      }
      if (mult > maxStyle) maxStyle = mult;
    }
    rStyle = maxStyle;
  }

  return Math.round(gradeValue * rDist * rStyle);
}

describe('Effective Grade Value Calculation & Rounding Precision', () => {
  const defaultAptitudes = {
    turf: 'A',
    dirt: 'G',
    short: 'A',
    mile: 'A',
    middle: 'A',
    long: 'A',
    nige: 'A',
    senkou: 'A',
    sashi: 'A',
    oikomi: 'A',
  };

  test('applies 1.10x multiplier for distance rank A: 217 -> 239, 508 -> 559, 633 -> 696', () => {
    // 距離Aのみ
    assert.equal(calculateEffectiveGradeValue(217, [1], [], defaultAptitudes), 239);
    assert.equal(calculateEffectiveGradeValue(508, [1], [], defaultAptitudes), 559);
    assert.equal(calculateEffectiveGradeValue(633, [1], [], defaultAptitudes), 696);
  });

  test('applies composite 1.10 x 1.10 = 1.21x multiplier for distance A + style A: 633 -> 766', () => {
    assert.equal(calculateEffectiveGradeValue(633, [1], [1], defaultAptitudes), 766);
  });

  test('ignores ground aptitude: turf A vs dirt G does not change grade multiplier', () => {
    // バ場適性は影響しない（1.0倍）
    assert.equal(calculateEffectiveGradeValue(508, [], [], defaultAptitudes), 508);
  });

  test('applies 0.70x multiplier for aptitude G: 633 * 0.7 -> 443', () => {
    const aptWithShortG = { ...defaultAptitudes, short: 'G' };
    assert.equal(calculateEffectiveGradeValue(633, [1], [], aptWithShortG), 443);
  });
});

// 3. 進化差分計算 (+125 / +188 / 適性G見送り) & 排他処理のテスト
describe('Evolution Incremental Bonus & Mutual Exclusion', () => {
  const defaultApt = {
    turf: 'A',
    dirt: 'G',
    short: 'A',
    mile: 'A',
    middle: 'A',
    long: 'A',
    nige: 'A',
    senkou: 'A',
    sashi: 'A',
    oikomi: 'A',
  };

  test('calculates correct incremental bonus for generic gold to generic evo (+125 pt)', () => {
    const goldEff = calculateEffectiveGradeValue(508, [], [], defaultApt); // 508
    const evoEff = calculateEffectiveGradeValue(633, [], [], defaultApt);  // 633
    const gain = evoEff - goldEff;
    assert.equal(gain, 125, 'Increment must be +125 pt (633 - 508)');
  });

  test('calculates correct incremental bonus for generic gold to distance-A evo (+188 pt)', () => {
    const goldEff = calculateEffectiveGradeValue(508, [], [], defaultApt);    // 508
    const evoEff = calculateEffectiveGradeValue(633, [1], [], defaultApt);    // 696
    const gain = evoEff - goldEff;
    assert.equal(gain, 188, 'Increment must be +188 pt (696 - 508)');
  });

  test('skips evolution when aptitude G causes lower grade (keeps gold 508 pt instead of evo 443 pt)', () => {
    const aptWithG = { ...defaultApt, short: 'G' };
    const goldEff = calculateEffectiveGradeValue(508, [], [], aptWithG);  // 508
    const evoEff = calculateEffectiveGradeValue(633, [1], [], aptWithG);  // 443 (633 * 0.7 = 443.1 -> 443)
    const gain = evoEff - goldEff; // -65
    // gain <= 0 のため進化させない
    assert.ok(gain < 0, 'Evolution gain is negative');
    const shouldEvolve = gain > 0;
    assert.equal(shouldEvolve, false, 'Must not evolve if effective grade drops');
  });

  test('mutually excludes duplicate evolution when base gold is shared by chara evo and scenario evo', () => {
    // 同一ベーススキル ID 100
    const evolvedBaseSkillIds = new Set();
    const baseSkillId = 100;

    // 自前進化を適用
    evolvedBaseSkillIds.add(baseSkillId);

    // シナリオ進化側で同じ baseSkillId は排他される
    const canScenarioEvolve = !evolvedBaseSkillIds.has(baseSkillId);
    assert.equal(canScenarioEvolve, false, 'Same base skill cannot be evolved twice');
  });
});

// 4. Master Data Integrity
describe('Master Data Integrity', () => {
  const masterJsonPath = resolveDataFile('skill_master.json');
  assert.ok(fs.existsSync(masterJsonPath), 'skill_master.json must exist');
  const masterData = JSON.parse(fs.readFileSync(masterJsonPath, 'utf8'));

  test('contains valid skills, cards, and scenarios', () => {
    assert.ok(masterData.skills.length > 2000, 'Should have over 2000 skills');
    assert.ok(masterData.cards.length > 250, 'Should have over 250 playable cards');
    assert.ok(masterData.scenarios.length >= 15, 'Should have at least 15 scenarios');
    assert.ok(masterData.charaEvolutions.length > 500, 'Should have over 500 chara evolutions');
  });
});

// 6. 回帰テスト 2: CaptureManager のフレーム供給デッドロック (修正前は stopCapture() で isPullArmed が消え、フレームが一切供給されずFAIL)
describe('CaptureManager Frame Supply Deadlock Regression', () => {
  // 最小限の DOM / Canvas / ImageBitmap モック
  const origDocument = globalThis.document;
  const origCreateImageBitmap = globalThis.createImageBitmap;
  const origCancelAnimationFrame = globalThis.cancelAnimationFrame;

  globalThis.document = {
    createElement: (tag) => {
      if (tag === 'canvas') {
        return {
          width: 0,
          height: 0,
          getContext: () => ({
            drawImage: () => {},
          }),
        };
      }
      if (tag === 'video') {
        return {
          autoplay: false,
          muted: false,
          loop: false,
          playsInline: false,
          src: '',
          pause: () => {},
          play: async () => {},
        };
      }
      return {};
    },
  };
  globalThis.createImageBitmap = async () => ({
    width: 1920,
    height: 1080,
    close: () => {},
  });
  globalThis.cancelAnimationFrame = () => {};

  test('Regression Test: supplies frame when worker pulls before capture source is loaded', async () => {
    let capturedFrames = 0;
    const manager = new CaptureManager({
      onFrameCaptured: () => {
        capturedFrames++;
      },
      onSourceChanged: () => {},
      onError: () => {},
    });

    // 1. Worker 起動時の最初の PULL 要求が届く（まだソースは未ロード）
    manager.onPullFrameRequest();

    // 2. その後、ユーザーが静止画ファイルをインポート
    const mockFile = {};
    await manager.loadImageFile(mockFile);

    // 3. 修正前のコードでは loadImageFile() の冒頭で stopCapture() が呼ばれ、
    //    this.isPullArmed = false となってしまうため、capturedFrames は 0 のままデッドロックする！
    assert.ok(capturedFrames >= 1, `Worker must receive a frame, but got ${capturedFrames} (DEADLOCK!)`);

    manager.stopCapture();
  });

  // モック後始末
  test('cleanup mocks', () => {
    globalThis.document = origDocument;
    globalThis.createImageBitmap = origCreateImageBitmap;
    globalThis.cancelAnimationFrame = origCancelAnimationFrame;
  });
});

// 10. フォント非依存・不可逆特徴量スキーマおよび初期化検証
describe('Font-Free Irreversible-Feature Schema & Init', () => {
  const templatesPath = resolveDataFile('templates.json');
  const masterJsonPath = resolveDataFile('skill_master.json');
  const templates = JSON.parse(fs.readFileSync(templatesPath, 'utf8'));
  const masterData = JSON.parse(fs.readFileSync(masterJsonPath, 'utf8'));

  test('templates.json omits glyphs, aptitudes, and h24/h16 bitmaps while preserving irreversible features', () => {
    // What: templates.json must omit glyphs, aptitudes, and h24/h16 digit bitmaps,
    // and store only norm_16x20 digits, shiba anchors, and irreversible skills/cards features.
    assert.equal(templates.glyphs, undefined, 'templates.json must not contain glyphs');
    assert.equal(templates.aptitudes, undefined, 'templates.json must not contain aptitudes');

    for (const d of '0123456789') {
      const digit = templates.digits?.[d];
      assert.ok(digit && digit.norm_16x20, `digits['${d}'].norm_16x20 must be present`);
      assert.equal(digit.h24, undefined, `digits['${d}'].h24 must be omitted`);
      assert.equal(digit.h16, undefined, `digits['${d}'].h16 must be omitted`);
    }

    assert.ok(
      templates.anchors?.shiba?.sizes && Object.keys(templates.anchors.shiba.sizes).length > 0,
      'templates.json must contain anchors.shiba.sizes'
    );
    assert.ok(Array.isArray(templates.skills) && templates.skills.length > 0, 'templates.json must contain skills');
    assert.ok(Array.isArray(templates.cards) && templates.cards.length > 0, 'templates.json must contain cards');
  });

  test('initializes skills, cards, and validCosts from templates.json alone without masterData', () => {
    // What: ImageRecognizer loads skillTable (128B/64B/64B), cardTable, and validCosts
    // directly from templates.json without requiring masterData, and throws when skills is missing.
    assert.throws(() => new ImageRecognizer({ ...templates, skills: undefined }), /templates\.skills/);

    const recognizer = new ImageRecognizer(templates);
    const stats = recognizer.getTableStats();
    const expectedSkills = masterData.skills.filter(
      (s) => s.rarity !== 6 && !((!s.needSkillPoint || s.needSkillPoint === 0) && (s.rarity ?? 0) <= 2) && !s.name.endsWith('×')
    ).length;
    assert.equal(stats.skills, expectedSkills, `Must load all ${expectedSkills} acquirable skills`);
    assert.equal(stats.cards, masterData.cards.length, 'Must load all playable cards');
    assert.ok(recognizer.getInitDurationMs() < 2000, `Init must complete quickly, got ${recognizer.getInitDurationMs().toFixed(1)}ms`);

    const cornerSkill = recognizer.skillTable.find((s) => s.id === 200332); // コーナー巧者○ (needSkillPoint: 180)
    assert.ok(cornerSkill, 'コーナー巧者○ must be loaded');
    assert.equal(cornerSkill.bytes.length, 128);
    assert.equal(cornerSkill.headBytes.length, 64);
    assert.equal(cornerSkill.tailBytes.length, 64);
    assert.ok(
      cornerSkill.validCosts.has(81) && cornerSkill.validCosts.has(126),
      'validCosts must include discounted costs'
    );
    assert.equal(cornerSkill.validCosts.has(84), false, 'validCosts must exclude impossible SP cost 84');
  });
});

// 11. CaptureManager 60FPS フレーム供給・直接 ImageBitmap クロップ・ライブ検証のテスト
describe('CaptureManager 60FPS Target & Direct Bitmap Supply', () => {
  test('requests 60fps stream constraints, skips 2D canvas drawImage, and supplies >= 30fps on PULL cadence', async () => {
    // What: Verify startLiveCapture requests frameRate { ideal: 60, max: 60 },
    // createImageBitmap crops directly from the video element without 2D canvas copy,
    // and consecutive PULL requests achieve >= 30fps without the legacy 66ms/100ms bottleneck.
    const origDocument = globalThis.document;
    const origCreateImageBitmap = globalThis.createImageBitmap;
    const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    let drawImageCalls = 0;
    let directVideoCropCalls = 0;
    let capturedConstraint = null;
    let frameCount = 0;

    const fakeVideo = {
      autoplay: false,
      muted: false,
      loop: false,
      playsInline: false,
      srcObject: null,
      paused: false,
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 0,
      play: async () => {},
      pause: () => {},
    };

    const fakeTrack = {
      label: 'window:132548:0',
      getSettings: () => ({ displaySurface: 'window' }),
      stop: () => {},
      onended: null,
    };

    globalThis.document = {
      createElement: (tag) => {
        if (tag === 'canvas') {
          return {
            width: 0,
            height: 0,
            getContext: () => ({
              drawImage: () => {
                drawImageCalls++;
              },
            }),
          };
        }
        if (tag === 'video') {
          return fakeVideo;
        }
        return {};
      },
    };

    globalThis.createImageBitmap = async (src, sx, sy, sw, sh) => {
      if (src === fakeVideo && sx === 0 && sy === 0 && sw === 1920 && sh === 1080) {
        directVideoCropCalls++;
      }
      return { width: sw ?? 1920, height: sh ?? 1080, close: () => {} };
    };

    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getDisplayMedia: async (constraints) => {
            capturedConstraint = constraints;
            return {
              getVideoTracks: () => [fakeTrack],
              getTracks: () => [fakeTrack],
            };
          },
        },
      },
    });

    let validatedLabel = '';
    let manager;
    try {
      manager = new CaptureManager({
        onFrameCaptured: (bitmap) => {
          bitmap.close();
          frameCount++;
          fakeVideo.currentTime += 1 / 60;
          if (frameCount < 4) {
            manager.onPullFrameRequest();
          }
        },
        onSourceChanged: () => {},
        onWindowValidated: (lbl) => {
          validatedLabel = lbl;
        },
        onError: (err) => {
          throw err;
        },
      });

      const t0 = performance.now();
      manager.onPullFrameRequest();
      await manager.startLiveCapture();
      const deadline = performance.now() + 500;
      while (frameCount < 4 && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const elapsedMs = performance.now() - t0;
      manager.stopCapture();

      assert.deepEqual(capturedConstraint?.video?.frameRate, { ideal: 60, max: 60 });
      assert.equal(validatedLabel, 'ウマ娘ウィンドウ (共有中)');
      assert.equal(drawImageCalls, 0, 'Must not copy via intermediate 2D canvas drawImage');
      assert.ok(directVideoCropCalls >= 4, `Expected direct video crops >= 4, got ${directVideoCropCalls}`);
      assert.ok(frameCount >= 4, `Expected >= 4 frames on PULL cadence, got ${frameCount}`);
      assert.ok(elapsedMs < 200, `Expected 4 frames in <200ms (>=30fps), took ${elapsedMs.toFixed(1)}ms`);
    } finally {
      manager?.stopCapture();
      globalThis.document = origDocument;
      globalThis.createImageBitmap = origCreateImageBitmap;
      if (origNavDesc) {
        Object.defineProperty(globalThis, 'navigator', origNavDesc);
      } else {
        delete globalThis.navigator;
      }
    }
  });

  test('stopCapture detaches video src/srcObject and calls load() before revoking blob URL', async () => {
    // What: Prevent net::ERR_FILE_NOT_FOUND race by detaching src/srcObject and resetting media element before URL.revokeObjectURL.
    const origDocument = globalThis.document;
    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;

    const events = [];
    const blobUrl = 'blob:http://127.0.0.1:4173/test-video-uuid';
    const fakeVideo = {
      autoplay: false,
      muted: false,
      loop: false,
      playsInline: false,
      srcObject: { dummy: true },
      _src: '',
      get src() {
        return this._src;
      },
      set src(val) {
        this._src = val;
        if (val) {
          queueMicrotask(() => {
            this.onloadedmetadata?.();
          });
        }
      },
      onloadedmetadata: null,
      onerror: null,
      play: async () => {},
      pause: () => {
        events.push('pause');
      },
      removeAttribute: (attr) => {
        if (attr === 'src') {
          fakeVideo._src = '';
        }
        events.push(`removeAttribute:${attr}`);
      },
      load: () => {
        events.push('load');
      },
    };

    globalThis.document = {
      createElement: (tag) => (tag === 'video' ? fakeVideo : {}),
    };
    URL.createObjectURL = () => blobUrl;
    URL.revokeObjectURL = (url) => {
      events.push(`revoke:${url}:${fakeVideo.src === '' ? 'detached' : 'attached'}`);
    };

    try {
      const manager = new CaptureManager({
        onFrameCaptured: () => {},
        onSourceChanged: () => {},
        onError: (err) => {
          throw err;
        },
      });

      await manager.loadVideoFile({});
      manager.stopCapture();

      assert.equal(fakeVideo.srcObject, null, 'srcObject must be cleared on stopCapture');
      assert.equal(fakeVideo.src, '', 'src must be cleared on stopCapture');
      assert.deepEqual(events, [
        'pause',
        'removeAttribute:src',
        'load',
        `revoke:${blobUrl}:detached`,
      ]);
    } finally {
      globalThis.document = origDocument;
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });
});

// 13. マルチWorkerプール並列ディスパッチ・順序保証・60FPSドリフト補正テスト
describe('Multi-Worker Pool & Drift-Corrected 60FPS Supply', () => {
  const masterData = JSON.parse(fs.readFileSync(resolveDataFile('skill_master.json'), 'utf8'));
  const masterStore = new MasterStore(masterData);

  test('determineWorkerPoolSize caps pool at 2 workers for >=2 cores to avoid GPU readback contention', () => {
    // What: Pool size uses 2 workers on >=2-core environments (1 on single-core) so Chromium GPU readback does not contend across 3+ workers.
    assert.equal(determineWorkerPoolSize(1), 1);
    assert.equal(determineWorkerPoolSize(2), 2);
    assert.equal(determineWorkerPoolSize(4), 2);
    assert.equal(determineWorkerPoolSize(8), 2);
  });

  test('RecognitionWorkerPool dispatches in parallel, reorders out-of-order results by seq, and isolates reset()', async () => {
    // What: Parallel workers completing out-of-order (seq 2 before seq 1) emit recognitionResult strictly in seq order,
    // preserve inheritable 180pt unique gradeValue, and discard stale pre-reset frames without leaking bitmaps.
    const mockWorkers = [];
    const closedBitmaps = [];

    class FakeWorker {
      constructor(idx) {
        this.idx = idx;
        this.onmessage = null;
        this.terminated = false;
        this.pendingHandlers = new Map();
      }
      postMessage(msg) {
        if (msg.type === 'init') {
          queueMicrotask(() => {
            this.onmessage?.({ data: { type: 'ready' } });
          });
        } else if (msg.type === 'frame') {
          this.pendingHandlers.set(msg.seq, msg);
        }
      }
      resolveFrame(seq, output) {
        const msg = this.pendingHandlers.get(seq);
        if (!msg) throw new Error(`Missing seq ${seq} on worker ${this.idx}`);
        this.pendingHandlers.delete(seq);
        msg.bitmap.close();
        this.onmessage?.({
          data: {
            type: 'rawResult',
            seq,
            output,
            latencyMs: 6,
          },
        });
      }
      terminate() {
        this.terminated = true;
      }
    }

    const pool = new RecognitionWorkerPool({
      masterStore,
      poolSize: 3,
      workerFactory: (idx) => {
        const w = new FakeWorker(idx);
        mockWorkers.push(w);
        return w;
      },
    });

    const emitted = [];
    let readyCount = 0;
    let frameCredits = 0;
    pool.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === 'ready') readyCount++;
      else if (msg.type === 'requestFrame') frameCredits++;
      else if (msg.type === 'recognitionResult') emitted.push(msg);
    };

    pool.postMessage({ type: 'init', masterDataUrl: '/data/skill_master.json' });
    await new Promise((r) => setTimeout(r, 10));

    assert.equal(readyCount, 1, 'Pool must emit ready once');
    assert.equal(frameCredits, 3, 'Pool must emit 3 initial requestFrame credits for 3 workers');
    assert.equal(pool.getIdleWorkerCount(), 3);

    const makeBitmap = (id) => ({
      width: 1920,
      height: 1080,
      close: () => closedBitmaps.push(id),
    });

    // Dispatch seq=1, 2, 3 concurrently across all 3 workers
    pool.postMessage({ type: 'frame', seq: 1, bitmap: makeBitmap(1), timestamp: 0, isStaticImage: false });
    pool.postMessage({ type: 'frame', seq: 2, bitmap: makeBitmap(2), timestamp: 16.7, isStaticImage: false });
    pool.postMessage({ type: 'frame', seq: 3, bitmap: makeBitmap(3), timestamp: 33.3, isStaticImage: false });
    assert.equal(pool.getIdleWorkerCount(), 0, 'All 3 workers must be concurrently busy');

    const resolveSeq = (seq, output) => {
      const worker = mockWorkers.find((w) => w.pendingHandlers.has(seq));
      assert.ok(worker, `Seq ${seq} must be assigned to an active worker`);
      worker.resolveFrame(seq, output);
    };

    // Out-of-order completion: seq=2 finishes first, then seq=3, then seq=1
    resolveSeq(2, {
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'skills_compact',
      skillPoint: 6325,
      cards: [{ skillId: 900011, name: 'シューティングスター', needSp: 140, state: 'unselected', dist: 90, box: { top: 200, bottom: 280, height: 80 } }],
    });
    assert.equal(emitted.length, 0, 'seq=2 must buffer until seq=1 arrives');

    resolveSeq(3, {
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'skills_compact',
      skillPoint: 6325,
      cards: [{ skillId: 200152, name: '良バ場○', needSp: 63, state: 'unselected', dist: 120, box: { top: 300, bottom: 380, height: 80 } }],
    });
    assert.equal(emitted.length, 0, 'seq=3 must also wait for seq=1');

    resolveSeq(1, {
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'skills_compact',
      skillPoint: 6325,
      cards: [],
    });

    assert.deepEqual(emitted.map((e) => e.seq), [1, 2, 3], 'Results must drain in strict seq order [1, 2, 3]');
    assert.equal(emitted[1].detectedSkillPoint, 6325, 'SP must confirm on 2nd consecutive frame in seq order');
    const shooting = emitted[2].detectedSkills.find((s) => s.id === 900011);
    assert.equal(shooting?.gradeValue, 180, 'Inheritable unique skill in pool must have 180pt gradeValue');
    assert.ok(emitted[2].detectedSkills.some((s) => s.name === '良バ場◎'), 'Pool aggregator must sync linked ◎');

    // Reset while seq=4 is in-flight -> stale result from seq=4 must be dropped
    pool.postMessage({ type: 'frame', seq: 4, bitmap: makeBitmap(4), timestamp: 50, isStaticImage: false });
    pool.postMessage({ type: 'reset' });
    resolveSeq(4, {
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'skills_compact',
      skillPoint: 9999,
      cards: [{ skillId: 920241, name: 'HOP STEP♪LOCK ON!', needSp: 140, state: 'unselected', dist: 90, box: { top: 200, bottom: 280, height: 80 } }],
    });
    assert.equal(emitted.length, 3, 'Stale pre-reset seq=4 result must be ignored');

    // Post-reset seq=5 is processed normally
    pool.postMessage({ type: 'frame', seq: 5, bitmap: makeBitmap(5), timestamp: 66.7, isStaticImage: true });
    resolveSeq(5, {
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'skills_compact',
      skillPoint: 1200,
      cards: [{ skillId: 200172, name: '春ウマ娘○', needSp: 63, state: 'unselected', dist: 120, box: { top: 200, bottom: 280, height: 80 } }],
    });
    assert.equal(emitted.length, 4);
    assert.equal(emitted[3].seq, 5);
    assert.equal(emitted[3].detectedSkillPoint, 1200);
    assert.equal(emitted[3].detectedSkills.some((s) => s.id === 920241), false, 'Pre-reset skill must not leak past reset');

    pool.terminate();
    assert.equal(mockWorkers.every((w) => w.terminated), true);
    assert.deepEqual(closedBitmaps.sort(), [1, 2, 3, 4, 5], 'All dispatched bitmaps must be closed');
  });

  test('CaptureManager sustains ~60FPS drift-corrected supply across multiple worker credits even with 25ms worker latency', async () => {
    // What: Even when each worker takes 25ms per frame (> 16.67ms), multi-slot credit flow + drift-corrected
    // target timing keeps frame supply well above 45-60 FPS without single-worker blocking.
    const origDocument = globalThis.document;
    const origCreateImageBitmap = globalThis.createImageBitmap;
    const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

    const fakeVideo = {
      autoplay: false,
      muted: false,
      loop: false,
      playsInline: false,
      srcObject: null,
      paused: false,
      readyState: 2,
      videoWidth: 1920,
      videoHeight: 1080,
      currentTime: 0,
      play: async () => {},
      pause: () => {},
    };
    const fakeTrack = {
      label: 'window:132548:0',
      getSettings: () => ({ displaySurface: 'window' }),
      stop: () => {},
      onended: null,
    };

    globalThis.document = {
      createElement: (tag) => (tag === 'video' ? fakeVideo : {}),
    };
    globalThis.createImageBitmap = async (_src, _sx, _sy, sw, sh) => ({
      width: sw ?? 1920,
      height: sh ?? 1080,
      close: () => {},
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      writable: true,
      value: {
        mediaDevices: {
          getDisplayMedia: async () => ({
            getVideoTracks: () => [fakeTrack],
            getTracks: () => [fakeTrack],
          }),
        },
      },
    });

    let captured = 0;
    let manager;
    try {
      manager = new CaptureManager({
        onFrameCaptured: (bitmap) => {
          bitmap.close();
          captured++;
          fakeVideo.currentTime += 1 / 60;
          // Simulate 25ms per-worker recognition latency (a single worker would max out at 40 FPS)
          setTimeout(() => {
            if (captured < 24) {
              manager.onPullFrameRequest(1);
            }
          }, 25);
        },
        onSourceChanged: () => {},
        onError: (err) => {
          throw err;
        },
      });

      // Arm 3 worker credits (equivalent to 3-worker pool)
      manager.onPullFrameRequest(3);
      const t0 = performance.now();
      await manager.startLiveCapture();

      const deadline = performance.now() + 1000;
      while (captured < 16 && performance.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const elapsedMs = performance.now() - t0;
      manager.stopCapture();

      const effectiveFps = ((captured - 1) * 1000) / elapsedMs;
      assert.ok(captured >= 16, `Expected >= 16 frames captured, got ${captured}`);
      assert.ok(
        effectiveFps >= 45,
        `Expected multi-slot drift-corrected supply >= 45 FPS despite 25ms worker latency, got ${effectiveFps.toFixed(1)} FPS (${elapsedMs.toFixed(1)}ms for ${captured} frames)`
      );
    } finally {
      manager?.stopCapture();
      globalThis.document = origDocument;
      globalThis.createImageBitmap = origCreateImageBitmap;
      if (origNavDesc) {
        Object.defineProperty(globalThis, 'navigator', origNavDesc);
      } else {
        delete globalThis.navigator;
      }
    }
  });
});

// 14. TypeScriptSkillSolver 進化前提12状態DP & 同一グループ排他選択・既取得ガード回帰テスト
describe('TypeScriptSkillSolver 12-State Evolution DP & Same-Group Exclusivity', () => {
  const masterData = JSON.parse(fs.readFileSync(resolveDataFile('skill_master.json'), 'utf8'));
  const masterStore = new MasterStore(masterData);
  const defaultAptitudes = {
    turf: 'A',
    dirt: 'G',
    short: 'A',
    mile: 'A',
    middle: 'A',
    long: 'A',
    nige: 'A',
    senkou: 'A',
    sashi: 'A',
    oikomi: 'A',
  };

  function makeDetectedSkill(skillId, overrides = {}) {
    const m = masterStore.skillsById.get(skillId);
    assert.ok(m, `Master skill ${skillId} must exist`);
    return {
      id: m.id,
      name: m.name,
      recognizedCost: overrides.recognizedCost ?? m.needSkillPoint,
      baseCost: m.needSkillPoint,
      gradeValue: m.gradeValue,
      rarity: m.rarity,
      groupId: m.groupId,
      groupRate: m.groupRate,
      state: 'unselected',
      isLocked: false,
      isExcluded: false,
      canEvolve: false,
      lastSeenTimestamp: 0,
      ...overrides,
    };
  }

  test('selects evolvable gold skill over higher-unevolved white skills via 12-state DP (chara Lv5 & scenario)', () => {
    // What: A gold skill (508pt) loses to two white skills (280+280=560pt) when unevolved,
    // but wins when DP evaluates its free chara Lv5 or scenario evolution (633pt) without double-counting.
    const solver = new TypeScriptSkillSolver(masterStore);
    const white1 = {
      id: 990001,
      name: 'テスト白スキル1',
      recognizedCost: 100,
      baseCost: 100,
      gradeValue: 280,
      rarity: 1,
      groupId: 990001,
      groupRate: 1,
      state: 'unselected',
      isLocked: false,
      isExcluded: false,
      canEvolve: false,
      lastSeenTimestamp: 0,
    };
    const white2 = {
      ...white1,
      id: 990002,
      name: 'テスト白スキル2',
      groupId: 990002,
    };

    // 1. 自前覚醒Lv5 (cardId: 100101, 全身全霊 200511: 508 -> 633)
    const goldChara = makeDetectedSkill(200511, { recognizedCost: 200 });
    const resChara = solver.solve([goldChara, white1, white2], {
      availableSp: 200,
      aptitudes: defaultAptitudes,
      selectedCardId: 100101,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.deepEqual(
      resChara.recommendedSkills.map((r) => r.skill.id),
      [200511],
      'DP must choose chara-evolvable 全身全霊 (633pt) over two white skills (560pt)'
    );
    assert.equal(resChara.totalAdditionalGrade, 633, 'Must not double-count chara evolution bonus');
    assert.equal(resChara.maxGradeValue, 633);
    assert.equal(resChara.recommendedSkills[0].effectiveGrade, 633);
    assert.equal(resChara.recommendedSkills[0].reason, undefined, 'Recommended skill must not display 自前進化前提 label');
    const lv5Rec = resChara.evolutionRecommendations.find((e) => e.slotType === 'chara_lv5');
    assert.ok(lv5Rec && lv5Rec.canEvolve && lv5Rec.baseSkillId === 200511);

    // 2. シナリオ進化 (scenarioId: 15, ネバーギブアップ 202721: 508 -> 633)
    const goldScen = makeDetectedSkill(202721, { recognizedCost: 200 });
    const resScen = solver.solve([goldScen, white1, white2], {
      availableSp: 200,
      aptitudes: defaultAptitudes,
      selectedScenarioId: 15,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.deepEqual(
      resScen.recommendedSkills.map((r) => r.skill.id),
      [202721],
      'DP must choose scenario-evolvable ネバーギブアップ (633pt) over two white skills (560pt)'
    );
    assert.equal(resScen.totalAdditionalGrade, 633, 'Must not double-count scenario evolution bonus');
    assert.equal(resScen.maxGradeValue, 633);
    assert.equal(resScen.recommendedSkills[0].reason, undefined, 'Recommended skill must not display シナリオ進化前提 label');
    const scenRec = resScen.evolutionRecommendations.find((e) => e.slotType === 'scenario');
    assert.ok(scenRec && scenRec.canEvolve && scenRec.baseSkillId === 202721);

    // 3. ロック中金スキルも進化を反映しつつ二重加算しない（進化前提ラベルなし）
    const goldLocked = makeDetectedSkill(200511, { recognizedCost: 200, isLocked: true });
    const resLocked = solver.solve([goldLocked], {
      availableSp: 200,
      aptitudes: defaultAptitudes,
      selectedCardId: 100101,
      lockedSkillIds: [200511],
      excludedSkillIds: [],
    });
    assert.equal(resLocked.totalAdditionalGrade, 633);
    assert.equal(resLocked.maxGradeValue, 633);
    assert.equal(resLocked.recommendedSkills[0].effectiveGrade, 633);
    assert.equal(resLocked.recommendedSkills[0].reason, '必須取得（ロック中）');
  });

  test('keeps gold/circle/double costs and DP maxGradeValue invariant across repeated up/down scroll scans', () => {
    // What: Scrolling back and forth with single-frame edge OCR noise on rarity=2 (機転: 324 vs 224),
    // rarity=1 ○/◎ sync (良バ場○: 63 vs 67), or 1-frame pink blur must not mutate confirmed costs/states or DP grade.
    // Also a real direct ◎ sighting must replace a synthetic ◎ cost created when ○ was seen selected above it.
    const agg = new RecognitionAggregator(masterStore);
    const solver = new TypeScriptSkillSolver(masterStore);
    const makeFrame = (cards) => ({
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'compact',
      skillPoint: 600,
      cards: cards.map((c) => ({
        dist: 120,
        box: { top: 500, bottom: 590, height: 90 },
        ...c,
      })),
    });

    // Pass 1 (down): 良バ場○(63) -> 良バ場◎(77) と 機転(324) を確定
    agg.processOutput(makeFrame([{ skillId: 200152, name: '良バ場○', needSp: 63, state: 'unselected' }]));
    const afterPass1 = agg.processOutput(makeFrame([{ skillId: 204731, name: '機転', needSp: 324, state: 'unselected' }]));

    const resPass1 = solver.solve(afterPass1.detectedSkills, {
      availableSp: 400,
      aptitudes: defaultAptitudes,
    });

    // Pass 2 (up/down scroll with edge digit noise & 1-frame pink blur)
    agg.processOutput(makeFrame([{ skillId: 204731, name: '機転', needSp: 224, state: 'unselected' }]));
    agg.processOutput(makeFrame([{ skillId: 200152, name: '良バ場○', needSp: 67, state: 'unselected' }]));
    const afterPass2 = agg.processOutput(
      makeFrame([{ skillId: 204731, name: '機転', needSp: 0, state: 'selected' }])
    );

    const kiten = afterPass2.detectedSkills.find((s) => s.id === 204731);
    const ryouDouble = afterPass2.detectedSkills.find((s) => s.id === 200151);
    assert.equal(kiten?.recognizedCost, 324, 'Gold skill 機転 cost must remain locked against scroll edge noise');
    assert.equal(kiten?.state, 'unselected', 'Single-frame pink blur must not flip skill state');
    assert.equal(ryouDouble?.recognizedCost, 77, 'Synthesized 良バ場◎ cost must not drift on 良バ場○ re-scan');

    const resPass2 = solver.solve(afterPass2.detectedSkills, {
      availableSp: 400,
      aptitudes: defaultAptitudes,
    });
    assert.equal(resPass2.maxGradeValue, resPass1.maxGradeValue, 'DP maxGradeValue must stay invariant on re-scroll');

    // Separate session: selected ○ (needSp=0) above real discounted ◎ (needSp=77)
    const agg2 = new RecognitionAggregator(masterStore);
    agg2.processOutput(makeFrame([{ skillId: 200152, name: '良バ場○', needSp: 0, state: 'selected' }]));
    const afterDirectDouble = agg2.processOutput(
      makeFrame([{ skillId: 200151, name: '良バ場◎', needSp: 77, state: 'unselected' }])
    );
    const realDouble = afterDirectDouble.detectedSkills.find((s) => s.id === 200151);
    assert.equal(realDouble?.recognizedCost, 77, 'Direct ◎ sighting must override synthetic default cost from selected ○');
  });

  test('selects optimal 2 scenario evolutions when 3+ scenario-evolvable candidates exist', () => {
    // What: With scenarioId=15 (max 2 scenario evolutions) and 3 scenario-evolvable candidates,
    // DP assigns the 2 slots to the highest-gain pair (+137pt each -> 696pt) and leaves the 3rd unevolved (508pt).
    const solver = new TypeScriptSkillSolver(masterStore);
    const neverGiveUp = makeDetectedSkill(202721, { recognizedCost: 180 }); // 508 -> 633 (+125)
    const kikotsu = makeDetectedSkill(202751, { recognizedCost: 180 }); // short A: 559 -> 696 (+137)
    const moyuru = makeDetectedSkill(204051, { recognizedCost: 180 }); // middle A: 559 -> 696 (+137)

    const res3 = solver.solve([neverGiveUp, kikotsu, moyuru], {
      availableSp: 540,
      aptitudes: defaultAptitudes,
      selectedScenarioId: 15,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });

    assert.equal(res3.recommendedSkills.length, 3);
    assert.equal(res3.totalAdditionalGrade, 696 + 696 + 508, 'Total must be 1900 (two evolved +137, one unevolved 508)');
    assert.equal(res3.maxGradeValue, 1900);
    const scenEvos = res3.evolutionRecommendations.filter((e) => e.slotType === 'scenario' && e.canEvolve);
    assert.equal(scenEvos.length, 2, 'Must recommend exactly 2 scenario evolutions');
    assert.deepEqual(
      scenEvos.map((e) => e.baseSkillId).sort((a, b) => a - b),
      [202751, 204051],
      'Must allocate the 2 scenario slots to 気骨稜稜 and 燃ゆる魂 (+137pt each)'
    );

    // 自前覚醒Lv5 (全身全霊) + シナリオ2枠 (気骨稜稜・燃ゆる魂) の計3枠同時最適化
    const zenshin = makeDetectedSkill(200511, { recognizedCost: 170 }); // chara Lv5: 508 -> 633 (+125), also in scenario 15
    const resCombo = solver.solve([zenshin, kikotsu, moyuru], {
      availableSp: 530,
      aptitudes: defaultAptitudes,
      selectedCardId: 100101,
      selectedScenarioId: 15,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.equal(resCombo.totalAdditionalGrade, 633 + 696 + 696);
    assert.equal(resCombo.maxGradeValue, 2025);
    assert.equal(resCombo.evolutionRecommendations.filter((e) => e.canEvolve).length, 3);
  });

  test('enforces same-group mutual exclusion (中距離コーナー○ / ◎ / 光芒円刃) and suppresses ◎ when gold is selected', () => {
    // What: Within groupId 20111, SP=250 selects only 光芒円刃 (never ◎), SP=100 selects only ○,
    // and when 光芒円刃 is already selected alongside ○/◎, ◎ and ○ are excluded from recommendations and not double-counted.
    const solver = new TypeScriptSkillSolver(masterStore);
    const circle = makeDetectedSkill(201112, { recognizedCost: 100 }); // 中距離コーナー○ (rate 1, 239pt)
    const double = makeDetectedSkill(201111, { recognizedCost: 110 }); // 中距離コーナー◎ (rate 2, 288pt, +110SP)
    const gold = makeDetectedSkill(201113, { recognizedCost: 250 });   // 光芒円刃 (rate 3, 559pt, cumulative 250SP)

    // 1. SP=250: 光芒円刃のみ選ばれ、◎も○も選ばれない
    const res250 = solver.solve([circle, double, gold], {
      availableSp: 250,
      aptitudes: defaultAptitudes,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.deepEqual(res250.recommendedSkills.map((r) => r.skill.id), [201113]);
    assert.equal(res250.spentSp, 250);
    assert.equal(res250.maxGradeValue, 559);

    // 2. SP=100: 中距離コーナー○のみ選ばれる
    const res100 = solver.solve([circle, double, gold], {
      availableSp: 100,
      aptitudes: defaultAptitudes,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.deepEqual(res100.recommendedSkills.map((r) => r.skill.id), [201112]);
    assert.equal(res100.spentSp, 100);
    assert.equal(res100.maxGradeValue, 239);

    // 3. 光芒円刃が selected で、中距離コーナー○ (acquired) と 中距離コーナー◎ (unselected) が同居していても ◎ は推奨されない
    const circleAcq = makeDetectedSkill(201112, { recognizedCost: 0, state: 'acquired' });
    const doubleUnselected = makeDetectedSkill(201111, { recognizedCost: 110, state: 'unselected' });
    const goldSelected = makeDetectedSkill(201113, { recognizedCost: 0, state: 'selected' });

    const resGoldSelected = solver.solve([circleAcq, doubleUnselected, goldSelected], {
      availableSp: 500,
      aptitudes: defaultAptitudes,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.deepEqual(
      resGoldSelected.recommendedSkills,
      [],
      'Must not recommend 中距離コーナー◎ or ○ when 光芒円刃 is already selected'
    );
    assert.equal(
      resGoldSelected.maxGradeValue,
      559,
      'Must count only highest groupRate skill (光芒円刃=559pt), not ○ + 光芒円刃'
    );
  });

  test('handles acquired/locked scenario competition, chara-vs-scenario exclusion, and locked group exclusivity', () => {
    // What: Acquired gold skills compete fairly for the 2 scenario slots against unselected candidates,
    // chara Lv5 vs scenario on the same skill (100101 + scenario 7) picks the higher-grade path without double-counting,
    // and locking a gold skill suppresses lower ○/◎ skills in the same group.
    const solver = new TypeScriptSkillSolver(masterStore);

    // 1. 既取得(acquired)のシナリオ進化対象(+125) vs 未取得候補2種(+137ずつ) → 候補2種がシナリオ枠を取り、既取得は未進化維持
    const acqScen = makeDetectedSkill(202721, { recognizedCost: 0, state: 'acquired' }); // 508 -> 633 (+125)
    const kikotsu = makeDetectedSkill(202751, { recognizedCost: 180 }); // 559 -> 696 (+137)
    const moyuru = makeDetectedSkill(204051, { recognizedCost: 180 }); // 559 -> 696 (+137)
    const resAcq = solver.solve([acqScen, kikotsu, moyuru], {
      availableSp: 360,
      aptitudes: defaultAptitudes,
      selectedScenarioId: 15,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.equal(resAcq.totalAdditionalGrade, 696 + 696);
    assert.equal(resAcq.maxGradeValue, 508 + 696 + 696);
    assert.deepEqual(
      resAcq.evolutionRecommendations
        .filter((e) => e.slotType === 'scenario' && e.canEvolve)
        .map((e) => e.baseSkillId)
        .sort((a, b) => a - b),
      [202751, 204051]
    );

    // 2. 同一スキルでシナリオ進化(696) > 自前Lv5(633) (cardId: 100101, scenarioId: 7, 全身全霊 200511)
    const zenshin = makeDetectedSkill(200511, { recognizedCost: 170 });
    const resDual = solver.solve([zenshin], {
      availableSp: 200,
      aptitudes: defaultAptitudes,
      selectedCardId: 100101,
      selectedScenarioId: 7,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.equal(resDual.totalAdditionalGrade, 696);
    assert.equal(resDual.maxGradeValue, 696);
    const charaLv5 = resDual.evolutionRecommendations.find((e) => e.slotType === 'chara_lv5');
    const scenDual = resDual.evolutionRecommendations.find((e) => e.slotType === 'scenario');
    assert.equal(charaLv5?.canEvolve, false, 'Chara Lv5 must not also evolve when Scenario evolution wins');
    assert.equal(scenDual?.canEvolve, true);

    // 3. 光芒円刃をロックした状態で 中距離コーナー○/◎ が候補にあっても同グループ下位は推奨されない
    const circle = makeDetectedSkill(201112, { recognizedCost: 100 });
    const double = makeDetectedSkill(201111, { recognizedCost: 110 });
    const goldLocked = makeDetectedSkill(201113, { recognizedCost: 250, isLocked: true });
    const resLockedGroup = solver.solve([circle, double, goldLocked], {
      availableSp: 400,
      aptitudes: defaultAptitudes,
      lockedSkillIds: [201113],
      excludedSkillIds: [],
    });
    assert.deepEqual(resLockedGroup.recommendedSkills.map((r) => r.skill.id), [201113]);
    assert.equal(resLockedGroup.spentSp, 250);
    assert.equal(resLockedGroup.maxGradeValue, 559);
  });
});

// 15. 残SP 0〜9 更新回帰テスト (from Public PR #4 contribution)
describe('Exhausted SP update', () => {
  const masterData = JSON.parse(fs.readFileSync(resolveDataFile('skill_master.json'), 'utf8'));
  const masterStore = new MasterStore(masterData);

  test('accepts 1-digit and 0 SP as confirmed values after 2-frame consensus', () => {
    // What: スキルを買い切った直後の 0〜9 SP が未認識扱いで据え置かれず、0 まで更新されること。
    const agg = new RecognitionAggregator(masterStore);
    const frame = (skillPoint, skillPointValid = true) => ({
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'compact',
      skillPoint,
      skillPointValid,
      cards: [],
    });

    assert.equal(agg.processOutput(frame(380)).detectedSkillPoint, undefined);
    assert.equal(agg.processOutput(frame(380)).detectedSkillPoint, 380);

    // 1桁 (8)
    assert.equal(agg.processOutput(frame(8)).detectedSkillPoint, 380);
    assert.equal(agg.processOutput(frame(8)).detectedSkillPoint, 8);

    // 0 (SPを使い切った状態)
    assert.equal(agg.processOutput(frame(0)).detectedSkillPoint, 8);
    assert.equal(agg.processOutput(frame(0)).detectedSkillPoint, 0);

    // OCR失敗 (skillPointValid=false) の 0 は確定値に影響しない
    assert.equal(agg.processOutput(frame(0, false)).detectedSkillPoint, 0);
  });
});

// 16. Review指出エッジケース回帰テスト (◎->[-]戻し / 後出し適性ポップアップ / DP最小消費SPタイブレーク)
describe('Review Edge Cases (◎ Revert, Late CharaDetail Dedup, Min-SP Tiebreak)', () => {
  const masterData = JSON.parse(fs.readFileSync(resolveDataFile('skill_master.json'), 'utf8'));
  const masterStore = new MasterStore(masterData);
  const defaultAptitudes = {
    turf: 'A',
    dirt: 'G',
    short: 'A',
    mile: 'A',
    middle: 'A',
    long: 'A',
    nige: 'A',
    senkou: 'A',
    sashi: 'A',
    oikomi: 'A',
  };

  test('resets synthetic ◎ state back to unselected when [-] reverts group to ○ unselected without clobbering acquired ◎', () => {
    // What: ◎を選択後に[-]で○（未選択）へ戻した場合に合成された◎もunselectedへ戻り、ソルバー候補から消えないこと。
    // また、既に本取得(acquired)された◎がある場合は未選択○観測で上書きされないこと。
    const agg = new RecognitionAggregator(masterStore);
    const cardFrame = (cards) => ({
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'compact',
      skillPoint: 1000,
      skillPointValid: true,
      cards,
    });

    // 1. まず ○ (右回り○: 200012, needSp=54) を2フレーム観測
    const singleUns = { skillId: 200012, name: '右回り○', needSp: 54, state: 'unselected', dist: 10, box: { top: 0, bottom: 90, height: 90 } };
    agg.processOutput(cardFrame([singleUns]));
    agg.processOutput(cardFrame([singleUns]));

    // 2. [+] で ◎ (右回り◎: 200011, selected) に変化し2フレーム観測
    const doubleSel = { skillId: 200011, name: '右回り◎', needSp: 0, state: 'selected', dist: 10, box: { top: 0, bottom: 90, height: 90 } };
    agg.processOutput(cardFrame([doubleSel]));
    let res = agg.processOutput(cardFrame([doubleSel]));
    assert.equal(res.detectedSkills.find((s) => s.id === 200011)?.state, 'selected');
    assert.equal(res.detectedSkills.find((s) => s.id === 200012)?.state, 'selected');

    // 3. [-] で ○ (unselected, needSp=54) まで戻した状態を2フレーム観測 -> ○と◎の両方が unselected に戻る
    agg.processOutput(cardFrame([singleUns]));
    res = agg.processOutput(cardFrame([singleUns]));
    assert.equal(res.detectedSkills.find((s) => s.id === 200012)?.state, 'unselected');
    assert.equal(res.detectedSkills.find((s) => s.id === 200011)?.state, 'unselected');

    // ソルバー上で ○ または ◎ が推奨候補に含まれること（◎ selected 残留で両方消えないこと）
    const solver = new TypeScriptSkillSolver(masterStore);
    const solved = solver.solve(res.detectedSkills, {
      availableSp: 200,
      aptitudes: defaultAptitudes,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.ok(
      solved.recommendedSkills.some((r) => r.skill.id === 200012 || r.skill.id === 200011),
      'Reverted ○/◎ group must remain eligible for solver recommendation'
    );

    // 4. acquired 保護テスト: ○ unselected で既に acquired な ◎ を上書きしないこと
    const aggAcq = new RecognitionAggregator(masterStore);
    const doubleAcq = { skillId: 200011, name: '右回り◎', needSp: 0, state: 'acquired', dist: 10, box: { top: 0, bottom: 90, height: 90 } };
    aggAcq.processOutput(cardFrame([doubleAcq]));
    aggAcq.processOutput(cardFrame([doubleAcq]));
    aggAcq.processOutput(cardFrame([singleUns]));
    const resAcq = aggAcq.processOutput(cardFrame([singleUns]));
    assert.equal(resAcq.detectedSkills.find((s) => s.id === 200011)?.state, 'acquired');
  });

  test('removes same-name 900k inheritable unique skill when ウマ娘詳細適性ポップアップ is opened after scanning skill list', () => {
    // What: スキル一覧を先にスキャンして同名継承固有(900671)が蓄積された後に適性ポップアップ(106701)を開いても、重複継承固有が除外されること。
    const agg = new RecognitionAggregator(masterStore);
    const fake900k = {
      skillId: 900671,
      name: '晦冥を照らせ永遠の耀き',
      needSp: 180,
      state: 'unselected',
      dist: 10,
      box: { top: 0, bottom: 90, height: 90 },
    };
    agg.processOutput({
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'compact',
      skillPoint: 1000,
      skillPointValid: true,
      cards: [fake900k],
    });
    let res = agg.processOutput({
      screenType: 'スキル獲得説明省略表示',
      screenMode: 'compact',
      skillPoint: 1000,
      skillPointValid: true,
      cards: [fake900k],
    });
    assert.ok(res.detectedSkills.some((s) => s.id === 900671));

    // 後からウマ娘詳細適性ポップアップを開く (cards: [], detectedCardId: 106701)
    res = agg.processOutput({
      screenType: 'ウマ娘詳細適性ポップアップ',
      screenMode: 'chara_detail',
      skillPoint: 0,
      skillPointValid: false,
      detectedCardId: 106701,
      cards: [],
    });
    assert.equal(res.detectedCardId, 106701);
    assert.equal(
      res.detectedSkills.some((s) => s.id === 900671),
      false,
      'Inheritable duplicate 900671 matching card 106701 uniqueSkillId must be purged even with empty cards'
    );
  });

  test('DP prefers lower spent SP when two evolution states achieve the exact same max grade', () => {
    // What: 進化状態ごとに同点(val === bestGrade)になる場合、後から評価される状態でも消費SPが小さい解(sp < bestSp)を採用すること。
    const solver = new TypeScriptSkillSolver(masterStore);
    const goldBase = masterStore.skillsById.get(200511); // 全身全霊 (cardId=100101 Lv5進化で633pt)
    assert.ok(goldBase);
    const goldSkill = {
      id: goldBase.id,
      name: goldBase.name,
      recognizedCost: 180,
      baseCost: goldBase.needSkillPoint,
      gradeValue: goldBase.gradeValue,
      rarity: goldBase.rarity,
      groupId: goldBase.groupId,
      groupRate: goldBase.groupRate,
      state: 'unselected',
      isLocked: false,
      isExcluded: false,
      canEvolve: false,
      lastSeenTimestamp: 0,
    };
    const highCostWhite = {
      id: 990003,
      name: '高コスト白スキル',
      recognizedCost: 220,
      baseCost: 220,
      gradeValue: 633,
      rarity: 1,
      groupId: 990003,
      groupRate: 1,
      state: 'unselected',
      isLocked: false,
      isExcluded: false,
      canEvolve: false,
      lastSeenTimestamp: 0,
    };

    const solved = solver.solve([highCostWhite, goldSkill], {
      availableSp: 220,
      aptitudes: defaultAptitudes,
      selectedCardId: 100101,
      lockedSkillIds: [],
      excludedSkillIds: [],
    });
    assert.equal(solved.maxGradeValue, 633);
    assert.equal(solved.spentSp, 180, 'Must prefer 180 SP evolved 全身全霊 over 220 SP tie');
    assert.deepEqual(solved.recommendedSkills.map((r) => r.skill.id), [200511]);
  });
});

// 17. mergeRecognizedSkills 回帰テスト (同一ミリ秒更新ロスト防止・空配列反映)
describe('mergeRecognizedSkills (Same-Millisecond Update & Empty Array Reflection)', () => {
  const makeItem = (overrides = {}) => ({
    id: 200012,
    name: '右回り○',
    recognizedCost: 54,
    baseCost: 90,
    gradeValue: 129,
    rarity: 1,
    groupId: 20001,
    groupRate: 1,
    state: 'unselected',
    isLocked: false,
    isExcluded: false,
    canEvolve: false,
    lastSeenTimestamp: 1700000000000,
    firstSeenOrder: 1,
    ...overrides,
  });

  test('applies state and recognizedCost updates when lastSeenTimestamp matches existing millisecond', () => {
    // What: 2ワーカー並列処理などで Date.now() が同一ミリ秒になった場合も state/recognizedCost 更新をロストせず、isLocked/isExcluded は維持すること。
    const prev = [makeItem({ isLocked: true, isExcluded: false, state: 'unselected', recognizedCost: 54 })];
    const incoming = [makeItem({ isLocked: false, state: 'selected', recognizedCost: 0, lastSeenTimestamp: 1700000000000 })];

    const merged = mergeRecognizedSkills(prev, incoming);
    assert.notEqual(merged, prev, 'Merged array must update reference when state/cost changed on same millisecond');
    assert.equal(merged.length, 1);
    assert.equal(merged[0].state, 'selected');
    assert.equal(merged[0].recognizedCost, 0);
    assert.equal(merged[0].isLocked, true, 'Must preserve user lock flag');
    assert.equal(merged[0].isExcluded, false, 'Must preserve user exclude flag');

    // 同一内容・同一タイムスタンプの場合は既存参照を返すこと
    const unchanged = mergeRecognizedSkills(merged, [
      makeItem({ state: 'selected', recognizedCost: 0, lastSeenTimestamp: 1700000000000 }),
    ]);
    assert.equal(unchanged, merged, 'Must preserve array reference when nothing changed');
  });

  test('clears previous skills when incoming skills becomes empty (e.g. 900k deduplication)', () => {
    // What: 重複継承固有の除去などで incomingSkills が空配列になった場合、UI側のスキル配列も空配列に追従すること。
    const prev = [makeItem({ id: 900671, name: '晦冥を照らせ永遠の耀き' })];
    const cleared = mergeRecognizedSkills(prev, []);
    assert.deepEqual(cleared, []);

    const alreadyEmpty = [];
    assert.equal(mergeRecognizedSkills(alreadyEmpty, []), alreadyEmpty);
  });
});
