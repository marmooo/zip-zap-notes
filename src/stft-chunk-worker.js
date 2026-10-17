/**
 * stft-chunk-worker.js
 * beatmap-worker.js から複数スポーンされ、割り当てられたフレーム範囲の
 * STFT/オンセット強度/エネルギーを計算して返す。
 */

import { computeRawOnsetEnvelope } from "./audio-beatmap.js";

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type !== "computeChunk") return;

  const {
    samples,
    sampleRate,
    fftSize,
    hopSize,
    frameStart,
    frameEnd,
    chunkId,
  } = msg;

  try {
    const raw = computeRawOnsetEnvelope(samples, sampleRate, {
      fftSize,
      hopSize,
      frameStart,
      frameEnd,
    });
    self.postMessage(
      {
        type: "chunkResult",
        chunkId,
        frameStart: raw.frameStart,
        frameEnd: raw.frameEnd,
        odf: raw.odf,
        energy: raw.energy,
        frameTimes: raw.frameTimes,
        // 同じ fftSize なら値はチャンク間で共通。結合時に使用する。
        win: raw._win,
        twiddleWr: raw._twiddles.wr,
        twiddleWi: raw._twiddles.wi,
      },
      [raw.odf.buffer, raw.energy.buffer, raw.frameTimes.buffer],
    );
  } catch (err) {
    self.postMessage({
      type: "chunkError",
      chunkId,
      message: String(err?.message ?? err),
    });
  }
};
