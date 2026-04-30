import './style.css';

// =====================================================================
// Types
// =====================================================================

type CapturedRow = {
  id: string;
  cardType: string;
  serial: string;
  addedAt: number;
};

type ReviewItem = {
  id: string;
  thumbnailDataUrl: string;
  rawText: string;
  cardType: string;
  serial: string;
  capturedAt: number;
};

type Thresholds = {
  whiteBrightness: number;
  whiteColorVariance: number;
  motionDelta: number;
  sharpnessMin: number;
  stabilityMs: number;
};

type SerialFormat = 'hex8' | 'decimal' | 'either' | 'custom';

type Settings = {
  selectedCameraId?: string;
  apiKey: string;
  model: string;
  muted: boolean;
  autoCapture: boolean;
  thresholds: Thresholds;
  serialFormat: SerialFormat;
  customSerialRegex: string;
  customSerialHint: string;
  minConfidence: number;
};

type State = {
  captured: CapturedRow[];
  review: ReviewItem[];
  settings: Settings;
};

type OcrResult = {
  cardType: string;
  serial: string;
  confidence?: number;
  raw: string;
};

// =====================================================================
// Constants
// =====================================================================

const STORAGE_KEY = 'scdl:state:v1';

const DEFAULT_THRESHOLDS: Thresholds = {
  whiteBrightness: 150,
  whiteColorVariance: 50,
  motionDelta: 6,
  sharpnessMin: 80,
  stabilityMs: 700
};

const DEFAULT_MODEL = 'baidu/qianfan-ocr-fast:free';
const DEFAULT_MIN_CONFIDENCE = 0.5;

const DETECTOR_W = 160;
const DETECTOR_H = 120;
const ROI_X = Math.floor(DETECTOR_W * 0.2);
const ROI_Y = Math.floor(DETECTOR_H * 0.2);
const ROI_W = Math.floor(DETECTOR_W * 0.6);
const ROI_H = Math.floor(DETECTOR_H * 0.6);
const DETECTOR_INTERVAL_MS = 100; // ~10fps

const HEX8_REGEX = /^([0-9A-F]{2} ){7}[0-9A-F]{2}$/;
const DECIMAL_REGEX = /^[0-9]{6,}$/;

const DEFAULT_HINT = 'Ready. Hold a card up or press Space to force a capture.';

// =====================================================================
// State
// =====================================================================

function defaultState(): State {
  return {
    captured: [],
    review: [],
    settings: {
      apiKey: import.meta.env.VITE_OPENROUTER_API_KEY ?? '',
      model: import.meta.env.VITE_OPENROUTER_MODEL ?? DEFAULT_MODEL,
      muted: false,
      autoCapture: true,
      thresholds: { ...DEFAULT_THRESHOLDS },
      serialFormat: 'hex8',
      customSerialRegex: '',
      customSerialHint: '',
      minConfidence: DEFAULT_MIN_CONFIDENCE
    }
  };
}

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as Partial<State>;
    const def = defaultState();
    return {
      captured: parsed.captured ?? [],
      review: parsed.review ?? [],
      settings: {
        ...def.settings,
        ...(parsed.settings ?? {}),
        apiKey: parsed.settings?.apiKey || def.settings.apiKey,
        model: parsed.settings?.model || def.settings.model,
        thresholds: {
          ...def.settings.thresholds,
          ...(parsed.settings?.thresholds ?? {})
        }
      }
    };
  } catch (err) {
    console.warn('Failed to load state', err);
    return defaultState();
  }
}

