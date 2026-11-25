import { readMediaDuration } from 'src/lib/mediaDuration';

import {
  ADTS_FRAME_SECONDS,
  adtsBytes,
  flacBytes,
  MP3_FRAME_SECONDS,
  mp3Bytes,
  mp4Bytes,
  oggOpusBytes,
  oggVorbisBytes,
  wavBytes,
  webmBytes,
} from '../../fixtures/media';

/**
 * Pure algorithm over every container the `max_duration_seconds` gate reads;
 * one REST test drives the gate (`rest/agentInputLimits.test.ts`).
 */
describe('readMediaDuration', () => {
  test.each([
    ['WAV', wavBytes({ seconds: 2.5 }), 2.5],
    [
      'WAV with a chunk before data',
      wavBytes({ seconds: 1, extraChunk: true }),
      1,
    ],
    ['FLAC', flacBytes({ seconds: 7 }), 7],
    ['Ogg Opus', oggOpusBytes({ seconds: 12 }), 12],
    ['Ogg Vorbis', oggVorbisBytes({ seconds: 3 }), 3],
    ['MP4 (mvhd v0)', mp4Bytes({ seconds: 90 }), 90],
    ['MP4 (mvhd v1)', mp4Bytes({ seconds: 45, version: 1 }), 45],
    ['fragmented MP4', mp4Bytes({ seconds: 30, fragmented: true }), 30],
    ['WebM with Info/Duration', webmBytes({ seconds: 20, declared: true }), 20],
    [
      'WebM timed by its clusters',
      webmBytes({ seconds: 8, declared: false }),
      8,
    ],
    ['MP3', mp3Bytes({ frames: 100 }), 100 * MP3_FRAME_SECONDS],
    [
      'MP3 after an ID3 tag',
      mp3Bytes({ frames: 10, id3: true }),
      10 * MP3_FRAME_SECONDS,
    ],
    ['ADTS AAC', adtsBytes({ frames: 50 }), 50 * ADTS_FRAME_SECONDS],
  ])('reads %s', (_label, bytes, seconds) => {
    expect(readMediaDuration({ bytes })).toBeCloseTo(seconds, 3);
  });

  test.each([
    ['bytes no reader recognises', Buffer.from('not audio at all')],
    ['an empty part', Buffer.alloc(0)],
    ['a WAV with no data chunk', wavBytes({ seconds: 1 }).subarray(0, 36)],
    ['an MP4 with no moov', mp4Bytes({ seconds: 1 }).subarray(0, 40)],
    [
      'a lone MPEG sync word',
      Buffer.from([0x00, 0xff, 0xfb, 0x90, 0x00, 0x01]),
    ],
  ])('answers null for %s', (_label, bytes) => {
    expect(readMediaDuration({ bytes })).toBeNull();
  });
});
