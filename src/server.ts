#!/usr/bin/env npx tsx
/**
 * Negotiator — A MentraOS App
 *
 * Real-time behavioral signal detection for smart glasses.
 * "We don't detect lies. We detect when something doesn't add up."
 *
 * Architecture:
 *   - Proactive-first: signals surface automatically during conversation
 *   - User taps for on-demand analysis or follow-up
 *   - Camera optional: adds signal weight but never initiates flags
 *   - Sensitivity setting: conservative / standard / sensitive
 *
 * Signal Display (monochrome green, punctuation system):
 *   ~    light — "something to notice"
 *   ~~   medium — "worth exploring"
 *   ~~~  strong — "slow down, multiple things don't line up"
 *
 * Governance: strictest of any NeuroverseOS app.
 *   - No truth claims about other people
 *   - No single-signal escalation
 *   - Context before signal
 *   - Camera never primary
 *   - Human dignity floor
 *
 * BYO-Key Model: same as Lenses.
 */

import { AppServer } from '@mentra/sdk';
import type { AppSession, TranscriptionData } from '@mentra/sdk';

import {
  MentraGovernedExecutor,
  DEFAULT_USER_RULES,
} from 'neuroverseos-governance/adapters/mentraos';
import type { AppContext } from 'neuroverseos-governance/adapters/mentraos';
import { evaluateGuard } from 'neuroverseos-governance/engine/guard-engine';
import { simulateWorld } from 'neuroverseos-governance/engine/simulate-engine';
import type { GuardEvent, WorldDefinition } from 'neuroverseos-governance/types';
import { parseWorldMarkdown } from 'neuroverseos-governance/engine/bootstrap-parser';
import { emitWorldDefinition } from 'neuroverseos-governance/engine/bootstrap-emitter';

import {
  SignalClassifier,
  type Sensitivity,
  type SignalClassification,
} from './signal-classifier.js';

import {
  type GovernanceGate,
  type GovernanceState,
  type NegotiatorJournal,
  type SignalRecord,
  EMPTY_JOURNAL,
  WORDS_GLANCE,
  WORDS_DEPTH,
  WORDS_FOLLOWUP,
  CLASSIFY_DELAY_MS,
  trustToGate,
  gateAdjustments,
  followThroughRate,
  bestSignalType,
} from './governance.js';

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ─── Constants ───────────────────────────────────────────────────────────────

const APP_ID = 'com.neuroverse.negotiator';
const DEFAULT_AMBIENT_BUFFER_SECONDS = 120;
const MAX_AMBIENT_TOKENS_ESTIMATE = 700;

const FOLLOW_UP_WINDOW_MS = 30_000;
const RECENCY_BOOST_SECONDS = 15;

const MIN_CLASSIFY_WORDS = 8;

/** Pattern to detect help request */
const HELP_PATTERN = /^(?:help|show\s+me\s+commands|how\s+does\s+this\s+work)\b/i;

/** Pattern to detect new conversation / reset */
const RESET_PATTERN = /\b(?:new\s+(?:conversation|chat|call|meeting)|reset|start\s+over|clear)\b/i;

/** Pattern to detect "negotiating with [person]" for profile lookup */
const NEGOTIATING_WITH_PATTERN = /\b(?:negotiating\s+with|meeting\s+with|talking\s+to|call\s+with)\s+(\w+)\b/i;

/** Trigger word for on-demand analysis */
const NEGOTIATE_TRIGGER = /\b(?:negotiate|read\s+(?:the\s+)?room|what\s+do\s+you\s+see)\b/i;

const AI_MODELS: Record<string, { provider: 'openai' | 'anthropic'; model: string }> = {
  'auto': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'claude-haiku-4-5-20251001': { provider: 'anthropic', model: 'claude-haiku-4-5-20251001' },
  'gpt-4o-mini': { provider: 'openai', model: 'gpt-4o-mini' },
};

// ─── AI Provider ─────────────────────────────────────────────────────────────

interface AIProvider { name: 'openai' | 'anthropic'; apiKey: string; model: string; }

async function callUserAI(
  provider: AIProvider, systemPrompt: string,
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  userMessage: string, maxWords: number,
): Promise<{ text: string; tokensUsed?: number }> {
  const maxTokens = Math.max(50, maxWords * 3);
  const allMessages = [...messages, { role: 'user' as const, content: userMessage }];

  if (provider.name === 'anthropic') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: provider.apiKey });
    const response = await client.messages.create({ model: provider.model, max_tokens: maxTokens, system: systemPrompt, messages: allMessages });
    const textBlock = response.content.find(b => b.type === 'text');
    return { text: textBlock?.text ?? '', tokensUsed: response.usage.input_tokens + response.usage.output_tokens };
  }
  if (provider.name === 'openai') {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: provider.apiKey });
    const response = await client.chat.completions.create({ model: provider.model, max_tokens: maxTokens, messages: [{ role: 'system' as const, content: systemPrompt }, ...allMessages] });
    return { text: response.choices[0]?.message?.content ?? '', tokensUsed: response.usage?.total_tokens };
  }
  throw new Error(`Unsupported provider: ${provider.name}`);
}

// ─── Governance ──────────────────────────────────────────────────────────────

function loadPlatformWorld() {
  const govRoot = resolve(require.resolve('neuroverseos-governance/package.json'), '..');
  const worldPath = resolve(govRoot, 'src/worlds/mentraos-smartglasses.nv-world.md');
  const worldMd = readFileSync(worldPath, 'utf-8');
  const parseResult = parseWorldMarkdown(worldMd);
  if (!parseResult.world || parseResult.issues.some(i => i.severity === 'error')) {
    throw new Error('Failed to load platform governance world');
  }
  return emitWorldDefinition(parseResult.world).world;
}

