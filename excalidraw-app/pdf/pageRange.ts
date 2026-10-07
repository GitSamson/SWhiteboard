/** Page range selection for the PDF "expand pages" action. */

export interface PageRange {
  start: number;
  end: number;
}

/**
 * Clamp user-entered page numbers into `[1, pageCount]`, coercing to
 * integers; an end before the start collapses to the start page.
 */
export const clampPageRange = (
  start: number,
  end: number,
  pageCount: number,
): PageRange => {
  const clamp = (value: number) =>
    Math.max(1, Math.min(pageCount, Math.floor(value) || 1));
  const clampedStart = clamp(start);
  const clampedEnd = clamp(end);
  return clampedEnd < clampedStart
    ? { start: clampedStart, end: clampedStart }
    : { start: clampedStart, end: clampedEnd };
};
