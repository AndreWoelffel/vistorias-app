/**
 * Profiler do preview da placa — somente DEV (`import.meta.env.DEV`).
 * Coleta 100 inferências e emite relatório com média, min, max e P95.
 */

export type PlatePreviewFrameType = 'yolo-only' | 'cnn-full' | 'cnn-skipped';

export type PlatePreviewFrameSample = {
  frameIndex: number;
  frameType: PlatePreviewFrameType;
  tfBackend: string;
  drawImageMs: number;
  yoloLetterboxMs: number;
  yoloInferMs: number;
  /** GPU→CPU: tensor.array() no decode YOLO */
  yoloTensorReadMs: number;
  /** NMS + filtros JS após leitura do tensor */
  yoloDecodeLogicMs: number;
  getImageDataMs: number;
  sharpnessMs: number;
  /** Pré-processamento morfológico por caractere (índice 0–6) */
  charPreprocessMs: number[];
  /** cnn.predict() por caractere */
  charCnnPredictMs: number[];
  /** GPU→CPU: logits.data() por caractere */
  charCnnTensorReadMs: number[];
  textAssemblyMs: number;
  gateMs: number;
  overlayMs: number;
  reactSetStateMs: number;
  totalMs: number;
  longTasks: Array<{ label: string; ms: number }>;
};

export type MetricStats = {
  n: number;
  avg: number;
  min: number;
  max: number;
  p95: number;
};

export type PlatePreviewProfilerReport = {
  sampleCount: number;
  tfBackend: string;
  byFrameType: Record<PlatePreviewFrameType, number>;
  metrics: Record<string, MetricStats>;
  charPreprocess: MetricStats[];
  charCnnPredict: MetricStats[];
  charCnnTensorRead: MetricStats[];
  gpuSync: {
    yoloTensorRead: MetricStats;
    cnnTensorReadSum: MetricStats;
    combined: MetricStats;
  };
  longTasksOver16ms: Array<{
    label: string;
    count: number;
    totalMs: number;
    maxMs: number;
    avgMs: number;
    p95Ms: number;
  }>;
  topBottlenecks: Array<{ label: string; p95Ms: number; avgMs: number }>;
  analysis: string[];
};

const SAMPLE_TARGET = 100;
const LONG_TASK_THRESHOLD_MS = 16;

const samples: PlatePreviewFrameSample[] = [];
let current: Partial<PlatePreviewFrameSample> & { _started?: number } | null = null;
let frameCounter = 0;
let lastReport: PlatePreviewProfilerReport | null = null;

function isDev(): boolean {
  return import.meta.env.DEV;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function calcStats(values: number[]): MetricStats {
  const filtered = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (filtered.length === 0) {
    return { n: 0, avg: 0, min: 0, max: 0, p95: 0 };
  }
  const sorted = [...filtered].sort((a, b) => a - b);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return {
    n: sorted.length,
    avg: sum / sorted.length,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    p95: percentile(sorted, 95),
  };
}

function emptyCharArray(): number[] {
  return [0, 0, 0, 0, 0, 0, 0];
}

function ensureCurrentLongTasks(): Array<{ label: string; ms: number }> {
  if (!current) return [];
  if (!current.longTasks) current.longTasks = [];
  return current.longTasks;
}

export function isPlatePreviewProfiling(): boolean {
  return isDev() && current != null;
}

export function resetPlatePreviewPerf(): void {
  if (!isDev()) return;
  samples.length = 0;
  current = null;
  frameCounter = 0;
  lastReport = null;
}

export function beginPlatePreviewFrame(tfBackend = ''): void {
  if (!isDev()) return;
  if (samples.length === 0 && frameCounter === 0) {
    console.info(
      `[PlatePreview Profiler] Coletando ${SAMPLE_TARGET} inferências (modo placa, DEV). ` +
        'Relatório automático no console; window.__platePreviewProfilerReport ou flushPlatePreviewProfilerReport().',
    );
  }
  current = {
    _started: performance.now(),
    frameIndex: frameCounter,
    tfBackend,
    drawImageMs: 0,
    yoloLetterboxMs: 0,
    yoloInferMs: 0,
    yoloTensorReadMs: 0,
    yoloDecodeLogicMs: 0,
    getImageDataMs: 0,
    sharpnessMs: 0,
    charPreprocessMs: emptyCharArray(),
    charCnnPredictMs: emptyCharArray(),
    charCnnTensorReadMs: emptyCharArray(),
    textAssemblyMs: 0,
    gateMs: 0,
    overlayMs: 0,
    reactSetStateMs: 0,
    longTasks: [],
  };
}

export function patchPlatePreviewFrame(patch: Partial<PlatePreviewFrameSample>): void {
  if (!isDev() || !current) return;
  const { longTasks, ...rest } = patch;
  Object.assign(current, rest);
  if (longTasks?.length) {
    ensureCurrentLongTasks().push(...longTasks);
  }
}

/** Registra operação síncrona; marca long-task se > 16 ms. */
export function measurePlatePreviewSync<T>(label: string, fn: () => T): T {
  if (!isDev() || !current) return fn();
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  if (ms >= LONG_TASK_THRESHOLD_MS) {
    ensureCurrentLongTasks().push({ label, ms });
  }
  return result;
}

/** Registra operação assíncrona; marca long-task se > 16 ms. */
export async function measurePlatePreviewAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!isDev() || !current) return fn();
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  if (ms >= LONG_TASK_THRESHOLD_MS) {
    ensureCurrentLongTasks().push({ label, ms });
  }
  return result;
}