function loadAppWorld(): WorldDefinition | null {
  try {
    const worldPath = resolve(__dirname, 'worlds/negotiator-app.nv-world.md');
    const worldMd = readFileSync(worldPath, 'utf-8');
    const parseResult = parseWorldMarkdown(worldMd);
    if (parseResult.world && !parseResult.issues.some(i => i.severity === 'error')) {
      return emitWorldDefinition(parseResult.world).world;
    }
  } catch { /* optional */ }
  return null;
}

function loadBehavioralWorld(): string {
  try {
    const worldPath = resolve(__dirname, 'worlds/behavioral-signals.nv-world.md');
    return readFileSync(worldPath, 'utf-8');
  } catch (err) {
    console.error('[Negotiator] Failed to load behavioral world:', err instanceof Error ? err.message : err);
    // Minimal fallback — app still functions but with generic prompt
    return '# Thesis\nDetect behavioral signals in conversation. Surface when something doesn\'t add up.\n';
  }
}

// ─── Content Governance (kernel boundary checking) ───────────────────────────
// This is the REAL governance showcase: checking actual user speech and AI
// responses against the kernel's forbidden patterns (prompt injection,
// API key leaks, system prompt leaks).
//
// The MentraGovernedExecutor checks intents (can this action happen?).
// evaluateGuard() with contentFields checks CONTENT (is this text safe?).

/**
 * Check user input for prompt injection and other forbidden patterns.
 * Returns true if the content is safe, false if it should be blocked.
 */
function checkInputContent(text: string, world: WorldDefinition): { safe: boolean; reason?: string } {
  const event: GuardEvent = {
    intent: 'user_input_content',
    direction: 'input',
    contentFields: {
      customer_input: text,
      raw: text,
    },
  };

  const verdict = evaluateGuard(event, world, { level: 'standard' });

  if (verdict.status === 'BLOCK') {
    console.log(`[Negotiator] INPUT BLOCKED by kernel: ${verdict.reason}`);
    return { safe: false, reason: verdict.reason };
  }
  return { safe: true };
}

/**
 * Check AI output for API key leaks, system prompt leaks, and other
 * forbidden output patterns before displaying to the user.
 */
function checkOutputContent(text: string, world: WorldDefinition): { safe: boolean; reason?: string } {
  const event: GuardEvent = {
    intent: 'ai_output_content',
    direction: 'output',
    contentFields: {
      draft_reply: text,
      raw: text,
    },
  };

  const verdict = evaluateGuard(event, world, { level: 'standard' });

  if (verdict.status === 'BLOCK') {
    console.log(`[Negotiator] OUTPUT BLOCKED by kernel: ${verdict.reason}`);
    return { safe: false, reason: verdict.reason };
  }
  return { safe: true };
}

// ─── Governance State Bridge (invisible to user) ─────────────────────────────
// The user never sees trust scores, gate names, or governance warnings.
// They just feel it: responses get shorter or richer, proactive gets
// quieter or more confident. Like a good assistant who reads the room.
//
// How it works:
//   1. After each action, feed metrics into simulateWorld()
//   2. The rule engine computes session_trust based on world file rules
//   3. Gate classification determines behavior adjustments
//   4. Adjustments are invisible — no UI, just behavioral changes

/**
 * Evaluate the current governance state by feeding app metrics into
 * the world's rule engine. Returns the new trust score and gate.
 */
function evaluateGovernanceState(
  world: WorldDefinition | null,
  metrics: NegotiatorSession['metrics'],
  currentTrust: number,
): GovernanceState {
  if (!world) return { sessionTrust: currentTrust, gate: 'ACTIVE' };

  try {
    const result = simulateWorld(world, {
      stateOverrides: {
        session_trust: currentTrust,
        ai_calls_made: metrics.aiCalls,
        signals_surfaced: metrics.signalsSurfaced,
        false_positive_dismissals: metrics.dismissals,
        governance_blocks: metrics.governanceBlocks,
      },
    });

    const newTrust = (result.finalState.session_trust as number) ?? currentTrust;
    return { sessionTrust: newTrust, gate: trustToGate(newTrust) };
  } catch {
    return { sessionTrust: currentTrust, gate: currentTrust >= 70 ? 'ACTIVE' : 'DEGRADED' };
  }
}

function buildNegotiatorPrompt(maxWords: number): string {
  const worldContent = loadBehavioralWorld();
  // Extract the key sections for the system prompt
  return `## Negotiator
"We don't detect lies. We detect when something doesn't add up."

${worldContent.split('# Tone')[0]}

## Constraints
You are responding through smart glasses during a live conversation.
Keep responses under ${maxWords} words. Start with the ~ prefix matching signal strength.
Be conversational. No bullet points. No markdown. No emojis.
No "I detected..." — just give the insight and the move.
One sentence. Make it count.`;
}

// ─── Ambient Buffer (same pattern as Lenses) ─────────────────────────────────

interface AmbientEntry { text: string; timestamp: number; }
interface AmbientBuffer { enabled: boolean; bystanderAcknowledged: boolean; entries: AmbientEntry[]; maxBufferSeconds: number; maxTokensPerCall: number; sends: number; }

function purgeExpiredAmbient(buffer: AmbientBuffer): void {
  const cutoff = Date.now() - (buffer.maxBufferSeconds * 1000);
  buffer.entries = buffer.entries.filter(e => e.timestamp >= cutoff);
}

