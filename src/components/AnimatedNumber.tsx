import { useEffect, useRef } from 'react';

interface AnimatedNumberProps {
  value: number;
  durationMs?: number;
  prefix?: string;
  suffix?: string;
  className?: string;
}

/**
 * React の再レンダリングを誘発せずに DOM テキストのみを滑らかにカウントアップ表示するコンポーネント。
 */
export function AnimatedNumber({
  value,
  durationMs = 220,
  prefix = '',
  suffix = '',
  className,
}: AnimatedNumberProps) {
  const spanRef = useRef<HTMLSpanElement | null>(null);
  const displayedRef = useRef<number>(value);

  useEffect(() => {
    const el = spanRef.current;
    if (!el) return;

    const from = displayedRef.current;
    const to = value;
    if (from === to) {
      el.textContent = `${prefix}${to.toLocaleString()}${suffix}`;
      return;
    }

    const prefersReducedMotion =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (prefersReducedMotion || durationMs <= 0) {
      displayedRef.current = to;
      el.textContent = `${prefix}${to.toLocaleString()}${suffix}`;
      return;
    }

    let rafId = 0;
    const startTime = performance.now();

    const step = (now: number) => {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / durationMs);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const current = Math.round(from + (to - from) * eased);
      displayedRef.current = current;
      el.textContent = `${prefix}${current.toLocaleString()}${suffix}`;

      if (t < 1) {
        rafId = requestAnimationFrame(step);
      } else {
        displayedRef.current = to;
      }
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [value, durationMs, prefix, suffix]);

  return (
    <span ref={spanRef} className={className}>
      {prefix}
      {value.toLocaleString()}
      {suffix}
    </span>
  );
}
