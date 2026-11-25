/** kbit/s by [version 1 ? 0 : 1][layer 1..3 - 1][bitrate index]. */
const BITRATES = [
  [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
];

/** Hz by the header's version bits (2.5, reserved, 2, 1). */
const MPEG_SAMPLE_RATES: Record<number, readonly number[]> = {
  0: [11025, 12000, 8000],
  2: [22050, 24000, 16000],
  3: [44100, 48000, 32000],
};

const AAC_SAMPLE_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025,
  8000, 7350,
];

type Frame = { length: number; samples: number; sampleRate: number };

// An ADTS (AAC) header: sync 0xFFF with layer bits 00.
const adtsFrame = (bytes: Buffer, at: number): Frame | null => {
  if (at + 7 > bytes.length) return null;
  const sampleRate = AAC_SAMPLE_RATES[(bytes[at + 2] >> 2) & 0x0f];
  const length =
    ((bytes[at + 3] & 0x03) << 11) |
    (bytes[at + 4] << 3) |
    (bytes[at + 5] >> 5);
  const blocks = (bytes[at + 6] & 0x03) + 1;
  return sampleRate && length >= 7
    ? { length, samples: 1024 * blocks, sampleRate }
    : null;
};

const mpegFrameSize = (args: {
  layer: number;
  versionOne: boolean;
  bitrate: number;
  sampleRate: number;
  padding: number;
}): Frame => {
  const { bitrate, sampleRate, padding } = args;
  if (args.layer === 1) {
    const length = (Math.floor((12 * bitrate) / sampleRate) + padding) * 4;
    return { length, samples: 384, sampleRate };
  }
  const samples = args.layer === 3 && !args.versionOne ? 576 : 1152;
  const length = Math.floor((samples / 8) * (bitrate / sampleRate)) + padding;
  return { length, samples, sampleRate };
};

const mpegFrame = (bytes: Buffer, at: number): Frame | null => {
  if (at + 4 > bytes.length) return null;
  const versionBits = (bytes[at + 1] >> 3) & 0x03;
  const layer = 4 - ((bytes[at + 1] >> 1) & 0x03);
  const sampleRate = MPEG_SAMPLE_RATES[versionBits]?.[(bytes[at + 2] >> 2) & 3];
  const versionOne = versionBits === 3;
  const kbps =
    BITRATES[versionOne ? 0 : 1][layer - 1]?.[bytes[at + 2] >> 4] ?? 0;
  if (!sampleRate || layer > 3 || kbps === 0) return null;
  return mpegFrameSize({
    layer,
    versionOne,
    bitrate: kbps * 1000,
    sampleRate,
    padding: (bytes[at + 2] >> 1) & 0x01,
  });
};

const frameAt = (bytes: Buffer, at: number): Frame | null => {
  if (bytes[at] !== 0xff || (bytes[at + 1] & 0xe0) !== 0xe0) return null;
  return (bytes[at + 1] & 0x16) === 0x10
    ? adtsFrame(bytes, at)
    : mpegFrame(bytes, at);
};

/** Where the audio starts: past an ID3v2 tag (syncsafe size, optional footer). */
const audioStart = (bytes: Buffer): number => {
  if (bytes.toString('latin1', 0, 3) !== 'ID3' || bytes.length < 10) return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const footer = bytes[5] & 0x10 ? 10 : 0;
  return 10 + size + footer;
};

/** An encoder may pad between the tag and the first frame. */
const SYNC_SEARCH_BYTES = 65536;

// A sync word alone is two bytes any binary can carry: a frame counts when
// another frame, or the end of the bytes, follows it.
const isFrameRun = (bytes: Buffer, at: number): boolean => {
  const frame = frameAt(bytes, at);
  if (!frame) return false;
  const next = at + frame.length;
  return next === bytes.length || frameAt(bytes, next) !== null;
};

const firstFrame = (bytes: Buffer): number => {
  const start = audioStart(bytes);
  const limit = Math.min(start + SYNC_SEARCH_BYTES, bytes.length);
  for (let at = start; at < limit; at += 1) {
    if (isFrameRun(bytes, at)) return at;
  }
  return bytes.length;
};

/**
 * MP3 (MPEG audio layers I–III) and ADTS AAC: the sum of every frame's
 * samples, which holds for constant and variable bitrate alike.
 */
export const readMpegAudioDuration = (bytes: Buffer): number | null => {
  let offset = firstFrame(bytes);
  let seconds = 0;
  let frames = 0;
  for (
    let frame = frameAt(bytes, offset);
    frame && offset + frame.length <= bytes.length;
    frame = frameAt(bytes, offset)
  ) {
    seconds += frame.samples / frame.sampleRate;
    frames += 1;
    offset += frame.length;
  }
  return frames > 0 ? seconds : null;
};
