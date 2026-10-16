import { addDays, addMonths, parseDate } from './warranty.js';

/**
 * Evenly spaced visit due dates across a contract period.
 * 2 visits in a 12-month contract starting 1 Jan -> 1 Apr + 1 Oct (centred in each block).
 */
export function scheduleVisits(start: string, end: string, visitsPerYear: number): string[] {
  const totalDays = Math.round((parseDate(end).getTime() - parseDate(start).getTime()) / 86_400_000) + 1;
  const years = Math.max(totalDays / 365, 1 / 12);
  const count = Math.max(1, Math.round(visitsPerYear * years));
  const block = totalDays / count;
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(addDays(start, Math.floor(block * i + block / 2)));
  }
  return out;
}

/** Default one-year contract end date from a start date. */
export const defaultContractEnd = (start: string) => addDays(addMonths(start, 12), -1);
