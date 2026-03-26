import { describe, it, expect, beforeEach } from 'vitest';
import { SignalClassifier, type SignalClassification } from './signal-classifier';

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockAI(response: Partial<SignalClassification>) {
  return async () => JSON.stringify(response);
}

function silentAI() {
  return mockAI({ action: 'SILENT', strength: 'none', signals: [], reasoning: 'normal' });
}

function twoSignalAI() {
  return mockAI({
    action: 'SURFACE',
    strength: 'light',
    signals: [
      { type: 'deflection', description: 'dodged the question', timestamp: Date.now() },
      { type: 'cognitive_load', description: 'long pause', timestamp: Date.now() },
    ],
    reasoning: 'two distinct signals',
    suggestedMove: 'Ask again differently',
  });
}

function threeSignalAI() {
  return mockAI({
    action: 'SURFACE',
    strength: 'medium',
    signals: [
      { type: 'deflection', description: 'dodged the question', timestamp: Date.now() },
      { type: 'cognitive_load', description: 'long pause', timestamp: Date.now() },
      { type: 'inconsistency', description: 'timeline changed', timestamp: Date.now() },
    ],
    reasoning: 'three distinct signals',
  });
}

function fourSignalAI() {
  return mockAI({
    action: 'SURFACE',
    strength: 'strong',
    signals: [
      { type: 'deflection', description: 'dodged the question', timestamp: Date.now() },
      { type: 'cognitive_load', description: 'long pause', timestamp: Date.now() },
      { type: 'inconsistency', description: 'timeline changed', timestamp: Date.now() },
      { type: 'overcompensation', description: 'said honestly three times', timestamp: Date.now() },
    ],
    reasoning: 'four distinct signals',
  });
}

function cameraOnlyAI() {
  return mockAI({
    action: 'SURFACE',
    strength: 'light',
    signals: [
      { type: 'gaze_avoidance' as any, description: 'looked away', timestamp: Date.now() },
      { type: 'body_shift' as any, description: 'shifted position', timestamp: Date.now() },
    ],
    reasoning: 'camera signals',
  });
}

