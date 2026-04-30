# Smart Card Disposal Logger

A single-page web app for fast, in-browser logging of smart-card serial numbers from a webcam feed. The detector waits for a still, sharp white card, snaps automatically, sends the frame to a vision model via [OpenRouter](https://openrouter.ai), and adds the parsed serial to a downloadable list. Optimized for stack-and-peel throughput — running through ~100 cards as fast as you can flip them.

Fully client-side. No backend, no database, no login. Runs from `npm run dev` or any static host.

## Features

- Live webcam capture with camera-source picker
- Auto-capture state machine (white-card / motion / sharpness signals at ~10fps)
- ROI overlay with color-coded state (idle / detected / ready)
- OpenRouter vision OCR with PNG payload, JSON response parsing, and 429/5xx retry
- Configurable serial format: 8-pair hex, decimal, either, or custom regex
- Confidence threshold — low-confidence reads are routed to the review tray
- Inline-editable captured table with duplicate highlighting
- Review tray with thumbnails, edit fields, J/K nav, Enter/D shortcuts
- WebAudio feedback (click on snap, rising chord on good read, low buzz on bad read or duplicate)
- CSV download (RFC 4180) and TSV clipboard copy
- All state persisted to `localStorage`

## Setup

```bash
git clone https://github.com/benjaminellison/SmartCardIDAutoCapture.git
cd SmartCardIDAutoCapture
npm install
cp .env.example .env.local
```

Open `.env.local` and paste your OpenRouter key:

```
VITE_OPENROUTER_API_KEY=sk-or-v1-...
VITE_OPENROUTER_MODEL=google/gemini-2.5-flash-lite
```

`.env.local` is gitignored. Anything prefixed `VITE_` is bundled into the browser JS, so use a key restricted to a small set of cheap or free vision models on OpenRouter.

## Run

```bash
npm run dev      # local dev server, opens browser
npm run build    # type-check + produce dist/
npm run preview  # serve the production build
```

Grant camera access on first load. If you have multiple webcams, pick the one you want from the dropdown.

## Usage

Hold a stack of cards in front of the camera, back of the top card facing the lens. The detector watches the central ROI for a still, sharp white surface — when those conditions hold for the configured stability window, it snaps and sends the frame to the model. Peel the top card off; that motion re-arms the detector for the next card.

Reads that pass the format regex *and* meet the confidence floor go straight into the captured table. Anything else lands in the review tray below — physically set those cards aside into a "needs review" pile and clean up at the end via the tray's confirm/discard buttons.

### Status indicator

The giant banner above the video shows the current pipeline state:

- `WAITING FOR CARD` — idle / no card detected
- `STEADY…` — white card detected but moving or out of focus
- `OCR…` — frame sent, awaiting model response
- `ADDED ✓` — valid serial added to the table
- `REVIEW ⚠` — invalid format, low confidence, or duplicate; sent to review tray
- `OCR ERROR` — provider error after retries

### Keyboard shortcuts

| Key | Action |
|-----|--------|
| `Space` | Force-capture the current frame |
| `U` | Undo the last capture |
| `J` / `K` | Next / previous review item |
| `Enter` | Confirm focused review item (move to captured) |
| `D` | Discard focused review item |
| `Esc` | Close settings / collapse review tray |

### Tuning the auto-capture detector

The live metrics line under the video shows the four signals the detector watches:

```
bright 152 cvar 18 motion 3 sharp 95 · state CARD_STILL
```

Each value is **green** when it passes its threshold, **red** when it fails. **All four green simultaneously for the configured stability window = snap.** Open Settings to adjust:

- `White brightness` — mean ROI brightness must be above this. Lower if cards aren't being detected (typical office lighting often needs 130–150).
- `Color variance (max)` — RGB-channel spread must be below this. Raise if your webcam has a tint (try 40–60).
- `Motion delta (max)` — frame-to-frame pixel diff must be below this. Raise slightly if you can't hold steady enough.
- `Sharpness (min)` — Laplacian variance must be above this.
- `Stability window (ms)` — all four signals must hold for this long before triggering. Bump to 800–1000ms if you see the detector firing before autofocus settles.

The console logs `OCR ###ms conf=... fullSharp=... type=... serial=...` for every capture. Compare `fullSharp` (full-resolution sharpness on the actual frame sent) to the live `sharp` (downsampled detector value) — if `fullSharp` is consistently low while `sharp` reads high, your camera's autofocus is hunting and you should lengthen the stability window.

### Serial format

Pick the format on the Settings dialog:

- **Hex (8 pairs)** — `12 34 AB CD 56 78 EF 90`
- **Decimal** — digits only, six or more characters
- **Either** — accepts either of the above
- **Custom regex** — provide a JS regex and a one-line prompt hint that tells the model what to look for

The prompt sent to the model is built from the chosen format so the model knows whether to expect hex or numeric output.

### Model selection

Set `VITE_OPENROUTER_MODEL` in `.env.local`, or override at runtime in the Settings dialog. Free models on OpenRouter share aggressive upstream rate limits — fine for casual testing but you'll hit walls running 100 cards in a session. Cheap paid VLMs (Gemini 2.5 Flash Lite, Claude Haiku 4.5) cost cents per session and are dramatically more reliable. Image-editing models like Sourceful Riverflow won't work — they don't return text.

## Stack

- Vanilla TypeScript + Vite. No framework, no UI library.
- Single `src/app.ts`, one CSS file, native `<dialog>` for the settings panel.
- WebAudio API for tones (no asset files).
- `localStorage` key `scdl:state:v1` for persistence.

## Privacy

The webcam stream stays in the browser. Captured frames are sent to OpenRouter only when you trigger an OCR call — and only the parsed text is saved to localStorage; image data is held in memory or as base64 thumbnails for the review tray. Nothing is uploaded to a server you control. Clearing localStorage wipes everything.