export function recordPlatePreviewCharPreprocess(charIndex: number, ms: number): void {
  if (!isDev() || !current?.charPreprocessMs) return;
  if (charIndex >= 0 && charIndex < 7) {
    current.charPreprocessMs[charIndex] = ms;
    if (ms >= LONG_TASK_THRESHOLD_MS) {
      ensureCurrentLongTasks().push({ label: `char${charIndex + 1}.preprocess`, ms });
    }
  }
}

export function recordPlatePreviewCharCnn(
  charIndex: number,
  predictMs: number,
  tensorReadMs: number,
): void {
  if (!isDev() || !current) return;
  if (charIndex >= 0 && charIndex < 7) {
    current.charCnnPredictMs![charIndex] = predictMs;
    current.charCnnTensorReadMs![charIndex] = tensorReadMs;
    if (predictMs >= LONG_TASK_THRESHOLD_MS) {
      ensureCurrentLongTasks().push({ label: `char${charIndex + 1}.cnn.predict`, ms: predictMs });
    }
    if (tensorReadMs >= LONG_TASK_THRESHOLD_MS) {
      ensureCurrentLongTasks().push({ label: `char${charIndex + 1}.cnn.tensorRead`, ms: tensorReadMs });
    }
  }
}

export function endPlatePreviewFrame(
  patch?: Partial<PlatePreviewFrameSample> & {
    frameType?: PlatePreviewFrameType;
  },
): void {
  if (!isDev() || !current) return;

  const started = current._started ?? performance.now();
  const { _started: _, longTasks = [], ...rest } = current;
  const p = patch ?? {};

  const sample: PlatePreviewFrameSample = {
    frameIndex: frameCounter,
    frameType: p.frameType ?? rest.frameType ?? 'yolo-only',
    tfBackend: p.tfBackend ?? rest.tfBackend ?? '',
    drawImageMs: p.drawImageMs ?? rest.drawImageMs ?? 0,
    yoloLetterboxMs: p.yoloLetterboxMs ?? rest.yoloLetterboxMs ?? 0,
    yoloInferMs: p.yoloInferMs ?? rest.yoloInferMs ?? 0,
    yoloTensorReadMs: p.yoloTensorReadMs ?? rest.yoloTensorReadMs ?? 0,
    yoloDecodeLogicMs: p.yoloDecodeLogicMs ?? rest.yoloDecodeLogicMs ?? 0,
    getImageDataMs: p.getImageDataMs ?? rest.getImageDataMs ?? 0,
    sharpnessMs: p.sharpnessMs ?? rest.sharpnessMs ?? 0,
    charPreprocessMs: [...(p.charPreprocessMs ?? rest.charPreprocessMs ?? emptyCharArray())],
    charCnnPredictMs: [...(p.charCnnPredictMs ?? rest.charCnnPredictMs ?? emptyCharArray())],
    charCnnTensorReadMs: [...(p.charCnnTensorReadMs ?? rest.charCnnTensorReadMs ?? emptyCharArray())],
    textAssemblyMs: p.textAssemblyMs ?? rest.textAssemblyMs ?? 0,
    gateMs: p.gateMs ?? rest.gateMs ?? 0,
    overlayMs: p.overlayMs ?? rest.overlayMs ?? 0,
    reactSetStateMs: p.reactSetStateMs ?? rest.reactSetStateMs ?? 0,
    totalMs: performance.now() - started,
    longTasks: [...longTasks, ...(p.longTasks ?? [])],
  };

  current = null;
  frameCounter += 1;
  samples.push(sample);

  if (samples.length === SAMPLE_TARGET) {
    lastReport = buildProfilerReport(samples);
    printProfilerReport(lastReport);
  } else if (samples.length > 0 && samples.length % 25 === 0) {
    console.log(`[PlatePreview Profiler] ${samples.length}/${SAMPLE_TARGET} inferências coletadas…`);
  }
}