function getAmbientContext(buffer: AmbientBuffer): string {
  purgeExpiredAmbient(buffer);
  if (buffer.entries.length === 0) return '';
  const now = Date.now();
  const recentCutoff = now - (RECENCY_BOOST_SECONDS * 1000);
  const recent = buffer.entries.filter(e => e.timestamp >= recentCutoff);
  const older = buffer.entries.filter(e => e.timestamp < recentCutoff);
  const maxWords = Math.floor(buffer.maxTokensPerCall * 0.75);
  const build = (entries: AmbientEntry[], budget: number) => {
    const parts: string[] = []; let wc = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const w = entries[i].text.split(/\s+/);
      if (wc + w.length > budget) break;
      parts.unshift(entries[i].text); wc += w.length;
    }
    return parts.join(' ');
  };
  return [build(older, Math.floor(maxWords * 0.25)), build(recent, Math.floor(maxWords * 0.75))].filter(Boolean).join(' ');
}

// ─── Journal (SimpleStorage) ─────────────────────────────────────────────────
// Persists across sessions. Tracks signal effectiveness over time.
// The feedback loop: signal → user acted (follow-up/redirect) or didn't (dismiss/ignore)

async function loadJournal(session: AppSession): Promise<NegotiatorJournal> {
  try {
    const stored = await session.storage.get('journal');
    if (stored) return stored as NegotiatorJournal;
  } catch { /* first session */ }
  return { ...EMPTY_JOURNAL };
}

async function saveJournal(session: AppSession, journal: NegotiatorJournal): Promise<void> {
  try {
    await session.storage.set('journal', journal);
  } catch (err) {
    console.warn('[Negotiator] Failed to save journal:', err instanceof Error ? err.message : err);
  }
}

// ─── Session State ───────────────────────────────────────────────────────────

interface NegotiatorSession {
  aiProvider: AIProvider | null;
  executor: MentraGovernedExecutor;
  appContext: AppContext;
  classifier: SignalClassifier;
  classifyTimer: ReturnType<typeof setTimeout> | null;
  ambientBuffer: AmbientBuffer;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastSignalTime: number;
  lastSignalText: string;
  transcriptionBuffer: string[];
  appSession: AppSession;
  journal: NegotiatorJournal;
  /** Governance state — trust score and gate (invisible to user) */
  governance: GovernanceState;
  /** Whether the last insight was proactive (for follow-through tracking) */
  lastWasProactive: boolean;
  /** Signal types from the last proactive insight (for effectiveness tracking) */
  lastSignalTypes: string[];
  outputMode: 'display' | 'audio' | 'both';
  /** Current person being negotiated with (if identified) */
  currentProfile: string | null;
  knownContacts: Array<{ full: string; first: string }>;
  metrics: { activations: number; aiCalls: number; signalsSurfaced: number; followThroughs: number; dismissals: number; governanceBlocks: number; ambientSends: number; sessionStart: number; };
}

const sessions = new Map<string, NegotiatorSession>();

// ─── Output Helper ───────────────────────────────────────────────────────────
// Delivers insights via display, audio, or both based on user preference
// and hardware capabilities.

async function deliver(session: AppSession, text: string, mode: 'display' | 'audio' | 'both'): Promise<void> {
  const caps = session.capabilities;
  const canDisplay = caps?.hasDisplay ?? false;
  const canSpeak = caps?.hasSpeaker ?? false;

  if ((mode === 'display' || mode === 'both') && canDisplay) {
    session.layouts.showTextWall(text);
  }
  if ((mode === 'audio' || mode === 'both') && canSpeak) {
    // Fire and forget — don't await audio to avoid blocking/timeout
    session.audio.speak(text).catch((err) => {
      console.warn('[Negotiator] Audio speak failed:', err instanceof Error ? err.message : err);
    });
  }
  // Fallback: if user chose display but no display, try audio (fire and forget)
  if (mode === 'display' && !canDisplay && canSpeak) {
    session.audio.speak(text).catch(() => {});
  }
  // Fallback: if user chose audio but no speaker, try display
  if (mode === 'audio' && !canSpeak && canDisplay) {
    session.layouts.showTextWall(text);
  }
}

// ─── The App ─────────────────────────────────────────────────────────────────

class NegotiatorApp extends AppServer {
  private platformWorld = loadPlatformWorld();
  private appWorld = loadAppWorld();