function saveState(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

let state: State = loadState();

// =====================================================================
// DOM refs
// =====================================================================

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const video = $<HTMLVideoElement>('video');
const cameraSelect = $<HTMLSelectElement>('cameraSelect');
const snapBtn = $<HTMLButtonElement>('snapBtn');
const autoCaptureToggle = $<HTMLInputElement>('autoCaptureToggle');
const statusEl = $<HTMLDivElement>('status');
const hintEl = $<HTMLParagraphElement>('hint');
const roiOverlay = $<HTMLDivElement>('roiOverlay');
const metricsInline = $<HTMLParagraphElement>('metricsInline');
const metricsRow = $<HTMLDivElement>('metricsRow');
const tuneBtn = $<HTMLButtonElement>('tuneBtn');
const capturedCount = $<HTMLSpanElement>('capturedCount');
const capturedTbody = $<HTMLTableSectionElement>('capturedTbody');
const emptyState = $<HTMLParagraphElement>('emptyState');
const downloadBtn = $<HTMLButtonElement>('downloadBtn');
const copyBtn = $<HTMLButtonElement>('copyBtn');
const clearBtn = $<HTMLButtonElement>('clearBtn');

const reviewSection = $<HTMLElement>('reviewSection');
const reviewBody = $<HTMLDivElement>('reviewBody');
const reviewCount = $<HTMLSpanElement>('reviewCount');
const toggleReviewBtn = $<HTMLButtonElement>('toggleReviewBtn');

const settingsBtn = $<HTMLButtonElement>('settingsBtn');
const settingsDialog = $<HTMLDialogElement>('settingsDialog');
const closeSettingsBtn = $<HTMLButtonElement>('closeSettingsBtn');
const doneSettingsBtn = $<HTMLButtonElement>('doneSettingsBtn');
const apiKeyInput = $<HTMLInputElement>('apiKeyInput');
const apiKeyToggleBtn = $<HTMLButtonElement>('apiKeyToggleBtn');
const modelInput = $<HTMLInputElement>('modelInput');
const mutedInput = $<HTMLInputElement>('mutedInput');
const autoCaptureSettingInput = $<HTMLInputElement>('autoCaptureSettingInput');
const testCaptureBtn = $<HTMLButtonElement>('testCaptureBtn');
const resetThresholdsBtn = $<HTMLButtonElement>('resetThresholdsBtn');
const liveMetrics = $<HTMLParagraphElement>('liveMetrics');
const serialFormatInput = $<HTMLSelectElement>('serialFormatInput');
const customSerialRegexInput = $<HTMLInputElement>('customSerialRegexInput');
const customSerialHintInput = $<HTMLInputElement>('customSerialHintInput');
const minConfidenceInput = $<HTMLInputElement>('minConfidenceInput');
const minConfidenceOut = $<HTMLOutputElement>('minConfidenceOut');

const thresholdInputs = {
  whiteBrightness: $<HTMLInputElement>('whiteBrightnessInput'),
  whiteColorVariance: $<HTMLInputElement>('whiteColorVarianceInput'),
  motionDelta: $<HTMLInputElement>('motionDeltaInput'),
  sharpnessMin: $<HTMLInputElement>('sharpnessMinInput'),
  stabilityMs: $<HTMLInputElement>('stabilityMsInput')
};

const thresholdOutputs = {
  whiteBrightness: $<HTMLOutputElement>('whiteBrightnessOut'),
  whiteColorVariance: $<HTMLOutputElement>('whiteColorVarianceOut'),
  motionDelta: $<HTMLOutputElement>('motionDeltaOut'),
  sharpnessMin: $<HTMLOutputElement>('sharpnessMinOut'),
  stabilityMs: $<HTMLOutputElement>('stabilityMsOut')
};

// =====================================================================
// Status indicator
// =====================================================================

type StatusKind = 'idle' | 'steady' | 'ocr' | 'added' | 'review' | 'error';

let flashTimer: number | undefined;

function setStatus(kind: StatusKind, text: string, hint?: string): void {
  statusEl.className = `status ${kind}`;
  statusEl.textContent = text;
  if (hint !== undefined) hintEl.textContent = hint;
}

function flashStatus(kind: StatusKind, text: string, hint?: string, duration = 1200): void {
  setStatus(kind, text, hint);
  if (flashTimer !== undefined) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    setStatus('idle', 'WAITING FOR CARD', DEFAULT_HINT);
  }, duration);
}

// =====================================================================
// Audio feedback
// =====================================================================

let audioCtx: AudioContext | null = null;

function getAudioCtx(): AudioContext | null {
  if (state.settings.muted) return null;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

function playTone(frequency: number, durationMs: number, type: OscillatorType = 'sine', peakGain = 0.18, attackMs = 8, startOffsetMs = 0) {
  const ctx = getAudioCtx();
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = frequency;
  const start = ctx.currentTime + startOffsetMs / 1000;
  const attack = start + attackMs / 1000;
  const end = start + durationMs / 1000;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(peakGain, attack);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain).connect(ctx.destination);
  osc.start(start);
  osc.stop(end + 0.01);
}

function playClick(): void {
  playTone(1200, 60, 'sine', 0.22);
}

function playGood(): void {
  // Rising chord: C5, E5, G5
  playTone(523.25, 180, 'sine', 0.16, 8, 0);
  playTone(659.25, 180, 'sine', 0.16, 8, 80);
  playTone(783.99, 240, 'sine', 0.16, 8, 160);
}

function playBuzz(): void {
  playTone(110, 380, 'sawtooth', 0.18, 10);
}

// =====================================================================
// Camera
// =====================================================================

let currentStream: MediaStream | null = null;

async function listCameras(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === 'videoinput');
}

async function startCamera(deviceId?: string): Promise<void> {
  if (currentStream) {
    currentStream.getTracks().forEach((t) => t.stop());
    currentStream = null;
  }
  const constraints: MediaStreamConstraints = {
    video: deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      : { width: { ideal: 1920 }, height: { ideal: 1080 } },
    audio: false
  };
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = currentStream;
}

async function initCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('error', 'CAMERA UNAVAILABLE', 'Your browser does not support getUserMedia.');
    return;
  }
  try {
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn('Camera permission denied', err);
    setStatus('error', 'CAMERA DENIED', 'Grant camera access and reload the page.');
    return;
  }

  const cameras = await listCameras();
  cameraSelect.innerHTML = '';
  cameras.forEach((cam, i) => {
    const opt = document.createElement('option');
    opt.value = cam.deviceId;
    opt.textContent = cam.label || `Camera ${i + 1}`;
    cameraSelect.appendChild(opt);
  });

  const remembered = state.settings.selectedCameraId;
  const preferred =
    remembered && cameras.some((c) => c.deviceId === remembered)
      ? remembered
      : cameras[0]?.deviceId;

  if (preferred) {
    cameraSelect.value = preferred;
    try {
      await startCamera(preferred);
      state.settings.selectedCameraId = preferred;
      saveState();
      setStatus('idle', 'WAITING FOR CARD', DEFAULT_HINT);
    } catch (err) {
      console.error('Failed to start camera', err);
      setStatus('error', 'CAMERA ERROR', 'Could not start the selected camera.');
    }
  } else {
    setStatus('error', 'NO CAMERA', 'No video input devices found.');
  }
}

