\# Smart Card Disposal Logger — Plan



A single-page web app that uses a webcam to capture the back of smart cards, extracts the card type and serial number via a vision model, and builds a downloadable list. Optimized for high throughput: running through a stack of \~100 cards as fast as the user can flip them.



This document captures the agreed-on design from the planning conversation. Delete it once the app is built.



\## Goals \& non-goals



\*\*Goals\*\*

\- Run a stack of \~100 cards quickly; bottleneck = hand speed, not software.

\- Immediate, unambiguous audio feedback on every capture (good vs. bad read).

\- Fully client-side; ephemeral session; no backend, no DB.

\- Cheap to operate (free or near-free OpenRouter model).



\*\*Non-goals\*\*

\- No login, no multi-user, no server-side storage.

\- No mobile layout (target: desktop with attached webcam).

\- Card images are not exported — only the parsed text. Thumbnails are kept in memory / localStorage for the review tray only.



\## Stack



\- \*\*Vanilla TypeScript + Vite.\*\* No React, no Tailwind, no shadcn — overkill for this UI.

\- Single `index.html`, one `app.ts`, one small CSS file.

\- One runtime concern: `fetch` to OpenRouter. No Tesseract (see "OCR strategy").

\- Deploys as static files; runs from any static host or `file://`.



\## Core flow (stack-and-peel)



1\. User holds a stack of cards up to the webcam, back of the top card facing the lens.

2\. App detects: white card present + still + sharp → \*\*snap\*\* (click tone).

3\. Captured frame goes to OpenRouter vision model → `{card\\\_type, serial, confidence}`.

4\. \~1s later: \*\*rising chord = good read\*\* (added to table) OR \*\*low buzz = bad read\*\* (added to on-screen review tray with thumbnail).

5\. User peels the top card off the stack — that motion re-arms the detector.

6\. Next card settles → snap → repeat.

7\. On bad read, user physically sets that card aside into a "needs review" pile, then continues. Cleanup happens at the end via the review tray.



\## Auto-capture state machine



Detector runs at \~10fps on a 160×120 grayscale downscale of the video frame. Two signals computed per frame:



\- \*\*White-card presence\*\*: mean brightness of central ROI above threshold AND low color variance.

\- \*\*Frame-diff\*\*: pixel delta vs. previous frame. High = motion; low = still.

\- \*\*Sharpness\*\*: Laplacian variance of the central ROI, to gate against autofocus blur.



States:



```

NO\\\_CARD       — central ROI not white-ish. Idle.

\&#x20;                 ↓ (white card appears)

CARD\\\_MOVING   — white card present but frame-diff high or sharpness low.

\&#x20;                 ↓ (still + sharp for 400ms)

CARD\\\_STILL    — snap! play click tone, send to OCR, transition to COOLDOWN.

\&#x20;                 ↓

COOLDOWN      — ignore frames until motion is seen again (peel).

\&#x20;                 ↓ (motion detected)

\&#x20;               back to NO\\\_CARD or CARD\\\_MOVING based on white-card signal.

```



Tunables (all in one config object):

\- Stability window: 400ms

\- Sharpness threshold (Laplacian variance)

\- White threshold (mean brightness, color variance)

\- Frame-diff threshold



Manual override: \*\*Spacebar\*\* force-captures the current frame regardless of state.



\## OCR strategy



\- \*\*Vision model via OpenRouter only.\*\* Skip Tesseract — small etched text on smart cards is unreliable for it, and running both serially adds latency.

\- Send the \*\*whole captured frame\*\* as a base64 PNG (no pre-cropping; modern VLMs handle the layout fine).

\- Structured output schema: `{card\\\_type: string, serial: string, confidence: number}`.

\- \*\*Validate the serial\*\* against `^(\\\[0-9A-F]{2} ){7}\\\[0-9A-F]{2}$` after uppercasing and normalizing whitespace (collapse multiple spaces/tabs to single spaces).

\- If serial matches AND confidence is reasonable → \*\*good read\*\* (add to table).

\- Otherwise → \*\*bad read\*\* (add to review tray with thumbnail + raw model output + editable fields).



\### Model selection



\- The user will create an OpenRouter API key restricted (server-side on OpenRouter) to a subset of cheap/free vision models.

\- The app passes a single model name in the request body. Provide an editable model field in settings (defaults to a known cheap vision model like `google/gemini-2.5-flash`); user can change it without code changes.

\- No in-app model dropdown.



\### Latency / throughput



\- OCR call blocks re-arming the detector. Don't pipeline. The user needs the verdict before peeling so they can correctly route the card to the "good" or "review" pile.

\- Target: <1.5s per card end-to-end (snap → verdict tone). For 100 cards that's \~2.5min of OCR latency total; acceptable.

\- Per-card latency + confidence logged to console so the user can compare models on the first 5–10 cards.