  protected async onSession(session: AppSession, sessionId: string, userId: string): Promise<void> {
    const aiApiKey = session.settings.get<string>('ai_api_key', '');
    const aiProviderSetting = session.settings.get<string>('ai_provider', '');
    const aiModelSetting = session.settings.get<string>('ai_model', 'auto');
    const sensitivity = session.settings.get<string>('sensitivity', 'standard') as Sensitivity;
    const cameraEnabled = session.settings.get<boolean>('camera_signals', false);
    const ambientEnabled = session.settings.get<boolean>('ambient_context', false);
    const ambientBystanderAck = session.settings.get<boolean>('ambient_bystander_ack', false);
    const ambientBufferSeconds = session.settings.get<number>('ambient_buffer_duration', DEFAULT_AMBIENT_BUFFER_SECONDS);
    const outputMode = session.settings.get<string>('output_mode', 'display') as 'display' | 'audio' | 'both';
    const contactsRaw = session.settings.get<string>('contacts', '');
    const knownContacts: Array<{ full: string; first: string }> = contactsRaw
      .split(',')
      .map(n => n.trim())
      .filter(n => n.length > 0)
      .map(n => ({ full: n.toLowerCase(), first: n.split(/\s+/)[0].toLowerCase() }));

    let aiProvider: AIProvider | null = null;
    if (aiApiKey) {
      const mc = AI_MODELS[aiModelSetting] ?? AI_MODELS['auto'];
      aiProvider = { name: aiProviderSetting === 'openai' ? 'openai' : mc.provider, apiKey: aiApiKey, model: mc.model };
    }

    const appContext: AppContext = { appId: APP_ID, aiProviderDeclared: true, declaredAIProviders: ['openai', 'anthropic'], dataRetentionOptedIn: false, aiDataTypesSent: 0, glassesModel: undefined };
    const executor = new MentraGovernedExecutor(this.platformWorld, {
      onBlock: (r) => console.log(`[Negotiator] BLOCKED: ${r.verdict.reason}`),
      onPause: (r) => console.log(`[Negotiator] CONFIRM: ${r.verdict.reason}`),
    }, DEFAULT_USER_RULES);

    const journal = await loadJournal(session);

    const state: NegotiatorSession = {
      aiProvider, executor, appContext,
      classifier: new SignalClassifier(sensitivity, cameraEnabled),
      classifyTimer: null,
      ambientBuffer: { enabled: ambientEnabled, bystanderAcknowledged: ambientBystanderAck, entries: [], maxBufferSeconds: ambientBufferSeconds, maxTokensPerCall: MAX_AMBIENT_TOKENS_ESTIMATE, sends: 0 },
      conversationHistory: [],
      lastSignalTime: 0, lastSignalText: '',
      transcriptionBuffer: [],
      appSession: session,
      journal,
      governance: { sessionTrust: 100, gate: 'ACTIVE' },
      lastWasProactive: false,
      lastSignalTypes: [],
      outputMode,
      currentProfile: null,
      knownContacts,
      metrics: { activations: 0, aiCalls: 0, signalsSurfaced: 0, followThroughs: 0, dismissals: 0, governanceBlocks: 0, ambientSends: 0, sessionStart: Date.now() },
    };
    sessions.set(sessionId, state);

    if (!aiProvider) {
      deliver(session, 'Negotiator: Add your AI API key in Settings.', outputMode).catch(() => {});
      return;
    }

    const displayCheck = state.executor.evaluate('display_response', state.appContext);
    if (displayCheck.allowed) {
      deliver(session, `Negotiator active. ${sensitivity} sensitivity.`, outputMode).catch(() => {});
    }

    // ── Touch Events (side panel) ──────────────────────────────────────
    // Single tap = on-demand analysis or follow-up
    // Double tap = dismiss a bad signal
    session.events.onTouchEvent((data) => {
      const s = sessions.get(sessionId);
      if (!s || !s.aiProvider) return;

      const gesture = data.gesture ?? data.type ?? '';

      // Single tap or forward swipe = analyze / follow-up
      if (gesture === 'single_tap' || gesture === 'forward_swipe' || gesture === 'tap') {
        const now = Date.now();
        const inWindow = s.lastSignalTime > 0 && (now - s.lastSignalTime) < FOLLOW_UP_WINDOW_MS;

        // ── Follow-through tracking ────────────────────────────────────
        if (inWindow && s.lastWasProactive) {
          s.metrics.followThroughs++;
          s.journal.totalFollowThroughs++;
          for (const type of s.lastSignalTypes) {
            const eff = s.journal.signalEffectiveness[type] ?? { surfaced: 0, acted: 0, dismissed: 0 };
            eff.acted++;
            s.journal.signalEffectiveness[type] = eff;
          }
          s.journal.recentSignals.push(...s.lastSignalTypes.map(t => ({ type: t, acted: true, dismissed: false })));
          s.lastWasProactive = false;
        }

        if (inWindow) {
          this.followUp(s, session, sessionId);
        } else {
          this.onDemandAnalysis(s, session, sessionId);
        }
      }

      // Double tap or backward swipe = dismiss
      if (gesture === 'double_tap' || gesture === 'backward_swipe') {
        if (s.lastWasProactive) {
          for (const type of s.lastSignalTypes) {
            const eff = s.journal.signalEffectiveness[type] ?? { surfaced: 0, acted: 0, dismissed: 0 };
            eff.dismissed++;
            s.journal.signalEffectiveness[type] = eff;
          }
          s.journal.recentSignals.push(...s.lastSignalTypes.map(t => ({ type: t, acted: false, dismissed: true })));
          s.lastWasProactive = false;
        }
        this.dismiss(s, session);
      }
    });

    // ── Transcription Events ─────────────────────────────────────────────
    session.events.onTranscription(async (data: TranscriptionData) => {
      const s = sessions.get(sessionId);
      if (!s || !s.aiProvider) return;
      if (!data.text || data.text.trim().length === 0) return;
      if (!data.isFinal) return;

      const userText = data.text.trim();

      // Ambient buffer
      if (s.ambientBuffer.enabled && s.ambientBuffer.bystanderAcknowledged) {
        s.ambientBuffer.entries.push({ text: userText, timestamp: Date.now() });
        purgeExpiredAmbient(s.ambientBuffer);
      }

      // ── Help command ────────────────────────────────────────────────────
      if (HELP_PATTERN.test(userText)) {
        const helpSteps = [
          'Tap to read the room. Signals appear automatically.',
          'Tap again within 30s for a deeper tactical read.',
          'Long press to dismiss a bad signal.',
          'Say "new call" to reset between conversations. Settings on your phone for sensitivity + API key.',
        ];
        const step = s.metrics.activations % helpSteps.length;
        const displayCheck = s.executor.evaluate('display_response', s.appContext);
        if (displayCheck.allowed) await deliver(session, helpSteps[step], s.outputMode);
        return;
      }

      // ── Reset / new conversation ───────────────────────────────────────
      if (RESET_PATTERN.test(userText)) {
        s.conversationHistory = [];
        s.ambientBuffer.entries = [];
        s.classifier.destroy();
        s.lastSignalTime = 0;
        s.lastSignalText = '';
        s.lastWasProactive = false;
        s.lastSignalTypes = [];
        s.currentProfile = null;
        const displayCheck = s.executor.evaluate('display_response', s.appContext);
        if (displayCheck.allowed) {
          await deliver(session, 'New conversation. Listening.', s.outputMode);
        }
        return;
      }

      // ── Profile detection ─────────────────────────────────────────────
      // Check if user is responding to a "Which [name]?" clarification
      if (!s.currentProfile && s.knownContacts.length > 0) {
        const clarificationMatch = s.knownContacts.find(c => userText.toLowerCase().includes(c.full));
        if (clarificationMatch && s.conversationHistory.some(h => h.content.includes('Which '))) {
          await this.activateProfile(clarificationMatch.full, s, session);
          return;
        }
      }

      // Check explicit trigger: "meeting with John", "talking to Sarah"
      const profileMatch = NEGOTIATING_WITH_PATTERN.exec(userText);
      if (profileMatch) {
        await this.activateProfile(profileMatch[1], s, session);
        return;
      }

      // Auto-detect known contacts mentioned in conversation
      if (!s.currentProfile && s.knownContacts.length > 0) {
        const lower = userText.toLowerCase();

        // First try full name match (most specific)
        const fullMatch = s.knownContacts.find(c => lower.includes(c.full));
        if (fullMatch) {
          await this.activateProfile(fullMatch.full, s, session);
        } else {
          // Try first name — but check for ambiguity
          const firstMatches = s.knownContacts.filter(c => lower.includes(c.first));
          if (firstMatches.length === 1) {
            await this.activateProfile(firstMatches[0].full, s, session);
          } else if (firstMatches.length > 1) {
            // Ambiguous — ask for clarification
            const options = firstMatches.map(c => c.full).join(', ');
            deliver(session, `Which ${firstMatches[0].first}? ${options}`, s.outputMode).catch(() => {});
          }
        }
      }

      // Voice trigger
      if (NEGOTIATE_TRIGGER.test(userText)) {
        await this.onDemandAnalysis(s, session, sessionId);
        return;
      }

      // Proactive classification — every utterance, after a pause
      if (s.ambientBuffer.enabled) {
        s.classifier.addUtterance(userText);

        if (s.classifyTimer) clearTimeout(s.classifyTimer);

        const wordCount = userText.split(/\s+/).length;
        if (wordCount >= MIN_CLASSIFY_WORDS) {
          // Classify delay adjusts with governance gate (degraded = slower)
          const delay = gateAdjustments(s.governance.gate).classifyDelayMs;
          if (delay === Infinity) return; // Gate says no proactive

          s.classifyTimer = setTimeout(() => {
            if (!sessions.has(sessionId)) return;
            this.proactiveClassify(s, session, sessionId);
          }, delay);
        }
      }
    });
  }

