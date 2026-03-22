/**
 * Character Segmentation & Geometric Classifier
 * 
 * Uses Connected Component Labeling (CCL) to isolate individual characters
 * from a binarized plate image, then classifies ambiguous chars (Q/O, I/1)
 * using geometric feature analysis.
 * 
 * Pipeline: CCL → Filter by aspect ratio → Sort left-to-right → Pick top 7 →
 *           Normalize each to 64×128 with 10px white padding → Classify
 */

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════
interface CharFeatures {
  aspectRatio: number;
  fillRatio: number;
  holeCount: number;
  hasTail: boolean;
  hasSerif: boolean;
  topHeavy: number;
  leftHeavy: number;
  verticalSymmetry: number;
  bottomRightDensity: number;
  centerHoleFraction: number;
}

export interface SegmentedChar {
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  /** Normalized 64×128 character image as data URL */
  debugImage?: string;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Connected Component Labeling (CCL) — 4-connected, on dark pixels
// ═══════════════════════════════════════════════════════════════════════════════
interface CCLComponent {
  label: number;
  pixels: number[];
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  area: number;
}

function connectedComponentLabeling(
  data: Uint8ClampedArray, w: number, h: number
): CCLComponent[] {
  const labels = new Int32Array(w * h);
  let nextLabel = 1;
  const components: Map<number, CCLComponent> = new Map();

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = y * w + x;
      if (data[idx * 4] >= 128 || labels[idx] !== 0) continue;

      // BFS flood fill
      const label = nextLabel++;
      const queue = [idx];
      labels[idx] = label;
      const comp: CCLComponent = {
        label, pixels: [], minX: x, maxX: x, minY: y, maxY: y, area: 0
      };

      while (queue.length > 0) {
        const ci = queue.pop()!;
        comp.pixels.push(ci);
        comp.area++;
        const cx = ci % w, cy = Math.floor(ci / w);
        comp.minX = Math.min(comp.minX, cx);
        comp.maxX = Math.max(comp.maxX, cx);
        comp.minY = Math.min(comp.minY, cy);
        comp.maxY = Math.max(comp.maxY, cy);

        const neighbors = [
          cy > 0 ? ci - w : -1,
          cy < h - 1 ? ci + w : -1,
          cx > 0 ? ci - 1 : -1,
          cx < w - 1 ? ci + 1 : -1,
        ];
        for (const ni of neighbors) {
          if (ni >= 0 && labels[ni] === 0 && data[ni * 4] < 128) {
            labels[ni] = label;
            queue.push(ni);
          }
        }
      }

      components.set(label, comp);
    }
  }

  return Array.from(components.values());
}

// ═══════════════════════════════════════════════════════════════════════════════
// Filter & Select Character Components
// ═══════════════════════════════════════════════════════════════════════════════
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function filterBestSeven(candidates: SegmentedChar[]): SegmentedChar[] {
  if (candidates.length <= 7) {
    return [...candidates].sort((a, b) => a.x - b.x);
  }

  const medH = median(candidates.map(c => c.h));
  const ranked = [...candidates].sort((a, b) => {
    const da = Math.abs(a.h - medH);
    const db = Math.abs(b.h - medH);
    return da - db;
  });

  const best = ranked.slice(0, 7);
  best.sort((a, b) => a.x - b.x);
  return best;
}

