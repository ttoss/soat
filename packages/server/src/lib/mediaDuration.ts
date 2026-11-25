import { readMatroskaDuration } from './matroskaDuration';
import { readMpegAudioDuration } from './mpegAudioDuration';

type Reader = {
  matches: (bytes: Buffer) => boolean;
  read: (bytes: Buffer) => number | null;
};

const ascii = (bytes: Buffer, offset: number, length: number): string => {
  return bytes.toString('latin1', offset, offset + length);
};

const readWavDuration = (bytes: Buffer): number | null => {
  let byteRate: number | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = ascii(bytes, offset, 4);
    const size = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    if (id === 'fmt ' && start + 12 <= bytes.length) {
      byteRate = bytes.readUInt32LE(start + 8);
    }
    if (id === 'data') {
      // A streamed WAV writes its data size as zero or 0xFFFFFFFF.
      const available = bytes.length - start;
      const dataSize = size === 0 || size > available ? available : size;
      return byteRate ? dataSize / byteRate : null;
    }
    offset = start + size + (size % 2);
  }
  return null;
};

/** STREAMINFO: sample rate (20 bits) and total samples (36 bits) at `at`. */
const flacStreamInfoDuration = (bytes: Buffer, at: number): number | null => {
  if (at + 18 > bytes.length) return null;
  const sampleRate =
    (bytes[at + 10] << 12) | (bytes[at + 11] << 4) | (bytes[at + 12] >> 4);
  const totalSamples =
    (bytes[at + 13] & 0x0f) * 2 ** 32 + bytes.readUInt32BE(at + 14);
  return sampleRate > 0 && totalSamples > 0 ? totalSamples / sampleRate : null;
};

// STREAMINFO is the first metadata block, after `fLaC` and its 4-byte header.
const readFlacDuration = (bytes: Buffer): number | null => {
  return (bytes[4] & 0x7f) === 0 ? flacStreamInfoDuration(bytes, 8) : null;
};

const OGG_PAGE_HEADER = 27;

/** The rate the granule position counts in, and the samples it skips first. */
const oggClock = (packet: Buffer): { rate: number; preSkip: number } | null => {
  if (ascii(packet, 0, 8) === 'OpusHead') {
    return { rate: 48000, preSkip: packet.readUInt16LE(10) };
  }
  if (ascii(packet, 0, 7) === '\x01vorbis' && packet.length >= 16) {
    return { rate: packet.readUInt32LE(12), preSkip: 0 };
  }
  return null;
};

const lastGranule = (bytes: Buffer): number | null => {
  for (
    let at = bytes.lastIndexOf('OggS');
    at >= 0;
    at = bytes.lastIndexOf('OggS', at - 1)
  ) {
    if (at + OGG_PAGE_HEADER > bytes.length) continue;
    const granule = bytes.readBigInt64LE(at + 6);
    if (granule >= 0n) return Number(granule);
  }
  return null;
};

const readOggDuration = (bytes: Buffer): number | null => {
  if (bytes.length < OGG_PAGE_HEADER) return null;
  const segments = bytes[26];
  const clock = oggClock(bytes.subarray(OGG_PAGE_HEADER + segments));
  const granule = lastGranule(bytes);
  if (!clock || clock.rate === 0 || granule === null) return null;
  return Math.max(granule - clock.preSkip, 0) / clock.rate;
};

type Box = { type: string; start: number; end: number };

const boxesIn = (bytes: Buffer, from: number, to: number): Box[] => {
  const boxes: Box[] = [];
  let offset = from;
  while (offset + 8 <= to) {
    let size = bytes.readUInt32BE(offset);
    let header = 8;
    if (size === 1 && offset + 16 <= to) {
      size = Number(bytes.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) {
      size = to - offset;
    }
    if (size < header) break;
    const end = Math.min(offset + size, to);
    boxes.push({
      type: ascii(bytes, offset + 4, 4),
      start: offset + header,
      end,
    });
    offset = end;
  }
  return boxes;
};

const childBox = (bytes: Buffer, parent: Box, type: string): Box | null => {
  return (
    boxesIn(bytes, parent.start, parent.end).find((box) => {
      return box.type === type;
    }) ?? null
  );
};

/** A full box's 32- or 64-bit field, by its version byte. */
const versioned = (bytes: Buffer, box: Box, v0At: number, v1At: number) => {
  return bytes[box.start] === 1
    ? Number(bytes.readBigUInt64BE(box.start + v1At))
    : bytes.readUInt32BE(box.start + v0At);
};

const fragmentedDuration = (bytes: Buffer, moov: Box): number => {
  const mvex = childBox(bytes, moov, 'mvex');
  const mehd = mvex && childBox(bytes, mvex, 'mehd');
  return mehd ? versioned(bytes, mehd, 4, 4) : 0;
};

// `mvhd` holds the timescale and duration; a fragmented file leaves the
// duration 0 and declares it in `mvex/mehd`.
const readIsoBmffDuration = (bytes: Buffer): number | null => {
  const moov = boxesIn(bytes, 0, bytes.length).find((box) => {
    return box.type === 'moov';
  });
  const mvhd = moov && childBox(bytes, moov, 'mvhd');
  if (!moov || !mvhd || mvhd.end - mvhd.start < 32) return null;
  const timescale = bytes.readUInt32BE(
    mvhd.start + (bytes[mvhd.start] === 1 ? 20 : 12)
  );
  const duration =
    versioned(bytes, mvhd, 16, 24) || fragmentedDuration(bytes, moov);
  return timescale > 0 && duration > 0 && duration < 0xffffffff
    ? duration / timescale
    : null;
};

const READERS: readonly Reader[] = [
  {
    matches: (bytes) => {
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE';
    },
    read: readWavDuration,
  },
  {
    matches: (bytes) => {
      return ascii(bytes, 0, 4) === 'fLaC';
    },
    read: readFlacDuration,
  },
  {
    matches: (bytes) => {
      return ascii(bytes, 0, 4) === 'OggS';
    },
    read: readOggDuration,
  },
  {
    matches: (bytes) => {
      return bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3;
    },
    read: readMatroskaDuration,
  },
  {
    matches: (bytes) => {
      return ['ftyp', 'moov', 'mdat', 'wide', 'free'].includes(
        ascii(bytes, 4, 4)
      );
    },
    read: readIsoBmffDuration,
  },
];

/**
 * The duration in seconds of audio or video bytes, read from the container's
 * own headers, or `null` when no reader here recognises them. Pure JS: the
 * ESM-only media parsers do not load in Jest's VM (`tests/unit/jest.config.ts`).
 */
export const readMediaDuration = (args: {
  bytes: Uint8Array;
}): number | null => {
  const bytes = Buffer.from(
    args.bytes.buffer,
    args.bytes.byteOffset,
    args.bytes.byteLength
  );
  const reader = READERS.find(({ matches }) => {
    return matches(bytes);
  });
  const seconds = (reader?.read ?? readMpegAudioDuration)(bytes);
  return seconds !== null && Number.isFinite(seconds) && seconds >= 0
    ? seconds
    : null;
};