function singleSignalAI() {
  return mockAI({
    action: 'SURFACE',
    strength: 'light',
    signals: [
      { type: 'deflection', description: 'dodged the question', timestamp: Date.now() },
    ],
    reasoning: 'one signal',
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('SignalClassifier', () => {
  let classifier: SignalClassifier;

  beforeEach(() => {
    classifier = new SignalClassifier('standard', false);
  });

  describe('classify — governance: no_single_signal_escalation', () => {
    it('suppresses single signals even if AI says SURFACE', async () => {
      classifier.addUtterance('So the meeting was on Tuesday, right?');
      const result = await classifier.classify(singleSignalAI());
      expect(result.action).toBe('SILENT');
      expect(result.reasoning).toContain('single signal');
    });

    it('surfaces when 2+ signals detected (standard mode)', async () => {
      classifier.addUtterance('So the meeting was on Tuesday, right?');
      const result = await classifier.classify(twoSignalAI());
      expect(result.action).toBe('SURFACE');
      expect(result.prefix).toBe('~');
      expect(result.strength).toBe('light');
    });

    it('returns SILENT for empty conversation', async () => {
      const result = await classifier.classify(twoSignalAI());
      expect(result.action).toBe('SILENT');
      expect(result.reasoning).toBe('no conversation');
    });
  });

  describe('classify — governance: no_camera_confidence', () => {
    it('suppresses camera-only signals', async () => {
      classifier.addUtterance('Tell me about the project timeline.');
      const result = await classifier.classify(cameraOnlyAI());
      expect(result.action).toBe('SILENT');
      expect(result.reasoning).toContain('camera-only');
    });
  });

  describe('classify — sensitivity thresholds', () => {
    it('conservative requires 3+ signals', async () => {
      classifier.setSensitivity('conservative');
      classifier.addUtterance('Tell me more about that.');
      const result = await classifier.classify(twoSignalAI());
      expect(result.action).toBe('SILENT');
      expect(result.reasoning).toContain('conservative');
    });

    it('conservative surfaces at 3 signals', async () => {
      classifier.setSensitivity('conservative');
      classifier.addUtterance('Tell me more about that.');
      const result = await classifier.classify(threeSignalAI());
      expect(result.action).toBe('SURFACE');
      expect(result.prefix).toBe('~~');
    });

    it('standard surfaces at 2 signals', async () => {
      classifier.setSensitivity('standard');
      classifier.addUtterance('Tell me more about that.');
      const result = await classifier.classify(twoSignalAI());
      expect(result.action).toBe('SURFACE');
      expect(result.prefix).toBe('~');
    });

    it('sensitive surfaces at 2 signals', async () => {
      classifier.setSensitivity('sensitive');
      classifier.addUtterance('Tell me more about that.');
      const result = await classifier.classify(twoSignalAI());
      expect(result.action).toBe('SURFACE');
    });
  });

  describe('classify — strength prefix mapping', () => {
    it('maps 2 signals to ~ light', async () => {
      classifier.addUtterance('conversation');
      const result = await classifier.classify(twoSignalAI());
      expect(result.prefix).toBe('~');
      expect(result.strength).toBe('light');
    });

    it('maps 3 signals to ~~ medium', async () => {
      classifier.addUtterance('conversation');
      const result = await classifier.classify(threeSignalAI());
      expect(result.prefix).toBe('~~');
      expect(result.strength).toBe('medium');
    });

    it('maps 4+ signals to ~~~ strong', async () => {
      classifier.addUtterance('conversation');
      const result = await classifier.classify(fourSignalAI());
      expect(result.prefix).toBe('~~~');
      expect(result.strength).toBe('strong');
    });
  });

  describe('classify — error handling', () => {
    it('returns SILENT on malformed AI response', async () => {
      classifier.addUtterance('something');
      const result = await classifier.classify(async () => 'not json at all');
      expect(result.action).toBe('SILENT');
      expect(result.reasoning).toBe('classification error');
    });

    it('returns SILENT on invalid action field', async () => {
      classifier.addUtterance('something');
      const result = await classifier.classify(async () => JSON.stringify({ action: 'INVALID', signals: [] }));
      expect(result.action).toBe('SILENT');
      expect(result.reasoning).toBe('invalid classification');
    });
  });

  describe('isDuplicate — bigram similarity', () => {
    it('detects exact duplicates', () => {
      classifier.recordInsight('deflection detected on timeline question');
      expect(classifier.isDuplicate('deflection detected on timeline question')).toBe(true);
    });

    it('detects near-duplicates above threshold', () => {
      classifier.recordInsight('deflection detected on timeline question');
      expect(classifier.isDuplicate('deflection detected on the timeline question')).toBe(true);
    });

    it('allows sufficiently different insights', () => {
      classifier.recordInsight('deflection detected on timeline question');
      expect(classifier.isDuplicate('overcompensation with repeated honestly')).toBe(false);
    });

    it('is case-insensitive', () => {
      classifier.recordInsight('Deflection Detected On Timeline');
      expect(classifier.isDuplicate('deflection detected on timeline')).toBe(true);
    });
  });

  describe('buildInsightText', () => {
    it('uses suggestedMove when available', () => {
      const classification: SignalClassification = {
        action: 'SURFACE',
        strength: 'light',
        prefix: '~',
        signals: [
          { type: 'deflection', description: 'dodged it', timestamp: Date.now() },
          { type: 'cognitive_load', description: 'long pause', timestamp: Date.now() },
        ],
        reasoning: 'test',
        suggestedMove: 'Ask again differently',
      };
      expect(classifier.buildInsightText(classification)).toBe('~ Ask again differently');
    });

    it('falls back to signal descriptions', () => {
      const classification: SignalClassification = {
        action: 'SURFACE',
        strength: 'medium',
        prefix: '~~',
        signals: [
          { type: 'deflection', description: 'dodged it', timestamp: Date.now() },
          { type: 'cognitive_load', description: 'long pause', timestamp: Date.now() },
        ],
        reasoning: 'test',
      };
      expect(classifier.buildInsightText(classification)).toBe('~~ dodged it + long pause');
    });

    it('returns empty string for SILENT', () => {
      const classification: SignalClassification = {
        action: 'SILENT',
        strength: 'none',
        prefix: '',
        signals: [],
        reasoning: 'test',
      };
      expect(classifier.buildInsightText(classification)).toBe('');
    });
  });

  describe('conversation buffer management', () => {
    it('trims buffer to max entries', () => {
      for (let i = 0; i < 30; i++) {
        classifier.addUtterance(`utterance ${i}`);
      }
      const recent = classifier.getRecentConversation(25);
      expect(recent).toContain('utterance 29');
      expect(recent).not.toContain('utterance 0');
    });
  });
});
