/**
 * Firefox/Gecko 等のブラウザにおける I420/NV12 サブサンプリング制約に対応する外側偶数境界クロップ計算。
 * 奇数座標や奇数サイズによる copyTo のクラッシュを防ぐ。
 */
export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FrameDimensions {
  width: number;
  height: number;
}

/**
 * 要求された矩形を外側に偶数アラインメントして返す。
 * フレーム境界を超える場合は null を返し、全フレームフォールバックとする。
 */
export function outwardEvenCropRect(
  pane: CropRect,
  captured: FrameDimensions
): CropRect | null {
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
