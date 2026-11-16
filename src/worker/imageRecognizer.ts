/**
 * imageRecognizer.ts
 *
 * ブラウザおよび Node.js の RGBA バッファに対して動作する
 * 純粋な TypeScript 実装の画像認識パイプライン。
 */

export interface ImageBuffer {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

interface ConnectedComponent {
  left: number;
  top: number;
  width: number;
  height: number;
  area: number;
  cx: number;
  cy: number;
}

export interface RecognizedCardResult {
  skillId: number;
  name: string;
  needSp: number;
  state: 'unselected' | 'selected' | 'acquired';
  dist: number;
  box: { top: number; bottom: number; height: number };
}

export interface RecognitionOutput {
  screenType: 'ウマ娘詳細適性ポップアップ' | '育成完了確認（ホーム画面）' | 'スキル獲得説明省略表示' | 'スキル獲得通常表示';
  screenMode: 'chara_detail' | 'idle' | 'compact' | 'normal';
  skillPoint: number;
  aptitudes?: Record<string, string>;
  detectedCardId?: number;
  cards: RecognizedCardResult[];
}

export interface TemplatesData {
  digits: Record<
    string,
    {
      norm_16x20: {
        mask: number[];
      };
    }
  >;
  anchors: {
    shiba: {
      sizes: Record<
        string,
        {
          width: number;
          height: number;
          pixels: number[][];
        }
      >;
    };
  };
  skills?: {
    id: number;
    name: string;
    aspect_ratio: number;
    feature_128b: string;
    head_64b: string;
    tail_64b: string;
    need_pt?: number;
    rarity?: number;
    valid_costs?: number[];
  }[];
  cards?: {
    card_id: number;
    chara_name: string;
    card_title: string;
    name_feature: string;
    title_feature: string;
  }[];
}

const APT_NAMES = ['芝', 'ダート', '短距離', 'マイル', '中距離', '長距離', '逃げ', '先行', '差し', '追込'];

/**
 * 8連結の連結成分ラベリング (OpenCV connectedComponentsWithStats 互換)
 */
function connectedComponentsWithStats(
  binaryImage: Uint8Array,
  width: number,
  height: number
): ConnectedComponent[] {
  const labels = new Int32Array(width * height);
  const components: ConnectedComponent[] = [];
  let currentLabel = 0;

  const queueX = new Int32Array(width * height);
  const queueY = new Int32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if (binaryImage[idx] === 0 || labels[idx] !== 0) {
        continue;
      }

      currentLabel++;
      labels[idx] = currentLabel;

      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      let area = 0;
      let sumX = 0;
      let sumY = 0;

      let head = 0;
      let tail = 0;
      queueX[tail] = x;
      queueY[tail] = y;
      tail++;

      while (head < tail) {
        const qx = queueX[head];
        const qy = queueY[head];
        head++;

        area++;
        sumX += qx;
        sumY += qy;

        if (qx < minX) minX = qx;
        if (qx > maxX) maxX = qx;
        if (qy < minY) minY = qy;
        if (qy > maxY) maxY = qy;

        // 8近傍探索
        for (let dy = -1; dy <= 1; dy++) {
          const ny = qy + dy;
          if (ny < 0 || ny >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = qx + dx;
            if (nx < 0 || nx >= width) continue;

            const nIdx = ny * width + nx;
            if (binaryImage[nIdx] !== 0 && labels[nIdx] === 0) {
              labels[nIdx] = currentLabel;
              queueX[tail] = nx;
              queueY[tail] = ny;
              tail++;
            }
          }
        }
      }

      components.push({
        left: minX,
        top: minY,
        width: maxX - minX + 1,
        height: maxY - minY + 1,
        area,
        cx: sumX / area,
        cy: sumY / area,
      });
    }
  }

  return components;
}

/**
 * 画像のリサイズ (OpenCV INTER_AREA 互換の面積平均)
 */
