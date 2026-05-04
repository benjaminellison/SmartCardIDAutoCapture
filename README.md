# Smart Card Disposal Logger

A single-page web app for fast, in-browser logging of U.S. Department of State PKI smart-card information from a webcam feed. The detector waits for a still, sharp white card, snaps automatically, sends the frame to a vision model via [OpenRouter](https://openrouter.ai), and adds the parsed fields (description, version, serial) to a downloadable list. Optimized for stack-and-peel throughput — running through ~100 cards as fast as you can flip them.

Fully client-side. No backend, no database, no login. Runs from `npm run dev` or any static host.

## Features

- Live webcam capture with camera-source picker, pause/resume, and Show/Hide for the API key
- Auto-capture state machine (white-card / motion / sharpness signals at ~10fps)
- ROI overlay with color-coded state (idle / detected / ready)
- One-click **Tune to current** button writes detector thresholds from the live readings
- Card-type aware OCR — recognizes 5 known card types and applies per-type formatting rules
- Editable OCR prompt in Settings (with Reset to default)
- Confidence threshold — low-confidence reads are routed to the review tray for human review
- Inline-editable captured table (description, version, serial) with duplicate highlighting
- Review tray with thumbnails, edit fields, J/K nav, Enter/D shortcuts
- WebAudio feedback (click on snap, rising chord on good read, low buzz on bad read or duplicate)
- CSV download (RFC 4180) and TSV clipboard copy
- All state persisted to `localStorage`; old rows auto-migrate when the schema expands

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

Reads where the model successfully classifies the card type *and* the serial passes that type's format check *and* the model's confidence meets the floor go straight into the captured table. Anything else lands in the review tray below — physically set those cards aside into a "needs review" pile and clean up at the end via the tray's confirm/discard buttons.

### Status indicator

The giant banner above the video shows the current pipeline state:

- `WAITING FOR CARD` — idle / no card detected
- `STEADY…` — white card detected but moving or out of focus
- `OCR…` — frame sent, awaiting model response
- `ADDED ✓` — valid serial added to the table
- `REVIEW ⚠` — invalid format, low confidence, unrecognized card type, or duplicate; sent to review tray
- `OCR ERROR` — provider error after retries
- `PAUSED` — camera off; click Resume to continue

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

Each value is **green** when it passes its threshold, **red** when it fails. **All four green simultaneously for the configured stability window = snap.**

**Quickest path:** put a representative card in the frame, hold steady, and click the **Tune to current** button next to the metrics line. It snapshots the readings into the four threshold sliders with sensible margins so this same view passes plus a bit of slack. Stability window is left alone (it's time-based).

To tune manually in Settings:

- `White brightness` — mean ROI brightness must be above this. Lower if cards aren't being detected (typical office lighting often needs 130–150).
- `Color variance (max)` — RGB-channel spread must be below this. Raise if your webcam has a tint (try 40–60).
- `Motion delta (max)` — frame-to-frame pixel diff must be below this. Raise slightly if you can't hold steady enough.
- `Sharpness (min)` — Laplacian variance must be above this.
- `Stability window (ms)` — all four signals must hold for this long before triggering. Bump to 800–1000ms if you see the detector firing before autofocus settles.

The console logs `OCR ###ms conf=... fullSharp=... cardType=... desc=... ver=... serial=...` for every capture. Compare `fullSharp` (full-resolution sharpness on the actual frame sent) to the live `sharp` (downsampled detector value) — if `fullSharp` is consistently low while `sharp` reads high, your camera's autofocus is hunting and you should lengthen the stability window.

## Recognized card types

The OCR prompt describes 5 known card types and tells the model exactly how to extract description / version / serial for each. Per-type validators reject malformed serials and route them to the review tray.

| Type ID | Description | Version | Serial format |
|---|---|---|---|
| `gd-fips-201-sce-v7` | `G+D FIPS 201 SCE` | `7.0` | 6–10 alphanumeric chars |
| `gd-fips-201-sce-v3-2` | `G+D FIPS 201 SCE` or `G&D FIPS 201 SCE` (preserve `&` vs `+`) | `3.2` | TWO serials joined by ` / ` (long-with-dashes first, short second) |
| `safenet-sc650` | `SafeNet AT SC650` (older may omit "AT") | `v4.2k`, `v4.1`, older `v2.01` | 20 hex digits with dashes preserved (`XXXX-XXXX-XXXX-XXXX-XXXX`) |
| `gemalto-idprime-md` | `Gemalto IDPrime MD` (the "Gemalto" prefix must be preserved) | `RevB` if printed; `1.0` otherwise | 16 hex chars as 8 byte pairs separated by single spaces, uppercase |
| `idemia-id-one-piv` | `ID-One PIV ... from IDEMIA` | e.g. `2.4` | hyphenated alphanumeric (the `P/N` is **not** the serial) |

Anything that doesn't match a known type is classified `unknown` and routed to the review tray for manual handling.

### Editing the prompt

The full prompt with all per-type rules and warnings (don't drop "Gemalto", ignore the hashed-out line below the real text on older SafeNet, P/N is not the serial, etc.) is editable in **Settings → OCR → Prompt**. Tweak it to handle a new card type, correct a recurring misread, or shorten it for a different model. Click **Reset prompt** to restore the bundled default.

The prompt is part of every OCR request, so changes take effect immediately on the next capture.

### Model selection

Set `VITE_OPENROUTER_MODEL` in `.env.local`, or override at runtime in the Settings dialog. Free models on OpenRouter share aggressive upstream rate limits and are gated by the OpenRouter account-level data policy — fine for casual testing but you'll hit walls running 100 cards in a session. Cheap paid VLMs (Gemini 2.5 Flash Lite, Claude Haiku 4.5) cost cents per session and are dramatically more reliable. Image-editing models like Sourceful Riverflow won't work — they don't return text.

## Stack

- Vanilla TypeScript + Vite. No framework, no UI library.
- Single `src/app.ts`, one CSS file, native `<dialog>` for the settings panel.
- WebAudio API for tones (no asset files).
- `localStorage` key `scdl:state:v1` for persistence; schema migrations are handled in `loadState`.

## Privacy

The webcam stream stays in the browser. Captured frames are sent to OpenRouter only when you trigger an OCR call — and only the parsed text is saved to localStorage; image data is held in memory or as base64 thumbnails for the review tray. Nothing is uploaded to a server you control. Clearing localStorage wipes everything.