  // ── Proactive Signal Classification ────────────────────────────────────

  private async proactiveClassify(s: NegotiatorSession, session: AppSession, sessionId: string): Promise<void> {
    if (!s.aiProvider) return;

    // ── Governance gate check (invisible) ────────────────────────────
    // Re-evaluate trust based on current metrics. Adjust behavior silently.
    s.governance = evaluateGovernanceState(this.appWorld, s.metrics, s.governance.sessionTrust);
    const adjustments = gateAdjustments(s.governance.gate);

    // If gate says no proactive, stop silently
    if (!adjustments.proactiveEnabled) return;

    // Governance: both AI calls go through the guard
    const classifyCheck = s.executor.evaluate('ai_send_transcription', s.appContext);
    if (!classifyCheck.allowed) { s.metrics.governanceBlocks++; return; }
    const ambientCheck = s.executor.evaluate('ai_send_ambient', s.appContext);
    if (!ambientCheck.allowed) { s.metrics.governanceBlocks++; return; }

    s.metrics.aiCalls++;

    const classification = await s.classifier.classify(
      async (systemPrompt, userMessage) => {
        const response = await callUserAI(s.aiProvider!, systemPrompt, [], userMessage, 100);
        return response.text;
      },
    );

    if (classification.action === 'SILENT') return;

    // Build the insight text
    const insightText = s.classifier.buildInsightText(classification);
    if (!insightText || s.classifier.isDuplicate(insightText)) return;

    // Generate the full negotiation insight using the behavioral world
    const systemPrompt = buildNegotiatorPrompt(WORDS_GLANCE);
    const signalContext = classification.signals.map(sig => `${sig.type}: ${sig.description}`).join('. ');

    // Governance: second AI call also goes through the guard
    const insightPermCheck = s.executor.evaluate('ai_send_transcription', s.appContext);
    if (!insightPermCheck.allowed) { s.metrics.governanceBlocks++; return; }

    s.metrics.aiCalls++;

    try {
      const response = await callUserAI(
        s.aiProvider!,
        systemPrompt,
        s.conversationHistory.slice(-4),
        `[SIGNALS DETECTED: ${signalContext}. Suggested move: ${classification.suggestedMove ?? 'clarify'}. Give the user a ${classification.prefix} prefixed negotiation insight.]`,
        WORDS_GLANCE,
      );

      if (response.text) {
        // ── Kernel: check proactive output for leaks ──────────────────
        if (this.appWorld) {
          const outputCheck = checkOutputContent(response.text, this.appWorld);
          if (!outputCheck.safe) {
            console.log(`[Negotiator] Proactive output blocked: ${outputCheck.reason}`);
            return;
          }
        }

        // Ensure the prefix is present
        let display = response.text;
        if (!display.startsWith('~')) {
          display = `${classification.prefix} ${display}`;
        }

        const displayCheck = s.executor.evaluate('display_response', s.appContext);
        if (displayCheck.allowed) {
          await deliver(session, display, s.outputMode);
        }

        s.classifier.recordInsight(display);

        // Update dashboard with follow-through rate
        const dur = Math.round((Date.now() - s.metrics.sessionStart) / 60000);
        const ftRate = followThroughRate(s.journal);
        const cost = (s.metrics.aiCalls * 0.001).toFixed(3);
        const signalCount = s.metrics.signalsSurfaced + 1;
        session.dashboard.content.writeToMain(`${signalCount} signals (~$${cost}) · ${ftRate}% led to action · ${dur}m`);

        s.conversationHistory.push(
          { role: 'user', content: `[Proactive signal: ${signalContext}]` },
          { role: 'assistant', content: display },
        );
        if (s.conversationHistory.length > 6) s.conversationHistory = s.conversationHistory.slice(-6);

        s.lastSignalTime = Date.now();
        s.lastSignalText = display;
        s.lastWasProactive = true;
        s.lastSignalTypes = classification.signals.map(sig => sig.type);
        s.metrics.signalsSurfaced++;

        // Record signal surfaced in effectiveness tracking
        for (const sig of classification.signals) {
          const eff = s.journal.signalEffectiveness[sig.type] ?? { surfaced: 0, acted: 0, dismissed: 0 };
          eff.surfaced++;
          s.journal.signalEffectiveness[sig.type] = eff;
        }
      }
    } catch (err) {
      console.error(`[Negotiator] AI call failed:`, err instanceof Error ? err.message : err);
    }
  }

