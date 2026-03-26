import { describe, it, expect } from 'vitest';
import {
  trustToGate,
  gateAdjustments,
  followThroughRate,
  bestSignalType,
  EMPTY_JOURNAL,
  WORDS_DEPTH,
  WORDS_GLANCE,
  CLASSIFY_DELAY_MS,
  type NegotiatorJournal,
} from './governance';

// ─── Gate Classification ────────────────────────────────────────────────────

describe('trustToGate', () => {
  it('ACTIVE at trust >= 70', () => {
    expect(trustToGate(100)).toBe('ACTIVE');
    expect(trustToGate(70)).toBe('ACTIVE');
  });

  it('DEGRADED at trust 31-69', () => {
    expect(trustToGate(69)).toBe('DEGRADED');
    expect(trustToGate(50)).toBe('DEGRADED');
    expect(trustToGate(31)).toBe('DEGRADED');
  });

  it('SUSPENDED at trust 11-30', () => {
    expect(trustToGate(30)).toBe('SUSPENDED');
    expect(trustToGate(20)).toBe('SUSPENDED');
    expect(trustToGate(11)).toBe('SUSPENDED');
  });

  it('REVOKED at trust <= 10', () => {
    expect(trustToGate(10)).toBe('REVOKED');
    expect(trustToGate(5)).toBe('REVOKED');
    expect(trustToGate(0)).toBe('REVOKED');
  });

  it('handles boundary values precisely', () => {
    expect(trustToGate(70)).toBe('ACTIVE');
    expect(trustToGate(69.9)).toBe('DEGRADED');
    expect(trustToGate(30)).toBe('SUSPENDED');
    expect(trustToGate(10)).toBe('REVOKED');
    expect(trustToGate(10.1)).toBe('SUSPENDED');
  });
});

// ─── Gate Adjustments ───────────────────────────────────────────────────────

describe('gateAdjustments', () => {
  it('ACTIVE: full words, proactive on, normal delay', () => {
    const adj = gateAdjustments('ACTIVE');
    expect(adj.maxWords).toBe(WORDS_DEPTH);
    expect(adj.proactiveEnabled).toBe(true);
    expect(adj.classifyDelayMs).toBe(CLASSIFY_DELAY_MS);
  });

  it('DEGRADED: 60% words, proactive on, 2x delay', () => {
    const adj = gateAdjustments('DEGRADED');
    expect(adj.maxWords).toBe(Math.round(WORDS_DEPTH * 0.6));
    expect(adj.proactiveEnabled).toBe(true);
    expect(adj.classifyDelayMs).toBe(CLASSIFY_DELAY_MS * 2);
  });

  it('SUSPENDED: glance words only, no proactive', () => {
    const adj = gateAdjustments('SUSPENDED');
    expect(adj.maxWords).toBe(WORDS_GLANCE);
    expect(adj.proactiveEnabled).toBe(false);
    expect(adj.classifyDelayMs).toBe(Infinity);
  });

  it('REVOKED: zero words, nothing works', () => {
    const adj = gateAdjustments('REVOKED');
    expect(adj.maxWords).toBe(0);
    expect(adj.proactiveEnabled).toBe(false);
    expect(adj.classifyDelayMs).toBe(Infinity);
  });
});

// ─── Trust Degradation Math ─────────────────────────────────────────────────

describe('trust degradation (Rule 002 simulation)', () => {
  it('trust *= 0.85 degrades from 100 to 85', () => {
    const trust = 100 * 0.85;
    expect(trust).toBe(85);
    expect(trustToGate(trust)).toBe('ACTIVE');
  });

  it('two degradations: 100 → 85 → 72.25 (still ACTIVE)', () => {
    const trust = 100 * 0.85 * 0.85;
    expect(trust).toBeCloseTo(72.25);
    expect(trustToGate(trust)).toBe('ACTIVE');
  });

  it('three degradations: 100 → 61.4 (DEGRADED)', () => {
    const trust = 100 * 0.85 * 0.85 * 0.85;
    expect(trust).toBeCloseTo(61.41, 1);
    expect(trustToGate(trust)).toBe('DEGRADED');
  });

  it('repeated degradation eventually reaches SUSPENDED', () => {
    let trust = 100;
    let steps = 0;
    while (trustToGate(trust) !== 'SUSPENDED' && steps < 50) {
      trust *= 0.85;
      steps++;
    }
    expect(trustToGate(trust)).toBe('SUSPENDED');
    expect(steps).toBeGreaterThan(3);
    expect(steps).toBeLessThan(20);
  });

  it('repeated degradation eventually reaches REVOKED', () => {
    let trust = 100;
    let steps = 0;
    while (trustToGate(trust) !== 'REVOKED' && steps < 100) {
      trust *= 0.85;
      steps++;
    }
    expect(trustToGate(trust)).toBe('REVOKED');
  });
});

// ─── Journal Analytics ──────────────────────────────────────────────────────

describe('followThroughRate', () => {
  it('returns 0 for empty journal', () => {
    expect(followThroughRate(EMPTY_JOURNAL)).toBe(0);
  });

  it('calculates percentage correctly', () => {
    const journal: NegotiatorJournal = {
      ...EMPTY_JOURNAL,
      totalSignals: 10,
      totalFollowThroughs: 7,
    };
    expect(followThroughRate(journal)).toBe(70);
  });

  it('rounds to nearest integer', () => {
    const journal: NegotiatorJournal = {
      ...EMPTY_JOURNAL,
      totalSignals: 3,
      totalFollowThroughs: 1,
    };
    expect(followThroughRate(journal)).toBe(33);
  });

  it('returns 100 when all signals acted on', () => {
    const journal: NegotiatorJournal = {
      ...EMPTY_JOURNAL,
      totalSignals: 5,
      totalFollowThroughs: 5,
    };
    expect(followThroughRate(journal)).toBe(100);
  });
});

describe('bestSignalType', () => {
  it('returns null for empty journal', () => {
    expect(bestSignalType(EMPTY_JOURNAL)).toBeNull();
  });

  it('returns null when no signal type has enough data', () => {
    const journal: NegotiatorJournal = {
      ...EMPTY_JOURNAL,
      signalEffectiveness: {
        deflection: { surfaced: 2, acted: 2, dismissed: 0 },
      },
    };
    expect(bestSignalType(journal)).toBeNull();
  });

  it('returns the most effective signal type', () => {
    const journal: NegotiatorJournal = {
      ...EMPTY_JOURNAL,
      signalEffectiveness: {
        deflection: { surfaced: 10, acted: 8, dismissed: 2 },
        inconsistency: { surfaced: 10, acted: 5, dismissed: 5 },
        cognitive_load: { surfaced: 10, acted: 3, dismissed: 7 },
      },
    };
    expect(bestSignalType(journal)).toBe('deflection');
  });

  it('ignores types with fewer than 3 samples', () => {
    const journal: NegotiatorJournal = {
      ...EMPTY_JOURNAL,
      signalEffectiveness: {
        deflection: { surfaced: 2, acted: 2, dismissed: 0 },
        inconsistency: { surfaced: 5, acted: 3, dismissed: 2 },
      },
    };
    expect(bestSignalType(journal)).toBe('inconsistency');
  });
});
