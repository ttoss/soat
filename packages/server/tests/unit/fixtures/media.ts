/**
 * Minimal audio and video containers of a chosen duration: the headers a
 * duration reader reads, with silent or empty payloads.
 */

const u32le = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};

const u32be = (value: number): Buffer => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};

/** 8-bit mono PCM at `sampleRate`, one byte per sample. */
export const wavBytes = (args: {
  seconds: number;
  sampleRate?: number;
  extraChunk?: boolean;
}): Buffer => {
  const sampleRate = args.sampleRate ?? 8000;
  const data = Buffer.alloc(Math.round(args.seconds * sampleRate), 0x80);
  const fmt = Buffer.concat([
    Buffer.from([1, 0, 1, 0]),
    u32le(sampleRate),
    u32le(sampleRate),
    Buffer.from([1, 0, 8, 0]),
  ]);
  const chunks = [
    Buffer.from('fmt '),
    u32le(fmt.length),
    fmt,
    ...(args.extraChunk
      ? [Buffer.from('LIST'), u32le(3), Buffer.from('abc\0')]
      : []),
    Buffer.from('data'),
    u32le(data.length),
    data,
  ];
  const body = Buffer.concat(chunks);
  return Buffer.concat([
    Buffer.from('RIFF'),
    u32le(body.length + 4),
    Buffer.from('WAVE'),
    body,
  ]);
};

export const flacBytes = (args: {
  seconds: number;
  sampleRate?: number;
}): Buffer => {
  const sampleRate = args.sampleRate ?? 44100;
  const total = Math.round(args.seconds * sampleRate);
  const info = Buffer.alloc(34);
  info[10] = (sampleRate >> 12) & 0xff;
  info[11] = (sampleRate >> 4) & 0xff;
  info[12] = ((sampleRate & 0x0f) << 4) | 0x02;
  info[13] = 0xf0 | (Math.floor(total / 2 ** 32) & 0x0f);
  info.writeUInt32BE(total % 2 ** 32, 14);
  return Buffer.concat([
    Buffer.from('fLaC'),
    Buffer.from([0x80, 0, 0, 34]),
    info,
  ]);
};

const oggPage = (args: { granule: bigint; packet: Buffer }): Buffer => {
  const header = Buffer.alloc(27);
  header.write('OggS', 0, 'latin1');
  header.writeBigInt64LE(args.granule, 6);
  header[26] = 1;
  return Buffer.concat([
    header,
    Buffer.from([args.packet.length]),
    args.packet,
  ]);
};

export const oggOpusBytes = (args: { seconds: number }): Buffer => {
  const preSkip = 312;
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'latin1');
  head[8] = 1;
  head[9] = 1;
  head.writeUInt16LE(preSkip, 10);
  head.writeUInt32LE(48000, 12);
  return Buffer.concat([
    oggPage({ granule: 0n, packet: head }),
    oggPage({ granule: -1n, packet: Buffer.alloc(8) }),
    oggPage({
      granule: BigInt(Math.round(args.seconds * 48000) + preSkip),
      packet: Buffer.alloc(8),
    }),
  ]);
};

export const oggVorbisBytes = (args: {
  seconds: number;
  sampleRate?: number;
}): Buffer => {
  const sampleRate = args.sampleRate ?? 22050;
  const head = Buffer.alloc(30);
  head.write('\x01vorbis', 0, 'latin1');
  head[11] = 1;
  head.writeUInt32LE(sampleRate, 12);
  return Buffer.concat([
    oggPage({ granule: 0n, packet: head }),
    oggPage({
      granule: BigInt(Math.round(args.seconds * sampleRate)),
      packet: Buffer.alloc(8),
    }),
  ]);
};

const box = (type: string, ...payload: Buffer[]): Buffer => {
  const body = Buffer.concat(payload);
  return Buffer.concat([u32be(body.length + 8), Buffer.from(type), body]);
};

const mvhd = (args: {
  version: 0 | 1;
  timescale: number;
  duration: number;
}): Buffer => {
  if (args.version === 1) {
    const body = Buffer.alloc(112);
    body[0] = 1;
    body.writeUInt32BE(args.timescale, 20);
    body.writeBigUInt64BE(BigInt(args.duration), 24);
    return box('mvhd', body);
  }
  const body = Buffer.alloc(100);
  body.writeUInt32BE(args.timescale, 12);
  body.writeUInt32BE(args.duration, 16);
  return box('mvhd', body);
};

