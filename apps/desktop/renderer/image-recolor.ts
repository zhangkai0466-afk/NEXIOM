export const MAX_RECOLOR_PIXELS = 20_000_000;

export type RecolorMode = "connected" | "global";

export interface RecolorSelectionOptions {
  x: number;
  y: number;
  tolerance: number;
  mode: RecolorMode;
  feather?: number;
}

export interface RecolorOperation extends RecolorSelectionOptions {
  target: string;
}

export interface PixelSample {
  r: number;
  g: number;
  b: number;
  a: number;
  hex: string;
}

export interface PixelBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RecolorSelection {
  mask: Uint8Array;
  selectedPixels: number;
  bounds: PixelBounds | null;
  source: PixelSample;
}

export interface RecolorStepSummary {
  changedPixels: number;
  selectedPixels: number;
  bounds: PixelBounds | null;
  source: PixelSample;
  target: string;
}

export interface RecolorResult extends RecolorSelection, RecolorStepSummary {
  pixels: Uint8ClampedArray;
}

export interface RecolorReplayResult {
  pixels: Uint8ClampedArray;
  steps: RecolorStepSummary[];
  changedPixels: number;
}

export interface ImageAdjustments {
  brightness?: number;
  contrast?: number;
  saturation?: number;
}

export interface ImageAdjustmentResult {
  pixels: Uint8ClampedArray;
  changedPixels: number;
  adjustments: Required<ImageAdjustments>;
}

type Oklab = readonly [l: number, a: number, b: number];

function validateImage(pixels: Uint8ClampedArray, width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0)
    throw new RangeError("Image dimensions must be positive integers.");
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || pixelCount > MAX_RECOLOR_PIXELS)
    throw new RangeError(`Image exceeds the ${MAX_RECOLOR_PIXELS.toLocaleString("en-US")} pixel limit.`);
  if (!(pixels instanceof Uint8ClampedArray) || pixels.length !== pixelCount * 4)
    throw new RangeError("RGBA buffer length does not match the image dimensions.");
}

function validateSelection(options: RecolorSelectionOptions, width: number, height: number) {
  if (!Number.isFinite(options.x) || !Number.isFinite(options.y))
    throw new RangeError("Selection coordinates must be finite numbers.");
  const x = Math.floor(options.x);
  const y = Math.floor(options.y);
  if (x < 0 || x >= width || y < 0 || y >= height)
    throw new RangeError("Selection coordinates are outside the image.");
  if (!Number.isFinite(options.tolerance) || options.tolerance < 0 || options.tolerance > 40)
    throw new RangeError("Tolerance must be between 0 and 40 OKLab delta-E units.");
  if (options.mode !== "connected" && options.mode !== "global")
    throw new TypeError("Recolor mode must be connected or global.");
  const feather = options.feather ?? 0.25;
  if (!Number.isFinite(feather) || feather < 0 || feather > 1)
    throw new RangeError("Feather must be between 0 and 1.");
  return { x, y, feather };
}

function normalizeAdjustments(adjustments: ImageAdjustments): Required<ImageAdjustments> {
  const normalized = {
    brightness: adjustments.brightness ?? 0,
    contrast: adjustments.contrast ?? 0,
    saturation: adjustments.saturation ?? 0,
  };
  for (const [name, value] of Object.entries(normalized)) {
    if (!Number.isFinite(value) || value < -100 || value > 100)
      throw new RangeError(`${name} must be between -100 and 100.`);
  }
  return normalized;
}

function byteHex(value: number) {
  return value.toString(16).padStart(2, "0").toUpperCase();
}

function rgbHex(r: number, g: number, b: number) {
  return `#${byteHex(r)}${byteHex(g)}${byteHex(b)}`;
}