cameraSelect.addEventListener('change', async () => {
  const id = cameraSelect.value;
  state.settings.selectedCameraId = id;
  saveState();
  try {
    await startCamera(id);
  } catch (err) {
    console.error(err);
    setStatus('error', 'CAMERA ERROR', 'Could not start the selected camera.');
  }
});

// =====================================================================
// Auto-capture detector
// =====================================================================

const detectorCanvas = document.createElement('canvas');
detectorCanvas.width = DETECTOR_W;
detectorCanvas.height = DETECTOR_H;
const detectorCtx = (() => {
  const c = detectorCanvas.getContext('2d', { willReadFrequently: true });
  if (!c) throw new Error('Failed to create detector canvas context');
  return c;
})();

let prevGray: Uint8ClampedArray | null = null;
let detectorState: 'NO_CARD' | 'CARD_MOVING' | 'COOLDOWN' = 'NO_CARD';
let stableSince = 0;
let lastDetectorTick = 0;
let captureInFlight = false;
let latestMetrics: Metrics | null = null;

type Metrics = { brightness: number; colorVariance: number; motion: number; sharpness: number };

function laplacianVariance(gray: Uint8ClampedArray, w: number, h: number): number {
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const v = -4 * gray[i] + gray[i - 1] + gray[i + 1] + gray[i - w] + gray[i + w];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function computeMetrics(): Metrics | null {
  if (video.videoWidth === 0 || video.videoHeight === 0) return null;
  detectorCtx.drawImage(video, 0, 0, DETECTOR_W, DETECTOR_H);
  const { data } = detectorCtx.getImageData(0, 0, DETECTOR_W, DETECTOR_H);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  const gray = new Uint8ClampedArray(ROI_W * ROI_H);
  for (let y = 0; y < ROI_H; y++) {
    for (let x = 0; x < ROI_W; x++) {
      const srcIdx = ((y + ROI_Y) * DETECTOR_W + (x + ROI_X)) * 4;
      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      sumR += r;
      sumG += g;
      sumB += b;
      gray[y * ROI_W + x] = (r * 0.299 + g * 0.587 + b * 0.114) | 0;
    }
  }
  const pixelCount = ROI_W * ROI_H;
  const meanR = sumR / pixelCount;
  const meanG = sumG / pixelCount;
  const meanB = sumB / pixelCount;
  const brightness = (meanR + meanG + meanB) / 3;
  const colorVariance =
    Math.max(meanR, meanG, meanB) - Math.min(meanR, meanG, meanB);

  let motion = 0;
  if (prevGray && prevGray.length === gray.length) {
    let sum = 0;
    for (let i = 0; i < gray.length; i++) {
      sum += Math.abs(gray[i] - prevGray[i]);
    }
    motion = sum / gray.length;
  } else {
    motion = 999;
  }
  prevGray = gray;

  const sharpness = laplacianVariance(gray, ROI_W, ROI_H);
  return { brightness, colorVariance, motion, sharpness };
}

function detectorLoop(): void {
  requestAnimationFrame(detectorLoop);
  const now = performance.now();
  if (now - lastDetectorTick < DETECTOR_INTERVAL_MS) return;
  lastDetectorTick = now;

  const m = computeMetrics();
  if (!m) return;
  latestMetrics = m;

  // Live metrics in settings dialog
  if (settingsDialog.open) {
    liveMetrics.textContent =
      `bright=${m.brightness.toFixed(0)}  cvar=${m.colorVariance.toFixed(0)}  ` +
      `motion=${m.motion.toFixed(1)}  sharp=${m.sharpness.toFixed(0)}  ` +
      `state=${detectorState}`;
  }

  if (!state.settings.autoCapture) {
    roiOverlay.className = 'roi-overlay hidden';
    metricsRow.hidden = true;
    return;
  }
  roiOverlay.className = 'roi-overlay';

  const t = state.settings.thresholds;
  const isWhiteCard = m.brightness > t.whiteBrightness && m.colorVariance < t.whiteColorVariance;
  const isStill = m.motion < t.motionDelta;
  const isSharp = m.sharpness > t.sharpnessMin;

  // Always-visible live metrics for tuning
  metricsRow.hidden = false;
  const fmt = (val: number, ok: boolean) =>
    `<span class="${ok ? 'ok' : 'bad'}">${val.toFixed(0)}</span>`;
  metricsInline.innerHTML =
    `bright ${fmt(m.brightness, m.brightness > t.whiteBrightness)} ` +
    `cvar ${fmt(m.colorVariance, m.colorVariance < t.whiteColorVariance)} ` +
    `motion ${fmt(m.motion, isStill)} ` +
    `sharp ${fmt(m.sharpness, isSharp)} ` +
    `· state ${detectorState}`;

  if (captureInFlight) return;

  if (detectorState === 'COOLDOWN') {
    // Re-arm on motion (peel)
    if (!isStill || !isWhiteCard) {
      detectorState = 'NO_CARD';
      stableSince = 0;
    }
    return;
  }

  if (!isWhiteCard) {
    detectorState = 'NO_CARD';
    stableSince = 0;
    roiOverlay.className = 'roi-overlay';
    if (!flashTimer) setStatus('idle', 'WAITING FOR CARD', DEFAULT_HINT);
    return;
  }

  if (!isStill || !isSharp) {
    detectorState = 'CARD_MOVING';
    stableSince = 0;
    roiOverlay.className = 'roi-overlay detected';
    if (!flashTimer) setStatus('steady', 'STEADY…', isSharp ? 'Hold still.' : 'Focusing…');
    return;
  }

  // White, still, sharp
  roiOverlay.className = 'roi-overlay ready';
  if (stableSince === 0) stableSince = now;
  if (now - stableSince >= t.stabilityMs) {
    detectorState = 'COOLDOWN';
    stableSince = 0;
    void triggerCapture();
  }
}

// =====================================================================
// OCR (OpenRouter)
// =====================================================================

function buildOcrPrompt(): string {
  let serialLine: string;
  switch (state.settings.serialFormat) {
    case 'hex8':
      serialLine =
        '- "serial": the printed serial as 8 hex byte pairs separated by single spaces, uppercase (e.g. "12 34 AB CD 56 78 EF 90")';
      break;
    case 'decimal':
      serialLine =
        '- "serial": the printed numeric serial number, digits only with no separators (e.g. "1234567890123")';
      break;
    case 'either':
      serialLine =
        '- "serial": the printed serial. If hex, format as 8 byte pairs separated by single spaces uppercase (e.g. "12 34 AB CD 56 78 EF 90"). If numeric, digits only with no separators.';
      break;
    case 'custom':
      serialLine = `- "serial": the printed serial. ${state.settings.customSerialHint || 'Use the exact format printed on the card.'}`;
      break;
  }

  return `You are reading the back of a smart card. Extract:
- "card_type": short identifier (manufacturer or model name as printed)
${serialLine}
- "confidence": number 0-1 reflecting how confident you are in the serial. Use < 0.5 if you cannot read every character with certainty.

Read carefully — small etched text on a white card. Output the serial EXACTLY as printed; do not guess characters or invent text. If a character is ambiguous, lower the confidence rather than guessing.

Output ONLY a JSON object with exactly those three fields. No commentary, no markdown, no code fences.`;
}

async function callOcr(imageDataUrl: string): Promise<OcrResult> {
  const delays = [0, 1500, 4000]; // up to 3 attempts on transient failures
  let lastErr: Error = new Error('OCR failed');
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) {
      setStatus('ocr', `OCR retry ${attempt}…`, 'Provider rate-limited; backing off.');
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
    try {
      return await callOcrOnce(imageDataUrl);
    } catch (err) {
      lastErr = err as Error;
      const msg = lastErr.message;
      const isTransient = /^HTTP 429/.test(msg) || /^HTTP 5\d\d/.test(msg) || /network|fetch failed/i.test(msg);
      if (!isTransient) throw err;
    }
  }
  throw lastErr;
}

