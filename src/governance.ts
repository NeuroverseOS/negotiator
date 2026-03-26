/**
 * Governance logic — pure functions for trust scoring, gate transitions,
 * and behavioral adjustments. Extracted for testability.
 */

// ─── Constants (re-exported for tests) ──────────────────────────────────────

export const WORDS_GLANCE = 15;
export const WORDS_DEPTH = 50;
export const WORDS_FOLLOWUP = 35;
export const CLASSIFY_DELAY_MS = 3_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export type GovernanceGate = 'ACTIVE' | 'DEGRADED' | 'SUSPENDED' | 'REVOKED';

export interface GovernanceState {
  sessionTrust: number;
  gate: GovernanceGate;
}

export interface SignalRecord {
  type: string;
  acted: boolean;
  dismissed: boolean;
}

export interface NegotiatorJournal {
  totalSignals: number;
  totalDismissals: number;
  totalFollowThroughs: number;
  totalSessions: number;
  lastSessionDate: string;
  recentSignals: SignalRecord[];
  signalEffectiveness: Record<string, { surfaced: number; acted: number; dismissed: number }>;
}

export const EMPTY_JOURNAL: NegotiatorJournal = {
  totalSignals: 0,
  totalDismissals: 0,
  totalFollowThroughs: 0,
  totalSessions: 0,
  lastSessionDate: '',
  recentSignals: [],
  signalEffectiveness: {},
};

// ─── Gate Classification ────────────────────────────────────────────────────

export function trustToGate(trust: number): GovernanceGate {
  if (trust <= 10) return 'REVOKED';
  if (trust <= 30) return 'SUSPENDED';
  if (trust < 70) return 'DEGRADED';
  return 'ACTIVE';
}

// ─── Gate Adjustments ───────────────────────────────────────────────────────

export function gateAdjustments(gate: GovernanceGate): {
  maxWords: number;
  proactiveEnabled: boolean;
  classifyDelayMs: number;
} {
  switch (gate) {
    case 'ACTIVE':
      return { maxWords: WORDS_DEPTH, proactiveEnabled: true, classifyDelayMs: CLASSIFY_DELAY_MS };
    case 'DEGRADED':
      return { maxWords: Math.round(WORDS_DEPTH * 0.6), proactiveEnabled: true, classifyDelayMs: CLASSIFY_DELAY_MS * 2 };
    case 'SUSPENDED':
      return { maxWords: WORDS_GLANCE, proactiveEnabled: false, classifyDelayMs: Infinity };
    case 'REVOKED':
      return { maxWords: 0, proactiveEnabled: false, classifyDelayMs: Infinity };
  }
}

// ─── Journal Analytics ──────────────────────────────────────────────────────

export function followThroughRate(journal: NegotiatorJournal): number {
  if (journal.totalSignals === 0) return 0;
  return Math.round((journal.totalFollowThroughs / journal.totalSignals) * 100);
}

export function bestSignalType(journal: NegotiatorJournal): string | null {
  let best: string | null = null;
  let bestRate = 0;
  for (const [type, stats] of Object.entries(journal.signalEffectiveness)) {
    if (stats.surfaced < 3) continue;
    const rate = stats.acted / stats.surfaced;
    if (rate > bestRate) { bestRate = rate; best = type; }
  }
  return best;
}
