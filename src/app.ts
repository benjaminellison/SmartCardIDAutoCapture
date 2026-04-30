import './style.css';

type CapturedRow = {
  id: string;
  cardType: string;
  serial: string;
  addedAt: number;
};

type State = {
  captured: CapturedRow[];
  settings: {
    selectedCameraId?: string;
  };
};

const STORAGE_KEY = 'scdl:state:v1';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
};

const video = $<HTMLVideoElement>('video');
const cameraSelect = $<HTMLSelectElement>('cameraSelect');
const snapBtn = $<HTMLButtonElement>('snapBtn');
const statusEl = $<HTMLDivElement>('status');
const hintEl = $<HTMLParagraphElement>('hint');
const capturedCount = $<HTMLSpanElement>('capturedCount');
const capturedTbody = $<HTMLTableSectionElement>('capturedTbody');
const emptyState = $<HTMLParagraphElement>('emptyState');
const downloadBtn = $<HTMLButtonElement>('downloadBtn');
const copyBtn = $<HTMLButtonElement>('copyBtn');
const clearBtn = $<HTMLButtonElement>('clearBtn');

let state: State = loadState();
let currentStream: MediaStream | null = null;
let flashTimer: number | undefined;

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<State>;
      return {
        captured: parsed.captured ?? [],
        settings: parsed.settings ?? {}
      };
    }
  } catch (err) {
    console.warn('Failed to load state', err);
  }
  return { captured: [], settings: {} };
}

function saveState(): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const DEFAULT_HINT = 'Press Space to capture the current frame.';

function setStatus(text: string, hint?: string): void {
  statusEl.textContent = text;
  if (hint !== undefined) hintEl.textContent = hint;
}

function flashStatus(text: string, duration = 700): void {
  setStatus(text);
  if (flashTimer !== undefined) window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    setStatus('WAITING FOR CARD', DEFAULT_HINT);
  }, duration);
}

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
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false
  };
  currentStream = await navigator.mediaDevices.getUserMedia(constraints);
  video.srcObject = currentStream;
}

async function initCamera(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('CAMERA UNAVAILABLE', 'Your browser does not support getUserMedia.');
    return;
  }
  try {
    // Initial permission grant — also unlocks device labels in enumerateDevices.
    const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    tmp.getTracks().forEach((t) => t.stop());
  } catch (err) {
    console.warn('Camera permission denied', err);
    setStatus('CAMERA DENIED', 'Grant camera access and reload the page.');
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
  const preferred = remembered && cameras.some((c) => c.deviceId === remembered)
    ? remembered
    : cameras[0]?.deviceId;

  if (preferred) {
    cameraSelect.value = preferred;
    try {
      await startCamera(preferred);
      state.settings.selectedCameraId = preferred;
      saveState();
    } catch (err) {
      console.error('Failed to start camera', err);
      setStatus('CAMERA ERROR', 'Could not start the selected camera.');
    }
  } else {
    setStatus('NO CAMERA', 'No video input devices found.');
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
    setStatus('CAMERA ERROR', 'Could not start the selected camera.');
  }
});

function captureFrame(): void {
  // Step 1: no OCR yet. Just add an empty row, ready for inline edit.
  // The captured frame will be wired to OpenRouter in step 2.
  flashStatus('CAPTURED');
  addRow({
    id: crypto.randomUUID(),
    cardType: '',
    serial: '',
    addedAt: Date.now()
  });
}

function addRow(row: CapturedRow): void {
  state.captured.push(row);
  saveState();
  renderTable();
  // Focus the new row's first input for fast manual entry in step 1.
  const firstInput = capturedTbody.querySelector<HTMLInputElement>(
    `tr[data-id="${row.id}"] input.card-type`
  );
  firstInput?.focus();
}

function deleteRow(id: string): void {
  state.captured = state.captured.filter((r) => r.id !== id);
  saveState();
  renderTable();
}

function updateRow(id: string, field: 'cardType' | 'serial', value: string): void {
  const row = state.captured.find((r) => r.id === id);
  if (!row) return;
  row[field] = value;
  saveState();
}

function renderTable(): void {
  capturedCount.textContent = String(state.captured.length);
  emptyState.style.display = state.captured.length === 0 ? 'block' : 'none';
  capturedTbody.innerHTML = '';

  for (const row of state.captured) {
    const tr = document.createElement('tr');
    tr.dataset.id = row.id;

    const tdType = document.createElement('td');
    const inputType = document.createElement('input');
    inputType.type = 'text';
    inputType.className = 'card-type';
    inputType.value = row.cardType;
    inputType.placeholder = 'Card type';
    inputType.addEventListener('input', () => updateRow(row.id, 'cardType', inputType.value));
    tdType.appendChild(inputType);

    const tdSerial = document.createElement('td');
    const inputSerial = document.createElement('input');
    inputSerial.type = 'text';
    inputSerial.className = 'serial';
    inputSerial.value = row.serial;
    inputSerial.placeholder = 'Serial';
    inputSerial.addEventListener('input', () => updateRow(row.id, 'serial', inputSerial.value));
    tdSerial.appendChild(inputSerial);

    const tdActions = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'icon';
    delBtn.textContent = '✕';
    delBtn.title = 'Delete row';
    delBtn.addEventListener('click', () => deleteRow(row.id));
    tdActions.appendChild(delBtn);

    tr.appendChild(tdType);
    tr.appendChild(tdSerial);
    tr.appendChild(tdActions);
    capturedTbody.appendChild(tr);
  }
}

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
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

downloadBtn.addEventListener('click', () => {
  if (state.captured.length === 0) {
    flashStatus('NOTHING TO EXPORT');
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
    flashStatus('NOTHING TO COPY');
    return;
  }
  try {
    await navigator.clipboard.writeText(buildTsv());
    flashStatus('COPIED');
  } catch (err) {
    console.error('Clipboard write failed', err);
    flashStatus('COPY FAILED');
  }
});

clearBtn.addEventListener('click', () => {
  if (state.captured.length === 0) return;
  if (!confirm(`Clear all ${state.captured.length} captured rows?`)) return;
  state.captured = [];
  saveState();
  renderTable();
});

snapBtn.addEventListener('click', captureFrame);

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement | null;
  const isTyping = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA');
  if (e.code === 'Space' && !isTyping) {
    e.preventDefault();
    captureFrame();
  }
});

renderTable();
initCamera();
