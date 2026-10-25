import { describe, expect, it } from 'vitest';
import { RUN_UP, patternsOf, reaction, reactionIndex, story, type Reaction } from '../utils/earningsReaction';

const dates = Array.from({length: 40}, (_, i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10));

describe('earnings reaction', () => {
  it('reacts the same session before or during market hours, the next one after hours', () => {
    expect(reactionIndex(dates, dates[25], 'Before')).toBe(25);
    expect(reactionIndex(dates, dates[25], 'During')).toBe(25);
    expect(reactionIndex(dates, dates[25], 'After')).toBe(26);
    expect(reactionIndex(dates, dates[25], null)).toBe(26);
    // A weekend filing (between two sessions) reacts on the next session.
    expect(reactionIndex(['2026-01-02', '2026-01-05'], '2026-01-03', 'Before')).toBe(1);
  });

  it('measures the run-up, first day and since from the close before the result', () => {
    const closes = dates.map((_, i) => (i <= 25 ? 100 + i : 200));
    const value = reaction(dates, closes, dates[25], 'After')!;
    expect(value.runUp).toBeCloseTo((125 / (125 - RUN_UP) - 1) * 100);
    expect(value.day1).toBeCloseTo(60);
    expect(value.since).toBeCloseTo(60);
    expect(value.sessions).toBe(14);
    expect(value.path[value.at]).toBe(1);
  });

  it('waits for the first session and tells the story in one sentence', () => {
    const closes = dates.map((_, i) => 100 + i);
    expect(reaction(dates, closes, dates[39], 'After')).toMatchObject({day1: null, since: null, sessions: 0});
    const value = reaction(dates, dates.map((_, i) => (i < 25 ? 100 : i === 25 ? 90 : 80)), dates[24], 'After')!;
    expect(story(value)).toBe('Quiet into results, sold off 10.0% on the day, then gave back to -20.0%');
  });

  it('names reaction patterns, and a reaction can show several', () => {
    const move = (runUp: number, day1: number, since: number, sessions = 10): Reaction => ({runUp, day1, since, after: null, sessions, path: [], at: 0});
    expect(patternsOf(move(8, -4, -12))).toEqual(['soldOff', 'soldNews', 'faded']);
    expect(patternsOf(move(0, 5, 12))).toEqual(['rallied', 'keptGoing']);
    expect(patternsOf(move(0, 1, 2))).toEqual([]);
    expect(patternsOf(move(0, 5, 12, 0))).toEqual(['awaiting']);
  });
});