function filterCharComponents(
  components: CCLComponent[], imgW: number, imgH: number
): SegmentedChar[] {
  // Geometric filtering to ignore QR Code (square) and small noise (bolts/dirt)
  const filtered = components.filter(c => {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const ar = bw / bh;
    const heightRatio = bh / imgH;
    const areaRatio = c.area / (imgW * imgH);

    // aspectRatio: ignore squares (QR ~ 1.0) and wide blobs (borders/stripes)
    if (ar <= 0.15 || ar >= 0.75) return false;
    // heightRatio: chars occupy much of crop height
    if (heightRatio <= 0.4) return false;
    // areaRatio: ignore tiny noise
    if (areaRatio <= 0.005) return false;
    return true;
  });

  // Sort left-to-right by minX for stable merging / selection
  filtered.sort((a, b) => a.minX - b.minX);

  // Merge overlapping/adjacent components (parts of same character)
  const merged: SegmentedChar[] = [];
  for (const c of filtered) {
    const bw = c.maxX - c.minX + 1;
    const bh = c.maxY - c.minY + 1;
    const last = merged[merged.length - 1];
    // If this component overlaps horizontally with the last, merge them
    if (last && c.minX < last.x + last.w * 0.6) {
      last.w = Math.max(last.x + last.w, c.maxX + 1) - last.x;
      last.y = Math.min(last.y, c.minY);
      last.h = Math.max(last.y + last.h, c.maxY + 1) - last.y;
      last.area += c.area;
    } else {
      merged.push({ x: c.minX, y: c.minY, w: bw, h: bh, area: c.area });
    }
  }

  // If more than 7 remain, choose the best-aligned row of blobs that looks like a plate line.
  // Prefer groups of 5–7 characters that share a similar Y coordinate (within 10% of image height),
  // then within that row pick the 7 whose heights best match the median height.
  if (merged.length === 0) return [];

  const tolY = imgH * 0.10;
  const centers = merged.map(s => s.y + s.h / 2);
  let bestGroup: SegmentedChar[] = [];

  for (let i = 0; i < merged.length; i++) {
    const baseCy = centers[i];
    const group: SegmentedChar[] = [];
    for (let j = 0; j < merged.length; j++) {
      if (Math.abs(centers[j] - baseCy) <= tolY) {
        group.push(merged[j]);
      }
    }
    if (group.length > bestGroup.length) {
      bestGroup = group;
    }
  }

  // Prefer rows with between 5 and 7 blobs; if best row is outside this range, fall back to median-based selection.
  if (bestGroup.length >= 5 && bestGroup.length <= 7) {
    return filterBestSeven(bestGroup);
  }

  return filterBestSeven(merged);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Normalize Character — crop, resize to 64×128, add 10px white padding
// ═══════════════════════════════════════════════════════════════════════════════
const CHAR_W = 64;
const CHAR_H = 128;
const CHAR_PAD = 10;

export function normalizeCharImage(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  seg: SegmentedChar
): { canvas: HTMLCanvasElement; dataUrl: string } {
  // Extract the character region from original image
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = seg.w;
  srcCanvas.height = seg.h;
  const srcCtx = srcCanvas.getContext('2d')!;
  const srcData = srcCtx.createImageData(seg.w, seg.h);

  for (let dy = 0; dy < seg.h; dy++) {
    for (let dx = 0; dx < seg.w; dx++) {
      const sx = seg.x + dx;
      const sy = seg.y + dy;
      if (sx >= 0 && sx < imgW && sy >= 0 && sy < imgH) {
        const si = (sy * imgW + sx) * 4;
        const di = (dy * seg.w + dx) * 4;
        srcData.data[di] = data[si];
        srcData.data[di + 1] = data[si + 1];
        srcData.data[di + 2] = data[si + 2];
        srcData.data[di + 3] = 255;
      }
    }
  }
  srcCtx.putImageData(srcData, 0, 0);

  // Create normalized canvas with padding
  const outW = CHAR_W + CHAR_PAD * 2;
  const outH = CHAR_H + CHAR_PAD * 2;
  const outCanvas = document.createElement('canvas');
  outCanvas.width = outW;
  outCanvas.height = outH;
  const outCtx = outCanvas.getContext('2d')!;

  // White background
  outCtx.fillStyle = '#FFFFFF';
  outCtx.fillRect(0, 0, outW, outH);

  // Draw character centered with padding, preserving aspect ratio
  const scale = Math.min(CHAR_W / seg.w, CHAR_H / seg.h);
  const drawW = Math.round(seg.w * scale);
  const drawH = Math.round(seg.h * scale);
  const drawX = CHAR_PAD + Math.round((CHAR_W - drawW) / 2);
  const drawY = CHAR_PAD + Math.round((CHAR_H - drawH) / 2);

  outCtx.imageSmoothingEnabled = false;
  outCtx.drawImage(srcCanvas, 0, 0, seg.w, seg.h, drawX, drawY, drawW, drawH);

  return { canvas: outCanvas, dataUrl: outCanvas.toDataURL('image/png') };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Segmentation Public API — returns segments + debug images
// ═══════════════════════════════════════════════════════════════════════════════
export function segmentPlateCharacters(
  data: Uint8ClampedArray, w: number, h: number
): SegmentedChar[] {
  console.log(`[CCL] Starting segmentation on ${w}×${h} image`);
  const components = connectedComponentLabeling(data, w, h);
  console.log(`[CCL] Found ${components.length} connected components`);

  const segments = filterCharComponents(components, w, h);
  console.log(`[CCL] Filtered to ${segments.length} character candidates`);

  // Generate debug images for each segment
  for (const seg of segments) {
    const { dataUrl } = normalizeCharImage(data, w, h, seg);
    seg.debugImage = dataUrl;
  }

  return segments;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Feature Extraction (same as before but cleaner)
// ═══════════════════════════════════════════════════════════════════════════════

function extractCharBitmap(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  seg: SegmentedChar
): { bitmap: Uint8Array; w: number; h: number } {
  const bitmap = new Uint8Array(seg.w * seg.h);
  for (let y = 0; y < seg.h; y++) {
    for (let x = 0; x < seg.w; x++) {
      const sx = seg.x + x, sy = seg.y + y;
      if (sx >= 0 && sx < imgW && sy >= 0 && sy < imgH) {
        bitmap[y * seg.w + x] = data[(sy * imgW + sx) * 4] < 128 ? 1 : 0;
      }
    }
  }
  return { bitmap, w: seg.w, h: seg.h };
}

function normalizeCharBitmap(
  bitmap: Uint8Array, w: number, h: number
): { bitmap: Uint8Array; w: number; h: number } {
  const SIZE = 32;
  const normalized = new Uint8Array(SIZE * SIZE);
  const scaleX = w / SIZE, scaleY = h / SIZE;
  for (let ny = 0; ny < SIZE; ny++) {
    for (let nx = 0; nx < SIZE; nx++) {
      const srcX = Math.min(Math.floor(nx * scaleX), w - 1);
      const srcY = Math.min(Math.floor(ny * scaleY), h - 1);
      normalized[ny * SIZE + nx] = bitmap[srcY * w + srcX];
    }
  }
  return { bitmap: normalized, w: SIZE, h: SIZE };
}

function countHoles(bitmap: Uint8Array, w: number, h: number): number {
  const visited = new Uint8Array(w * h);
  const queue: number[] = [];

  // Flood from borders
  for (let x = 0; x < w; x++) {
    if (bitmap[x] === 0 && !visited[x]) { queue.push(x); visited[x] = 1; }
    const bi = (h - 1) * w + x;
    if (bitmap[bi] === 0 && !visited[bi]) { queue.push(bi); visited[bi] = 1; }
  }
  for (let y = 0; y < h; y++) {
    const li = y * w;
    if (bitmap[li] === 0 && !visited[li]) { queue.push(li); visited[li] = 1; }
    const ri = y * w + (w - 1);
    if (bitmap[ri] === 0 && !visited[ri]) { queue.push(ri); visited[ri] = 1; }
  }

  while (queue.length > 0) {
    const idx = queue.shift()!;
    const x = idx % w, y = Math.floor(idx / w);
    const neighbors = [
      y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1,
      x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1,
    ];
    for (const ni of neighbors) {
      if (ni >= 0 && !visited[ni] && bitmap[ni] === 0) { visited[ni] = 1; queue.push(ni); }
    }
  }

  let holes = 0;
  for (let i = 0; i < w * h; i++) {
    if (bitmap[i] === 0 && !visited[i]) {
      holes++;
      const holeQueue = [i]; visited[i] = 1;
      while (holeQueue.length > 0) {
        const idx = holeQueue.shift()!;
        const x = idx % w, y = Math.floor(idx / w);
        const neighbors = [
          y > 0 ? idx - w : -1, y < h - 1 ? idx + w : -1,
          x > 0 ? idx - 1 : -1, x < w - 1 ? idx + 1 : -1,
        ];
        for (const ni of neighbors) {
          if (ni >= 0 && !visited[ni] && bitmap[ni] === 0) { visited[ni] = 1; holeQueue.push(ni); }
        }
      }
    }
  }
  return holes;
}

function detectTail(bitmap: Uint8Array, w: number, h: number): boolean {
  const startY = Math.floor(h * 0.6);
  const midX = Math.floor(w / 2);

  let brDark = 0, blDark = 0;
  for (let y = startY; y < h; y++) {
    for (let x = midX; x < w; x++) if (bitmap[y * w + x] === 1) brDark++;
    for (let x = 0; x < midX; x++) if (bitmap[y * w + x] === 1) blDark++;
  }

  let diagonalScore = 0;
  const diagLen = Math.min(w - midX, h - startY);
  for (let d = 0; d < diagLen; d++) {
    const x = midX + Math.floor(d * (w - midX) / diagLen);
    const y = startY + Math.floor(d * (h - startY) / diagLen);
    if (x < w && y < h && bitmap[y * w + x] === 1) diagonalScore++;
  }
  const diagRatio = diagLen > 0 ? diagonalScore / diagLen : 0;

  const bottomRows = Math.max(3, Math.floor(h * 0.15));
  let bottomRightDark = 0, bottomLeftDark = 0;
  for (let y = h - bottomRows; y < h; y++) {
    for (let x = midX; x < w; x++) if (bitmap[y * w + x] === 1) bottomRightDark++;
    for (let x = 0; x < midX; x++) if (bitmap[y * w + x] === 1) bottomLeftDark++;
  }

  const asymmetry = bottomRightDark / Math.max(1, bottomLeftDark);
  const overallAsymmetry = brDark / Math.max(1, blDark);

  return (asymmetry > 1.3 && diagRatio > 0.2) || (overallAsymmetry > 1.4 && asymmetry > 1.2);
}

function detectSerif(bitmap: Uint8Array, w: number, h: number): boolean {
  const bottomRows = Math.max(2, Math.floor(h * 0.15));
  const midRows = Math.floor(h * 0.1);
  const midStart = Math.floor(h * 0.4);

  let bottomWidth = 0, midWidth = 0;
  for (let y = h - bottomRows; y < h; y++) {
    let minX = w, maxX = 0;
    for (let x = 0; x < w; x++) {
      if (bitmap[y * w + x] === 1) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    bottomWidth += maxX - minX;
  }
  bottomWidth /= bottomRows;
  for (let y = midStart; y < midStart + midRows; y++) {
    let minX = w, maxX = 0;
    for (let x = 0; x < w; x++) {
      if (bitmap[y * w + x] === 1) { minX = Math.min(minX, x); maxX = Math.max(maxX, x); }
    }
    midWidth += maxX - minX;
  }
  midWidth /= Math.max(1, midRows);
  return bottomWidth > midWidth * 1.4;
}

function extractFeatures(bitmap: Uint8Array, w: number, h: number): CharFeatures {
  let totalDark = 0, topDark = 0, bottomDark = 0, leftDark = 0, rightDark = 0, brDark = 0;
  const midY = Math.floor(h / 2), midX = Math.floor(w / 2);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (bitmap[y * w + x] === 1) {
        totalDark++;
        if (y < midY) topDark++; else bottomDark++;
        if (x < midX) leftDark++; else rightDark++;
        if (y >= midY && x >= midX) brDark++;
      }
    }
  }

  const total = w * h;
  const cX1 = Math.floor(w * 0.25), cX2 = Math.floor(w * 0.75);
  const cY1 = Math.floor(h * 0.25), cY2 = Math.floor(h * 0.75);
  let centerWhite = 0, centerTotal = 0;
  for (let y = cY1; y < cY2; y++) {
    for (let x = cX1; x < cX2; x++) {
      centerTotal++;
      if (bitmap[y * w + x] === 0) centerWhite++;
    }
  }

  let symMatch = 0, symTotal = 0;
  for (let y = 0; y < h; y++) {
    for (let dx = 0; dx < midX; dx++) {
      symTotal++;
      if (bitmap[y * w + dx] === bitmap[y * w + (w - 1 - dx)]) symMatch++;
    }
  }

  return {
    aspectRatio: w / h,
    fillRatio: totalDark / total,
    holeCount: countHoles(bitmap, w, h),
    hasTail: detectTail(bitmap, w, h),
    hasSerif: detectSerif(bitmap, w, h),
    topHeavy: topDark / Math.max(1, bottomDark),
    leftHeavy: leftDark / Math.max(1, rightDark),
    verticalSymmetry: symTotal > 0 ? symMatch / symTotal : 0,
    bottomRightDensity: brDark / Math.max(1, totalDark),
    centerHoleFraction: centerTotal > 0 ? centerWhite / centerTotal : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Classification Rules
// ═══════════════════════════════════════════════════════════════════════════════

function classifyQvsO(f: CharFeatures): { char: 'Q' | 'O'; confidence: number } {
  let qScore = 0, oScore = 0;
  if (f.hasTail) { qScore += 40; } else { oScore += 30; }
  if (f.bottomRightDensity > 0.3) { qScore += 15; } else { oScore += 10; }
  if (f.verticalSymmetry > 0.85) { oScore += 20; } else { qScore += 10; }
  if (f.fillRatio > 0.4) { qScore += 5; } else { oScore += 5; }
  const total = qScore + oScore;
  return qScore > oScore
    ? { char: 'Q', confidence: (qScore / total) * 100 }
    : { char: 'O', confidence: (oScore / total) * 100 };
}

function classifyIvs1(f: CharFeatures): { char: 'I' | '1'; confidence: number } {
  let iScore = 0, oneScore = 0;
  if (f.aspectRatio < 0.35) { iScore += 25; } else { oneScore += 15; }
  if (f.hasSerif) { oneScore += 35; } else { iScore += 20; }
  if (f.topHeavy > 1.1) { oneScore += 10; }
  if (f.verticalSymmetry > 0.9) { iScore += 15; } else { oneScore += 10; }
  if (f.fillRatio > 0.6) { iScore += 5; }
  const total = iScore + oneScore;
  return iScore > oneScore
    ? { char: 'I', confidence: (iScore / total) * 100 }
    : { char: '1', confidence: (oneScore / total) * 100 };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Per-Character Geometric Classification (after Tesseract SINGLE_CHAR)
// ═══════════════════════════════════════════════════════════════════════════════
export function classifyCharGeometric(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  seg: SegmentedChar, ocrChar: string, positionType: 'letter' | 'digit'
): { correctedChar: string; correction?: string } {
  const raw = extractCharBitmap(data, imgW, imgH, seg);
  if (raw.w < 3 || raw.h < 3) return { correctedChar: ocrChar };

  const { bitmap, w, h } = normalizeCharBitmap(raw.bitmap, raw.w, raw.h);
  const features = extractFeatures(bitmap, w, h);

  if (positionType === 'letter') {
    if (ocrChar === 'O' || ocrChar === '0' || ocrChar === 'Q') {
      const result = classifyQvsO(features);
      if (result.char !== ocrChar) {
        return {
          correctedChar: result.char,
          correction: `'${ocrChar}' → '${result.char}' (${result.confidence.toFixed(0)}% conf, tail=${features.hasTail})`
        };
      }
    }
    if (ocrChar === '1' || ocrChar === 'I') {
      return { correctedChar: 'I', correction: ocrChar !== 'I' ? `'${ocrChar}' → 'I' (letter pos)` : undefined };
    }
  }

  if (positionType === 'digit') {
    if (ocrChar === 'O' || ocrChar === 'Q') {
      return { correctedChar: '0', correction: `'${ocrChar}' → '0' (digit pos)` };
    }
    if (ocrChar === 'I' || ocrChar === 'l') {
      return { correctedChar: '1', correction: `'${ocrChar}' → '1' (digit pos)` };
    }
  }

  return { correctedChar: ocrChar };
}

// Legacy export for compatibility
export async function classifyAmbiguousChars(
  imageData: Uint8ClampedArray, imgW: number, imgH: number,
  segments: SegmentedChar[], ocrText: string,
  positions: 'mercosul' | 'old'
): Promise<{ correctedText: string; corrections: string[] }> {
  const chars = ocrText.split('');
  const corrections: string[] = [];
  const letterPositions = positions === 'mercosul' ? [0, 1, 2, 4] : [0, 1, 2];
  const digitPositions = positions === 'mercosul' ? [3, 5, 6] : [3, 4, 5, 6];

  for (let i = 0; i < Math.min(chars.length, segments.length, 7); i++) {
    const isLetterPos = letterPositions.includes(i);
    const isDigitPos = digitPositions.includes(i);
    const posType = isLetterPos ? 'letter' as const : isDigitPos ? 'digit' as const : 'letter' as const;

    const { correctedChar, correction } = classifyCharGeometric(
      imageData, imgW, imgH, segments[i], chars[i], posType
    );
    if (correction) {
      corrections.push(`Pos ${i + 1}: ${correction}`);
      chars[i] = correctedChar;
    }
  }

  return { correctedText: chars.join(''), corrections };
}

export function quickQOAnalysis(
  data: Uint8ClampedArray, imgW: number, imgH: number,
  segX: number, segW: number
): 'Q' | 'O' {
  const seg: SegmentedChar = { x: segX, y: 0, w: segW, h: imgH, area: 0 };
  const raw = extractCharBitmap(data, imgW, imgH, seg);
  if (raw.w < 3 || raw.h < 3) return 'O';
  const features = extractFeatures(raw.bitmap, raw.w, raw.h);
  return classifyQvsO(features).char;
}