async function callOcrOnce(imageDataUrl: string): Promise<OcrResult> {
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.settings.apiKey}`,
      'HTTP-Referer': window.location.origin,
      'X-Title': 'Smart Card Disposal Logger'
    },
    body: JSON.stringify({
      model: state.settings.model,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: buildOcrPrompt() },
            { type: 'image_url', image_url: { url: imageDataUrl } }
          ]
        }
      ],
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 240)}`);
  }
  const json = await res.json();
  const content: string = json.choices?.[0]?.message?.content ?? '';
  return parseOcrResponse(content);
}

function parseOcrResponse(content: string): OcrResult {
  const raw = content;
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  const tryParse = (s: string): OcrResult | null => {
    try {
      const obj = JSON.parse(s) as Record<string, unknown>;
      return {
        cardType: String(obj.card_type ?? obj.cardType ?? '').trim(),
        serial: String(obj.serial ?? '').trim(),
        confidence:
          typeof obj.confidence === 'number' ? obj.confidence : undefined,
        raw
      };
    } catch {
      return null;
    }
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    const obj = tryParse(match[0]);
    if (obj) return obj;
  }

  // Fallback: regex out a hex serial from raw text
  const serialMatch = raw.match(/(?:[0-9A-Fa-f]{2}\s+){7}[0-9A-Fa-f]{2}/);
  return {
    cardType: '',
    serial: serialMatch ? serialMatch[0] : '',
    raw
  };
}