function buildProfilerReport(allSamples: PlatePreviewFrameSample[]): PlatePreviewProfilerReport {
  const byFrameType: Record<PlatePreviewFrameType, number> = {
    'yolo-only': 0,
    'cnn-full': 0,
    'cnn-skipped': 0,
  };
  for (const s of allSamples) byFrameType[s.frameType] += 1;

  const pick = (fn: (s: PlatePreviewFrameSample) => number) =>
    allSamples.map(fn);

  const cnnFull = allSamples.filter((s) => s.frameType === 'cnn-full');

  const charPreprocessArrays = cnnFull.map((s) => s.charPreprocessMs);
  const charCnnPredictArrays = cnnFull.map((s) => s.charCnnPredictMs);
  const charCnnReadArrays = cnnFull.map((s) => s.charCnnTensorReadMs);

  const charPreprocess = Array.from({ length: 7 }, (_, i) =>
    calcStats(charPreprocessArrays.map((row) => row[i] ?? 0).filter((v) => v > 0)),
  );
  const charCnnPredict = Array.from({ length: 7 }, (_, i) =>
    calcStats(charCnnPredictArrays.map((row) => row[i] ?? 0).filter((v) => v > 0)),
  );
  const charCnnTensorRead = Array.from({ length: 7 }, (_, i) =>
    calcStats(charCnnReadArrays.map((row) => row[i] ?? 0).filter((v) => v > 0)),
  );

  const cnnTensorReadSumPerFrame = cnnFull.map((s) =>
    s.charCnnTensorReadMs.reduce((a, b) => a + b, 0),
  );
  const gpuSyncCombined = cnnFull.map(
    (s) => s.yoloTensorReadMs + s.charCnnTensorReadMs.reduce((a, b) => a + b, 0),
  );

  const metricDefs: Array<{ key: string; fn: (s: PlatePreviewFrameSample) => number }> = [
    { key: 'totalMs', fn: (s) => s.totalMs },
    { key: 'drawImageMs', fn: (s) => s.drawImageMs },
    { key: 'yoloLetterboxMs', fn: (s) => s.yoloLetterboxMs },
    { key: 'yoloInferMs', fn: (s) => s.yoloInferMs },
    { key: 'yoloTensorReadMs', fn: (s) => s.yoloTensorReadMs },
    { key: 'yoloDecodeLogicMs', fn: (s) => s.yoloDecodeLogicMs },
    { key: 'getImageDataMs', fn: (s) => s.getImageDataMs },
    { key: 'sharpnessMs', fn: (s) => s.sharpnessMs },
    { key: 'textAssemblyMs', fn: (s) => s.textAssemblyMs },
    { key: 'gateMs', fn: (s) => s.gateMs },
    { key: 'overlayMs', fn: (s) => s.overlayMs },
    { key: 'reactSetStateMs', fn: (s) => s.reactSetStateMs },
    {
      key: 'charPreprocessTotalMs',
      fn: (s) => s.charPreprocessMs.reduce((a, b) => a + b, 0),
    },
    {
      key: 'charCnnPredictTotalMs',
      fn: (s) => s.charCnnPredictMs.reduce((a, b) => a + b, 0),
    },
    {
      key: 'charCnnTensorReadTotalMs',
      fn: (s) => s.charCnnTensorReadMs.reduce((a, b) => a + b, 0),
    },
    {
      key: 'gpuSyncTotalMs',
      fn: (s) => s.yoloTensorReadMs + s.charCnnTensorReadMs.reduce((a, b) => a + b, 0),
    },
  ];

  const metrics: Record<string, MetricStats> = {};
  for (const { key, fn } of metricDefs) {
    metrics[key] = calcStats(pick(fn));
  }

  const longTaskMap = new Map<string, number[]>();
  for (const s of allSamples) {
    for (const t of s.longTasks) {
      const list = longTaskMap.get(t.label) ?? [];
      list.push(t.ms);
      longTaskMap.set(t.label, list);
    }
  }
  const longTasksOver16ms = [...longTaskMap.entries()]
    .map(([label, times]) => {
      const st = calcStats(times);
      return {
        label,
        count: st.n,
        totalMs: times.reduce((a, b) => a + b, 0),
        maxMs: st.max,
        avgMs: st.avg,
        p95Ms: st.p95,
      };
    })
    .sort((a, b) => b.p95Ms - a.p95Ms);

  const bottleneckCandidates = [
    { label: 'drawImage', stats: metrics.drawImageMs },
    { label: 'yoloLetterbox', stats: metrics.yoloLetterboxMs },
    { label: 'yoloInfer', stats: metrics.yoloInferMs },
    { label: 'yoloTensorRead (GPU→CPU)', stats: metrics.yoloTensorReadMs },
    { label: 'yoloDecodeLogic', stats: metrics.yoloDecodeLogicMs },
    { label: 'getImageData', stats: metrics.getImageDataMs },
    { label: 'sharpness', stats: metrics.sharpnessMs },
    { label: 'charPreprocessTotal', stats: metrics.charPreprocessTotalMs },
    { label: 'charCnnPredictTotal', stats: metrics.charCnnPredictTotalMs },
    { label: 'charCnnTensorReadTotal (GPU→CPU)', stats: metrics.charCnnTensorReadTotalMs },
    { label: 'gpuSyncTotal (YOLO read + CNN reads)', stats: metrics.gpuSyncTotalMs },
    { label: 'textAssembly', stats: metrics.textAssemblyMs },
    { label: 'gate', stats: metrics.gateMs },
    { label: 'overlay', stats: metrics.overlayMs },
    { label: 'reactSetState', stats: metrics.reactSetStateMs },
  ].sort((a, b) => b.stats.p95 - a.stats.p95);

  const topBottlenecks = bottleneckCandidates.slice(0, 8).map((b) => ({
    label: b.label,
    p95Ms: b.stats.p95,
    avgMs: b.stats.avg,
  }));

  const analysis: string[] = [];
  const backend = allSamples[allSamples.length - 1]?.tfBackend ?? 'unknown';
  const gpuP95 = metrics.gpuSyncTotalMs?.p95 ?? 0;
  const cnnPredictP95 = metrics.charCnnPredictTotalMs?.p95 ?? 0;
  const cnnReadP95 = metrics.charCnnTensorReadTotalMs?.p95 ?? 0;
  const yoloReadP95 = metrics.yoloTensorReadMs?.p95 ?? 0;
  const preprocessP95 = metrics.charPreprocessTotalMs?.p95 ?? 0;
  const yoloInferP95 = metrics.yoloInferMs?.p95 ?? 0;

  analysis.push(`Backend TensorFlow.js: ${backend}`);
  analysis.push(
    `Frames: ${allSamples.length} total | yolo-only=${byFrameType['yolo-only']} | cnn-full=${byFrameType['cnn-full']} | cnn-skipped=${byFrameType['cnn-skipped']}`,
  );

  if (gpuP95 >= cnnPredictP95 && gpuP95 >= yoloInferP95 && gpuP95 >= preprocessP95) {
    analysis.push(
      `GPU→CPU (tensor.array + logits.data) domina no P95: ${gpuP95.toFixed(1)} ms ` +
        `(YOLO read P95=${yoloReadP95.toFixed(1)} ms, CNN reads P95=${cnnReadP95.toFixed(1)} ms).`,
    );
  } else if (cnnPredictP95 >= preprocessP95 && cnnPredictP95 >= yoloInferP95) {
    analysis.push(
      `Inferência CNN (predict) domina no P95: ${cnnPredictP95.toFixed(1)} ms ` +
        `(GPU→CPU reads P95=${cnnReadP95.toFixed(1)} ms).`,
    );
  } else if (preprocessP95 >= yoloInferP95) {
    analysis.push(`Pré-processamento morfológico CPU domina no P95: ${preprocessP95.toFixed(1)} ms.`);
  } else {
    analysis.push(`Inferência YOLO domina no P95: ${yoloInferP95.toFixed(1)} ms.`);
  }

  const longTaskCount = longTasksOver16ms.reduce((s, t) => s + t.count, 0);
  if (longTaskCount > 0) {
    analysis.push(
      `Detectadas ${longTaskCount} operações síncronas > ${LONG_TASK_THRESHOLD_MS} ms. ` +
        `Maior ofensor: "${longTasksOver16ms[0]?.label}" P95=${longTasksOver16ms[0]?.p95Ms.toFixed(1)} ms.`,
    );
  }

  return {
    sampleCount: allSamples.length,
    tfBackend: backend,
    byFrameType,
    metrics,
    charPreprocess,
    charCnnPredict,
    charCnnTensorRead,
    gpuSync: {
      yoloTensorRead: calcStats(pick((s) => s.yoloTensorReadMs)),
      cnnTensorReadSum: calcStats(cnnTensorReadSumPerFrame),
      combined: calcStats(gpuSyncCombined.length ? gpuSyncCombined : pick((s) => s.yoloTensorReadMs)),
    },
    longTasksOver16ms,
    topBottlenecks,
    analysis,
  };
}