  // ── On-Demand Analysis (user taps or says "negotiate") ─────────────────

  private async onDemandAnalysis(s: NegotiatorSession, session: AppSession, sessionId: string): Promise<void> {
    s.metrics.activations++;

    // Re-evaluate governance (invisible to user)
    s.governance = evaluateGovernanceState(this.appWorld, s.metrics, s.governance.sessionTrust);
    const adjustments = gateAdjustments(s.governance.gate);

    // REVOKED = nothing works. User still tapped, so give them a brief note.
    if (adjustments.maxWords === 0) return;

    const ambientText = s.ambientBuffer.enabled && s.ambientBuffer.bystanderAcknowledged
      ? getAmbientContext(s.ambientBuffer)
      : '';

    // Word limit adjusts with gate — degraded sessions get shorter responses
    const systemPrompt = buildNegotiatorPrompt(adjustments.maxWords);

    const permCheck = s.executor.evaluate('ai_send_transcription', s.appContext);
    if (!permCheck.allowed) { s.metrics.governanceBlocks++; return; }

    s.metrics.aiCalls++;

    // Inject profile context if we know who the user is talking to
    const profileContext = s.currentProfile
      ? `[Context: The user is in a conversation with ${s.currentProfile}. Use any prior signal history to inform your analysis.] `
      : '';

    const userMessage = ambientText
      ? `${profileContext}[The user tapped for a negotiation read. Here's the recent conversation — analyze for behavioral signals and give a tactical insight.]\n${ambientText}`
      : s.conversationHistory.length > 0
        ? `${profileContext}[The user tapped for a negotiation read. Analyze the conversation so far.]`
        : '[First activation. Give a brief negotiation principle to keep in mind.]';

    // ── Kernel: check user input for prompt injection ────────────────
    if (this.appWorld && ambientText) {
      const inputCheck = checkInputContent(ambientText, this.appWorld);
      if (!inputCheck.safe) {
        console.log(`[Negotiator] Input blocked: ${inputCheck.reason}`);
        s.metrics.governanceBlocks++;
        return;
      }
    }

    try {
      const response = await callUserAI(s.aiProvider!, systemPrompt, s.conversationHistory.slice(-4), userMessage, WORDS_DEPTH);
      if (response.text) {
        // ── Kernel: check AI output for leaks before display ──────────
        if (this.appWorld) {
          const outputCheck = checkOutputContent(response.text, this.appWorld);
          if (!outputCheck.safe) {
            console.log(`[Negotiator] Output blocked: ${outputCheck.reason}`);
            return; // Don't display unsafe output
          }
        }

        const displayCheck = s.executor.evaluate('display_response', s.appContext);
        if (displayCheck.allowed) await deliver(session, response.text, s.outputMode);

        s.conversationHistory.push({ role: 'user', content: userMessage }, { role: 'assistant', content: response.text });
        if (s.conversationHistory.length > 6) s.conversationHistory = s.conversationHistory.slice(-6);
        s.lastSignalTime = Date.now();
        s.lastSignalText = response.text;
      }
    } catch (err) {
      const errCheck = s.executor.evaluate('display_response', s.appContext);
      if (errCheck.allowed) await deliver(session, 'Something went wrong. Try again.', s.outputMode);
    }
  }

  // ── Follow-Up ──────────────────────────────────────────────────────────