/** An ISO BMFF file (MP4, MOV, M4A); `fragmented` declares it in `mehd`. */
export const mp4Bytes = (args: {
  seconds: number;
  version?: 0 | 1;
  fragmented?: boolean;
}): Buffer => {
  const timescale = 1000;
  const duration = Math.round(args.seconds * timescale);
  const mehd = Buffer.concat([Buffer.alloc(4), u32be(duration)]);
  const moov = args.fragmented
    ? box(
        'moov',
        mvhd({ version: 0, timescale, duration: 0 }),
        box('mvex', box('mehd', mehd))
      )
    : box('moov', mvhd({ version: args.version ?? 0, timescale, duration }));
  return Buffer.concat([
    box('ftyp', Buffer.from('isom'), u32be(512), Buffer.from('isomiso2')),
    box('mdat', Buffer.alloc(16)),
    moov,
  ]);
};

const UNKNOWN_SIZE = Buffer.from([
  0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
]);

const ebml = (id: number[], payload: Buffer): Buffer => {
  return Buffer.concat([
    Buffer.from(id),
    Buffer.from([0x80 | payload.length]),
    payload,
  ]);
};

const simpleBlock = (timecode: number): Buffer => {
  const payload = Buffer.alloc(4);
  payload[0] = 0x81;
  payload.writeInt16BE(timecode, 1);
  return ebml([0xa3], payload);
};

/**
 * Matroska/WebM with a segment of unknown size, as a recorder streams it;
 * `declared` writes `Info/Duration`, else only the clusters time it.
 */
export const webmBytes = (args: {
  seconds: number;
  declared: boolean;
}): Buffer => {
  const ms = Math.round(args.seconds * 1000);
  const scale = Buffer.from([0x0f, 0x42, 0x40]);
  const duration = Buffer.alloc(8);
  duration.writeDoubleBE(ms);
  const info = ebml(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      ebml([0x2a, 0xd7, 0xb1], scale),
      ...(args.declared ? [ebml([0x44, 0x89], duration)] : []),
    ])
  );
  const clusterTimecode = Math.max(ms - 1000, 0);
  const cluster = Buffer.concat([
    Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
    UNKNOWN_SIZE,
    ebml([0xe7], u32be(clusterTimecode)),
    simpleBlock(0),
    simpleBlock(ms - clusterTimecode),
  ]);
  return Buffer.concat([
    ebml([0x1a, 0x45, 0xdf, 0xa3], ebml([0x42, 0x82], Buffer.from('webm'))),
    Buffer.from([0x18, 0x53, 0x80, 0x67]),
    UNKNOWN_SIZE,
    info,
    cluster,
  ]);
};

/** MPEG-1 Layer III, 128 kbit/s, 44.1 kHz: 417-byte frames of 1152 samples. */
export const MP3_FRAME_SECONDS = 1152 / 44100;

export const mp3Bytes = (args: { frames: number; id3?: boolean }): Buffer => {
  const frame = Buffer.alloc(417);
  frame.set([0xff, 0xfb, 0x90, 0x00]);
  const id3 = Buffer.concat([
    Buffer.from('ID3'),
    Buffer.from([3, 0, 0, 0, 0, 0, 10]),
    Buffer.alloc(10),
  ]);
  return Buffer.concat([
    ...(args.id3 ? [id3] : []),
    ...Array.from({ length: args.frames }, () => {
      return frame;
    }),
  ]);
};

/** AAC in ADTS at 44.1 kHz: 1024 samples per frame. */
export const ADTS_FRAME_SECONDS = 1024 / 44100;

export const adtsBytes = (args: { frames: number }): Buffer => {
  const length = 64;
  const frame = Buffer.alloc(length);
  frame.set([
    0xff,
    0xf1,
    0x50,
    0x80 | ((length >> 11) & 0x03),
    (length >> 3) & 0xff,
    ((length & 0x07) << 5) | 0x1f,
    0xfc,
  ]);
  return Buffer.concat(
    Array.from({ length: args.frames }, () => {
      return frame;
    })
  );
};
