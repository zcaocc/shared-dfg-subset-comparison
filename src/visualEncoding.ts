export function opacityFromNormalizedValue(normalized: number): number {
  if (!Number.isFinite(normalized) || normalized < 0.02) return 0.1;
  if (normalized >= 0.72) return 0.9;
  return 0.2 + (normalized - 0.02) ;
}