function parseHex(value: string): readonly [number, number, number, string] {
  if (!/^#[0-9a-f]{6}$/i.test(value)) throw new TypeError("Target color must use #RRGGBB format.");
  const normalized = value.toUpperCase();
  return [
    Number.parseInt(normalized.slice(1, 3), 16),
    Number.parseInt(normalized.slice(3, 5), 16),
    Number.parseInt(normalized.slice(5, 7), 16),
    normalized,
  ];
}

function srgbToLinear(value: number) {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(value: number) {
  const channel = value <= 0.0031308 ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, channel)) * 255);
}

function rgbToOklab(r: number, g: number, b: number): Oklab {
  const red = srgbToLinear(r);
  const green = srgbToLinear(g);
  const blue = srgbToLinear(b);
  const l = Math.cbrt(0.4122214708 * red + 0.5363325363 * green + 0.0514459929 * blue);
  const m = Math.cbrt(0.2119034982 * red + 0.6806995451 * green + 0.1073969566 * blue);
  const s = Math.cbrt(0.0883024619 * red + 0.2817188376 * green + 0.6299787005 * blue);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function oklabToRgb([lightness, axisA, axisB]: Oklab): readonly [number, number, number] {
  const lRoot = lightness + 0.3963377774 * axisA + 0.2158037573 * axisB;
  const mRoot = lightness - 0.1055613458 * axisA - 0.0638541728 * axisB;
  const sRoot = lightness - 0.0894841775 * axisA - 1.291485548 * axisB;
  const l = lRoot ** 3;
  const m = mRoot ** 3;
  const s = sRoot ** 3;
  return [
    linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function deltaE(left: Oklab, right: Oklab) {
  return 100 * Math.hypot(left[0] - right[0], left[1] - right[1], left[2] - right[2]);
}

function sampleAt(pixels: Uint8ClampedArray, index: number): PixelSample {
  const offset = index * 4;
  const r = pixels[offset];
  const g = pixels[offset + 1];
  const b = pixels[offset + 2];
  return { r, g, b, a: pixels[offset + 3], hex: rgbHex(r, g, b) };
}

export function samplePixel(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
): PixelSample {
  validateImage(pixels, width, height);
  const point = validateSelection({ x, y, tolerance: 0, mode: "connected" }, width, height);
  return sampleAt(pixels, point.y * width + point.x);
}

function selectionWeight(
  pixels: Uint8ClampedArray,
  index: number,
  source: PixelSample,
  sourceLab: Oklab,
  tolerance: number,
  feather: number,
) {
  const offset = index * 4;
  if (pixels[offset + 3] === 0) return 0;
  if (tolerance === 0)
    return pixels[offset] === source.r && pixels[offset + 1] === source.g && pixels[offset + 2] === source.b ? 1 : 0;
  const distance = deltaE(rgbToOklab(pixels[offset], pixels[offset + 1], pixels[offset + 2]), sourceLab);
  if (distance >= tolerance) return 0;
  if (feather === 0) return 1;
  const solidLimit = tolerance * (1 - feather);
  if (distance <= solidLimit) return 1;
  const position = (distance - solidLimit) / (tolerance - solidLimit);
  const smooth = position * position * (3 - 2 * position);
  return 1 - smooth;
}

function boundsFromExtrema(minX: number, minY: number, maxX: number, maxY: number): PixelBounds | null {
  return maxX < minX ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

export function createRecolorSelection(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  options: RecolorSelectionOptions,
): RecolorSelection {
  validateImage(pixels, width, height);
  const { x, y, feather } = validateSelection(options, width, height);
  const pixelCount = width * height;
  const mask = new Uint8Array(pixelCount);
  const seedIndex = y * width + x;
  const source = sampleAt(pixels, seedIndex);
  if (source.a === 0) return { mask, selectedPixels: 0, bounds: null, source };
  const sourceLab = rgbToOklab(source.r, source.g, source.b);
  let weightCache: Map<number, number> | null = options.tolerance > 0 ? new Map() : null;
  const weightAt = (index: number) => {
    const offset = index * 4;
    if (pixels[offset + 3] === 0) return 0;
    if (weightCache) {
      const key = (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
      const cached = weightCache.get(key);
      if (cached !== undefined) return cached;
      const weight = selectionWeight(pixels, index, source, sourceLab, options.tolerance, feather);
      if (weightCache.size < 4096) weightCache.set(key, weight);
      else weightCache = null;
      return weight;
    }
    return selectionWeight(pixels, index, source, sourceLab, options.tolerance, feather);
  };
  let selectedPixels = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  const select = (index: number) => {
    const weight = weightAt(index);
    if (weight <= 0) return false;
    mask[index] = Math.max(1, Math.round(weight * 255));
    selectedPixels += 1;
    const pixelX = index % width;
    const pixelY = Math.floor(index / width);
    minX = Math.min(minX, pixelX);
    minY = Math.min(minY, pixelY);
    maxX = Math.max(maxX, pixelX);
    maxY = Math.max(maxY, pixelY);
    return true;
  };

  if (options.mode === "global") {
    for (let index = 0; index < pixelCount; index += 1) select(index);
  } else {
    const visited = new Uint8Array(Math.ceil(pixelCount / 8));
    const queueChunkSize = 16_384;
    const queue: Uint32Array[] = [];
    let head = 0;
    let tail = 0;
    const enqueue = (index: number) => {
      const chunkIndex = Math.floor(tail / queueChunkSize);
      if (!queue[chunkIndex]) queue.push(new Uint32Array(queueChunkSize));
      queue[chunkIndex][tail % queueChunkSize] = index;
      tail += 1;
    };
    const dequeue = () => {
      const value = queue[Math.floor(head / queueChunkSize)][head % queueChunkSize];
      head += 1;
      return value;
    };
    const wasVisited = (index: number) => (visited[index >> 3] & (1 << (index & 7))) !== 0;
    const markVisited = (index: number) => { visited[index >> 3] |= 1 << (index & 7); };
    markVisited(seedIndex);
    enqueue(seedIndex);
    while (head < tail) {
      const index = dequeue();
      if (!select(index)) continue;
      const pixelX = index % width;
      const pixelY = Math.floor(index / width);
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const nextY = pixelY + offsetY;
        if (nextY < 0 || nextY >= height) continue;
        for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
          if (offsetX === 0 && offsetY === 0) continue;
          const nextX = pixelX + offsetX;
          if (nextX < 0 || nextX >= width) continue;
          const next = nextY * width + nextX;
          if (wasVisited(next)) continue;
          markVisited(next);
          enqueue(next);
        }
      }
    }
  }
  return { mask, selectedPixels, bounds: boundsFromExtrema(minX, minY, maxX, maxY), source };
}

function paintSelection(
  pixels: Uint8ClampedArray,
  selection: RecolorSelection,
  targetValue: string,
): RecolorStepSummary {
  const [targetR, targetG, targetB, target] = parseHex(targetValue);
  const sourceLab = rgbToOklab(selection.source.r, selection.source.g, selection.source.b);
  const targetLab = rgbToOklab(targetR, targetG, targetB);
  const shift: Oklab = [
    targetLab[0] - sourceLab[0],
    targetLab[1] - sourceLab[1],
    targetLab[2] - sourceLab[2],
  ];
  let changedPixels = 0;
  let outputCache: Map<number, readonly [number, number, number]> | null = new Map();
  for (let index = 0; index < selection.mask.length; index += 1) {
    const maskValue = selection.mask[index];
    if (maskValue === 0) continue;
    const offset = index * 4;
    const originalR = pixels[offset];
    const originalG = pixels[offset + 1];
    const originalB = pixels[offset + 2];
    const cacheKey = (((originalR << 16) | (originalG << 8) | originalB) * 256) + maskValue;
    let output = outputCache?.get(cacheKey);
    if (!output) {
      const current = rgbToOklab(originalR, originalG, originalB);
      const weight = maskValue / 255;
      output = oklabToRgb([
        current[0] + shift[0] * weight,
        current[1] + shift[1] * weight,
        current[2] + shift[2] * weight,
      ]);
      if (outputCache) {
        if (outputCache.size < 4096) outputCache.set(cacheKey, output);
        else outputCache = null;
      }
    }
    const [r, g, b] = output;
    if (r !== originalR || g !== originalG || b !== originalB) changedPixels += 1;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
  }
  return {
    changedPixels,
    selectedPixels: selection.selectedPixels,
    bounds: selection.bounds,
    source: selection.source,
    target,
  };
}

export function applyRecolorOperation(
  sourcePixels: Uint8ClampedArray,
  width: number,
  height: number,
  operation: RecolorOperation,
): RecolorResult {
  validateImage(sourcePixels, width, height);
  const pixels = new Uint8ClampedArray(sourcePixels);
  const selection = createRecolorSelection(pixels, width, height, operation);
  const summary = paintSelection(pixels, selection, operation.target);
  return { pixels, mask: selection.mask, ...summary };
}

export function replayRecolorOperations(
  originalPixels: Uint8ClampedArray,
  width: number,
  height: number,
  operations: readonly RecolorOperation[],
): RecolorReplayResult {
  validateImage(originalPixels, width, height);
  const pixels = new Uint8ClampedArray(originalPixels);
  const steps: RecolorStepSummary[] = [];
  for (const operation of operations) {
    const selection = createRecolorSelection(pixels, width, height, operation);
    steps.push(paintSelection(pixels, selection, operation.target));
  }
  let changedPixels = 0;
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (
      pixels[offset] !== originalPixels[offset]
      || pixels[offset + 1] !== originalPixels[offset + 1]
      || pixels[offset + 2] !== originalPixels[offset + 2]
    ) changedPixels += 1;
  }
  return { pixels, steps, changedPixels };
}

export function applyImageAdjustments(
  sourcePixels: Uint8ClampedArray,
  width: number,
  height: number,
  adjustments: ImageAdjustments,
): ImageAdjustmentResult {
  validateImage(sourcePixels, width, height);
  const normalized = normalizeAdjustments(adjustments);
  const pixels = new Uint8ClampedArray(sourcePixels);
  if (normalized.brightness === 0 && normalized.contrast === 0 && normalized.saturation === 0)
    return { pixels, changedPixels: 0, adjustments: normalized };

  const brightness = normalized.brightness / 100;
  const contrast = normalized.contrast / 100;
  const saturation = normalized.saturation / 100;
  const contrastFactor = contrast < 0 ? 1 + contrast : 1 + 3 * contrast;
  const saturationFactor = 1 + saturation;
  const brightnessChromaFactor = brightness < 0 ? 1 + brightness : 1 - brightness;
  let changedPixels = 0;
  let adjustmentCache: Map<number, readonly [number, number, number]> | null = new Map();

  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) continue;
    const originalR = pixels[offset];
    const originalG = pixels[offset + 1];
    const originalB = pixels[offset + 2];
    const cacheKey = (originalR << 16) | (originalG << 8) | originalB;
    let adjusted = adjustmentCache?.get(cacheKey);
    if (!adjusted) {
      const [originalLightness, originalA, originalBaxis] = rgbToOklab(originalR, originalG, originalB);
      const brightened = brightness < 0
        ? originalLightness * (1 + brightness)
        : originalLightness + (1 - originalLightness) * brightness;
      const contrasted = Math.min(1, Math.max(0, 0.5 + (brightened - 0.5) * contrastFactor));
      const chromaFactor = brightnessChromaFactor * saturationFactor;
      adjusted = oklabToRgb([
        contrasted,
        originalA * chromaFactor,
        originalBaxis * chromaFactor,
      ]);
      if (adjustmentCache) {
        if (adjustmentCache.size < 4096) adjustmentCache.set(cacheKey, adjusted);
        else adjustmentCache = null;
      }
    }
    const [r, g, b] = adjusted;
    if (r !== originalR || g !== originalG || b !== originalB) changedPixels += 1;
    pixels[offset] = r;
    pixels[offset + 1] = g;
    pixels[offset + 2] = b;
  }
  return { pixels, changedPixels, adjustments: normalized };
}