function printProfilerReport(report: PlatePreviewProfilerReport): void {
  console.group(`[PlatePreview Profiler] Relatório — ${report.sampleCount} inferências`);
  console.log('Análise:', report.analysis.join(' | '));

  const tableRows: Record<string, string> = {};
  for (const [key, st] of Object.entries(report.metrics)) {
    if (st.n === 0) continue;
    tableRows[key] = `avg=${st.avg.toFixed(1)} min=${st.min.toFixed(1)} max=${st.max.toFixed(1)} p95=${st.p95.toFixed(1)} (n=${st.n})`;
  }
  console.table(tableRows);

  console.group('Por caractere (frames cnn-full)');
  for (let i = 0; i < 7; i++) {
    const pp = report.charPreprocess[i];
    const cp = report.charCnnPredict[i];
    const cr = report.charCnnTensorRead[i];
    if (pp.n === 0 && cp.n === 0) continue;
    console.log(
      `Char ${i + 1}: preprocess p95=${pp.p95.toFixed(1)}ms | ` +
        `cnn.predict p95=${cp.p95.toFixed(1)}ms | cnn.tensorRead p95=${cr.p95.toFixed(1)}ms`,
    );
  }
  console.groupEnd();

  console.group('GPU→CPU sync');
  console.table({
    yoloTensorRead: report.gpuSync.yoloTensorRead,
    cnnTensorReadSum: report.gpuSync.cnnTensorReadSum,
    combined: report.gpuSync.combined,
  });
  console.groupEnd();

  console.group('Top gargalos (P95)');
  console.table(report.topBottlenecks);
  console.groupEnd();

  if (report.longTasksOver16ms.length > 0) {
    console.group(`Long tasks > ${LONG_TASK_THRESHOLD_MS} ms`);
    console.table(report.longTasksOver16ms);
    console.groupEnd();
  }

  console.groupEnd();

  if (typeof window !== 'undefined') {
    (window as unknown as { __platePreviewProfilerReport?: PlatePreviewProfilerReport }).__platePreviewProfilerReport =
      report;
  }
}

export function getPlatePreviewProfilerReport(): PlatePreviewProfilerReport | null {
  return lastReport;
}

/** Força relatório com amostras já coletadas (útil antes de 100). */
export function flushPlatePreviewProfilerReport(): PlatePreviewProfilerReport | null {
  if (!isDev() || samples.length === 0) return null;
  lastReport = buildProfilerReport(samples);
  printProfilerReport(lastReport);
  return lastReport;
}

export function getPlatePreviewSampleCount(): number {
  return samples.length;
}

/** Compat: métricas pós-captura OCR (plateOcrPerf). */
export function recordPlatePreviewFrame(): void {
  /* legado — use endPlatePreviewFrame */
}