function normalizeSerial(s: string): string {
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

function isValidSerial(s: string): boolean {
  const norm = normalizeSerial(s);
  if (!norm) return false;
  switch (state.settings.serialFormat) {
    case 'hex8':
      return HEX8_REGEX.test(norm);
    case 'decimal':
      return DECIMAL_REGEX.test(norm);
    case 'either':
      return HEX8_REGEX.test(norm) || DECIMAL_REGEX.test(norm);
    case 'custom':
      try {
        return new RegExp(state.settings.customSerialRegex).test(norm);
      } catch {
        return false;
      }
  }
}

// =====================================================================
// Capture pipeline
// =====================================================================

function captureFullFrame(): { fullPng: string; thumbJpeg: string; fullSharpness: number } | null {
  if (video.videoWidth === 0) return null;
  const w = video.videoWidth;
  const h = video.videoHeight;

  const full = document.createElement('canvas');
  full.width = w;
  full.height = h;
  const fctx = full.getContext('2d');
  if (!fctx) return null;
  fctx.drawImage(video, 0, 0, w, h);
  // PNG: lossless. Slightly bigger upload but materially better OCR on small etched text.
  const fullPng = full.toDataURL('image/png');

  const thumbW = 320;
  const thumbH = Math.round((h * thumbW) / w);
  const thumb = document.createElement('canvas');
  thumb.width = thumbW;
  thumb.height = thumbH;
  const tctx = thumb.getContext('2d');
  if (!tctx) return null;
  tctx.drawImage(full, 0, 0, thumbW, thumbH);
  const thumbJpeg = thumb.toDataURL('image/jpeg', 0.75);

  // Compute Laplacian variance on a 480-wide grayscale of the actual capture.
  // The detector's 60x90 ROI sharpness can read high during autofocus hunt — this
  // gives us a real-resolution number to log alongside the OCR result.
  const checkW = 480;
  const checkH = Math.round((h * checkW) / w);
  const check = document.createElement('canvas');
  check.width = checkW;
  check.height = checkH;
  const cctx = check.getContext('2d');
  let fullSharpness = 0;
  if (cctx) {
    cctx.drawImage(full, 0, 0, checkW, checkH);
    const { data } = cctx.getImageData(0, 0, checkW, checkH);
    const gray = new Uint8ClampedArray(checkW * checkH);
    for (let i = 0; i < gray.length; i++) {
      const j = i * 4;
      gray[i] = (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) | 0;
    }
    fullSharpness = laplacianVariance(gray, checkW, checkH);
  }

  return { fullPng, thumbJpeg, fullSharpness };
}

async function triggerCapture(): Promise<void> {
  if (captureInFlight) return;
  captureInFlight = true;
  try {
    const frames = captureFullFrame();
    if (!frames) {
      flashStatus('error', 'NO VIDEO', 'Camera is not ready yet.');
      return;
    }
    playClick();
    setStatus('ocr', 'OCR…', 'Sending frame to OpenRouter.');

    if (!state.settings.apiKey) {
      // No key — drop straight into review tray.
      playBuzz();
      addReviewItem({
        id: crypto.randomUUID(),
        thumbnailDataUrl: frames.thumbJpeg,
        rawText: '(no API key configured — open Settings to add one)',
        cardType: '',
        serial: '',
        capturedAt: Date.now()
      });
      flashStatus('review', 'REVIEW ⚠', 'Set an OpenRouter API key in Settings.');
      return;
    }

    const start = performance.now();
    try {
      const result = await callOcr(frames.fullPng);
      const ms = Math.round(performance.now() - start);
      const conf = result.confidence != null ? result.confidence.toFixed(2) : 'n/a';
      console.log(
        `OCR ${ms}ms  conf=${conf}  fullSharp=${frames.fullSharpness.toFixed(0)}  ` +
          `type=${JSON.stringify(result.cardType)}  serial=${JSON.stringify(result.serial)}`
      );

      const normalized = normalizeSerial(result.serial);
      const formatOk = isValidSerial(normalized);
      const confOk =
        result.confidence == null || result.confidence >= state.settings.minConfidence;

      if (formatOk && confOk) {
        playGood();
        addCapturedRow({
          id: crypto.randomUUID(),
          cardType: result.cardType.trim(),
          serial: normalized,
          addedAt: Date.now()
        });
        const dup = state.captured.filter((r) => normalizeSerial(r.serial) === normalized).length > 1;
        flashStatus(
          dup ? 'review' : 'added',
          dup ? 'DUPLICATE ⚠' : 'ADDED ✓',
          `${ms}ms · ${dup ? 'serial already in list' : `${state.captured.length} captured`} · conf ${conf}`
        );
        if (dup) playBuzz();
      } else {
        const reason = !formatOk
          ? "serial didn't match format"
          : `confidence ${conf} < ${state.settings.minConfidence}`;
        playBuzz();
        addReviewItem({
          id: crypto.randomUUID(),
          thumbnailDataUrl: frames.thumbJpeg,
          rawText: `(conf ${conf}) ${result.raw}`,
          cardType: result.cardType.trim(),
          serial: result.serial.trim(),
          capturedAt: Date.now()
        });
        flashStatus('review', 'REVIEW ⚠', `${ms}ms · ${reason}`);
      }
    } catch (err) {
      console.error('OCR error', err);
      playBuzz();
      addReviewItem({
        id: crypto.randomUUID(),
        thumbnailDataUrl: frames.thumbJpeg,
        rawText: `Error: ${(err as Error).message}`,
        cardType: '',
        serial: '',
        capturedAt: Date.now()
      });
      flashStatus('error', 'OCR ERROR', (err as Error).message.slice(0, 80));
    }
  } finally {
    captureInFlight = false;
  }
}

// =====================================================================
// Captured table
// =====================================================================

function addCapturedRow(row: CapturedRow): void {
  state.captured.push(row);
  saveState();
  renderCaptured();
}

function deleteCapturedRow(id: string): void {
  state.captured = state.captured.filter((r) => r.id !== id);
  saveState();
  renderCaptured();
}

function updateCapturedRow(id: string, field: 'cardType' | 'serial', value: string): void {
  const row = state.captured.find((r) => r.id === id);
  if (!row) return;
  row[field] = value;
  saveState();
  // Duplicate highlighting depends on serial — re-render for that case.
  if (field === 'serial') renderCaptured();
}

function renderCaptured(): void {
  capturedCount.textContent = String(state.captured.length);
  emptyState.style.display = state.captured.length === 0 ? 'block' : 'none';
  capturedTbody.innerHTML = '';

  // Build serial -> count map for duplicate highlight
  const counts = new Map<string, number>();
  for (const r of state.captured) {
    const k = normalizeSerial(r.serial);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  for (const row of state.captured) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    const dup = counts.get(normalizeSerial(row.serial)) ?? 0;
    if (dup > 1) tr.classList.add('duplicate');

    const tdType = document.createElement('td');
    const inputType = document.createElement('input');
    inputType.type = 'text';
    inputType.className = 'card-type';
    inputType.value = row.cardType;
    inputType.placeholder = 'Card type';
    inputType.addEventListener('input', () =>
      updateCapturedRow(row.id, 'cardType', inputType.value)
    );
    tdType.appendChild(inputType);

    const tdSerial = document.createElement('td');
    const inputSerial = document.createElement('input');
    inputSerial.type = 'text';
    inputSerial.className = 'serial';
    inputSerial.value = row.serial;
    inputSerial.placeholder = 'Serial';
    inputSerial.addEventListener('input', () =>
      updateCapturedRow(row.id, 'serial', inputSerial.value)
    );
    tdSerial.appendChild(inputSerial);

    const tdActions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete row';
    delBtn.addEventListener('click', () => deleteCapturedRow(row.id));
    tdActions.appendChild(delBtn);

    tr.appendChild(tdType);
    tr.appendChild(tdSerial);
    tr.appendChild(tdActions);
    capturedTbody.appendChild(tr);
  }
}

// =====================================================================
// Review tray
// =====================================================================

let focusedReviewId: string | null = null;

function addReviewItem(item: ReviewItem): void {
  state.review.push(item);
  saveState();
  renderReview();
}

function discardReviewItem(id: string): void {
  state.review = state.review.filter((r) => r.id !== id);
  if (focusedReviewId === id) focusedReviewId = state.review[0]?.id ?? null;
  saveState();
  renderReview();
}

function confirmReviewItem(id: string): void {
  const item = state.review.find((r) => r.id === id);
  if (!item) return;
  // Move into captured even if serial format isn't perfect — user has reviewed.
  addCapturedRow({
    id: crypto.randomUUID(),
    cardType: item.cardType.trim(),
    serial: normalizeSerial(item.serial),
    addedAt: Date.now()
  });
  discardReviewItem(id);
}

function updateReviewItem(id: string, field: 'cardType' | 'serial', value: string): void {
  const item = state.review.find((r) => r.id === id);
  if (!item) return;
  item[field] = value;
  saveState();
}

function renderReview(): void {
  reviewCount.textContent = String(state.review.length);
  reviewSection.hidden = state.review.length === 0;
  reviewBody.innerHTML = '';

  if (state.review.length > 0 && focusedReviewId === null) {
    focusedReviewId = state.review[0].id;
  }

  for (const item of state.review) {
    const div = document.createElement('div');
    div.className = 'review-item';
    div.dataset.id = item.id;
    if (item.id === focusedReviewId) div.classList.add('focused');

    const img = document.createElement('img');
    img.src = item.thumbnailDataUrl;
    img.alt = '';

    const fields = document.createElement('div');
    fields.className = 'fields';

    if (item.rawText) {
      const raw = document.createElement('div');
      raw.className = 'raw';
      raw.textContent = item.rawText.slice(0, 600);
      fields.appendChild(raw);
    }

    const typeInput = document.createElement('input');
    typeInput.type = 'text';
    typeInput.value = item.cardType;
    typeInput.placeholder = 'Card type';
    typeInput.addEventListener('input', () => updateReviewItem(item.id, 'cardType', typeInput.value));
    fields.appendChild(typeInput);

    const serialInput = document.createElement('input');
    serialInput.type = 'text';
    serialInput.value = item.serial;
    serialInput.placeholder = 'Serial (8 hex byte pairs)';
    serialInput.addEventListener('input', () => updateReviewItem(item.id, 'serial', serialInput.value));
    fields.appendChild(serialInput);

    const actions = document.createElement('div');
    actions.className = 'actions';
    const confirmBtn = document.createElement('button');
    confirmBtn.type = 'button';
    confirmBtn.className = 'primary';
    confirmBtn.textContent = 'Confirm';
    confirmBtn.addEventListener('click', () => confirmReviewItem(item.id));
    const discardBtn = document.createElement('button');
    discardBtn.type = 'button';
    discardBtn.textContent = 'Discard';
    discardBtn.addEventListener('click', () => discardReviewItem(item.id));
    actions.appendChild(confirmBtn);
    actions.appendChild(discardBtn);

    div.addEventListener('click', () => {
      focusedReviewId = item.id;
      // Lightweight: just toggle .focused on siblings without full re-render
      reviewBody.querySelectorAll('.review-item').forEach((el) => el.classList.remove('focused'));
      div.classList.add('focused');
    });

    div.appendChild(img);
    div.appendChild(fields);
    div.appendChild(actions);
    reviewBody.appendChild(div);
  }
}

function focusNextReview(delta: 1 | -1): void {
  if (state.review.length === 0) return;
  const idx = state.review.findIndex((r) => r.id === focusedReviewId);
  const next = (idx + delta + state.review.length) % state.review.length;
  focusedReviewId = state.review[next].id;
  renderReview();
  reviewBody.querySelector(`[data-id="${focusedReviewId}"]`)?.scrollIntoView({ block: 'nearest' });
}

toggleReviewBtn.addEventListener('click', () => {
  const collapsed = reviewSection.dataset.collapsed === 'true';
  reviewSection.dataset.collapsed = collapsed ? 'false' : 'true';
  toggleReviewBtn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
});

// =====================================================================
// Export
// =====================================================================

function csvField(s: string): string {
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function buildCsv(): string {
  const lines = ['card_type,serial_number'];
  for (const r of state.captured) {
    lines.push(`${csvField(r.cardType)},${csvField(r.serial)}`);
  }
  return lines.join('\r\n');
}

function buildTsv(): string {
  const lines = ['card_type\tserial_number'];
  for (const r of state.captured) {
    const t = r.cardType.replace(/\t/g, ' ');
    const s = r.serial.replace(/\t/g, ' ');
    lines.push(`${t}\t${s}`);
  }
  return lines.join('\n');
}

function timestampForFilename(): string {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}`;
}

downloadBtn.addEventListener('click', () => {
  if (state.captured.length === 0) {
    flashStatus('idle', 'NOTHING TO EXPORT', DEFAULT_HINT);
    return;
  }
  const csv = buildCsv();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `smart-cards-${timestampForFilename()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

copyBtn.addEventListener('click', async () => {
  if (state.captured.length === 0) {
    flashStatus('idle', 'NOTHING TO COPY', DEFAULT_HINT);
    return;
  }
  try {
    await navigator.clipboard.writeText(buildTsv());
    flashStatus('added', 'COPIED', `${state.captured.length} rows on clipboard`);
  } catch (err) {
    console.error('Clipboard write failed', err);
    flashStatus('error', 'COPY FAILED', (err as Error).message);
  }
});

clearBtn.addEventListener('click', () => {
  if (state.captured.length === 0 && state.review.length === 0) return;
  if (!confirm(`Clear all ${state.captured.length} captured rows and ${state.review.length} review items?`)) return;
  state.captured = [];
  state.review = [];
  focusedReviewId = null;
  saveState();
  renderCaptured();
  renderReview();
});

// =====================================================================
// Settings dialog
// =====================================================================

function syncSettingsToInputs(): void {
  apiKeyInput.value = state.settings.apiKey;
  modelInput.value = state.settings.model;
  mutedInput.checked = state.settings.muted;
  autoCaptureSettingInput.checked = state.settings.autoCapture;
  autoCaptureToggle.checked = state.settings.autoCapture;

  for (const k of Object.keys(thresholdInputs) as Array<keyof Thresholds>) {
    const input = thresholdInputs[k];
    const out = thresholdOutputs[k];
    input.value = String(state.settings.thresholds[k]);
    out.value = String(state.settings.thresholds[k]);
  }

  serialFormatInput.value = state.settings.serialFormat;
  customSerialRegexInput.value = state.settings.customSerialRegex;
  customSerialHintInput.value = state.settings.customSerialHint;
  minConfidenceInput.value = String(state.settings.minConfidence);
  minConfidenceOut.value = state.settings.minConfidence.toFixed(2);
  syncCustomSerialVisibility();
}

function syncCustomSerialVisibility(): void {
  const isCustom = state.settings.serialFormat === 'custom';
  document.querySelectorAll<HTMLLabelElement>('label.custom-only[data-when="custom"]').forEach((el) => {
    el.hidden = !isCustom;
  });
}

function openSettings(): void {
  syncSettingsToInputs();
  if (!settingsDialog.open) settingsDialog.showModal();
}

settingsBtn.addEventListener('click', openSettings);
closeSettingsBtn.addEventListener('click', () => settingsDialog.close());
doneSettingsBtn.addEventListener('click', () => settingsDialog.close());

apiKeyInput.addEventListener('input', () => {
  state.settings.apiKey = apiKeyInput.value.trim();
  saveState();
});

apiKeyToggleBtn.addEventListener('click', () => {
  const showing = apiKeyInput.type === 'text';
  apiKeyInput.type = showing ? 'password' : 'text';
  apiKeyToggleBtn.textContent = showing ? 'Show' : 'Hide';
  apiKeyToggleBtn.setAttribute('aria-pressed', showing ? 'false' : 'true');
  apiKeyToggleBtn.setAttribute('aria-label', showing ? 'Show API key' : 'Hide API key');
});
modelInput.addEventListener('input', () => {
  state.settings.model = modelInput.value.trim() || DEFAULT_MODEL;
  saveState();
});
mutedInput.addEventListener('change', () => {
  state.settings.muted = mutedInput.checked;
  saveState();
});
autoCaptureSettingInput.addEventListener('change', () => {
  state.settings.autoCapture = autoCaptureSettingInput.checked;
  autoCaptureToggle.checked = state.settings.autoCapture;
  saveState();
});

for (const k of Object.keys(thresholdInputs) as Array<keyof Thresholds>) {
  const input = thresholdInputs[k];
  const out = thresholdOutputs[k];
  input.addEventListener('input', () => {
    const v = Number(input.value);
    state.settings.thresholds[k] = v;
    out.value = String(v);
    saveState();
  });
}

resetThresholdsBtn.addEventListener('click', () => {
  state.settings.thresholds = { ...DEFAULT_THRESHOLDS };
  saveState();
  syncSettingsToInputs();
});

function clampToInput(value: number, input: HTMLInputElement): number {
  const min = Number(input.min || '0');
  const max = Number(input.max || '9999');
  return Math.max(min, Math.min(max, Math.round(value)));
}

tuneBtn.addEventListener('click', () => {
  const m = latestMetrics;
  if (!m) {
    flashStatus('idle', 'NO READING', 'Wait a moment for live metrics, then try again.');
    return;
  }
  // Snapshot the current readings into thresholds with margins so this same
  // view still passes plus a bit of slack: dim the brightness floor, raise the
  // color-variance ceiling, allow some extra motion, accept slightly less sharp.
  state.settings.thresholds = {
    ...state.settings.thresholds,
    whiteBrightness: clampToInput(m.brightness - 10, thresholdInputs.whiteBrightness),
    whiteColorVariance: clampToInput(Math.max(m.colorVariance + 15, m.colorVariance * 1.4), thresholdInputs.whiteColorVariance),
    motionDelta: clampToInput(m.motion + 4, thresholdInputs.motionDelta),
    sharpnessMin: clampToInput(m.sharpness * 0.75, thresholdInputs.sharpnessMin)
  };
  saveState();
  syncSettingsToInputs();
  const t = state.settings.thresholds;
  flashStatus(
    'added',
    'TUNED',
    `bright>${t.whiteBrightness} cvar<${t.whiteColorVariance} motion<${t.motionDelta} sharp>${t.sharpnessMin}`
  );
});

serialFormatInput.addEventListener('change', () => {
  state.settings.serialFormat = serialFormatInput.value as SerialFormat;
  saveState();
  syncCustomSerialVisibility();
});
customSerialRegexInput.addEventListener('input', () => {
  state.settings.customSerialRegex = customSerialRegexInput.value.trim();
  saveState();
});
customSerialHintInput.addEventListener('input', () => {
  state.settings.customSerialHint = customSerialHintInput.value.trim();
  saveState();
});
minConfidenceInput.addEventListener('input', () => {
  const v = Number(minConfidenceInput.value);
  state.settings.minConfidence = v;
  minConfidenceOut.value = v.toFixed(2);
  saveState();
});

testCaptureBtn.addEventListener('click', () => {
  settingsDialog.close();
  void triggerCapture();
});

// Backdrop click closes the dialog
settingsDialog.addEventListener('click', (e) => {
  if (e.target === settingsDialog) settingsDialog.close();
});

// =====================================================================
// Top-level controls
// =====================================================================

autoCaptureToggle.addEventListener('change', () => {
  state.settings.autoCapture = autoCaptureToggle.checked;
  autoCaptureSettingInput.checked = state.settings.autoCapture;
  saveState();
});

snapBtn.addEventListener('click', () => {
  void triggerCapture();
});

// =====================================================================
// Keyboard shortcuts
// =====================================================================

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const isTyping =
    target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');

  if (e.code === 'Escape') {
    if (settingsDialog.open) {
      // <dialog> handles Esc natively, but keep behavior consistent.
      return;
    }
    if (state.review.length > 0) {
      reviewSection.dataset.collapsed = 'true';
      toggleReviewBtn.setAttribute('aria-expanded', 'false');
    }
    return;
  }

  if (isTyping) return;

  if (e.code === 'Space') {
    e.preventDefault();
    void triggerCapture();
    return;
  }

  if (e.key === 'u' || e.key === 'U') {
    e.preventDefault();
    if (state.captured.length === 0) return;
    state.captured.pop();
    saveState();
    renderCaptured();
    flashStatus('idle', 'UNDONE', `${state.captured.length} captured`);
    return;
  }

  if (e.key === 'j' || e.key === 'J') {
    e.preventDefault();
    focusNextReview(1);
    return;
  }
  if (e.key === 'k' || e.key === 'K') {
    e.preventDefault();
    focusNextReview(-1);
    return;
  }
  if (e.key === 'Enter') {
    if (focusedReviewId) {
      e.preventDefault();
      confirmReviewItem(focusedReviewId);
    }
    return;
  }
  if (e.key === 'd' || e.key === 'D') {
    if (focusedReviewId) {
      e.preventDefault();
      discardReviewItem(focusedReviewId);
    }
    return;
  }
});

// =====================================================================
// Boot
// =====================================================================

autoCaptureToggle.checked = state.settings.autoCapture;
syncSettingsToInputs();
renderCaptured();
renderReview();
setStatus('idle', 'WAITING FOR CARD', DEFAULT_HINT);
void initCamera();
detectorLoop();
