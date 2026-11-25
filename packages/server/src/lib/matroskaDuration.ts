const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const CLUSTER = 0x1f43b675;
const CLUSTER_TIMECODE = 0xe7;
const BLOCK_GROUP = 0xa0;
const BLOCK = 0xa1;
const SIMPLE_BLOCK = 0xa3;

/** Masters whose children are read in place, whatever size they declare. */
const DESCEND = new Set([SEGMENT, CLUSTER, BLOCK_GROUP]);

type VarInt = { value: number; length: number; unknown: boolean };

/** An EBML variable-length integer; `keepMarker` for an element id. */
const readVarInt = (
  bytes: Buffer,
  at: number,
  keepMarker: boolean
): VarInt | null => {
  const first = bytes[at];
  if (first === undefined || first === 0) return null;
  const length = Math.clz32(first) - 23;
  if (at + length > bytes.length) return null;
  let value = keepMarker ? first : first & (0xff >> length);
  let allOnes = value === 0xff >> length;
  for (let index = 1; index < length; index += 1) {
    value = value * 256 + bytes[at + index];
    allOnes = allOnes && bytes[at + index] === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
};

const readUnsigned = (bytes: Buffer, at: number, size: number): number => {
  let value = 0;
  for (let index = 0; index < size; index += 1) {
    value = value * 256 + bytes[at + index];
  }
  return value;
};

const readFloat = (bytes: Buffer, at: number, size: number): number | null => {
  if (size === 4) return bytes.readFloatBE(at);
  if (size === 8) return bytes.readDoubleBE(at);
  return null;
};

type Clock = {
  scale: number;
  declared: number | null;
  clusterTimecode: number;
  lastTimecode: number;
};

const readInfo = (bytes: Buffer, from: number, to: number, clock: Clock) => {
  let offset = from;
  while (offset < to) {
    const id = readVarInt(bytes, offset, true);
    const size = id && readVarInt(bytes, offset + id.length, false);
    if (!id || !size || size.unknown) return;
    const start = offset + id.length + size.length;
    if (id.value === TIMECODE_SCALE) {
      clock.scale = readUnsigned(bytes, start, size.value);
    }
    if (id.value === DURATION) {
      clock.declared = readFloat(bytes, start, size.value);
    }
    offset = start + size.value;
  }
};

// A block opens with its track number, then its timecode relative to the cluster.
const readBlock = (bytes: Buffer, at: number, clock: Clock) => {
  const track = readVarInt(bytes, at, false);
  if (!track || at + track.length + 2 > bytes.length) return;
  const relative = bytes.readInt16BE(at + track.length);
  clock.lastTimecode = Math.max(
    clock.lastTimecode,
    clock.clusterTimecode + relative
  );
};

const readElement = (
  bytes: Buffer,
  offset: number,
  clock: Clock
): number | null => {
  const id = readVarInt(bytes, offset, true);
  const size = id && readVarInt(bytes, offset + id.length, false);
  if (!id || !size) return null;
  const start = offset + id.length + size.length;
  if (DESCEND.has(id.value)) return start;
  if (size.unknown) return null;
  const end = start + size.value;
  if (id.value === INFO) readInfo(bytes, start, end, clock);
  if (id.value === CLUSTER_TIMECODE) {
    clock.clusterTimecode = readUnsigned(bytes, start, size.value);
  }
  if (id.value === SIMPLE_BLOCK || id.value === BLOCK) {
    readBlock(bytes, start, clock);
  }
  return end;
};

/**
 * Matroska and WebM: the `Info` duration when the muxer wrote one, else the
 * last block's timecode (a recorder streaming WebM writes no duration).
 */
export const readMatroskaDuration = (bytes: Buffer): number | null => {
  const clock: Clock = {
    scale: 1_000_000,
    declared: null,
    clusterTimecode: 0,
    lastTimecode: 0,
  };
  let offset: number | null = 0;
  while (offset !== null && offset < bytes.length) {
    offset = readElement(bytes, offset, clock);
  }
  const timecode = clock.declared ?? clock.lastTimecode;
  return timecode > 0 ? (timecode * clock.scale) / 1e9 : null;
};