\## Audio feedback



\- \*\*Click tone\*\* the instant a frame is captured ("saw it").

\- \*\*Rising chord\*\* \~1s later on good read.

\- \*\*Low buzz\*\* \~1s later on bad read.

\- All synthesized via WebAudio (no asset files). Pre-create oscillators and reuse.

\- Mute toggle in settings.



\## UI



```

+------------------------------------------------------------+

| Smart Card Disposal Logger    \\\[⚙ Settings]  \\\[How to use ▾] |

+------------------------------------------------------------+

| STATUS: WAITING FOR CARD                                   |

| +------------------------+  Captured (12)                  |

| |                        |  Type            Serial    ⋯  |

| |   \\\[live webcam feed]   |  Gemalto IDPrime 79 01 .. ✎ ✕|

| |                        |  Gemalto IDPrime AB 02 .. ✎ ✕|

| |   ROI guide overlay    |  ...                           |

| +------------------------+                                 |

| Camera: \\\[USB Webcam ▾]   Auto-capture: \\\[ON]  \\\[Snap ⎵]     |

+------------------------------------------------------------+

| Needs review (3)  \\\[expand ▾]                               |

|  \\\[thumb] type:\\\[\\\_\\\_\\\_\\\_] serial:\\\[\\\_\\\_\\\_\\\_]  \\\[Confirm] \\\[Discard]   |

+------------------------------------------------------------+

| \\\[Download CSV]  \\\[Copy to clipboard]  \\\[Clear all]           |

+------------------------------------------------------------+

```



\- \*\*Giant status indicator\*\* above the video, readable across the desk: `WAITING` / `STEADY` / `OCR…` / `ADDED ✓` / `REVIEW ⚠`.

\- \*\*One-line hint\*\* under the video updates with the current state.

\- \*\*Collapsible "How to use" panel\*\* at the top with stack-and-peel instructions, key bindings, and a note about granting camera access.

\- \*\*Empty state\*\* if camera permission is denied: clear message + retry button.

\- \*\*Camera selector\*\* dropdown (prominent — `facingMode: 'environment'` is a no-op on desktop).

\- \*\*Settings panel\*\*: API key (paste once, stored in localStorage), model name, mute, threshold tuning sliders, "test capture" button.



\## Captured list



\- Live table; columns: Card Type, Serial Number, actions (✎ edit, ✕ delete).

\- Inline editing of either field.

\- \*\*Duplicate detection\*\*: if the same serial is added twice, highlight both rows amber + low buzz on add. Still added; user resolves at end.

\- Persisted to `localStorage` after every change.



\## Review tray



\- Bottom of page, collapsible. Shows count badge.

\- Each entry: thumbnail of the captured frame + raw model output + editable Type/Serial fields + Confirm / Discard buttons.

\- Keyboard within the tray: `J/K` next/prev, `Enter` confirm, `D` discard.

\- Persisted to localStorage along with the thumbnail (as data URL).



\## Keyboard shortcuts (global)



\- \*\*Space\*\* — force capture current frame

\- \*\*U\*\* — undo last add (removes most recent row from the captured list)

\- \*\*Esc\*\* — close settings / collapse review tray



\## Export



\- \*\*Download CSV\*\*: `smart-cards-YYYY-MM-DD-HHMM.csv`, header `card\\\_type,serial\\\_number`, RFC 4180 quoting.

\- \*\*Copy to clipboard\*\*: same content, TSV-friendly so it pastes cleanly into Excel/Sheets.

\- \*\*Clear all\*\*: wipes both the captured list and the review tray (with confirm).



\## Persistence



Single `localStorage` key (e.g. `scdl:state:v1`) holding:

```ts

{

\&#x20; captured: { id, cardType, serial, addedAt }\\\[],

\&#x20; review:   { id, thumbnailDataUrl, rawText, cardType, serial, capturedAt }\\\[],

\&#x20; settings: { apiKey, model, muted, thresholds }

}

```



API key stored in localStorage with a clear note that it lives only on this machine.



\## Build order



1\. \*\*Skeleton\*\* — Vite scaffold, camera feed + camera selector, manual spacebar capture, captured table with edit/delete, CSV export + copy, localStorage persistence. Verify on the user's hardware.

2\. \*\*OpenRouter integration\*\* — settings panel, API key + model fields, vision call with structured output, serial regex validation, good/bad routing, click + chord + buzz tones.

3\. \*\*Auto-capture\*\* — state machine with white-card / motion / sharpness signals, ROI overlay, threshold tuning sliders.

4\. \*\*Review tray\*\* — thumbnails, inline edit, confirm/discard, keyboard nav, duplicate detection, undo.



\## Out of scope



\- Saving or exporting card images.

\- Mobile layout.

\- Server-side anything.

\- Pre-cropping regions for OCR (the VLM handles layout).

