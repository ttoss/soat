import assert from 'node:assert/strict';
import fs from 'node:fs';
import { describe, test } from 'node:test';
import zlib from 'node:zlib';

const LOGO_PATH = new URL(
  '../../packages/website/static/img/soat-logo-no-bg.png',
  import.meta.url
);
const HERO_PATH = new URL(
  '../../packages/website/src/components/HomepageHero/index.tsx',
  import.meta.url
);

/* Brightness, composited over black, a module dot needs under it. The nodes
   of the spiral clear it; the haze and lines between them mostly do not. */
const LIT_BRIGHTNESS = 195;
const SAMPLE_RADIUS = 3;

const paeth = (left, up, upLeft) => {
  const p = left + up - upLeft;
  const pa = Math.abs(p - left);
  const pb = Math.abs(p - up);
  const pc = Math.abs(p - upLeft);
  if (pa <= pb && pa <= pc) {
    return left;
  }
  return pb <= pc ? up : upLeft;
};

const RGBA = 6;
const PALETTE = 3;

const readChunks = (args) => {
  const buffer = fs.readFileSync(args.path);
  const chunks = { idat: [] };
  for (let offset = 8; offset < buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IDAT') {
      chunks.idat.push(data);
    } else {
      chunks[type] = data;
    }
    offset += length + 12;
  }
  return chunks;
};

/** Reverses the per-scanline PNG filters. */
const unfilter = (args) => {
  const { raw, stride, height, bytesPerPixel } = args;
  const pixels = Buffer.alloc(stride * height);
  const at = (x, y) => {
    return x >= 0 && y >= 0 ? pixels[y * stride + x] : 0;
  };
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x += 1) {
      const left = at(x - bytesPerPixel, y);
      const up = at(x, y - 1);
      const predictor = [
        0,
        left,
        up,
        (left + up) >> 1,
        paeth(left, up, at(x - bytesPerPixel, y - 1)),
      ][filter];
      pixels[y * stride + x] = (line[x] + predictor) & 0xff;
    }
  }
  return pixels;
};

/** Decodes an 8-bit, non-interlaced RGBA or palette PNG into brightness
    composited over black. */
const readBrightness = (args) => {
  const chunks = readChunks(args);
  const header = chunks.IHDR;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const colorType = header[9];
  assert.equal(header[8], 8, 'logo must be 8-bit');
  assert.ok(
    colorType === RGBA || colorType === PALETTE,
    'logo must be RGBA or palette'
  );
  assert.equal(header[12], 0, 'logo must not be interlaced');
  const bytesPerPixel = colorType === RGBA ? 4 : 1;
  const pixels = unfilter({
    raw: zlib.inflateSync(Buffer.concat(chunks.idat)),
    stride: width * bytesPerPixel,
    height,
    bytesPerPixel,
  });
  const palette = chunks.PLTE ?? Buffer.alloc(0);
  const transparency = chunks.tRNS ?? Buffer.alloc(0);
  const rgbaAt = (point) => {
    const i = (point.y * width + point.x) * bytesPerPixel;
    if (colorType === RGBA) {
      return [...pixels.subarray(i, i + 4)];
    }
    const entry = pixels[i];
    const alpha = entry < transparency.length ? transparency[entry] : 255;
    return [...palette.subarray(entry * 3, entry * 3 + 3), alpha];
  };
  return {
    width,
    height,
    brightnessAt: (point) => {
      const [red, green, blue, alpha] = rgbaAt(point);
      return ((red + green + blue) / 3) * (alpha / 255);
    },
  };
};

const readHeroGeometry = () => {
  const source = fs.readFileSync(HERO_PATH, 'utf8');
  const logo = source.match(
    /const LOGO = \{ width: (\d+), height: (\d+), coreX: (\d+), coreY: (\d+) \}/
  );
  assert.ok(logo, 'HomepageHero declares its LOGO geometry');
  const nodes = [
    ...source.matchAll(/\{ id: '([a-z]+)', x: (\d+), y: (\d+)/g),
  ].map((match) => {
    return { id: match[1], x: Number(match[2]), y: Number(match[3]) };
  });
  assert.ok(nodes.length > 0, 'HomepageHero declares its NODES');
  return {
    width: Number(logo[1]),
    height: Number(logo[2]),
    core: { x: Number(logo[3]), y: Number(logo[4]) },
    nodes,
  };
};

const brightestNear = (args) => {
  let best = 0;
  for (let dy = -SAMPLE_RADIUS; dy <= SAMPLE_RADIUS; dy += 1) {
    for (let dx = -SAMPLE_RADIUS; dx <= SAMPLE_RADIUS; dx += 1) {
      best = Math.max(
        best,
        args.image.brightnessAt({ x: args.point.x + dx, y: args.point.y + dy })
      );
    }
  }
  return best;
};

describe('homepage hero logo geometry', () => {
  const image = readBrightness({ path: LOGO_PATH });
  const hero = readHeroGeometry();

  test('LOGO matches the bitmap size', () => {
    assert.deepEqual(
      { width: hero.width, height: hero.height },
      { width: image.width, height: image.height }
    );
  });

  test('the core sits on the lit recall-core', () => {
    assert.ok(brightestNear({ image, point: hero.core }) >= LIT_BRIGHTNESS);
  });

  test('every module dot lands on a lit node of the spiral', () => {
    const unlit = hero.nodes.filter((node) => {
      return (
        node.x < SAMPLE_RADIUS ||
        node.y < SAMPLE_RADIUS ||
        node.x >= image.width - SAMPLE_RADIUS ||
        node.y >= image.height - SAMPLE_RADIUS ||
        brightestNear({ image, point: node }) < LIT_BRIGHTNESS
      );
    });
    assert.deepEqual(unlit, []);
  });
});