  private async followUp(s: NegotiatorSession, session: AppSession, sessionId: string): Promise<void> {
    s.metrics.activations++;

    const systemPrompt = buildNegotiatorPrompt(WORDS_FOLLOWUP);
    const permCheck = s.executor.evaluate('ai_send_transcription', s.appContext);
    if (!permCheck.allowed) { s.metrics.governanceBlocks++; return; }

    s.metrics.aiCalls++;

    try {
      const response = await callUserAI(
        s.aiProvider!,
        systemPrompt,
        s.conversationHistory.slice(-4),
        '[The user tapped again — they want a deeper read or a specific negotiation move. What should they do or say next?]',
        WORDS_FOLLOWUP,
      );
      if (response.text) {
        // Kernel: check follow-up output for leaks before display
        if (this.appWorld) {
          const outputCheck = checkOutputContent(response.text, this.appWorld);
          if (!outputCheck.safe) return;
        }

        const displayCheck = s.executor.evaluate('display_response', s.appContext);
        if (displayCheck.allowed) await deliver(session, response.text, s.outputMode);
        s.conversationHistory.push({ role: 'user', content: '[follow-up]' }, { role: 'assistant', content: response.text });
        if (s.conversationHistory.length > 6) s.conversationHistory = s.conversationHistory.slice(-6);
        s.lastSignalTime = Date.now();
      }
    } catch (err) {
      const errCheck = s.executor.evaluate('display_response', s.appContext);
      if (errCheck.allowed) await deliver(session, 'Something went wrong. Try again.', s.outputMode);
    }
  }

  // ── Profile Activation ──────────────────────────────────────────────

  private async activateProfile(name: string, s: NegotiatorSession, session: AppSession): Promise<void> {
    const cleanName = name.trim().toLowerCase();
    s.currentProfile = cleanName;

    const profileKey = `profile_${cleanName}`;
    const pastData = await session.simpleStorage.get(profileKey);
    let context = `Now tracking: ${cleanName}.`;
    if (pastData) {
      try {
        const history = JSON.parse(pastData);
        const totalSignals = history.signals ?? 0;
        const topPattern = history.topPattern ?? null;
        if (totalSignals > 0) {
          context = `${cleanName} — ${totalSignals} signals from past sessions.`;
          if (topPattern) context += ` Most common: ${topPattern}.`;
        }
      } catch { /* first time */ }
    }

    deliver(session, context, s.outputMode).catch(() => {});
    console.log(`[Negotiator] Profile activated: ${cleanName}`);
  }

  // ── Dismiss ────────────────────────────────────────────────────────────

