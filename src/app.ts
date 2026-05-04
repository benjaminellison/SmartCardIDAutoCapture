import './style.css';

// =====================================================================
// Types
// =====================================================================

type KnownCardTypeId =
  | 'gd-fips-201-sce-v7'
  | 'gd-fips-201-sce-v3-2'
  | 'safenet-sc650'
  | 'gemalto-idprime-md'
  | 'idemia-id-one-piv'
  | 'unknown';

type CapturedRow = {
  id: string;
  cardTypeId: KnownCardTypeId;
  cardDescription: string;
  version: string;
  serial: string;
  addedAt: number;
};

type ReviewItem = {
  id: string;
  thumbnailDataUrl: string;
  rawText: string;
  cardTypeId: KnownCardTypeId;
  cardDescription: string;
  version: string;
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

type Settings = {
  selectedCameraId?: string;
  apiKey: string;
  model: string;
  muted: boolean;
  autoCapture: boolean;
  thresholds: Thresholds;
  customPrompt: string;
  minConfidence: number;
};

type State = {
  captured: CapturedRow[];
  review: ReviewItem[];
  settings: Settings;
};

type OcrResult = {
  cardTypeId: KnownCardTypeId;
  cardDescription: string;
  version: string;
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

const DEFAULT_HINT = 'Ready. Hold a card up or press Space to force a capture.';

const KNOWN_CARD_TYPE_IDS: readonly KnownCardTypeId[] = [
  'gd-fips-201-sce-v7',
  'gd-fips-201-sce-v3-2',
  'safenet-sc650',
  'gemalto-idprime-md',
  'idemia-id-one-piv',
  'unknown'
];

// Per-card-type serial validators. Loose enough to not reject minor printing
// variations but strict enough to catch hallucinations and partial reads.
const CARD_VALIDATORS: Record<KnownCardTypeId, (serial: string) => boolean> = {
  'gd-fips-201-sce-v7': (s) => /^[0-9A-Z]{6,10}$/.test(s.toUpperCase()),
  'gd-fips-201-sce-v3-2': (s) => /\s\/\s/.test(s) && s.length >= 10,
  'safenet-sc650': (s) => /^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/.test(s.toUpperCase()),
  'gemalto-idprime-md': (s) => /^([0-9A-F]{2} ){7}[0-9A-F]{2}$/.test(s.toUpperCase()),
  'idemia-id-one-piv': (s) => /^[0-9A-Z]+(-[0-9A-Z]+){1,4}$/.test(s.toUpperCase()),
  'unknown': () => false // unknown always routes to review for manual handling
};

const DEFAULT_PROMPT = `You are reading the back of a U.S. Department of State PKI smart card. Identify which of the known card types below this is, then extract the description, version, and serial number using that card type's specific rules.

KNOWN CARD TYPES:

1. id "gd-fips-201-sce-v7" — G+D FIPS 201 SCE v7.0
   • Description (top-left): "G+D FIPS 201 SCE"
   • Version: "7.0"
   • Serial (top-right): 6–10 alphanumeric characters
   • No manufacture date

2. id "gd-fips-201-sce-v3-2" — Older G+D FIPS 201 SCE v3.2
   • Description (top-left): "G+D FIPS 201 SCE" OR "G&D FIPS 201 SCE" — preserve the "&" or "+" exactly as printed
   • Version: "3.2"
   • Serial: TWO serial numbers printed on this card. The first is long with dashes (e.g. XXXX-XXXX-XXXX-XXXX-XXXXX). The second is shorter (around 8 chars). Output BOTH joined by " / " on a single line, e.g. "AAAA-BBBB-CCCC-DDDD-EEEEE / FFFFFFFF". Long-with-dashes serial first, short serial second.

3. id "safenet-sc650" — SafeNet AT SC650 (and older variants)
   • Description (bottom-left): "SafeNet AT SC650" — older variants may omit the "AT" and read just "SafeNet SC650". Preserve exactly as printed.
   • Version: e.g. "v4.2k", "v4.1", older "v2.01"
   • Serial: 20 hex digits with dashes preserved, format XXXX-XXXX-XXXX-XXXX-XXXX (uppercase)
   • Some older cards have a hashed-out line of "#" characters BELOW the real text at the very bottom of the card. IGNORE that hashed line — it is not part of any field.

4. id "gemalto-idprime-md" — Gemalto IDPrime MD SNAP
   • Description (top-left): "Gemalto IDPrime MD" — IMPORTANT: always preserve the "Gemalto" prefix. Do NOT shorten the description to just "IDPrime MD" even if "Gemalto" is faint or partially obscured.
   • Version: if "RevB" appears next to the description, output "RevB". If no version is printed at all, output "1.0".
   • Serial (top-right): 16 hex characters formatted as 8 byte pairs separated by single spaces, uppercase, e.g. "12 34 AB CD 56 78 EF 90"
   • No manufacture date.

5. id "idemia-id-one-piv" — IDEMIA ID-One PIV
   • Description (top-left): "ID-One PIV ... from IDEMIA" — preserve the full phrase as printed
   • Version: appears immediately after "ID-One PIV" and before "(P/N", e.g. "2.4"
   • Serial (top-right, far right): hyphenated alphanumeric string like XXXXXX-XXXX-XXXXXXXXXX
   • CRITICAL WARNING: these cards print a "P/N nnnnnnn" part number INSIDE the description area. The P/N is NOT the serial number. Do not confuse them. The serial is in the top-right corner; the P/N is part of the description.
   • No manufacture date.

If the card does not match any of the above, set "card_type_id" to "unknown" and extract whatever description/version/serial you can read.

OUTPUT FORMAT — return ONLY this JSON object, no commentary, no markdown, no code fences:
{
  "card_type_id": "gd-fips-201-sce-v7" | "gd-fips-201-sce-v3-2" | "safenet-sc650" | "gemalto-idprime-md" | "idemia-id-one-piv" | "unknown",
  "card_description": "...",
  "version": "...",
  "serial": "...",
  "confidence": 0.0
}

"confidence" is your confidence in the SERIAL reading, 0 to 1. Use < 0.5 if any character is ambiguous. Read carefully — etched text is small. Output the serial EXACTLY as printed; do not guess characters.`;

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
      customPrompt: DEFAULT_PROMPT,
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
    // Migrate older rows that only had cardType/serial — they pre-date this
    // schema change. Map cardType -> cardDescription, default version + cardTypeId.
    type LegacyCaptured = Partial<CapturedRow> & { cardType?: string };
    type LegacyReview = Partial<ReviewItem> & { cardType?: string };
    const captured: CapturedRow[] = (parsed.captured ?? []).map((r: LegacyCaptured): CapturedRow => ({
      id: r.id ?? crypto.randomUUID(),
      cardTypeId: r.cardTypeId ?? 'unknown',
      cardDescription: r.cardDescription ?? r.cardType ?? '',
      version: r.version ?? '',
      serial: r.serial ?? '',
      addedAt: r.addedAt ?? Date.now()
    }));
    const review: ReviewItem[] = (parsed.review ?? []).map((r: LegacyReview): ReviewItem => ({
      id: r.id ?? crypto.randomUUID(),
      thumbnailDataUrl: r.thumbnailDataUrl ?? '',
      rawText: r.rawText ?? '',
      cardTypeId: r.cardTypeId ?? 'unknown',
      cardDescription: r.cardDescription ?? r.cardType ?? '',
      version: r.version ?? '',
      serial: r.serial ?? '',
      capturedAt: r.capturedAt ?? Date.now()
    }));
    return {
      captured,
      review,
      settings: {
        ...def.settings,
        ...(parsed.settings ?? {}),
        apiKey: parsed.settings?.apiKey || def.settings.apiKey,
        model: parsed.settings?.model || def.settings.model,
        customPrompt: parsed.settings?.customPrompt || def.settings.customPrompt,
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
const pauseBtn = $<HTMLButtonElement>('pauseBtn');
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
const customPromptInput = $<HTMLTextAreaElement>('customPromptInput');
const resetPromptBtn = $<HTMLButtonElement>('resetPromptBtn');
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
let cameraPaused = false;

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

function effectivePrompt(): string {
  return state.settings.customPrompt || DEFAULT_PROMPT;
}

function isKnownCardTypeId(s: unknown): s is KnownCardTypeId {
  return typeof s === 'string' && (KNOWN_CARD_TYPE_IDS as readonly string[]).includes(s);
}

// Normalize a serial per its card type's expected format. For card types where
// the canonical form is uppercase hex, uppercase. For others, just collapse
// whitespace and trim.
function normalizeSerial(s: string, cardTypeId: KnownCardTypeId): string {
  const trimmed = s.replace(/\s+/g, ' ').trim();
  switch (cardTypeId) {
    case 'safenet-sc650':
    case 'gemalto-idprime-md':
    case 'idemia-id-one-piv':
    case 'gd-fips-201-sce-v7':
      return trimmed.toUpperCase();
    case 'gd-fips-201-sce-v3-2':
      // Two serials joined by " / "; normalize each side's whitespace + uppercase
      return trimmed
        .split('/')
        .map((part) => part.trim().toUpperCase())
        .join(' / ');
    case 'unknown':
    default:
      return trimmed;
  }
}

function isValidSerial(s: string, cardTypeId: KnownCardTypeId): boolean {
  if (!s) return false;
  return CARD_VALIDATORS[cardTypeId](s);
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
            { type: 'text', text: effectivePrompt() },
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
      const id = obj.card_type_id ?? obj.cardTypeId;
      return {
        cardTypeId: isKnownCardTypeId(id) ? id : 'unknown',
        cardDescription: String(obj.card_description ?? obj.cardDescription ?? obj.card_type ?? '').trim(),
        version: String(obj.version ?? '').trim(),
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

  // Fallback: couldn't parse JSON at all. Return raw payload so the user can
  // see what came back in the review tray.
  return {
    cardTypeId: 'unknown',
    cardDescription: '',
    version: '',
    serial: '',
    raw
  };
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
        cardTypeId: 'unknown',
        cardDescription: '',
        version: '',
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
          `cardType=${result.cardTypeId}  desc=${JSON.stringify(result.cardDescription)}  ` +
          `ver=${JSON.stringify(result.version)}  serial=${JSON.stringify(result.serial)}`
      );

      const normalized = normalizeSerial(result.serial, result.cardTypeId);
      const formatOk = isValidSerial(normalized, result.cardTypeId);
      const confOk =
        result.confidence == null || result.confidence >= state.settings.minConfidence;

      if (formatOk && confOk) {
        playGood();
        addCapturedRow({
          id: crypto.randomUUID(),
          cardTypeId: result.cardTypeId,
          cardDescription: result.cardDescription.trim(),
          version: result.version.trim(),
          serial: normalized,
          addedAt: Date.now()
        });
        const dup =
          state.captured.filter(
            (r) => normalizeSerial(r.serial, r.cardTypeId) === normalized
          ).length > 1;
        flashStatus(
          dup ? 'review' : 'added',
          dup ? 'DUPLICATE ⚠' : 'ADDED ✓',
          `${ms}ms · ${result.cardTypeId} · ${dup ? 'serial already in list' : `${state.captured.length} captured`} · conf ${conf}`
        );
        if (dup) playBuzz();
      } else {
        const reason =
          result.cardTypeId === 'unknown'
            ? 'unrecognized card type'
            : !formatOk
              ? `serial didn't match ${result.cardTypeId} format`
              : `confidence ${conf} < ${state.settings.minConfidence}`;
        playBuzz();
        addReviewItem({
          id: crypto.randomUUID(),
          thumbnailDataUrl: frames.thumbJpeg,
          rawText: `(conf ${conf}) ${result.raw}`,
          cardTypeId: result.cardTypeId,
          cardDescription: result.cardDescription.trim(),
          version: result.version.trim(),
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
        cardTypeId: 'unknown',
        cardDescription: '',
        version: '',
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

function updateCapturedRow(id: string, field: 'cardDescription' | 'version' | 'serial', value: string): void {
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

  // Build (cardType + serial) -> count map for duplicate highlight
  const counts = new Map<string, number>();
  for (const r of state.captured) {
    const k = normalizeSerial(r.serial, r.cardTypeId);
    if (!k) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  for (const row of state.captured) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;
    const dup = counts.get(normalizeSerial(row.serial, row.cardTypeId)) ?? 0;
    if (dup > 1) tr.classList.add('duplicate');

    const tdDesc = document.createElement('td');
    const inputDesc = document.createElement('input');
    inputDesc.type = 'text';
    inputDesc.className = 'card-desc';
    inputDesc.value = row.cardDescription;
    inputDesc.placeholder = 'Description';
    inputDesc.title = `card_type_id: ${row.cardTypeId}`;
    inputDesc.addEventListener('input', () =>
      updateCapturedRow(row.id, 'cardDescription', inputDesc.value)
    );
    tdDesc.appendChild(inputDesc);

    const tdVersion = document.createElement('td');
    const inputVersion = document.createElement('input');
    inputVersion.type = 'text';
    inputVersion.className = 'version';
    inputVersion.value = row.version;
    inputVersion.placeholder = 'Version';
    inputVersion.addEventListener('input', () =>
      updateCapturedRow(row.id, 'version', inputVersion.value)
    );
    tdVersion.appendChild(inputVersion);

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

    tr.appendChild(tdDesc);
    tr.appendChild(tdVersion);
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
    cardTypeId: item.cardTypeId,
    cardDescription: item.cardDescription.trim(),
    version: item.version.trim(),
    serial: normalizeSerial(item.serial, item.cardTypeId),
    addedAt: Date.now()
  });
  discardReviewItem(id);
}

function updateReviewItem(id: string, field: 'cardDescription' | 'version' | 'serial', value: string): void {
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

    const typeBadge = document.createElement('div');
    typeBadge.className = 'review-type-badge';
    typeBadge.textContent = item.cardTypeId;
    fields.appendChild(typeBadge);

    const descInput = document.createElement('input');
    descInput.type = 'text';
    descInput.value = item.cardDescription;
    descInput.placeholder = 'Description';
    descInput.addEventListener('input', () => updateReviewItem(item.id, 'cardDescription', descInput.value));
    fields.appendChild(descInput);

    const versionInput = document.createElement('input');
    versionInput.type = 'text';
    versionInput.value = item.version;
    versionInput.placeholder = 'Version';
    versionInput.addEventListener('input', () => updateReviewItem(item.id, 'version', versionInput.value));
    fields.appendChild(versionInput);

    const serialInput = document.createElement('input');
    serialInput.type = 'text';
    serialInput.value = item.serial;
    serialInput.placeholder = 'Serial';
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
  const lines = ['card_description,version,serial'];
  for (const r of state.captured) {
    lines.push(
      `${csvField(r.cardDescription)},${csvField(r.version)},${csvField(r.serial)}`
    );
  }
  return lines.join('\r\n');
}

function buildTsv(): string {
  const lines = ['card_description\tversion\tserial'];
  for (const r of state.captured) {
    const d = r.cardDescription.replace(/\t/g, ' ');
    const v = r.version.replace(/\t/g, ' ');
    const s = r.serial.replace(/\t/g, ' ');
    lines.push(`${d}\t${v}\t${s}`);
  }
  return lines.join('\r\n');
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

  customPromptInput.value = state.settings.customPrompt;
  minConfidenceInput.value = String(state.settings.minConfidence);
  minConfidenceOut.value = state.settings.minConfidence.toFixed(2);
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

customPromptInput.addEventListener('input', () => {
  state.settings.customPrompt = customPromptInput.value;
  saveState();
});
resetPromptBtn.addEventListener('click', () => {
  state.settings.customPrompt = DEFAULT_PROMPT;
  saveState();
  customPromptInput.value = DEFAULT_PROMPT;
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

async function setCameraPaused(paused: boolean): Promise<void> {
  cameraPaused = paused;
  pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  if (paused) {
    if (currentStream) {
      currentStream.getTracks().forEach((t) => t.stop());
      currentStream = null;
    }
    video.srcObject = null;
    prevGray = null;
    detectorState = 'NO_CARD';
    stableSince = 0;
    metricsRow.hidden = true;
    roiOverlay.className = 'roi-overlay hidden';
    setStatus('idle', 'PAUSED', 'Camera off. Click Resume to continue.');
  } else {
    setStatus('idle', 'WAITING FOR CARD', DEFAULT_HINT);
    try {
      await startCamera(state.settings.selectedCameraId);
    } catch (err) {
      console.error('Failed to resume camera', err);
      setStatus('error', 'CAMERA ERROR', 'Could not restart the camera.');
    }
  }
}

pauseBtn.addEventListener('click', () => {
  void setCameraPaused(!cameraPaused);
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