function resizeArea(
  src: Uint8Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Uint8Array {
  const dst = new Uint8Array(dstW * dstH);
  const xRatio = srcW / dstW;
  const yRatio = srcH / dstH;

  for (let dy = 0; dy < dstH; dy++) {
    const syStart = dy * yRatio;
    const syEnd = (dy + 1) * yRatio;
    const sy0 = Math.floor(syStart);
    const sy1 = Math.min(srcH, Math.ceil(syEnd));

    for (let dx = 0; dx < dstW; dx++) {
      const sxStart = dx * xRatio;
      const sxEnd = (dx + 1) * xRatio;
      const sx0 = Math.floor(sxStart);
      const sx1 = Math.min(srcW, Math.ceil(sxEnd));

      let totalWeight = 0;
      let weightedSum = 0;

      for (let sy = sy0; sy < sy1; sy++) {
        const yWeight = Math.min(sy + 1, syEnd) - Math.max(sy, syStart);
        if (yWeight <= 0) continue;

        for (let sx = sx0; sx < sx1; sx++) {
          const xWeight = Math.min(sx + 1, sxEnd) - Math.max(sx, sxStart);
          if (xWeight <= 0) continue;

          const weight = xWeight * yWeight;
          weightedSum += src[sy * srcW + sx] * weight;
          totalWeight += weight;
        }
      }

      dst[dy * dstW + dx] = totalWeight > 0 ? Math.round(weightedSum / totalWeight) : 0;
    }
  }

  return dst;
}

interface MatchResult {
  score: number;
  bestX: number;
  bestY: number;
}

const POPCNT16 = new Uint8Array(65536);
for (let i = 1; i < 65536; i++) {
  POPCNT16[i] = POPCNT16[i >> 1] + (i & 1);
}
const POPCNT8 = POPCNT16.subarray(0, 256);

function toUint16View(bytes: Uint8Array): Uint16Array {
  if ((bytes.byteOffset & 1) === 0) {
    return new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  }
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  return new Uint16Array(aligned.buffer);
}

function fnv1aHash(arr: Uint8Array): number {
  let h = 2166136261;
  for (let i = 0; i < arr.length; i++) {
    h ^= arr[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * 2値配列 (0..255) を 1バイト 8ビットとしてビットパック (> threshold を 1 とする)
 */
function packBits(binArr: Uint8Array, threshold = 128): Uint8Array {
  const packed = new Uint8Array(binArr.length >> 3);
  for (let i = 0; i < binArr.length; i++) {
    if (binArr[i] > threshold) {
      packed[i >> 3] |= 1 << (7 - (i & 7));
    }
  }
  return packed;
}

/**
 * ビットパック配列を行ごとに -1, 0, +1 ビットシフト
 */
function shiftBits(
  bytes: Uint8Array,
  rowBytes: number,
  numRows: number,
  shift: number
): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let row = 0; row < numRows; row++) {
    const rOff = row * rowBytes;
    for (let b = 0; b < rowBytes; b++) {
      const cur = bytes[rOff + b];
      if (shift === -1) {
        const next = b < rowBytes - 1 ? bytes[rOff + b + 1] : 0;
        out[rOff + b] = ((cur << 1) & 0xff) | (next >> 7);
      } else if (shift === 1) {
        const prev = b > 0 ? bytes[rOff + b - 1] : 0;
        out[rOff + b] = (cur >> 1) | ((prev & 1) << 7);
      } else {
        out[rOff + b] = cur;
      }
    }
  }
  return out;
}

interface PreparedTemplate {
  tmplW: number;
  tmplH: number;
  tmplZero: Float32Array;
  invSqrtTmplVar: number;
  isBinary: boolean;
  tmplMean: number;
  fgY: Uint16Array;
  fgX: Uint16Array;
}

const templateCache = new WeakMap<number[][], PreparedTemplate>();

function getPreparedTemplate(tmpl: number[][], tmplW: number, tmplH: number): PreparedTemplate | null {
  const cached = templateCache.get(tmpl);
  if (cached && cached.tmplW === tmplW && cached.tmplH === tmplH) {
    return cached;
  }

  const area = tmplW * tmplH;
  let tmplSum = 0;
  let isBinary = true;
  let fgCount = 0;
  for (let y = 0; y < tmplH; y++) {
    const row = tmpl[y];
    for (let x = 0; x < tmplW; x++) {
      const val = row[x];
      tmplSum += val;
      if (val === 255) fgCount++;
      else if (val !== 0) isBinary = false;
    }
  }
  const tmplMean = tmplSum / area;

  const tmplZero = new Float32Array(area);
  const fgY = new Uint16Array(isBinary ? fgCount : 0);
  const fgX = new Uint16Array(isBinary ? fgCount : 0);
  let fgIdx = 0;
  let tmplVar = 0;
  for (let y = 0; y < tmplH; y++) {
    const row = tmpl[y];
    const base = y * tmplW;
    for (let x = 0; x < tmplW; x++) {
      const val = row[x];
      const diff = val - tmplMean;
      tmplZero[base + x] = diff;
      tmplVar += diff * diff;
      if (isBinary && val === 255) {
        fgY[fgIdx] = y;
        fgX[fgIdx] = x;
        fgIdx++;
      }
    }
  }
  if (tmplVar <= 1e-6) return null;

  const prepared: PreparedTemplate = {
    tmplW,
    tmplH,
    tmplZero,
    invSqrtTmplVar: 1.0 / Math.sqrt(tmplVar),
    isBinary,
    tmplMean,
    fgY,
    fgX,
  };
  templateCache.set(tmpl, prepared);
  return prepared;
}

/**
 * テンプレートマッチング (TM_CCOEFF_NORMED)
 * 積分画像による O(1) ROI 分散計算と 1次元 TypedArray / 2値スパース共分散で厳密一致を高速算出
 */
function matchTemplateNormed(
  roi: Uint8Array,
  roiW: number,
  roiH: number,
  tmpl: number[][],
  tmplW: number,
  tmplH: number
): MatchResult {
  if (roiW < tmplW || roiH < tmplH) return { score: 0, bestX: 0, bestY: 0 };

  const prep = getPreparedTemplate(tmpl, tmplW, tmplH);
  if (!prep) return { score: 0, bestX: 0, bestY: 0 };

  const { tmplZero, invSqrtTmplVar, isBinary, tmplMean, fgY, fgX } = prep;
  const fgCount = fgY.length;
  const area = tmplW * tmplH;
  const invArea = 1.0 / area;

  // 積分画像 (sum と sumSq) を構築し、任意ウィンドウの roiVar を O(1) で求める
  const satW = roiW + 1;
  const sat = new Float64Array(satW * (roiH + 1));
  const satSq = new Float64Array(satW * (roiH + 1));
  for (let y = 0; y < roiH; y++) {
    let rowSum = 0;
    let rowSqSum = 0;
    const srcOff = y * roiW;
    const prevOff = y * satW;
    const curOff = (y + 1) * satW;
    for (let x = 0; x < roiW; x++) {
      const v = roi[srcOff + x];
      rowSum += v;
      rowSqSum += v * v;
      sat[curOff + x + 1] = sat[prevOff + x + 1] + rowSum;
      satSq[curOff + x + 1] = satSq[prevOff + x + 1] + rowSqSum;
    }
  }

  const maxRx = roiW - tmplW;
  const maxRy = roiH - tmplH;
  let maxScore = -1.0;
  let bestX = 0;
  let bestY = 0;

  for (let ry = 0; ry <= maxRy; ry++) {
    const r0 = ry * satW;
    const r1 = (ry + tmplH) * satW;
    for (let rx = 0; rx <= maxRx; rx++) {
      const c0 = rx;
      const c1 = rx + tmplW;
      const sum = sat[r1 + c1] - sat[r0 + c1] - sat[r1 + c0] + sat[r0 + c0];
      const sqSum = satSq[r1 + c1] - satSq[r0 + c1] - satSq[r1 + c0] + satSq[r0 + c0];
      const roiVar = sqSum - sum * sum * invArea;
      if (roiVar <= 1e-6) continue;

      let cov: number;
      if (isBinary) {
        let fgSum = 0;
        for (let i = 0; i < fgCount; i++) {
          fgSum += roi[(ry + fgY[i]) * roiW + (rx + fgX[i])];
        }
        cov = 255 * fgSum - tmplMean * sum;
      } else {
        // sum(tmplZero) == 0 のため sum(tmplZero * (R - Rmean)) == sum(tmplZero * R) が 1パスで成立する
        cov = 0;
        for (let y = 0; y < tmplH; y++) {
          const rOff = (ry + y) * roiW + rx;
          const tOff = y * tmplW;
          for (let x = 0; x < tmplW; x++) {
            cov += tmplZero[tOff + x] * roi[rOff + x];
          }
        }
      }

      const s = (cov * invSqrtTmplVar) / Math.sqrt(roiVar);
      if (s > maxScore) {
        maxScore = s;
        bestX = rx;
        bestY = ry;
      }
    }
  }

  return { score: maxScore, bestX, bestY };
}

function parseHexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export class ImageRecognizer {
  private templates: TemplatesData;
  private initDurationMs = 0;
  private skillTable: {
    id: number;
    name: string;
    aspect: number;
    bytes: Uint8Array;
    headBytes: Uint8Array;
    tailBytes: Uint8Array;
    bytes16: Uint16Array;
    head16: Uint16Array;
    tail16: Uint16Array;
    need_pt: number;
    rarity: number;
    validCosts: Set<number>;
  }[] = [];
  private firstCharFamilyMap: Map<string, (typeof this.skillTable)[0][]> = new Map();
  private racecourseFamilyMap: Map<string, (typeof this.skillTable)[0][]> = new Map();
  private cardTable: {
    cardId: number;
    name: string;
    title: string;
    nameBytes: Uint8Array;
    titleBytes: Uint8Array;
  }[] = [];
  private lastSpCache: {
    screenType: string;
    roiW: number;
    roiH: number;
    hash: number;
    bin: Uint8Array;
    value: number;
  } | null = null;
  private cardNameCache = new Map<
    string,
    {
      fullBytes: Uint8Array;
      result: { skillId: number; name: string; rarity: number; dist: number };
    }
  >();

  constructor(templates: TemplatesData) {
    const tInit0 = performance.now();
    this.templates = templates;

    if (!templates.skills) {
      throw new Error('templates.skills is required to initialize ImageRecognizer');
    }

    for (const s of templates.skills) {
      // 獲得不可・無効スキルの除外 (ハルシネーション防止)
      if (s.rarity === 6) continue;
      if ((s.need_pt === 0 || !s.need_pt) && (s.rarity ?? 0) <= 2) continue;
      // 紫スキル（バッドスキル）はスキル獲得画面の未選択カード枠に出現しないため除外
      if (s.name.endsWith('×')) continue;

      if (!s.head_64b || !s.tail_64b) {
        throw new Error(`Skill template ${s.id} (${s.name}) is missing head_64b or tail_64b`);
      }

      const bytes = parseHexBytes(s.feature_128b);
      const headBytes = parseHexBytes(s.head_64b);
      const tailBytes = parseHexBytes(s.tail_64b);
      const validCosts = new Set<number>(s.valid_costs || []);

      this.skillTable.push({
        id: s.id,
        name: s.name,
        aspect: s.aspect_ratio,
        bytes,
        headBytes,
        tailBytes,
        bytes16: toUint16View(bytes),
        head16: toUint16View(headBytes),
        tail16: toUint16View(tailBytes),
        need_pt: s.need_pt || 0,
        rarity: s.rarity ?? 0,
        validCosts,
      });
    }

    if (templates.cards) {
      for (const c of templates.cards) {
        this.cardTable.push({
          cardId: c.card_id,
          name: c.chara_name,
          title: c.card_title,
          nameBytes: parseHexBytes(c.name_feature),
          titleBytes: parseHexBytes(c.title_feature),
        });
      }
    }

    // aspect 昇順に整列し、認識時の二分探索＋外側スキャンで無関係候補を早期打ち切りする
    this.skillTable.sort((a, b) => a.aspect - b.aspect);

    // 同族スキルファミリ（*ウマ娘○, *回り○, *回りの鬼 等、先頭1文字のみが異なる同長スキルファミリ）の事前インデックス化
    for (const s of this.skillTable) {
      if (s.name.length >= 3) {
        const suf1 = s.name.slice(1);
        let list = this.firstCharFamilyMap.get(suf1);
        if (!list) {
          list = [];
          this.firstCharFamilyMap.set(suf1, list);
        }
        if (!list.some((existing) => existing.name === s.name)) {
          list.push(s);
        }
      }
      if (s.name.endsWith('レース場○') || s.name.endsWith('レース場◎')) {
        const suf = s.name.endsWith('レース場◎') ? 'レース場◎' : 'レース場○';
        let list = this.racecourseFamilyMap.get(suf);
        if (!list) {
          list = [];
          this.racecourseFamilyMap.set(suf, list);
        }
        if (!list.some((existing) => existing.name === s.name)) {
          list.push(s);
        }
      }
    }
    // 先頭文字が異なるスキルが2種類以上存在するファミリのみを保持
    for (const [suf, list] of this.firstCharFamilyMap.entries()) {
      const distinctChars = new Set(list.map((s) => s.name[0]));
      if (distinctChars.size < 2) {
        this.firstCharFamilyMap.delete(suf);
      }
    }

    this.initDurationMs = performance.now() - tInit0;
  }

  public getInitDurationMs(): number {
    return this.initDurationMs;
  }

  public getTableStats(): { skills: number; cards: number } {
    return { skills: this.skillTable.length, cards: this.cardTable.length };
  }

  /**
   * 数字 OCR (トポロジー解析 + 16x20 正規化コサイン相関)
   */
  public recognizeDigit(patch: Uint8Array, pW: number, pH: number): string {
    // 1ピクセルパディング
    const padW = pW + 2;
    const padH = pH + 2;
    const invPad = new Uint8Array(padW * padH);

    for (let y = 0; y < padH; y++) {
      for (let x = 0; x < padW; x++) {
        if (x === 0 || y === 0 || x === padW - 1 || y === padH - 1) {
          invPad[y * padW + x] = 255;
        } else {
          invPad[y * padW + x] = 255 - patch[(y - 1) * pW + (x - 1)];
        }
      }
    }

    // 穴の検出
    const ccs = connectedComponentsWithStats(invPad, padW, padH);
    const holes: ConnectedComponent[] = [];

    for (const c of ccs) {
      if (
        c.left > 0 &&
        c.top > 0 &&
        c.left + c.width < padW &&
        c.top + c.height < padH &&
        c.area >= 3
      ) {
        holes.push(c);
      }
    }

    let candidates: string[];
    const numHoles = holes.length;

    if (numHoles >= 2) {
      candidates = ['8'];
    } else if (numHoles === 1) {
      const h0 = holes[0];
      const holeHRatio = h0.height / padH;
      const cy = h0.cy / padH;

      if (holeHRatio >= 0.42) {
        candidates = ['0'];
      } else if (cy < 0.4) {
        candidates = ['9', '4'];
      } else if (cy > 0.55) {
        candidates = ['6'];
      } else {
        candidates = ['4', '6', '9'];
      }
    } else {
      candidates = ['1', '2', '3', '4', '5', '7'];
    }

    // 16x20 正規化二値化
    const resized = resizeArea(patch, pW, pH, 16, 20);
    const patchNorm = new Float32Array(16 * 20);
    let patchNormSq = 0;
    for (let i = 0; i < 320; i++) {
      const val = resized[i] > 64 ? 1.0 : 0.0;
      patchNorm[i] = val;
      patchNormSq += val * val;
    }

    let bestScore = -999.0;
    let bestCh = candidates[0];

    for (const ch of candidates) {
      const tInfo = this.templates.digits[ch]?.norm_16x20;
      if (!tInfo) continue;

      const tMask = tInfo.mask;
      let dot = 0;
      let tNormSq = 0;
      for (let i = 0; i < 320; i++) {
        dot += patchNorm[i] * tMask[i];
        tNormSq += tMask[i] * tMask[i];
      }

      const corr = dot / (Math.sqrt(patchNormSq) * Math.sqrt(tNormSq) + 1e-6);
      if (corr > bestScore) {
        bestScore = corr;
        bestCh = ch;
      }
    }

    return bestCh;
  }

  /**
   * 画面種別判定 (4種: ポップアップ, ホーム, 説明省略, 通常表示)
   */
  public detectScreenType(img: ImageBuffer): {
    screenType: 'ウマ娘詳細適性ポップアップ' | '育成完了確認（ホーム画面）' | 'スキル獲得説明省略表示' | 'スキル獲得通常表示';
    screenMode: 'chara_detail' | 'idle' | 'compact' | 'normal';
    anchorDx?: number;
    anchorDy?: number;
    titlebarOffsetY: number;
  } {
    const { width: w, height: h, data } = img;

    // タイトルバー等の垂直オフセットを検出
    let titlebarOffsetY = 0;
    if (w > h) {
      const expectedH = Math.round((w * 9) / 16);
      if (h > expectedH + 8) {
        titlebarOffsetY = h - expectedH;
      }
    } else {
      const expectedH = Math.round((w * 16) / 9);
      if (h > expectedH + 8) {
        titlebarOffsetY = h - expectedH;
      }
    }

    // 1. 育成完了確認（ホーム画面）判定 (2pxストライド・暗転中の詳細ポップアップは常にオレンジ=0)
    // Why not green toggle before orange: ホーム画面の左下領域にも緑要素が含まれるため、オレンジボタン判定を先に実行する
    let btnY0: number;
    let btnY1: number;
    let btnX0: number;
    let btnX1: number;

    if (w > h) {
      btnY0 = Math.floor((h - titlebarOffsetY) * 0.75) + titlebarOffsetY;
      btnY1 = Math.floor((h - titlebarOffsetY) * 0.95) + titlebarOffsetY;
      btnX0 = Math.floor(w * 0.15);
      btnX1 = Math.floor(w * 0.45);
    } else {
      btnY0 = Math.floor((h - titlebarOffsetY) * 0.8) + titlebarOffsetY;
      btnY1 = Math.floor((h - titlebarOffsetY) * 0.95) + titlebarOffsetY;
      btnX0 = Math.floor(w * 0.1);
      btnX1 = w;
    }

    let orangePixels = 0;
    for (let y = btnY0; y < btnY1; y += 2) {
      const rowOffset = y * w;
      for (let x = btnX0; x < btnX1; x += 2) {
        const idx = (rowOffset + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (r > 200 && g > 80 && g < 180 && b < 90) {
          orangePixels++;
        }
      }
    }

    if (orangePixels > 625) {
      return {
        screenType: '育成完了確認（ホーム画面）',
        screenMode: 'idle',
        anchorDx: 0,
        anchorDy: 0,
        titlebarOffsetY,
      };
    }

    // 2. スキル獲得説明省略表示トグル判定 (ポップアップ暗転時は緑比率 0 のため、先に軽量判定し芝マッチングを回避)
    let togY0: number;
    let togY1: number;
    let togX0: number;
    let togX1: number;

    if (w > h) {
      const scale = (h - titlebarOffsetY) / 1080.0;
      togY0 = Math.floor(815 * scale) + titlebarOffsetY;
      togY1 = Math.floor(858 * scale) + titlebarOffsetY;
      togX0 = Math.floor(175 * scale);
      togX1 = Math.floor(295 * scale);
    } else {
      togY0 = Math.floor(0.755 * (h - titlebarOffsetY)) + titlebarOffsetY;
      togY1 = Math.floor(0.785 * (h - titlebarOffsetY)) + titlebarOffsetY;
      togX0 = Math.floor(0.045 * w);
      togX1 = Math.floor(0.214 * w);
    }

    let greenPixels = 0;
    let totalTog = 0;
    for (let y = togY0; y < togY1; y++) {
      const rowOffset = y * w;
      for (let x = togX0; x < togX1; x++) {
        const idx = (rowOffset + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        if (g > 160 && g > r * 1.15 && g > b * 1.15) {
          greenPixels++;
        }
        totalTog++;
      }
    }

    const greenRatio = totalTog > 0 ? greenPixels / totalTog : 0;
    if (greenRatio > 0.05) {
      return {
        screenType: 'スキル獲得説明省略表示',
        screenMode: 'compact',
        anchorDx: 0,
        anchorDy: 0,
        titlebarOffsetY,
      };
    }

    // 3. ウマ娘詳細ポップアップ判定（芝アンカー）
    let idealExpX: number;
    let idealExpY: number;
    let fsize: number;

    if (w > h) {
      // 横画面
      const scale = (h - titlebarOffsetY) / 1080.0;
      idealExpX = Math.round(412 * scale);
      idealExpY = Math.round(346 * scale);
      if (w === 1920 && (h === 1080 || h === 1080 + titlebarOffsetY)) {
        fsize = 16;
      } else {
        const targetFs = 16 * scale;
        const availableFs = [10, 11, 12, 14, 16, 20, 24, 28, 32];
        fsize = availableFs.reduce((prev, curr) =>
          Math.abs(curr - targetFs) < Math.abs(prev - targetFs) ? curr : prev
        );
      }
    } else {
      // 縦画面
      const scaleW = w / 561.0;
      const scaleH = (h - titlebarOffsetY) / 997.0;
      idealExpX = Math.round(150 * scaleW);
      idealExpY = Math.round(319 * scaleH);
      const targetFs = 28.0 * (w / 1080.0);
      const availableFs = [10, 11, 12, 14, 16, 20, 24, 28, 32];
      fsize = availableFs.reduce((prev, curr) =>
        Math.abs(curr - targetFs) < Math.abs(prev - targetFs) ? curr : prev
      );
    }

    const expX = idealExpX;
    const expY = idealExpY + titlebarOffsetY;

    const roiY0 = Math.max(0, expY - 45);
    const roiY1 = Math.min(h, expY + 45);
    const roiX0 = Math.max(0, expX - 45);
    const roiX1 = Math.min(w, expX + 45);
    const roiW = roiX1 - roiX0;
    const roiH = roiY1 - roiY0;

    const shibaData =
      this.templates.anchors.shiba.sizes[fsize.toString()] ||
      this.templates.anchors.shiba.sizes['16'];

    if (shibaData && roiW >= shibaData.width && roiH >= shibaData.height) {
      // ROI内のみインライン二値化
      const roiSlice = new Uint8Array(roiW * roiH);
      let darkCount = 0;
      for (let y = 0; y < roiH; y++) {
        const rowOffset = (roiY0 + y) * w;
        for (let x = 0; x < roiW; x++) {
          const idx = (rowOffset + (roiX0 + x)) * 4;
          const r = data[idx];
          const g = data[idx + 1];
          const b = data[idx + 2];
          if (0.299 * r + 0.587 * g + 0.114 * b <= 120.5) {
            roiSlice[y * roiW + x] = 255;
            darkCount++;
          }
        }
      }

      if (darkCount >= 10) {
        const match = matchTemplateNormed(
          roiSlice,
          roiW,
          roiH,
          shibaData.pixels,
          shibaData.width,
          shibaData.height
        );

        if (match.score >= 0.60) {
          const actualAnchorX = roiX0 + match.bestX;
          const actualAnchorY = roiY0 + match.bestY;
          const anchorDx = actualAnchorX - idealExpX;
          const anchorDy = actualAnchorY - idealExpY;
          return {
            screenType: 'ウマ娘詳細適性ポップアップ',
            screenMode: 'chara_detail',
            anchorDx,
            anchorDy,
            titlebarOffsetY,
          };
        }
      }
    }

    return {
      screenType: 'スキル獲得通常表示',
      screenMode: 'normal',
      anchorDx: 0,
      anchorDy: 0,
      titlebarOffsetY,
    };
  }

  /**
   * ウマ娘詳細適性ポップアップの適性ランク10箇所認識
   */
  public recognizeAptitudes(
    img: ImageBuffer,
    titlebarOffsetY = 0,
    anchorDx = 0,
    anchorDy = 0
  ): Record<string, string> | undefined {
    const { width: w, height: h, data } = img;

    let xs: number[];
    let ys: number[];
    let boxR: number;

    if (w > h) {
      // 横画面
      const scale = (h - titlebarOffsetY) / 1080.0;
      xs = [464, 575, 687, 798].map((x) => Math.round(x * scale));
      ys = [354, 388, 421].map((y) => Math.round(y * scale));
      boxR = Math.max(4, Math.round(7 * scale));
    } else {
      // 縦画面
      const scaleW = w / 561.0;
      const scaleH = (h - titlebarOffsetY) / 997.0;
      xs = [198, 301, 404, 507].map((x) => Math.round(x * scaleW));
      ys = [327, 358, 389].map((y) => Math.round(y * scaleH));
      boxR = Math.max(4, Math.round(6 * scaleW));
    }

    xs = xs.map((x) => x + anchorDx);
    ys = ys.map((y) => y + anchorDy);

    const results: Record<string, string> = {};
    let idx = 0;

    for (let rIdx = 0; rIdx < ys.length; rIdx++) {
      const y = ys[rIdx];
      const cols = rIdx === 0 ? [0, 1] : [0, 1, 2, 3];

      for (const c of cols) {
        const x = xs[c];
        const y0 = Math.max(0, y - boxR);
        const y1 = Math.min(h - 1, y + boxR);
        const x0 = Math.max(0, x - boxR);
        const x1 = Math.min(w - 1, x + boxR);

        let charSumR = 0;
        let charSumG = 0;
        let charSumB = 0;
        let charCount = 0;

        let allSumR = 0;
        let allSumG = 0;
        let allSumB = 0;
        let allCount = 0;

        for (let py = y0; py <= y1; py++) {
          const rowOffset = py * w;
          for (let px = x0; px <= x1; px++) {
            const pIdx = (rowOffset + px) * 4;
            const r = data[pIdx];
            const g = data[pIdx + 1];
            const b = data[pIdx + 2];

            allSumR += r;
            allSumG += g;
            allSumB += b;
            allCount++;

            // HSV の S と V を計算
            const maxVal = Math.max(r, g, b);
            const minVal = Math.min(r, g, b);
            const v = maxVal;
            const s = maxVal === 0 ? 0 : Math.round(((maxVal - minVal) * 255) / maxVal);

            if (s > 40 || v < 185) {
              charSumR += r;
              charSumG += g;
              charSumB += b;
              charCount++;
            }
          }
        }

        let rank: string;
        // 文字ピクセル比率チェック: 枠全体の15%未満なら文字が存在しない (背景のみ)
        if (allCount > 0 && charCount < allCount * 0.15) {
          rank = '?';
        } else {
          const avgR = charCount > 0 ? charSumR / charCount : allSumR / allCount;
          const avgG = charCount > 0 ? charSumG / charCount : allSumG / allCount;
          const avgB = charCount > 0 ? charSumB / charCount : allSumB / allCount;

          const meanRGB = (avgR + avgG + avgB) / 3;
          const stdRGB = Math.sqrt(
            ((avgR - meanRGB) ** 2 + (avgG - meanRGB) ** 2 + (avgB - meanRGB) ** 2) / 3
          );

          if (stdRGB < 12) {
            rank = 'G';
          } else if (avgB > 180 && avgR < 165 && avgG < 160) {
            rank = 'F';
          } else if (avgB > 180 && avgR > 160 && avgG < 155) {
            rank = 'E';
          } else if (avgB > 190 && avgG > 160 && avgR < 150) {
            rank = 'D';
          } else if (avgG > avgR + 15 && avgG > avgB + 15) {
            rank = 'C';
          } else if (avgR > 215 && avgG >= 125 && avgG <= 155 && avgB >= 155 && avgB <= 185) {
            rank = 'B';
          } else if (avgR > 195 && avgB < 135) {
            rank = 'A';
          } else if (avgR > 215 && avgG > 165 && avgG <= 210 && avgB >= 140 && (avgR - avgB) >= 35) {
            rank = 'S';
          } else {
            rank = '?';
          }
        }

        results[APT_NAMES[idx]] = rank;
        idx++;
      }
    }

    // 妥当性検証: '?' が含まれる、または大分類に有効適性 (S/A/B) が1つも無い場合は無効
    for (const name of APT_NAMES) {
      if (results[name] === '?') return undefined;
    }

    const groundValid = ['芝', 'ダート'].some((k) => ['S', 'A', 'B'].includes(results[k]));
    const distValid = ['短距離', 'マイル', '中距離', '長距離'].some((k) => ['S', 'A', 'B'].includes(results[k]));
    const styleValid = ['逃げ', '先行', '差し', '追込'].some((k) => ['S', 'A', 'B'].includes(results[k]));

    if (!groundValid || !distValid || !styleValid) {
      return undefined;
    }

    return results;
  }

  /**
   * ウマ娘詳細適性ポップアップのヘッダーから育成ウマ娘カードIDを同定
   */
  public recognizeCardId(
    img: ImageBuffer,
    titlebarOffsetY: number,
    anchorDx: number,
    anchorDy: number
  ): number | undefined {
    if (this.cardTable.length === 0) return undefined;

    const { width: w, height: h, data } = img;
    let nameY0: number;
    let nameY1: number;
    let titleY0: number;
    let titleY1: number;
    let nameX0: number;
    let nameX1: number;

    if (w > h) {
      const scale = (h - titlebarOffsetY) / 1080.0;
      const actualAnchorX = Math.round(412 * scale) + anchorDx;
      // anchorDy は detectScreenType で既に titlebarOffsetY が加算された理想Yとの差分 (actualAnchorY - idealExpY)
      // のため、titlebarOffsetY を二重加算してはならない
      const actualAnchorY = Math.round(346 * scale) + anchorDy;

      nameY0 = Math.max(0, actualAnchorY - Math.round(198 * scale));
      nameY1 = Math.min(h, actualAnchorY - Math.round(173 * scale));
      titleY0 = Math.max(0, actualAnchorY - Math.round(225 * scale));
      titleY1 = Math.min(h, actualAnchorY - Math.round(202 * scale));

      nameX0 = Math.max(0, actualAnchorX + Math.round(120 * scale));
      nameX1 = Math.min(w, actualAnchorX + Math.round(360 * scale));
    } else {
      const scaleW = w / 561.0;
      const scaleH = (h - titlebarOffsetY) / 997.0;

      nameY0 = Math.max(0, Math.round(135 * scaleH) + anchorDy);
      nameY1 = Math.min(h, Math.round(162 * scaleH) + anchorDy);
      titleY0 = Math.max(0, Math.round(112 * scaleH) + anchorDy);
      titleY1 = Math.min(h, Math.round(136 * scaleH) + anchorDy);

      nameX0 = Math.max(0, Math.round(250 * scaleW) + anchorDx);
      nameX1 = Math.min(w, Math.round(485 * scaleW) + anchorDx);
    }

    const nameW = nameX1 - nameX0;
    const nameH = nameY1 - nameY0;
    if (nameW <= 20 || nameH <= 5) return undefined;

    // 二値化 & 連結成分抽出 (name)
    const nameBin = new Uint8Array(nameW * nameH);
    for (let y = 0; y < nameH; y++) {
      const rowOffset = (nameY0 + y) * w;
      for (let x = 0; x < nameW; x++) {
        const idx = (rowOffset + (nameX0 + x)) * 4;
        const g = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
        nameBin[y * nameW + x] = g < 110 ? 255 : 0;
      }
    }

    const ccsN = connectedComponentsWithStats(nameBin, nameW, nameH);
    const validN = ccsN.filter((c) => c.area >= 15 && c.height >= 8 && c.width < 50);
    if (validN.length === 0) return undefined;

    const minXN = Math.min(...validN.map((c) => c.left));
    const maxXN = Math.max(...validN.map((c) => c.left + c.width));
    const minYN = Math.min(...validN.map((c) => c.top));
    const maxYN = Math.max(...validN.map((c) => c.top + c.height));
    const cropNW = maxXN - minXN + 1;
    const cropNH = maxYN - minYN + 1;
    if (cropNW <= 10 || cropNH <= 5) return undefined;

    const cropN = new Uint8Array(cropNW * cropNH);
    for (let y = 0; y < cropNH; y++) {
      for (let x = 0; x < cropNW; x++) {
        cropN[y * cropNW + x] = nameBin[(minYN + y) * nameW + (minXN + x)];
      }
    }
    const normN = resizeArea(cropN, cropNW, cropNH, 64, 16);
    const realBytesN = new Uint8Array(128);
    for (let i = 0; i < 1024; i++) {
      if (normN[i] > 64) {
        realBytesN[i >> 3] |= 1 << (7 - (i & 7));
      }
    }

    // 二値化 & 連結成分抽出 (title)
    const titleW = nameW;
    const titleH = titleY1 - titleY0;
    let realBytesT: Uint8Array | null = null;
    if (titleH > 5) {
      const titleBin = new Uint8Array(titleW * titleH);
      for (let y = 0; y < titleH; y++) {
        const rowOffset = (titleY0 + y) * w;
        for (let x = 0; x < titleW; x++) {
          const idx = (rowOffset + (nameX0 + x)) * 4;
          const g = Math.round(0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2]);
          titleBin[y * titleW + x] = g < 110 ? 255 : 0;
        }
      }
      const ccsT = connectedComponentsWithStats(titleBin, titleW, titleH);
      const validT = ccsT.filter((c) => c.area >= 10 && c.height >= 7 && c.width < 50);
      if (validT.length > 0) {
        const minXT = Math.min(...validT.map((c) => c.left));
        const maxXT = Math.max(...validT.map((c) => c.left + c.width));
        const minYT = Math.min(...validT.map((c) => c.top));
        const maxYT = Math.max(...validT.map((c) => c.top + c.height));
        const cropTW = maxXT - minXT + 1;
        const cropTH = maxYT - minYT + 1;
        if (cropTW > 10 && cropTH > 5) {
          const cropT = new Uint8Array(cropTW * cropTH);
          for (let y = 0; y < cropTH; y++) {
            for (let x = 0; x < cropTW; x++) {
              cropT[y * cropTW + x] = titleBin[(minYT + y) * titleW + (minXT + x)];
            }
          }
          const normT = resizeArea(cropT, cropTW, cropTH, 64, 16);
          realBytesT = new Uint8Array(128);
          for (let i = 0; i < 1024; i++) {
            if (normT[i] > 64) {
              realBytesT[i >> 3] |= 1 << (7 - (i & 7));
            }
          }
        }
      }
    }

    let bestCardId: number | undefined = undefined;
    let bestDist = 99999;
    let bestHamN = 99999;

    for (const c of this.cardTable) {
      let hamN = 0;
      for (let b = 0; b < 128; b++) {
        let xor = realBytesN[b] ^ c.nameBytes[b];
        while (xor > 0) {
          hamN += xor & 1;
          xor >>= 1;
        }
      }

      let hamT = 0;
      if (realBytesT) {
        for (let b = 0; b < 128; b++) {
          let xor = realBytesT[b] ^ c.titleBytes[b];
          while (xor > 0) {
            hamT += xor & 1;
            xor >>= 1;
          }
        }
      }

      const tot = hamN + (realBytesT ? hamT : hamN);
      if (tot < bestDist) {
        bestDist = tot;
        bestHamN = hamN;
        bestCardId = c.cardId;
      }
    }

    if (bestHamN <= 300) {
      return bestCardId;
    }
    return undefined;
  }

  /**
   * 所持スキルPt OCR
   */
  public recognizeSkillPt(
    img: ImageBuffer,
    screenType: 'ウマ娘詳細適性ポップアップ' | '育成完了確認（ホーム画面）' | 'スキル獲得説明省略表示' | 'スキル獲得通常表示'
  ): number {
    const { width: w, height: h, data } = img;

    let titlebarOffsetY = 0;
    if (w > h) {
      const expectedH = Math.round((w * 9) / 16);
      if (h > expectedH + 8) {
        titlebarOffsetY = h - expectedH;
      }
    } else {
      const expectedH = Math.round((w * 16) / 9);
      if (h > expectedH + 8) {
        titlebarOffsetY = h - expectedH;
      }
    }

    let y0: number;
    let y1: number;
    let x0: number;
    let x1: number;
    let th: number;

    if (screenType === '育成完了確認（ホーム画面）') {
      if (w > h) {
        y0 = Math.floor(h * 0.83);
        y1 = Math.floor(h * 0.865);
        x0 = Math.floor(w * 0.225);
        x1 = Math.floor(w * 0.265);
      } else {
        y0 = Math.floor(h * 0.835);
        y1 = Math.floor(h * 0.865);
        x0 = Math.floor(w * 0.295);
        x1 = Math.floor(w * 0.405);
      }
      th = 140;
    } else {
      if (w > h) {
        const scale = (h - titlebarOffsetY) / 1080.0;
        y0 = Math.floor(334 * scale) + titlebarOffsetY;
        y1 = Math.floor(378 * scale) + titlebarOffsetY;
        x0 = Math.floor(w * 0.35);
        x1 = Math.floor(w * 0.42);
      } else {
        y0 = Math.floor((h - titlebarOffsetY) * 0.31) + titlebarOffsetY;
        y1 = Math.floor((h - titlebarOffsetY) * 0.35) + titlebarOffsetY;
        x0 = Math.floor(w * 0.68);
        x1 = Math.floor(w * 0.88);
      }
      th = 195;
    }

    const roiW = x1 - x0;
    const roiH = y1 - y0;
    if (roiW <= 0 || roiH <= 0) return 0;

    const binInv = new Uint8Array(roiW * roiH);
    let hash = 2166136261;
    for (let y = 0; y < roiH; y++) {
      const rowOffset = (y0 + y) * w;
      const dstOff = y * roiW;
      for (let x = 0; x < roiW; x++) {
        const idx = (rowOffset + (x0 + x)) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        const v = gray <= th ? 255 : 0;
        binInv[dstOff + x] = v;
        hash ^= v;
        hash = Math.imul(hash, 16777619);
      }
    }
    hash = hash >>> 0;

    if (
      this.lastSpCache &&
      this.lastSpCache.screenType === screenType &&
      this.lastSpCache.roiW === roiW &&
      this.lastSpCache.roiH === roiH &&
      this.lastSpCache.hash === hash &&
      bytesEqual(this.lastSpCache.bin, binInv)
    ) {
      return this.lastSpCache.value;
    }

    const ccs = connectedComponentsWithStats(binInv, roiW, roiH);
    const validCcs = ccs.filter(
      (c) =>
        c.area >= 10 &&
        c.height >= 8 &&
        // Why not hardcoded 25px: portrait 1080x1920 digits like '8' and '4' reach 26px width (~0.76 * height)
        c.width <= Math.max(25, c.height) &&
        c.top >= 2 &&
        c.top + c.height < roiH - 1 &&
        c.left > 0
    );

    validCcs.sort((a, b) => a.left - b.left);
    if (validCcs.length === 0 || validCcs.length > 4) {
      this.lastSpCache = { screenType, roiW, roiH, hash, bin: binInv, value: 0 };
      return 0;
    }

    let valStr = '';
    for (const c of validCcs) {
      const patch = new Uint8Array(c.width * c.height);
      for (let py = 0; py < c.height; py++) {
        for (let px = 0; px < c.width; px++) {
          patch[py * c.width + px] = binInv[(c.top + py) * roiW + (c.left + px)];
        }
      }
      valStr += this.recognizeDigit(patch, c.width, c.height);
    }

    const val = parseInt(valStr, 10) || 0;
    const out = val < 10 || val > 9999 ? 0 : val;
    this.lastSpCache = { screenType, roiW, roiH, hash, bin: binInv, value: out };
    return out;
  }

  /**
   * スキルカード枠の検出
   */
  public detectCards(
    img: ImageBuffer,
    isCompact: boolean
  ): { boxes: { top: number; bottom: number; height: number }[]; cLeft: number; cRight: number } {
    const { width: w, height: h, data } = img;

    let titlebarOffsetY = 0;
    if (w > h) {
      const expectedH = Math.round((w * 9) / 16);
      if (h > expectedH + 8) {
        titlebarOffsetY = h - expectedH;
      }
    } else {
      const expectedH = Math.round((w * 16) / 9);
      if (h > expectedH + 8) {
        titlebarOffsetY = h - expectedH;
      }
    }

    let cLeft: number;
    let cRight: number;
    let yScanStart: number;
    let yScanEnd: number;
    let containerTop: number;
    let containerBottom: number;

    if (w > h) {
      const scaleH = (h - titlebarOffsetY) / 1080.0;
      if (Math.abs(w - 1583) <= 50) {
        const scaleW = w / 1583.0;
        cLeft = Math.round(211 * scaleW);
        cRight = Math.round(683 * scaleW);
      } else {
        const scaleW = w / 1920.0;
        cLeft = Math.round(276 * scaleW);
        cRight = Math.round(829 * scaleW);
      }
      yScanStart = Math.floor(200 * scaleH) + titlebarOffsetY;
      yScanEnd = Math.floor(950 * scaleH) + titlebarOffsetY;
      containerTop = Math.floor(380 * scaleH) + titlebarOffsetY;
      containerBottom = Math.floor(940 * scaleH) + titlebarOffsetY;
    } else {
      const scaleW = w / 561.0;
      const scaleH = (h - titlebarOffsetY) / 997.0;
      cLeft = Math.round(25 * scaleW);
      cRight = Math.round(536 * scaleW);
      yScanStart = Math.floor(200 * scaleH) + titlebarOffsetY;
      yScanEnd = Math.floor(950 * scaleH) + titlebarOffsetY;
      containerTop = Math.floor(360 * scaleH) + titlebarOffsetY;
      containerBottom = Math.floor(920 * scaleH) + titlebarOffsetY;
    }

    const cw = cRight - cLeft;
    // Why not: 0.4..0.7 は「ヒントLv」白ピル(0.58..0.82)と重なり、0.35..0.55 は通常表示の「進化条件達成」バッジ(0.35..0.39)を拾うため、両者を避ける 0.40..0.58 を走査する
    const stripX0 = Math.floor(cLeft + cw * 0.4);
    const stripX1 = Math.floor(cLeft + cw * 0.58);
    const stripW = stripX1 - stripX0;

    const effH = h - titlebarOffsetY;
    const nominalRatio = isCompact ? 0.0837 : 0.1304;
    const nominalCh = Math.round(nominalRatio * effH);
    // Why not: 単純な minCh/maxCh (0.07h/0.104h) だと 87px の見切れカードを通してしまうため、公称高さ比率 ± 許容幅で棄却する
    const tolCh = isCompact
      ? Math.max(2, Math.round(effH * 0.002))
      : Math.max(4, Math.round(effH * 0.004));
    const minCh = nominalCh - tolCh;
    const maxCh = nominalCh + tolCh;

    const boxes: { top: number; bottom: number; height: number }[] = [];
    let inCard = false;
    let startY = 0;
    let gapCount = 0;
    const gapThresh = isCompact ? 235 : 240;

    for (let y = yScanStart; y < yScanEnd; y++) {
      let rowSum = 0;
      for (let x = stripX0; x < stripX1; x++) {
        const idx = (y * w + x) * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        rowSum += Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
      const val = rowSum / stripW;

      if (val < gapThresh) {
        gapCount = 0;
        if (!inCard) {
          inCard = true;
          startY = y;
        }
      } else if (inCard) {
        gapCount++;
        // Why not: 1-2行のカード内明部ライン（金/固有カードの区切り線等）でカードが分割されるのを防ぐため、3行連続ギャップでカード終端と確定する
        if (gapCount >= 3) {
          inCard = false;
          gapCount = 0;
          const cardBottom = y - 2;
          const ch = cardBottom - startY;
          // 完全性チェック:
          // 1. 高さがカード規定サイズ内
          // 2. startY がコンテナ上端（スクロール領域上端）より下（ヘッダー下に見切れたカードを除外）
          // 3. cardBottom がコンテナ下端（フッター上端）より上（フッター下に見切れたカードを除外）
          const margin = w > h ? 15 : Math.round(30 * ((h - titlebarOffsetY) / 1080.0));
          if (
            ch >= minCh &&
            ch <= maxCh &&
            startY >= containerTop - margin &&
            cardBottom <= containerBottom + margin
          ) {
            boxes.push({ top: startY, bottom: cardBottom, height: ch });
          }
        }
      }
    }

    return { boxes, cLeft, cRight };
  }

  /**
   * カード矩形内の色・輝度分布から「獲得済み本体固有スキル（グレーアウトした虹色グラデーション背景）」かを判定する
   */
  public isAcquiredRainbowCard(cardData: Uint8Array, cw: number, ch: number): boolean {
    if (cw < 20 || ch < 12) return false;

    // 1. 右端 [-] 緑ボタンクラスタの有無: 本物の selected カードには明確な緑ボタン領域が存在する (実測 >= 3.6%)
    let greenPixels = 0;
    let greenTotal = 0;
    const gx0 = Math.floor(cw * 0.90);
    const gx1 = Math.floor(cw * 0.97);
    const gy0 = Math.floor(ch * 0.28);
    const gy1 = Math.floor(ch * 0.72);
    for (let y = gy0; y < gy1; y++) {
      const rowOffset = y * cw;
      for (let x = gx0; x < gx1; x++) {
        const idx = (rowOffset + x) * 4;
        const r = cardData[idx];
        const g = cardData[idx + 1];
        const b = cardData[idx + 2];
        if (g > r + 15 && g > b + 15) {
          greenPixels++;
        }
        greenTotal++;
      }
    }
    // Why not === 0: 圧縮ノイズや境界滲みの 1px 緑ノイズで虹色固有が selected 扱いになるのを防ぐ
    if (greenTotal > 0 && greenPixels >= Math.max(8, Math.floor(greenTotal * 0.025))) {
      return false;
    }

    // 2. カード中央〜左中部の背景色・輝度分布 (x: 0.20..0.72, y: 0.15..0.85)
    // 本体固有はグレーアウト減光 (背景平均輝度 < 192) かつ虹色の寒色帯 (シアン/青, coolRatio >= 0.30; 実測 0.78..0.98)。
    // 一方 selected 白カードは無彩色グレー (coolRatio <= 0.014)、金カードは単一暖色 (warmCount > coolCount)、未選択カードは高輝度 (>= 200)。
    const step = ch <= 80 ? 1 : 2;
    const x0 = Math.floor(cw * 0.20);
    const x1 = Math.floor(cw * 0.72);
    const y0 = Math.floor(ch * 0.15);
    const y1 = Math.floor(ch * 0.85);
    let bgCount = 0;
    let coolCount = 0;
    let warmCount = 0;
    let lumaSum = 0;

    for (let y = y0; y < y1; y += step) {
      const rowOffset = y * cw;
      for (let x = x0; x < x1; x += step) {
        const idx = (rowOffset + x) * 4;
        const r = cardData[idx];
        const g = cardData[idx + 1];
        const b = cardData[idx + 2];
        const maxc = r > g ? (r > b ? r : b) : g > b ? g : b;
        // 暗い文字インクを除外し、カード地色のみを評価する
        if (maxc < 95) continue;

        bgCount++;
        lumaSum += 0.299 * r + 0.587 * g + 0.114 * b;
        if (b > r + 10 || (g > r + 10 && b > r + 4)) {
          coolCount++;
        } else if (r > b + 15 && g >= b) {
          warmCount++;
        }
      }
    }

    if (bgCount < 20) return false;
    const avgBgLuma = lumaSum / bgCount;
    const coolRatio = coolCount / bgCount;

    return avgBgLuma < 192 && coolRatio >= 0.30 && coolCount > warmCount;
  }

  /**
   * カードの必要SP OCR認識 (SP値, 状態)
   */
  public ocrCardNeedSp(
    cardData: Uint8Array,
    cw: number,
    ch: number,
    isCompact: boolean
  ): { needSp: number; state: 'unselected' | 'selected' | 'acquired'; valid: boolean } {
    // 右側ボタン領域: カード背景や虹色装飾の誤検知を防ぐためボタン矩形に限定
    const btnX0 = Math.floor(cw * 0.78);
    const btnX1 = Math.floor(cw * 0.95);
    const btnY0 = Math.floor(ch * (isCompact ? 0.2 : 0.15));
    const btnY1 = Math.floor(ch * (isCompact ? 0.8 : 0.7));
    let pinkCount = 0;
    let darkTextCount = 0;

    for (let y = btnY0; y < btnY1; y++) {
      const rowOffset = y * cw;
      for (let x = btnX0; x < btnX1; x++) {
        const idx = (rowOffset + x) * 4;
        const r = cardData[idx];
        const g = cardData[idx + 1];
        const b = cardData[idx + 2];
        // ウマ娘の選択中ピンクボタン判定 (RGB ~(235, 75, 130))
        if (r > 195 && b > 100 && g < 130 && r - g > 65) {
          pinkCount++;
        }
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        if (gray >= 70 && gray <= 170) {
          darkTextCount++;
        }
      }
    }

    const isRainbowAcquired = this.isAcquiredRainbowCard(cardData, cw, ch);
    const btnArea = (btnX1 - btnX0) * (btnY1 - btnY0);
    const minPink = Math.max(50, Math.floor(btnArea * 0.005));
    const isPink = pinkCount > minPink;
    if (isPink) {
      // グレーアウト虹色カード（本体固有スキル）は isCompact/色調差/右端ノイズに関わらず常に獲得済
      if (isRainbowAcquired) {
        return { needSp: 0, state: 'acquired', valid: true };
      }

      // 「獲得済」バッジ(本体固有)もピンク地だが、右端に緑色の [-] ボタンクラスタが無く周囲が紫灰色で減光されているため selected と区別する
      let greenMinusCount = 0;
      let greenTotal = 0;
      const gx0 = Math.floor(cw * 0.91);
      const gx1 = Math.floor(cw * 0.97);
      const gy0 = Math.floor(ch * 0.30);
      const gy1 = Math.floor(ch * 0.70);
      for (let y = gy0; y < gy1; y++) {
        const rowOffset = y * cw;
        for (let x = gx0; x < gx1; x++) {
          const idx = (rowOffset + x) * 4;
          const r = cardData[idx];
          const g = cardData[idx + 1];
          const b = cardData[idx + 2];
          if (g > r + 15 && g > b + 15) {
            greenMinusCount++;
          }
          greenTotal++;
        }
      }

      const hasGreenCluster = greenTotal > 0 && greenMinusCount >= Math.max(8, Math.floor(greenTotal * 0.02));
      if (!hasGreenCluster) {
        let purpleBgCount = 0;
        let bgTotal = 0;
        const px0 = Math.floor(cw * 0.78);
        const px1 = Math.floor(cw * 0.90);
        const py0 = Math.floor(ch * 0.68);
        const py1 = Math.floor(ch * 0.82);
        for (let y = py0; y < py1; y++) {
          const rowOffset = y * cw;
          for (let x = px0; x < px1; x++) {
            const idx = (rowOffset + x) * 4;
            const r = cardData[idx];
            const g = cardData[idx + 1];
            const b = cardData[idx + 2];
            if (b > g + 25 && r > g + 15 && r < 190 && b < 195) {
              purpleBgCount++;
            }
            bgTotal++;
          }
        }
        if (bgTotal > 0 && purpleBgCount / bgTotal > 0.5) {
          return { needSp: 0, state: 'acquired', valid: true };
        }
      }

      return { needSp: 0, state: 'selected', valid: true };
    }

    let y1: number;
    let y2: number;
    if (isCompact) {
      y1 = Math.floor(ch * 0.2);
      y2 = Math.floor(ch * 0.7);
    } else {
      y1 = Math.floor(ch * 0.32);
      y2 = Math.floor(ch * 0.72);
    }
    const x1 = Math.floor(cw * 0.78);
    const x2 = Math.floor(cw * 0.93);

    const roiW = x2 - x1;
    const roiH = y2 - y1;
    if (roiW <= 0 || roiH <= 0) {
      return { needSp: 0, state: 'acquired', valid: false };
    }

    // 緑文字「Pt」のカットオフ検出
    const greenColsCount = new Int32Array(roiW);
    let totalGreenPixels = 0;
    for (let y = 0; y < roiH; y++) {
      const rowOffset = (y1 + y) * cw;
      for (let x = 0; x < roiW; x++) {
        const idx = (rowOffset + (x1 + x)) * 4;
        const r = cardData[idx];
        const g = cardData[idx + 1];
        const b = cardData[idx + 2];
        if (g > 150 && g > r * 1.1 && g > b * 1.1) {
          greenColsCount[x]++;
          totalGreenPixels++;
        }
      }
    }

    let cutX = Math.floor(roiW * 0.75);
    let foundGreen = false;
    for (let x = 0; x < roiW; x++) {
      if (greenColsCount[x] > 2) {
        cutX = x;
        foundGreen = true;
        break;
      }
    }

    const minDark = Math.max(20, Math.floor(btnArea * 0.002));
    if (!foundGreen || totalGreenPixels < 5) {
      // 緑文字Ptがない場合: 「獲得済」ボタンの文字成分または虹色グレーアウト背景が存在するか判定
      if (isRainbowAcquired || darkTextCount > minDark) {
        return { needSp: 0, state: 'acquired', valid: true };
      }
      return { needSp: 0, state: 'acquired', valid: false };
    }

    // 数字領域の二値反転
    const binInv = new Uint8Array(cutX * roiH);
    for (let y = 0; y < roiH; y++) {
      const rowOffset = (y1 + y) * cw;
      for (let x = 0; x < cutX; x++) {
        const idx = (rowOffset + (x1 + x)) * 4;
        const r = cardData[idx];
        const g = cardData[idx + 1];
        const b = cardData[idx + 2];
        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        binInv[y * cutX + x] = gray <= 140 ? 255 : 0;
      }
    }

    const ccs = connectedComponentsWithStats(binInv, cutX, roiH);
    const maxWidth = Math.max(20, Math.floor(cw * 0.032));
    const validCcs = ccs.filter(
      (c) =>
        c.area >= 8 &&
        c.height >= 6 &&
        c.width >= 3 &&
        c.width <= maxWidth &&
        c.left > 3 &&
        c.height / c.width <= 3.2
    );

    validCcs.sort((a, b) => a.left - b.left);
    if (validCcs.length === 0 || validCcs.length > 4) {
      return { needSp: 0, state: 'acquired', valid: false };
    }

    let valStr = '';
    for (const c of validCcs) {
      const patch = new Uint8Array(c.width * c.height);
      for (let py = 0; py < c.height; py++) {
        for (let px = 0; px < c.width; px++) {
          patch[py * c.width + px] = binInv[(c.top + py) * cutX + (c.left + px)];
        }
      }
      valStr += this.recognizeDigit(patch, c.width, c.height);
    }

    const val = parseInt(valStr, 10) || 0;
    if (val < 10 || val > 600) {
      return { needSp: 0, state: 'unselected', valid: false };
    }

    return {
      needSp: val,
      state: 'unselected',
      valid: true,
    };
  }

  /**
   * スキル名認識 (64x16 特徴量 + ○/◎ 判定 + ハミング距離照合)
   */
  public recognizeCardSkillName(
    cardData: Uint8Array,
    cw: number,
    ch: number,
    isCompact: boolean,
    needSp = 0,
    isUnselected = false,
    isGoldCard = false,
    cardState: 'unselected' | 'selected' | 'acquired' = isUnselected ? 'unselected' : 'acquired'
  ): { skillId: number; name: string; rarity: number; dist: number } {
    let ty1: number;
    let ty2: number;
    if (isCompact) {
      ty1 = Math.floor(ch * 0.15);
      ty2 = Math.floor(ch * 0.42);
    } else {
      ty1 = Math.floor(ch * 0.095);
      ty2 = Math.floor(ch * 0.23);
    }
    const tx1 = Math.floor(cw * 0.165);
    const tx2 = Math.floor(cw * 0.85);

    const stripW = tx2 - tx1;
    const stripH = ty2 - ty1;
    if (stripW <= 0 || stripH <= 0) return { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };

    let binThresh: number;
    if (isUnselected) {
      binThresh = cw < 450 ? 160 : isCompact || isGoldCard ? 155 : 140;
    } else {
      binThresh = 115;
    }
    const binClean = new Uint8Array(stripW * stripH);
    for (let y = 0; y < stripH; y++) {
      const rowOffset = (ty1 + y) * cw;
      for (let x = 0; x < stripW; x++) {
        const idx = (rowOffset + (tx1 + x)) * 4;
        const r = cardData[idx];
        const g = cardData[idx + 1];
        const b = cardData[idx + 2];

        // 1. Purple badge filter: 試験ボーナス等の紫バッジピクセルを除外
        if (b > 110 && b > g + 15 && r > g + 10) {
          binClean[y * stripW + x] = 0;
          continue;
        }

        const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
        binClean[y * stripW + x] = gray <= binThresh ? 255 : 0;
      }
    }

    // 左上ノイズ除去: isCompact のときは文字ストリップにノイズは存在しないため削らない。
    // 通常表示時のみ微小な境界枠線ノイズを除去（文字欠け防止のため最大3px）
    const noiseH = isCompact ? 0 : Math.min(3, Math.floor(stripH * 0.15));
    const noiseW = isCompact ? 0 : Math.min(3, Math.floor(stripW * 0.02));
    for (let y = 0; y < noiseH && y < stripH; y++) {
      for (let x = 0; x < noiseW && x < stripW; x++) {
        binClean[y * stripW + x] = 0;
      }
    }

    // 列の投影プロファイル
    const colSum = new Int32Array(stripW);
    for (let y = 0; y < stripH; y++) {
      const rowOffset = y * stripW;
      for (let x = 0; x < stripW; x++) {
        if (binClean[rowOffset + x] > 0) colSum[x]++;
      }
    }

    let firstCol = -1;
    for (let x = 0; x < stripW; x++) {
      if (colSum[x] > 0) {
        firstCol = x;
        break;
      }
    }
    if (firstCol === -1) return { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };

    let lastCol = firstCol;
    // Why 0.75 * stripH: 読点・スペースを含む長いスキル名 (例: 恩返し、召し上がれ) の 24px 空白で途中で切れないようにする
    const maxGap = Math.max(10, Math.floor(stripH * 0.75));
    for (let x = firstCol; x < stripW; x++) {
      if (colSum[x] > 0) {
        lastCol = x;
      } else if (x - lastCol > maxGap) {
        break;
      }
    }

    const patchW = lastCol - firstCol + 1;
    const patchH = stripH;

    // 行の投影プロファイル
    const rowSum = new Int32Array(patchH);
    for (let y = 0; y < patchH; y++) {
      const rowOffset = y * stripW;
      for (let x = 0; x < patchW; x++) {
        if (binClean[rowOffset + (firstCol + x)] > 0) rowSum[y]++;
      }
    }

    let firstRow = -1;
    let lastRow = -1;
    for (let y = 0; y < patchH; y++) {
      if (rowSum[y] > 0) {
        if (firstRow === -1) firstRow = y;
        lastRow = y;
      }
    }
    if (firstRow === -1) return { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };

    const cropH = lastRow - firstRow + 1;
    const cropW = patchW;
    const minExpectedH = Math.max(8, Math.floor(ch * 0.08));
    const maxExpectedH = Math.floor(ch * 0.35);
    if (cropH < minExpectedH || cropH > maxExpectedH || cropW < 18) {
      return { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };
    }

    const cropPatch = new Uint8Array(cropW * cropH);
    let totalInkCount = 0;
    for (let y = 0; y < cropH; y++) {
      const srcOffset = (firstRow + y) * stripW;
      const dstOffset = y * cropW;
      for (let x = 0; x < cropW; x++) {
        const val = binClean[srcOffset + (firstCol + x)];
        cropPatch[dstOffset + x] = val;
        if (val > 0) totalInkCount++;
      }
    }

    // インク物理密度ゲート (正規の文字は密度 >= 25%、幅1pxあたり >= 5px)
    // スクロールモーションブラーや残像ノイズ (密度 < 10% または 幅1pxあたり < 2.0px) を物理的に遮断
    const inkDensity = totalInkCount / (cropW * cropH);
    const inkPerW = totalInkCount / cropW;
    if (inkDensity < 0.10 || inkPerW < 2.0) {
      return { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };
    }

    const aspect = cropW / Math.max(1, cropH);
    if (aspect < 0.5) return { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };

    // 1. Full 64x16
    const resizedFull = resizeArea(cropPatch, cropW, cropH, 64, 16);
    const fullBytes = packBits(resizedFull);

    // 末尾文字の ○ vs ◎ 判定
    let isDoubleCircle = false;
    const rightCharW = Math.min(cropW, Math.ceil(cropH * 1.15));
    let whiteCount = 0;
    let totalCount = 0;
    for (let y = 0; y < cropH; y++) {
      for (let x = cropW - rightCharW; x < cropW; x++) {
        if (cropPatch[y * cropW + x] > 128) whiteCount++;
        totalCount++;
      }
    }
    if (totalCount > 0 && whiteCount / totalCount >= 0.28) {
      isDoubleCircle = true;
    }

    // 直近カード特徴量キャッシュ照合 (静止・低速スクロール時の再照合をスキップ)
    const fullHash = fnv1aHash(fullBytes);
    const cacheKey = `${fullHash}_${needSp}_${isGoldCard ? 1 : 0}_${isCompact ? 1 : 0}_${isUnselected ? 1 : 0}_${cardState}_${cw < 450 ? 1 : 0}_${isDoubleCircle ? 1 : 0}_${Math.round(aspect * 100)}`;
    const cachedCard = this.cardNameCache.get(cacheKey);
    if (cachedCard && bytesEqual(cachedCard.fullBytes, fullBytes)) {
      return cachedCard.result;
    }

    // 2. Head 32x16 (first ~2.0 * cropH to ~2.33 * cropH pixels, インク上下端タイト正規化)
    const baseHw = Math.round(cropH * 2.0);
    const hwList = [baseHw];
    const altHw = Math.round(cropH * 2.33);
    if (altHw <= cropW && altHw !== baseHw) hwList.push(altHw);
    if (cropH <= 13) {
      const alt2 = Math.round(cropH * 2.2);
      if (alt2 <= cropW && !hwList.includes(alt2)) hwList.push(alt2);
    }

    const headVariants: Uint8Array[] = [];
    for (const hw of hwList) {
      const headW = Math.min(cropW, Math.max(1, hw));
      let minY = cropH;
      let maxY = -1;
      for (let y = 0; y < cropH; y++) {
        for (let x = 0; x < headW; x++) {
          if (cropPatch[y * cropW + x] > 128) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const effH = maxY >= minY ? maxY - minY + 1 : cropH;
      const startY = maxY >= minY ? minY : 0;
      const headCrop = new Uint8Array(headW * effH);
      for (let y = 0; y < effH; y++) {
        for (let x = 0; x < headW; x++) {
          headCrop[y * headW + x] = cropPatch[(startY + y) * cropW + x];
        }
      }
      const resizedHead = resizeArea(headCrop, headW, effH, 32, 16);
      const headBytes = packBits(resizedHead);
      headVariants.push(
        headBytes,
        shiftBits(headBytes, 4, 16, -1),
        shiftBits(headBytes, 4, 16, 1)
      );
    }

    // 3. Tail 32x16 (last ~2.0 * cropH to ~2.33 * cropH pixels, インク上下端タイト正規化)
    const baseTw = Math.round(cropH * 2.0);
    const twList = [baseTw];
    const altTw = Math.round(cropH * 2.33);
    if (altTw <= cropW && altTw !== baseTw) twList.push(altTw);
    if (cropH <= 13) {
      const alt2 = Math.round(cropH * 2.2);
      if (alt2 <= cropW && !twList.includes(alt2)) twList.push(alt2);
    }

    const tailVariants: Uint8Array[] = [];
    for (const tw of twList) {
      const tailW = Math.min(cropW, Math.max(1, tw));
      const startX = cropW - tailW;
      let minY = cropH;
      let maxY = -1;
      for (let y = 0; y < cropH; y++) {
        for (let x = 0; x < tailW; x++) {
          if (cropPatch[y * cropW + (startX + x)] > 128) {
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const effH = maxY >= minY ? maxY - minY + 1 : cropH;
      const startY = maxY >= minY ? minY : 0;
      const tailCrop = new Uint8Array(tailW * effH);
      for (let y = 0; y < effH; y++) {
        for (let x = 0; x < tailW; x++) {
          tailCrop[y * tailW + x] = cropPatch[(startY + y) * cropW + (startX + x)];
        }
      }
      const resizedTail = resizeArea(tailCrop, tailW, effH, 32, 16);
      const tailBytes = packBits(resizedTail);
      tailVariants.push(
        tailBytes,
        shiftBits(tailBytes, 4, 16, -1),
        shiftBits(tailBytes, 4, 16, 1)
      );
    }

    // ±1bit シフト配列 (full: 8 bytes x 16 rows)
    const fullVariants = [
      fullBytes,
      shiftBits(fullBytes, 8, 16, -1),
      shiftBits(fullBytes, 8, 16, 1),
    ];
    const fullVariants16 = fullVariants.map(toUint16View);
    const headVariants16 = headVariants.map(toUint16View);
    const tailVariants16 = tailVariants.map(toUint16View);

    const storeCache = (res: { skillId: number; name: string; rarity: number; dist: number }) => {
      if (this.cardNameCache.size >= 64) {
        const oldestKey = this.cardNameCache.keys().next().value;
        if (oldestKey !== undefined) this.cardNameCache.delete(oldestKey);
      }
      this.cardNameCache.set(cacheKey, { fullBytes, result: res });
      return res;
    };

    let bestDist = 99999;
    let bestSkill: (typeof this.skillTable)[0] | null = null;
    let secondBestDist = 99999;
    let secondBestSkill: (typeof this.skillTable)[0] | null = null;
    let bestVariantFull: Uint8Array = fullVariants[0];
    let bestVariantHead: Uint8Array = headVariants[0];
    let bestVariantTail: Uint8Array = tailVariants[0];

    const aspectFactor = isCompact ? 1.14 : 1.0;
    const targetRawAspect = aspect / aspectFactor;
    let lo = 0;
    let hi = this.skillTable.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.skillTable[mid].aspect < targetRawAspect) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }

    let leftIdx = lo - 1;
    let rightIdx = lo;
    let leftDone = leftIdx < 0;
    let rightDone = rightIdx >= this.skillTable.length;

    while (!leftDone || !rightDone) {
      let pickRight: boolean;
      if (!leftDone && !rightDone) {
        const lDiff = Math.abs(this.skillTable[leftIdx].aspect * aspectFactor - aspect);
        const rDiff = Math.abs(this.skillTable[rightIdx].aspect * aspectFactor - aspect);
        pickRight = rDiff <= lDiff;
      } else {
        pickRight = !rightDone;
      }

      const s = pickRight ? this.skillTable[rightIdx++] : this.skillTable[leftIdx--];
      if (pickRight && rightIdx >= this.skillTable.length) rightDone = true;
      if (!pickRight && leftIdx < 0) leftDone = true;

      // アスペクト比ハードゲート & ペナルティ (係数 25): 単調増加のため範囲外到達側は以後打ち切り可能
      const expAspect = s.aspect * aspectFactor;
      const aspDiff = Math.abs(expAspect - aspect);
      const aspPen = Math.floor(aspDiff * 25);
      if (aspDiff > 1.45 * (1 + 0.1 * expAspect) || aspPen >= secondBestDist) {
        if (pickRight) rightDone = true;
        else leftDone = true;
        continue;
      }

      // 状態に応じて同名固有ペア(272組)の片方をスキップし、重複計算の削減と継承(180pt)/本体(340pt)の厳密分離を両立する
      if (cardState === 'acquired') {
        if (s.rarity <= 2 && s.id >= 900000 && s.id < 1000000) {
          continue;
        }
      } else if (s.rarity >= 3 || s.validCosts.size === 0) {
        continue;
      }

      // レアリティ不一致ペナルティ（白カードなのに金スキル、金カードなのに白スキル）
      let rarityPen = 0;
      if (isGoldCard && s.rarity === 1) rarityPen = 150;
      else if (!isGoldCard && s.rarity === 2) rarityPen = 150;

      if (s.name.length <= 2 && aspect > 2.5 * aspectFactor) continue;
      if (s.name.length >= 5 && aspect < 2.5 * aspectFactor) continue;

      if (rarityPen + aspPen >= secondBestDist) {
        continue;
      }

      let circlePen = 0;
      if (s.name.endsWith('◎')) circlePen = isDoubleCircle ? 0 : 80;
      else if (s.name.endsWith('○')) circlePen = isDoubleCircle ? 80 : 0;

      if (rarityPen + aspPen + circlePen >= secondBestDist) {
        continue;
      }

      const remDist = secondBestDist - aspPen - circlePen - rarityPen;
      const fullLimit = s.name.length <= 2 ? remDist + 1 : Math.ceil(remDist / 0.4) + 2;

      // Full ham (128 bytes = 64 uint16s = 1024 bits): 加算は単調非減少のため閾値到達時点で打ち切り可能
      const sBytes16 = s.bytes16;
      let minFullHam = 99999;
      let matchedFullVar = fullVariants[0];
      for (let v = 0; v < 3; v++) {
        const v16 = fullVariants16[v];
        const stopAt = minFullHam < fullLimit ? minFullHam : fullLimit;
        let h = 0;
        for (let i = 0; i < 64; i += 16) {
          for (let j = i; j < i + 16; j++) {
            h += POPCNT16[v16[j] ^ sBytes16[j]];
          }
          if (h >= stopAt) {
            h = 99999;
            break;
          }
        }
        if (h < minFullHam) {
          minFullHam = h;
          matchedFullVar = fullVariants[v];
        }
      }

      if (minFullHam >= fullLimit) {
        continue;
      }

      let totalDist: number;
      let matchedHeadVar = headVariants[0];
      let matchedTailVar = tailVariants[0];

      if (s.name.length <= 2) {
        totalDist = minFullHam + aspPen + circlePen + rarityPen;
      } else {
        // 下界枝刈り: head/tail/worstCharPen が最小(0)でも secondBestDist 以上なら 1位にも2位にもなり得ない
        if (Math.round(minFullHam * 0.40) + aspPen + circlePen + rarityPen >= secondBestDist) {
          continue;
        }

        // Head ham (64 bytes = 32 uint16s = 512 bits)
        // 文字セル H0 (Char 1: uint16 idx 0), H1 (Char 2: uint16 idx 1)
        const sHead16 = s.head16;
        let minHeadHam = 99999;
        let optH0 = 999, optH1 = 999;
        for (let v = 0; v < headVariants16.length; v++) {
          const v16 = headVariants16[v];
          let h0 = 0, h1 = 0;
          for (let y = 0; y < 32; y += 2) {
            h0 += POPCNT16[v16[y] ^ sHead16[y]];
            h1 += POPCNT16[v16[y + 1] ^ sHead16[y + 1]];
          }
          const h = h0 + h1;
          if (h < minHeadHam) {
            minHeadHam = h;
            optH0 = h0;
            optH1 = h1;
            matchedHeadVar = headVariants[v];
          }
        }

        // Tail ham (64 bytes = 32 uint16s = 512 bits)
        // 文字セル T0 (Char N-1: uint16 idx 0), T1 (Char N: uint16 idx 1)
        const sTail16 = s.tail16;
        let minTailHam = 99999;
        let optT0 = 999, optT1 = 999;
        for (let v = 0; v < tailVariants16.length; v++) {
          const v16 = tailVariants16[v];
          let t0 = 0, t1 = 0;
          for (let y = 0; y < 32; y += 2) {
            t0 += POPCNT16[v16[y] ^ sTail16[y]];
            t1 += POPCNT16[v16[y + 1] ^ sTail16[y + 1]];
          }
          const h = t0 + t1;
          if (h < minTailHam) {
            minTailHam = h;
            optT0 = t0;
            optT1 = t1;
            matchedTailVar = tailVariants[v];
          }
        }

        // Worst-Character Gate: 1文字でも大きく乖離している候補を弾く
        let worstCharHam: number;
        if (s.name.length >= 4) {
          worstCharHam = Math.max(optH0, optH1, optT0, optT1);
        } else {
          worstCharHam = Math.max(optH0, optH1, optT1);
        }

        if (worstCharHam > 76) {
          continue;
        }

        const worstCharPen = Math.max(0, worstCharHam - 68) * 1.5;

        // マルチパッチ重み付き統合距離 (Full 40%, Head 35%, Tail 25%) + 最悪文字ペナルティ
        const headNormalized = minHeadHam * 2;
        const tailNormalized = minTailHam * 2;
        const weightedHam = Math.round(
          minFullHam * 0.40 + headNormalized * 0.35 + tailNormalized * 0.25
        );
        totalDist = weightedHam + aspPen + circlePen + rarityPen + worstCharPen;
      }
      if (totalDist < bestDist) {
        if (bestSkill && bestSkill.name !== s.name) {
          secondBestDist = bestDist;
          secondBestSkill = bestSkill;
        }
        bestDist = totalDist;
        bestSkill = s;
        bestVariantFull = matchedFullVar;
        bestVariantHead = matchedHeadVar;
        bestVariantTail = matchedTailVar;
      } else if (
        totalDist === bestDist &&
        isUnselected &&
        needSp > 0 &&
        bestSkill &&
        bestSkill.name === s.name &&
        bestSkill.validCosts.size === 0 &&
        s.validCosts.size > 0
      ) {
        bestSkill = s;
        bestVariantFull = matchedFullVar;
        bestVariantHead = matchedHeadVar;
        bestVariantTail = matchedTailVar;
      } else if (totalDist < secondBestDist) {
        if (!bestSkill || bestSkill.name !== s.name) {
          secondBestDist = totalDist;
          secondBestSkill = s;
        }
      }
    }

    const UNKNOWN = { skillId: 0, name: 'Unknown', rarity: 0, dist: 9999 };

    // 金スキル(金背景)はグラデーション背景により距離240〜275に達し、継承固有・◎・獲得済枠も特殊フォント/背景のため240まで許容する
    // 一方、通常の白スキルは白地カードなので 205超はノイズ/ブラーとみなす
    const isGoldOrSpecial = Boolean(
      bestSkill &&
        (isGoldCard ||
          bestSkill.rarity >= 2 ||
          bestSkill.id >= 900000 ||
          bestSkill.name.endsWith('◎') ||
          !isUnselected)
    );
    const baseMaxDist = cw < 450 ? 285 : isGoldCard ? 275 : isGoldOrSpecial ? 240 : 205;
    const maxDist = isUnselected ? baseMaxDist : baseMaxDist + 40;
    if (bestDist > maxDist) {
      return storeCache(UNKNOWN);
    }

    // Pairwise XOR Disambiguation (同族スキルファミリ検証 & 1位・2位競合の差分ビット支持度検証)
    let xorVerified = false;
    if (bestSkill) {
      const suf1 = bestSkill.name.length >= 3 ? bestSkill.name.slice(1) : '';
      const firstCharSiblings = this.firstCharFamilyMap.get(suf1);
      const isRacecourse = bestSkill.name.endsWith('レース場○') || bestSkill.name.endsWith('レース場◎');

      if (firstCharSiblings && firstCharSiblings.length > 1) {
        // 先頭1文字のみが異なる同族スキル（例: 春ウマ娘○ vs 夏ウマ娘○、右回り○ vs 左回り○）
        for (const sib of firstCharSiblings) {
          if (sib.id === bestSkill.id) continue;
          let bestChar0Supp = 0;
          let sibChar0Supp = 0;
          for (let y = 0; y < 16; y++) {
            const rowOff = y * 4;
            for (let b = 0; b < 2; b++) {
              const diffMask = bestSkill.headBytes[rowOff + b] ^ sib.headBytes[rowOff + b];
              if (diffMask === 0) continue;
              const imgB = headVariants[0][rowOff + b];
              bestChar0Supp += POPCNT8[~(imgB ^ bestSkill.headBytes[rowOff + b]) & diffMask & 0xff];
              sibChar0Supp += POPCNT8[~(imgB ^ sib.headBytes[rowOff + b]) & diffMask & 0xff];
            }
          }
          const totalChar0Diff = bestChar0Supp + sibChar0Supp;
          if (totalChar0Diff > 10) {
            // 兄弟スキルの支持率が勝っている、または支持率 < 55% のときは 'Unknown' として棄却
            if (sibChar0Supp >= bestChar0Supp || bestChar0Supp / totalChar0Diff < 0.55) {
              return storeCache(UNKNOWN);
            }
          }
        }
        xorVerified = true;
      } else if (isRacecourse) {
        // レース場同族スキル（例: 京都レース場○ vs 東京レース場○）
        const rcSuf = bestSkill.name.endsWith('レース場◎') ? 'レース場◎' : 'レース場○';
        const rcSiblings = this.racecourseFamilyMap.get(rcSuf);
        if (rcSiblings && rcSiblings.length > 1) {
          for (const sib of rcSiblings) {
            if (sib.id === bestSkill.id) continue;
            let bestHeadSupp = 0;
            let sibHeadSupp = 0;
            for (let i = 0; i < 64; i++) {
              const diffMask = bestSkill.headBytes[i] ^ sib.headBytes[i];
              if (diffMask === 0) continue;
              const imgByte = headVariants[0][i];
              bestHeadSupp += POPCNT8[~(imgByte ^ bestSkill.headBytes[i]) & diffMask & 0xff];
              sibHeadSupp += POPCNT8[~(imgByte ^ sib.headBytes[i]) & diffMask & 0xff];
            }
            const totalHeadDiff = bestHeadSupp + sibHeadSupp;
            if (totalHeadDiff > 10) {
              if (sibHeadSupp >= bestHeadSupp || bestHeadSupp / totalHeadDiff < 0.54) {
                return storeCache(UNKNOWN);
              }
            }
          }
          xorVerified = true;
        }
      } else if (secondBestSkill && secondBestDist - bestDist < 60) {
        let isSuffixShared = false;
        let isPrefixShared = false;
        if (bestSkill.name.length >= 3 && secondBestSkill.name.length >= 3) {
          if (bestSkill.name.slice(2) === secondBestSkill.name.slice(2)) {
            isSuffixShared = true;
          }
          if (
            bestSkill.name.slice(0, -1) === secondBestSkill.name.slice(0, -1) ||
            bestSkill.name.slice(0, -2) === secondBestSkill.name.slice(0, -2)
          ) {
            isPrefixShared = true;
          }
        }

        if (isSuffixShared) {
          let bestHeadSupp = 0;
          let secondHeadSupp = 0;
          for (let i = 0; i < 64; i++) {
            const diffMask = bestSkill.headBytes[i] ^ secondBestSkill.headBytes[i];
            if (diffMask === 0) continue;
            const imgByte = bestVariantHead[i];
            bestHeadSupp += POPCNT8[~(imgByte ^ bestSkill.headBytes[i]) & diffMask & 0xff];
            secondHeadSupp += POPCNT8[~(imgByte ^ secondBestSkill.headBytes[i]) & diffMask & 0xff];
          }
          const totalHeadDiff = bestHeadSupp + secondHeadSupp;
          if (totalHeadDiff > 10) {
            if (secondHeadSupp >= bestHeadSupp || bestHeadSupp / totalHeadDiff < 0.55) {
              return storeCache(UNKNOWN);
            }
            xorVerified = true;
          }
        } else if (isPrefixShared) {
          let bestTailSupp = 0;
          let secondTailSupp = 0;
          for (let i = 0; i < 64; i++) {
            const diffMask = bestSkill.tailBytes[i] ^ secondBestSkill.tailBytes[i];
            if (diffMask === 0) continue;
            const imgByte = bestVariantTail[i];
            bestTailSupp += POPCNT8[~(imgByte ^ bestSkill.tailBytes[i]) & diffMask & 0xff];
            secondTailSupp += POPCNT8[~(imgByte ^ secondBestSkill.tailBytes[i]) & diffMask & 0xff];
          }
          const totalTailDiff = bestTailSupp + secondTailSupp;
          if (totalTailDiff > 10) {
            if (secondTailSupp >= bestTailSupp || bestTailSupp / totalTailDiff < 0.55) {
              return storeCache(UNKNOWN);
            }
            xorVerified = true;
          }
        } else {
          let bestDiffSupport = 0;
          let secondDiffSupport = 0;
          for (let i = 0; i < 128; i++) {
            const diffMask = bestSkill.bytes[i] ^ secondBestSkill.bytes[i];
            if (diffMask === 0) continue;
            const imgByte = bestVariantFull[i];
            bestDiffSupport += POPCNT8[~(imgByte ^ bestSkill.bytes[i]) & diffMask & 0xff];
            secondDiffSupport += POPCNT8[~(imgByte ^ secondBestSkill.bytes[i]) & diffMask & 0xff];
          }
          const totalDiffBits = bestDiffSupport + secondDiffSupport;
          if (totalDiffBits > 10) {
            if (secondDiffSupport >= bestDiffSupport || bestDiffSupport / totalDiffBits < 0.52) {
              return storeCache(UNKNOWN);
            }
          }
        }
      }
    }

    if (bestSkill && !xorVerified && bestDist > 165 && secondBestDist - bestDist <= 22) {
      return storeCache(UNKNOWN);
    }

    // Why not: 照合ループ内で除外すると SP 誤読時に他スキルへハルシネーションするため、最良候補確定後に事後検証し不一致時は他候補へ乗り換えずに Unknown とする
    // なお、未選択かつ SP > 0 のカードに innate 固有スキル (need_pt === 0 / validCosts 空) が誤一致するのも同様に棄却する
    if (
      bestSkill &&
      isUnselected &&
      needSp > 0 &&
      (bestSkill.validCosts.size === 0 || !bestSkill.validCosts.has(needSp))
    ) {
      return storeCache(UNKNOWN);
    }

    return storeCache(
      bestSkill
        ? { skillId: bestSkill.id, name: bestSkill.name, rarity: bestSkill.rarity, dist: bestDist }
        : UNKNOWN
    );
  }

  /**
   * 初期化時に主要認識ホットパスを複数回事前実行し、V8 TurboFan JIT コンパイルを完了させて
   * 初回実フレームでのレイテンシスパイクを防ぐ
   */
  public warmup(): void {
    const w = 600;
    const h = 160;
    const dummyCard = new Uint8Array(w * h * 4);
    for (let k = 0; k < 10; k++) {
      const isGold = k % 3 === 1;
      const isAcq = k % 3 === 2;
      dummyCard.fill(isGold ? 235 : 245);
      const isComp = k % 2 === 0;
      const sample = this.skillTable.length > 0 ? this.skillTable[(k * 137) % this.skillTable.length] : null;
      const boxY = isComp ? 30 : 18;
      const boxH = isComp ? 20 : 16;
      const boxW = sample ? Math.min(340, Math.max(48, Math.round(sample.aspect * boxH))) : 140;
      for (let py = 0; py < boxH; py++) {
        const sr = Math.min(15, Math.floor((py * 16) / boxH));
        for (let px = 0; px < boxW; px++) {
          const sc = Math.min(63, Math.floor((px * 64) / boxW));
          const isInk = sample ? (sample.bytes[sr * 8 + (sc >> 3)] & (0x80 >> (sc & 7))) !== 0 : true;
          if (!isInk) continue;
          const idx = ((boxY + py) * w + (115 + px)) * 4;
          dummyCard[idx] = 55;
          dummyCard[idx + 1] = 35;
          dummyCard[idx + 2] = 25;
        }
      }
      const sp = sample && sample.need_pt > 0 ? sample.need_pt : 160;
      this.ocrCardNeedSp(dummyCard, w, h, isComp);
      this.recognizeCardSkillName(
        dummyCard,
        w,
        h,
        isComp,
        isAcq ? 0 : sp,
        !isAcq,
        isGold,
        isAcq ? 'acquired' : 'unselected'
      );
    }
    this.cardNameCache.clear();

    const fw = 720;
    const fh = 1280;
    const dummyFrame = new Uint8Array(fw * fh * 4);
    dummyFrame.fill(240);
    const frameBuf: ImageBuffer = { data: dummyFrame, width: fw, height: fh };
    for (let k = 0; k < 4; k++) {
      this.detectScreenType(frameBuf);
      this.recognizeSkillPt(frameBuf, 'スキル獲得説明省略表示');
      this.detectCards(frameBuf, k % 2 === 0);
    }
    this.cardNameCache.clear();
  }

  /**
   * 全体認識実行
   */
  public recognize(img: ImageBuffer): RecognitionOutput {
    const { screenType, screenMode, anchorDx, anchorDy, titlebarOffsetY } = this.detectScreenType(img);
    const cards: RecognizedCardResult[] = [];

    if (screenType === 'ウマ娘詳細適性ポップアップ') {
      const aptitudes = this.recognizeAptitudes(img, titlebarOffsetY, anchorDx ?? 0, anchorDy ?? 0);
      const detectedCardId = this.recognizeCardId(img, titlebarOffsetY, anchorDx ?? 0, anchorDy ?? 0);
      if (aptitudes) {
        return {
          screenType,
          screenMode,
          skillPoint: 0,
          aptitudes,
          detectedCardId,
          cards: [],
        };
      }
      return {
        screenType: '育成完了確認（ホーム画面）',
        screenMode: 'idle',
        skillPoint: 0,
        cards: [],
      };
    }

    // 所持スキルPt認識
    const skillPoint = this.recognizeSkillPt(img, screenType);

    if (screenType === '育成完了確認（ホーム画面）') {
      return {
        screenType,
        screenMode,
        skillPoint,
        cards: [],
      };
    }

    // スキルカード枠の検出と各カード認識
    const isCompact = screenType === 'スキル獲得説明省略表示';
    const { boxes, cLeft, cRight } = this.detectCards(img, isCompact);
    const cw = cRight - cLeft;

    for (const box of boxes) {
      const ch = box.height;
      if (ch < 10 || cw < 50) continue;

      // カード画像を切り出し
      const cardData = new Uint8Array(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        const srcRowStart = ((box.top + y) * img.width + cLeft) * 4;
        cardData.set(img.data.subarray(srcRowStart, srcRowStart + cw * 4), y * cw * 4);
      }

      // 必要SP & 選択状態
      const spResult = this.ocrCardNeedSp(cardData, cw, ch, isCompact);
      if (!spResult.valid) {
        continue;
      }

      // 虹色グレーアウト背景の本体固有カードは、SP誤読等で unselected/selected に落ちることを防ぎ acquired に固定する
      const isRainbowUnique = this.isAcquiredRainbowCard(cardData, cw, ch);
      if (isRainbowUnique && spResult.state !== 'acquired') {
        spResult.state = 'acquired';
        spResult.needSp = 0;
      }

      // カード背景の平均輝度チェック (未選択スキルカードは白地 > 190)
      if (spResult.state === 'unselected') {
        let centerGraySum = 0;
        let centerPixCount = 0;
        const centerY0 = Math.floor(ch * 0.3);
        const centerY1 = Math.floor(ch * 0.7);
        const centerX0 = Math.floor(cw * 0.3);
        const centerX1 = Math.floor(cw * 0.7);
        for (let y = centerY0; y < centerY1; y++) {
          const rowOffset = y * cw;
          for (let x = centerX0; x < centerX1; x++) {
            const idx = (rowOffset + x) * 4;
            const r = cardData[idx];
            const g = cardData[idx + 1];
            const b = cardData[idx + 2];
            centerGraySum += Math.round(0.299 * r + 0.587 * g + 0.114 * b);
            centerPixCount++;
          }
        }
        const avgCenterGray = centerPixCount > 0 ? centerGraySum / centerPixCount : 255;
        if (avgCenterGray < 190) {
          continue;
        }
      }

      // 通常表示時 (!isCompact) の説明文 (description) 存在検証
      if (!isCompact) {
        let descDarkCount = 0;
        const dy0 = Math.floor(ch * 0.35);
        const dy1 = Math.floor(ch * 0.80);
        const dx0 = Math.floor(cw * 0.16);
        const dx1 = Math.floor(cw * 0.75);
        for (let y = dy0; y < dy1; y++) {
          const rowOffset = y * cw;
          for (let x = dx0; x < dx1; x++) {
            const idx = (rowOffset + x) * 4;
            const gray = Math.round(
              0.299 * cardData[idx] + 0.587 * cardData[idx + 1] + 0.114 * cardData[idx + 2]
            );
            if (gray <= 140) {
              descDarkCount++;
            }
          }
        }
        if (descDarkCount < 20) {
          continue; // 説明文が存在しない矩形はカードではない
        }
      }

      // カード背景帯 (x: 0.18*cw .. 0.60*cw, y: 0.05*ch .. 0.35*ch) で金カード判定
      // (スキルアイコン領域 x: 0..0.15*cw は黄色いアイコンを含むため除外する)
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
      let bgCount = 0;
      const yBg0 = Math.floor(ch * 0.05);
      const yBg1 = Math.floor(ch * 0.35);
      const xBg0 = Math.floor(cw * 0.18);
      const xBg1 = Math.floor(cw * 0.60);
      for (let y = yBg0; y < yBg1; y++) {
        const rowOffset = y * cw;
        for (let x = xBg0; x < xBg1; x++) {
          const idx = (rowOffset + x) * 4;
          rSum += cardData[idx];
          gSum += cardData[idx + 1];
          bSum += cardData[idx + 2];
          bgCount++;
        }
      }
      const avgR = bgCount > 0 ? rSum / bgCount : 255;
      const avgG = bgCount > 0 ? gSum / bgCount : 255;
      const avgB = bgCount > 0 ? bSum / bgCount : 255;
      const isGoldCard = avgR - avgB > 35 && avgG - avgB > 20;

      // スキル名認識
      const isUnselected = spResult.state === 'unselected';
      const { skillId, name, rarity, dist } = this.recognizeCardSkillName(
        cardData,
        cw,
        ch,
        isCompact,
        spResult.needSp,
        isUnselected,
        isGoldCard,
        spResult.state
      );
      if (skillId <= 0) {
        continue;
      }

      // 獲得済枠の厳密ガード:
      // スキル獲得画面で最初から獲得済なのは育成ウマ娘自身の固有スキル (rarity >= 3) のみ。
      // 通常スキル (rarity <= 2) で緑Ptもピンクも無い枠は 100% ハルシネーションなので棄却！
      if (spResult.state === 'acquired') {
        if (rarity < 3 || dist > 215) {
          continue;
        }
      }

      cards.push({
        skillId,
        name,
        needSp: spResult.needSp,
        state: spResult.state,
        dist,
        box,
      });
    }

    // スキル獲得画面と判定されたが有効なカードが1枚も検出されない場合は、
    // 非スキル画面（遷移中・レース画面等）のフォールバックとして扱い誤SP上書きを防止
    if (cards.length === 0) {
      return {
        screenType: '育成完了確認（ホーム画面）',
        screenMode: 'idle',
        skillPoint: 0,
        cards: [],
      };
    }

    return {
      screenType,
      screenMode,
      skillPoint,
      cards,
    };
  }
}
