# Negotiator

**Real-time behavioral signal detection for MentraOS smart glasses.**

*We don't detect lies. We detect when something doesn't add up.*

Negotiator is a [NeuroverseOS](https://github.com/NeuroverseOS) app for [MentraOS](https://github.com/anthropics/mentra) smart glasses that surfaces behavioral signals during conversations and negotiations. It reads the gap between what people say and how they say it — not to accuse, but to help the wearer ask sharper questions and make better decisions.

## License

This project is licensed under the [Apache License 2.0](LICENSE).

## What It Does

Negotiator monitors conversations in real time and detects five behavioral signal types:

| Signal | What It Means | Example |
|---|---|---|
| **Inconsistency** | Story details change across tellings, timelines shift | "Earlier they said Tuesday, now it's Thursday" |
| **Cognitive Load** | Unusual pauses on simple questions, overly complex explanations | "Long pause on a simple question — constructing or remembering?" |
| **Deflection** | Answering a different question than was asked | "They answered a question you didn't ask" |
| **Emotional Mismatch** | Tone doesn't match content | "Words say excited, tone says flat" |
| **Overcompensation** | Unprompted "honestly," repeating points, over-justifying | "'Honestly' appeared three times unprompted" |

Signals are displayed on the glasses HUD using a punctuation-based prefix system:

- `~` — Something to notice (light)
- `~~` — Worth exploring (medium)
- `~~~` — Slow down, multiple things don't line up (strong)

## How It Works

### Operating Modes

**Proactive mode** continuously monitors conversation. After 3+ seconds of silence following speech, it analyzes the recent exchange and surfaces signals when 2+ distinct patterns appear (or 3+ in conservative mode). Insights are limited to 15 words for glance readability.

**On-demand mode** is triggered by tapping the glasses or saying "negotiate" / "read the room." It provides deeper analysis (up to 50 words) with suggested negotiation moves drawn from techniques by Chris Voss, Robert Cialdini, and Daniel Kahneman.

**Follow-up mode** activates when the user taps again within 30 seconds, providing tactical advice based on the previous analysis without reclassifying.

### Sensitivity Levels

| Level | Threshold | Camera | Best For |
|---|---|---|---|
| **Conservative** | 3+ strong signals | Off | Fewer interruptions, high confidence |
| **Standard** (default) | 2+ signals | Off | Balanced, most users |
| **Sensitive** | 2+ signals (including weaker) | On | Experienced negotiators, max awareness |

### AI Integration

Negotiator uses a BYO-Key (Bring Your Own Key) model — users provide their own API key for either Anthropic (Claude) or OpenAI (GPT). The app defaults to small, fast models (Claude Haiku 4.5, GPT-4o Mini) for low-latency HUD display. No API keys are stored by the app; all AI calls are governed through MentraOS compliance checks.

### Adaptive Feedback Loop

The app learns from user behavior over time:

- **Follow-through** — If you tap after a proactive signal, it counts as useful
- **Dismissal** — If you long-press to dismiss, it counts as a false positive
- **Effectiveness tracking** — Learns which signal types you find useful per session
- **Trust score** — An invisible score (0-100) adjusts app behavior based on your feedback, controlling gate transitions from ACTIVE to DEGRADED to SUSPENDED to REVOKED

## Architecture

```
src/
  server.ts                              # Main app server (MentraOS AppServer)
  signal-classifier.ts                   # Signal detection engine
  worlds/
    negotiator-app.nv-world.md           # App-level governance rules
    behavioral-signals.nv-world.md       # Behavioral analysis framework
mentra.app.json                          # MentraOS app manifest
app_config.json                          # User-facing settings schema
Dockerfile                               # Multi-stage container build
```

**`server.ts`** — The main application server. Extends `AppServer` from the MentraOS SDK. Manages per-user session state, orchestrates AI calls, handles proactive/on-demand/follow-up modes, integrates the three-tier governance system, and tracks the adaptive feedback loop.

**`signal-classifier.ts`** — The signal detection engine. Buffers conversation utterances, classifies behavioral patterns using AI, enforces governance rules in code (single-signal suppression, no camera-only confidence), deduplicates insights using bigram similarity, and formats output with strength prefixes.

## Governance

Negotiator has the strictest governance of any NeuroverseOS app. The power to analyze someone's behavior in real time demands it.

### Understanding Governance Files

NeuroverseOS uses **governance files** — structured Markdown documents with the `.nv-world.md` extension — to define the rules, boundaries, and behavioral constraints that apps must follow. These aren't just documentation; they're machine-readable specifications that the governance engine (`neuroverseos-governance`) evaluates at runtime.

Governance files use a consistent structure:

| Section | Purpose |
|---|---|
| **Thesis** | The philosophical foundation — why this governance exists |
| **Invariants** | Rules that can never be violated, regardless of context |
| **State** | Variables the governance engine tracks at runtime |
| **Assumptions** (Profiles) | Named configuration presets with different parameter values |
| **Rules** | Conditional logic that modifies state when triggered |
| **Gates** | Threshold-based access levels that enable or restrict functionality |
| **Outcomes** | Observable metrics the governance system exposes |

This structure makes governance both human-readable (anyone can open the file and understand the rules) and machine-executable (the governance engine parses and enforces them).

### How Negotiator Uses Governance

Negotiator loads governance from three layers (highest priority wins):

1. **User Rules** — Personal, cross-app preferences (the user is always king)
2. **Platform World** — `mentraos-smartglasses.nv-world.md` from the [`neuroverseos-governance`](https://github.com/NeuroverseOS/neuroverseos-governance) package, enforcing hardware and session safety
3. **App World** — `negotiator-app.nv-world.md` (in this repo), defining Negotiator-specific behavioral rules

#### App-Level Governance: `negotiator-app.nv-world.md`

This is the core governance file for Negotiator. It defines:

**8 Immutable Invariants:**

| Invariant | What It Enforces |
|---|---|
| `signals_not_truth` | Never present signals as truth claims — patterns, not proof |
| `no_single_signal_escalation` | Single signals are always suppressed — everyone hesitates sometimes |
| `context_before_signal` | Consider language barriers, nervousness, anxiety before surfacing |
| `no_camera_confidence` | Camera signals can add weight but never initiate flags alone |
| `human_dignity_floor` | Respect the dignity of the person being analyzed — no "gotchas" |
| `bystander_analysis_consent` | Explicit acknowledgment required for analyzing non-consenting people |
| `no_diagnostic_labels` | Never diagnose anxiety, narcissism, etc. — patterns, not pathology |
| `ambient_never_persisted` | Speech buffer lives in RAM only — never written to disk |
| `signals_only_no_interpretation` | Always surface behavioral signals, never interpret emotional or symbolic meaning |

**State tracking** — `session_trust`, `signals_surfaced`, and `false_positive_dismissals` are tracked at runtime by the governance engine.

**Rules** — For example, Rule 002 degrades trust by 15% when a user dismisses more than 5 signals, recognizing the app is crying wolf.

**Gates** — Trust score thresholds control what the app can do:

| Gate | Trust Range | Behavior |
|---|---|---|
| ACTIVE | >= 70 | Full functionality, proactive signals, deep analysis |
| DEGRADED | 30-69 | Slower proactive signals, shorter responses |
| SUSPENDED | 11-29 | No proactive signals, minimal responses only |
| REVOKED | <= 10 | Nothing works |

#### Behavioral Framework: `behavioral-signals.nv-world.md`

This governance file defines the behavioral analysis philosophy. It uses the `philosophy` type (rather than `COMPLIANCE`) to provide the AI with a framework for reasoning rather than hard rules:

- **Principles** — Deep definitions of each signal type with `example_without` (wrong) and `example_with` (correct) framings
- **Voices** — Attributed reasoning styles (Chris Voss, Robert Cialdini, Daniel Kahneman) that shape how the AI communicates
- **Practices** — Negotiation techniques (labeling, calibrated questions, tactical silence, mirroring) the AI can suggest
- **Modes** — Five response modes (Direct, Translate, Reflect, Challenge, Teach) with distinct framings and behavior shaping rules
- **Boundaries** — Hard limits including prohibitions on analyzing vulnerable populations and clinical labeling

### Three-Tier Runtime Enforcement

Governance isn't just rules on paper. The server enforces it at three levels:

1. **Intent-level** — `MentraGovernedExecutor` checks whether an action is even allowed before execution
2. **Content-level** — `evaluateGuard()` performs kernel boundary checking on inputs (prompt injection, API key leaks) and outputs (system prompt leaks, safety violations)
3. **Behavioral-level** — The signal classifier enforces `no_single_signal_escalation` and `no_camera_confidence` directly in code, as a fail-safe even if AI classification returns wrong results

## Safety Design

- **No truth claims** — Every output is framed as a pattern, never an accusation
- **No single-signal alerts** — One hesitation is human; the app stays silent
- **Context-first** — Nervousness, language barriers, cultural differences are considered before any signal surfaces
- **Ephemeral by design** — The ambient buffer is RAM-only, never persisted to disk
- **No surveillance framing** — The goal is better negotiation, not catching people
- **Clinical referrals** — If the user exhibits paranoid patterns or describes abuse/coercion, the app suggests professional help

## Getting Started

### Prerequisites

- Node.js >= 20
- A MentraOS-compatible smart glasses device
- An API key from [Anthropic](https://console.anthropic.com/) or [OpenAI](https://platform.openai.com/)

### Development

```bash
npm install
npm run dev
```

### Production

```bash
npm start
```

### Docker

```bash
docker build -t negotiator .
docker run -p 3002:3002 negotiator
```

The container runs as an unprivileged user (`negotiator`, uid 1001) and includes a health check on port 3002.

## Configuration

User-facing settings are defined in `app_config.json` and presented through the MentraOS settings UI:

| Setting | Type | Default | Description |
|---|---|---|---|
| `sensitivity` | Select | `standard` | Signal detection sensitivity level |
| `camera_signals` | Toggle | Off | Use camera to add signal weight (never primary) |
| `ai_api_key` | Secret | — | Your Anthropic or OpenAI API key |
| `ai_provider` | Select | `anthropic` | AI provider (Anthropic or OpenAI) |
| `ai_model` | Select | `auto` | Model selection (auto selects fast models) |
| `ambient_context` | Toggle | Off | Enable ambient conversation listening |
| `ambient_bystander_ack` | Toggle | Off | Acknowledge analysis of non-consenting people |
| `ambient_buffer_duration` | Select | 120s | How long ambient speech is kept in RAM |

## App Manifest

The `mentra.app.json` file declares Negotiator's identity and requirements to the MentraOS platform:

- **Permissions**: Microphone (voice input and "negotiate" trigger) and Display (HUD output)
- **Hardware**: Display required
- **AI Declaration**: Uses AI, opt-in only, user-provided keys, no data retention, three-tier governance enforcement