  private async dismiss(s: NegotiatorSession, session: AppSession): Promise<void> {
    s.metrics.dismissals++;
    s.lastSignalTime = 0;

    // Governance: re-evaluate trust after dismiss (dismiss = signal quality feedback)
    s.governance = evaluateGovernanceState(this.appWorld, s.metrics, s.governance.sessionTrust);

    if (s.conversationHistory.length >= 2) s.conversationHistory = s.conversationHistory.slice(0, -2);
    s.conversationHistory.push(
      { role: 'user', content: '[Dismissed — that signal was wrong. Adjust sensitivity.]' },
      { role: 'assistant', content: 'Noted. Raising threshold.' },
    );
    const displayCheck = s.executor.evaluate('display_response', s.appContext);
    if (displayCheck.allowed) await deliver(session, 'Got it. Recalibrating.', s.outputMode);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────

  protected async onStop(sessionId: string, _userId: string, _reason: string): Promise<void> {
    const s = sessions.get(sessionId);
    if (s) {
      s.ambientBuffer.entries = [];
      if (s.classifyTimer) clearTimeout(s.classifyTimer);
      s.classifier.destroy();

      // Persist journal to SimpleStorage
      if (s.metrics.activations > 0 || s.metrics.signalsSurfaced > 0) {
        s.journal.totalSignals += s.metrics.signalsSurfaced;
        s.journal.totalDismissals += s.metrics.dismissals;
        s.journal.totalFollowThroughs += s.metrics.followThroughs;
        s.journal.totalSessions++;
        s.journal.lastSessionDate = new Date().toISOString().slice(0, 10);

        // Trim recent signals to last 50 (keep it under 100KB)
        if (s.journal.recentSignals.length > 50) {
          s.journal.recentSignals = s.journal.recentSignals.slice(-50);
        }

        await saveJournal(s.appSession, s.journal);
      }

      // Persist profile data if a person was identified this session
      if (s.currentProfile && s.metrics.signalsSurfaced > 0) {
        const profileKey = `profile_${s.currentProfile}`;
        try {
          const existing = await s.appSession.simpleStorage.get(profileKey);
          let profile = { signals: 0, sessions: 0, topPattern: null as string | null, patterns: {} as Record<string, number> };
          if (existing) {
            try { profile = JSON.parse(existing); } catch { /* corrupt, start fresh */ }
          }
          profile.signals += s.metrics.signalsSurfaced;
          profile.sessions += 1;

          // Track pattern frequency from this session's signal effectiveness
          for (const [type, stats] of Object.entries(s.journal.signalEffectiveness)) {
            profile.patterns[type] = (profile.patterns[type] ?? 0) + stats.surfaced;
          }

          // Find top pattern
          let maxCount = 0;
          for (const [type, count] of Object.entries(profile.patterns)) {
            if (count > maxCount) { maxCount = count; profile.topPattern = type; }
          }

          await s.appSession.simpleStorage.set(profileKey, JSON.stringify(profile));
          console.log(`[Negotiator] Saved profile for ${s.currentProfile}: ${profile.signals} total signals across ${profile.sessions} sessions`);
        } catch (err) {
          console.warn(`[Negotiator] Failed to save profile for ${s.currentProfile}:`, err instanceof Error ? err.message : err);
        }
      }

      const ftRate = followThroughRate(s.journal);
      const best = bestSignalType(s.journal);

      const d = Math.round((Date.now() - s.metrics.sessionStart) / 1000);
      console.log(`[Negotiator] Session ended after ${d}s — ${s.metrics.signalsSurfaced} signals, ${s.metrics.followThroughs} acted, ${s.metrics.dismissals} dismissed, ${ftRate}% follow-through${best ? `, best signal: ${best}` : ''}, ${s.metrics.aiCalls} AI calls`);
    }
    sessions.delete(sessionId);
  }
}

// ─── Start ───────────────────────────────────────────────────────────────────

const app = new NegotiatorApp({
  packageName: APP_ID,
  apiKey: process.env.MENTRA_APP_API_KEY ?? '',
  port: Number(process.env.PORT) || 3002,
});

const port = Number(process.env.PORT) || 3002;

await app.start();

// ─── Webview (phone UI) ──────────────────────────────────────────────────────

app.get('/webview', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Negotiator</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; padding: 20px; min-height: 100vh; }
    .header { text-align: center; padding: 30px 0 20px; }
    .header h1 { font-size: 24px; font-weight: 600; color: #fff; }
    .header p { font-size: 14px; color: #888; margin-top: 8px; font-style: italic; }
    .card { background: #1a1a1a; border-radius: 12px; padding: 20px; margin: 16px 0; border: 1px solid #2a2a2a; }
    .card h2 { font-size: 16px; color: #aaa; margin-bottom: 12px; text-transform: uppercase; letter-spacing: 1px; font-weight: 500; }
    .signal { display: flex; align-items: baseline; gap: 8px; margin: 8px 0; }
    .prefix { color: #4ade80; font-family: monospace; font-weight: bold; }
    .signal-name { color: #ccc; font-size: 14px; }
    .signal-desc { color: #888; font-size: 12px; }
    .controls { margin-top: 8px; }
    .controls p { color: #888; font-size: 13px; margin: 6px 0; }
    .controls strong { color: #ccc; }
    .status { text-align: center; padding: 20px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; background: #4ade80; border-radius: 50%; margin-right: 8px; }
    .status span { color: #4ade80; font-size: 14px; }
    .setup { background: #1a1a0a; border: 1px solid #4a4a00; border-radius: 12px; padding: 16px 20px; margin: 16px 0; }
    .setup h2 { font-size: 14px; color: #fbbf24; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
    .setup p { color: #aaa; font-size: 13px; line-height: 1.5; }
    .setup .steps { color: #ccc; font-size: 13px; margin-top: 8px; }
    .setup .steps strong { color: #fbbf24; }
    .footer { text-align: center; padding: 30px 0; color: #555; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Negotiator</h1>
    <p>"We don't detect lies. We detect when something doesn't add up."</p>
  </div>

  <div class="status">
    <span class="status-dot"></span><span>Active — listening for signals</span>
  </div>

  <div class="setup">
    <h2>Setup Required</h2>
    <p>Negotiator needs an AI API key to analyze conversations.</p>
    <div class="steps">
      <p><strong>1.</strong> Tap <strong style="background:#333;padding:4px 10px;border-radius:6px;border:1px solid #555;font-size:16px;">...</strong> at the top right of this screen</p>
      <p><strong>2.</strong> Go to <strong>Settings</strong></p>
      <p><strong>3.</strong> Enter your <strong>Anthropic</strong> or <strong>OpenAI</strong> API key</p>
      <p><strong>4.</strong> Choose your output mode (display, audio, or both)</p>
    </div>
  </div>

  <div class="card">
    <h2>Signal Types</h2>
    <div class="signal"><span class="prefix">~</span><span class="signal-name">Light</span><span class="signal-desc">— something to notice</span></div>
    <div class="signal"><span class="prefix">~~</span><span class="signal-name">Medium</span><span class="signal-desc">— worth exploring</span></div>
    <div class="signal"><span class="prefix">~~~</span><span class="signal-name">Strong</span><span class="signal-desc">— slow down, multiple things don't line up</span></div>
  </div>

  <div class="card">
    <h2>Controls</h2>
    <div class="controls">
      <p><strong>Tap side panel</strong> — get an on-demand analysis</p>
      <p><strong>Tap again within 30s</strong> — deeper tactical follow-up</p>
      <p><strong>Double tap side panel</strong> — dismiss a bad signal</p>
      <p><strong>Swipe forward</strong> — analyze (same as tap)</p>
      <p><strong>Swipe backward</strong> — dismiss (same as double tap)</p>
      <p><strong>Say "negotiate"</strong> — trigger analysis by voice</p>
      <p><strong>Say "new conversation"</strong> — reset for a new call</p>
    </div>
  </div>

  <div class="card">
    <h2>What It Detects</h2>
    <div class="controls">
      <p><strong>Inconsistency</strong> — details that change across tellings</p>
      <p><strong>Cognitive Load</strong> — unusual effort on simple questions</p>
      <p><strong>Deflection</strong> — answering a different question</p>
      <p><strong>Emotional Mismatch</strong> — tone doesn't match content</p>
      <p><strong>Overcompensation</strong> — excessive "honestly," repeating points</p>
    </div>
  </div>

  <div class="card">
    <h2>People Tracking</h2>
    <div class="controls">
      <p>Add names in <strong>Settings > People</strong> for auto-detection</p>
      <p>Or say <strong>"meeting with [name]"</strong> to track manually</p>
      <p>Signal history is saved per person across sessions</p>
      <p>Say <strong>"new conversation"</strong> to reset</p>
    </div>
  </div>

  <div class="footer">
    Negotiator by NeuroverseOS<br>
    Signals are patterns, not proof.
  </div>
</body>
</html>`);
});

Bun.serve({
  port,
  hostname: '0.0.0.0',
  fetch: app.fetch,
});

console.log(`[Negotiator] Running on port ${port}`);
