import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const source = await readFile("apps/desktop/renderer/image-recolor.ts", "utf8");
const compiled = await transform(source, { loader: "ts", format: "esm", target: "es2023" });
const recolor = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString("base64")}`);

function pixels(...colors) {
  return new Uint8ClampedArray(colors.flat());
}

test("global recolor replaces matching pixels and preserves every alpha byte", () => {
  const input = pixels(
    [220, 20, 30, 255], [10, 30, 220, 255],
    [220, 20, 30, 96], [10, 30, 220, 0],
  );
  const result = recolor.applyRecolorOperation(input, 2, 2, {
    x: 0, y: 0, target: "#20C070", tolerance: 0, mode: "global",
  });
  assert.equal(result.selectedPixels, 2);
  assert.equal(result.changedPixels, 2);
  assert.deepEqual([...result.pixels.filter((_, index) => index % 4 === 3)], [255, 255, 96, 0]);
  assert.deepEqual([...result.pixels.slice(4, 8)], [10, 30, 220, 255]);
  assert.deepEqual([...input.slice(0, 4)], [220, 20, 30, 255], "input remains immutable");
});

test("connected selection uses eight neighbors but cannot jump to a separate island", () => {
  const red = [210, 30, 30, 255];
  const blue = [20, 40, 180, 255];
  const input = pixels(
    red, blue, blue, blue,
    blue, red, blue, blue,
    blue, blue, blue, blue,
    blue, blue, blue, red,
  );
  const selection = recolor.createRecolorSelection(input, 4, 4, {
    x: 0, y: 0, tolerance: 0, mode: "connected",
  });
  assert.equal(selection.selectedPixels, 2, "diagonal red pixels are connected");
  assert.equal(selection.mask[0], 255);
  assert.equal(selection.mask[5], 255);
  assert.equal(selection.mask[15], 0, "the isolated island stays outside the selection");
  assert.deepEqual(selection.bounds, { x: 0, y: 0, width: 2, height: 2 });
});

test("connected selection crosses internal queue chunk boundaries", () => {
  const width = 20_000;
  const input = new Uint8ClampedArray(width * 4);
  for (let offset = 0; offset < input.length; offset += 4) {
    input[offset] = 80;
    input[offset + 1] = 140;
    input[offset + 2] = 190;
    input[offset + 3] = 255;
  }
  const selection = recolor.createRecolorSelection(input, width, 1, {
    x: 0, y: 0, tolerance: 0, mode: "connected",
  });
  assert.equal(selection.selectedPixels, width);
  assert.deepEqual(selection.bounds, { x: 0, y: 0, width, height: 1 });
});

test("matching always compares with the fixed seed and does not drift through a gradient", () => {
  const input = pixels(
    [80, 80, 80, 255],
    [96, 96, 96, 255],
    [112, 112, 112, 255],
    [128, 128, 128, 255],
  );
  const firstDistance = colorDistance(input, 0, 1);
  const secondDistance = colorDistance(input, 0, 2);
  const tolerance = (firstDistance + secondDistance) / 2;
  const selection = recolor.createRecolorSelection(input, 4, 1, {
    x: 0, y: 0, tolerance, mode: "connected", feather: 0,
  });
  assert.equal(selection.selectedPixels, 2);
  assert.equal(selection.mask[2], 0, "a neighbor outside seed tolerance cannot extend the region");
});

test("feathered tolerance produces a partial anti-aliased edge without changing alpha", () => {
  const input = pixels([200, 30, 30, 255], [220, 95, 95, 73]);
  const edgeDistance = colorDistance(input, 0, 1);
  const result = recolor.applyRecolorOperation(input, 2, 1, {
    x: 0, y: 0, target: "#2060D0", tolerance: edgeDistance * 1.2,
    mode: "connected", feather: 1,
  });
  assert.equal(result.selectedPixels, 2);
  assert.equal(result.pixels[7], 73);
  assert.notDeepEqual([...result.pixels.slice(4, 7)], [...input.slice(4, 7)]);
  assert.notDeepEqual([...result.pixels.slice(4, 7)], [32, 96, 208], "edge receives only a weighted shift");
  assert.ok(result.mask[1] > 0 && result.mask[1] < 255);
});

test("transparent seeds select nothing and hidden RGB values remain untouched", () => {
  const input = pixels([240, 20, 20, 0], [240, 20, 20, 255]);
  const result = recolor.applyRecolorOperation(input, 2, 1, {
    x: 0, y: 0, target: "#00FF00", tolerance: 40, mode: "global",
  });
  assert.equal(result.selectedPixels, 0);
  assert.equal(result.changedPixels, 0);
  assert.deepEqual([...result.pixels], [...input]);
});

test("operation replay is deterministic and supports undo by truncating the log", () => {
  const input = pixels([230, 30, 30, 255], [20, 40, 220, 255]);
  const operations = [
    { x: 0, y: 0, target: "#20A060", tolerance: 0, mode: "connected" },
    { x: 1, y: 0, target: "#E0B030", tolerance: 0, mode: "connected" },
  ];
  const first = recolor.replayRecolorOperations(input, 2, 1, operations.slice(0, 1));
  const complete = recolor.replayRecolorOperations(input, 2, 1, operations);
  const repeated = recolor.replayRecolorOperations(input, 2, 1, operations);
  assert.deepEqual([...complete.pixels], [...repeated.pixels]);
  assert.equal(complete.changedPixels, 2, "final changed pixels are counted once each");
  assert.deepEqual(
    [...first.pixels],
    [...recolor.applyRecolorOperation(input, 2, 1, operations[0]).pixels],
  );
  const reset = recolor.replayRecolorOperations(input, 2, 1, []);
  assert.deepEqual([...reset.pixels], [...input]);
  assert.equal(reset.changedPixels, 0);
});

test("sampling and validation reject malformed buffers, targets and unsafe dimensions", () => {
  const input = pixels([1, 2, 3, 4]);
  assert.deepEqual(recolor.samplePixel(input, 1, 1, 0, 0), { r: 1, g: 2, b: 3, a: 4, hex: "#010203" });
  assert.throws(() => recolor.samplePixel(input, 2, 1, 0, 0), /buffer length/);
  assert.throws(() => recolor.samplePixel(input, 1, 1, 1, 0), /outside/);
  assert.throws(() => recolor.applyRecolorOperation(input, 1, 1, {
    x: 0, y: 0, target: "red", tolerance: 0, mode: "global",
  }), /#RRGGBB/);
  assert.throws(() => recolor.createRecolorSelection(input, 1, 1, {
    x: 0, y: 0, tolerance: 41, mode: "global",
  }), /between 0 and 40/);
  assert.throws(
    () => recolor.samplePixel(input, recolor.MAX_RECOLOR_PIXELS + 1, 1, 0, 0),
    /pixel limit/,
  );
});

test("zero image adjustments are lossless and do not mutate the source", () => {
  const input = pixels([12, 34, 56, 255], [200, 150, 80, 117]);
  const result = recolor.applyImageAdjustments(input, 2, 1, {});
  assert.equal(result.changedPixels, 0);
  assert.deepEqual(result.adjustments, { brightness: 0, contrast: 0, saturation: 0 });
  assert.deepEqual([...result.pixels], [...input]);
  assert.notEqual(result.pixels, input, "callers receive an independent output buffer");
});

test("brightness, contrast and saturation compose while preserving alpha", () => {
  const input = pixels(
    [180, 70, 40, 255],
    [30, 110, 200, 83],
    [17, 99, 201, 0],
  );
  const result = recolor.applyImageAdjustments(input, 3, 1, {
    brightness: 18, contrast: 24, saturation: -35,
  });
  assert.equal(result.changedPixels, 2);
  assert.deepEqual([...result.pixels.filter((_, index) => index % 4 === 3)], [255, 83, 0]);
  assert.deepEqual([...result.pixels.slice(8, 12)], [17, 99, 201, 0], "fully transparent RGB stays untouched");
  assert.notDeepEqual([...result.pixels.slice(0, 3)], [...input.slice(0, 3)]);
  assert.notDeepEqual([...result.pixels.slice(4, 7)], [...input.slice(4, 7)]);
});

test("adjustment endpoints have defined neutral behavior", () => {
  const input = pixels([210, 80, 30, 190], [30, 150, 220, 70]);
  const desaturated = recolor.applyImageAdjustments(input, 2, 1, { saturation: -100 });
  for (let offset = 0; offset < desaturated.pixels.length; offset += 4)
    assert.ok(Math.max(...desaturated.pixels.slice(offset, offset + 3)) - Math.min(...desaturated.pixels.slice(offset, offset + 3)) <= 1);
  assert.deepEqual(
    [...recolor.applyImageAdjustments(input, 2, 1, { brightness: 100 }).pixels],
    [255, 255, 255, 190, 255, 255, 255, 70],
  );
  assert.deepEqual(
    [...recolor.applyImageAdjustments(input, 2, 1, { brightness: -100 }).pixels],
    [0, 0, 0, 190, 0, 0, 0, 70],
  );
});

test("image adjustment values outside the documented range are rejected", () => {
  const input = pixels([1, 2, 3, 255]);
  assert.throws(() => recolor.applyImageAdjustments(input, 1, 1, { brightness: 101 }), /brightness/);
  assert.throws(() => recolor.applyImageAdjustments(input, 1, 1, { contrast: Number.NaN }), /contrast/);
  assert.throws(() => recolor.applyImageAdjustments(input, 1, 1, { saturation: -101 }), /saturation/);
});

function colorDistance(buffer, leftIndex, rightIndex) {
  const left = [buffer[leftIndex * 4], buffer[leftIndex * 4 + 1], buffer[leftIndex * 4 + 2]];
  const right = [buffer[rightIndex * 4], buffer[rightIndex * 4 + 1], buffer[rightIndex * 4 + 2]];
  const lab = ([r, g, b]) => {
    const linear = (value) => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    };
    const [red, green, blue] = [linear(r), linear(g), linear(b)];
    const l = Math.cbrt(.4122214708 * red + .5363325363 * green + .0514459929 * blue);
    const m = Math.cbrt(.2119034982 * red + .6806995451 * green + .1073969566 * blue);
    const s = Math.cbrt(.0883024619 * red + .2817188376 * green + .6299787005 * blue);
    return [.2104542553 * l + .793617785 * m - .0040720468 * s,
      1.9779984951 * l - 2.428592205 * m + .4505937099 * s,
      .0259040371 * l + .7827717662 * m - .808675766 * s];
  };
  const [l1, a1, b1] = lab(left);
  const [l2, a2, b2] = lab(right);
  return 100 * Math.hypot(l1 - l2, a1 - a2, b1 - b2);
}
