/**
 * rhythm-game.js — Flip Flap Dodge engine
 *
 * 音に合わせて落ちてくるブロック（ノーツ）を「避ける」ゲームのエンジン。
 * Flip Flap Notes の 4 レーン・遠近感・描画構造をそのまま流用しつつ、
 * 判定を「タップ」から「衝突」に置き換えている。
 *
 *  - プレイヤーは判定ライン上の 1 レーンにいて、左右に 1 レーンずつ移動する。
 *  - ノーツ（startTime〜endTime の間、判定ラインを通過するブロック）と
 *    同じレーンにいる間は HP が減り、画面が赤くなる。HP が 0 になると死亡。
 *  - ノーツの一部は、出現する直前にプレイヤーのいるレーンへ差し替えられる
 *    （狙い撃ち。割合は難易度の aimRatio）。曲が疎でも常に避ける動作が要るようにする。
 *    GUARANTEE_ESCAPE が true のときは、canEscape() で「その後も必ず逃げ切れる」と
 *    確認できたときだけ差し替える。
 *  - ブロックの横幅は 1 本ずつ変わる（強いほど広い）。MIDI では同時に鳴った音（和音）を
 *    1 本にまとめ、音声ではオンセットの強さの順位から決める。乱数は使わない。
 *  - ノートの間引き・レーン割り当ては thinNotes()。Flip Flap Notes と同じ
 *    「NPS の帯に収まるよう二分探索で間引く」方式に加えて、
 *    「どの瞬間も必ず移動して逃げ切れる経路が残る」ことを保証する
 *    （GUARANTEE_ESCAPE が true のとき。false ならこの保証を外す）。
 */

// ---------------------------------------------------------------------------
// extractNotesFromMidy
// ---------------------------------------------------------------------------

export function extractNotesFromMidy(midy) {
  const inverseTempo = 1 / midy.tempo;
  const timeline = midy.timeline;
  const notes = [];
  const programs = new Uint8Array(16);
  const active = new Map();

  for (const event of timeline) {
    const sec = event.startTime * inverseTempo;
    switch (event.type) {
      case "programChange":
        if (event.channel != null) {
          programs[event.channel] = event.programNumber ?? 0;
        }
        break;
      case "noteOn": {
        const key = event.channel * 128 + event.noteNumber;
        if (event.velocity === 0) {
          const note = active.get(key);
          if (note) {
            note.endTime = sec;
            active.delete(key);
          }
          break;
        }
        const note = {
          noteNumber: event.noteNumber,
          startTime: sec,
          endTime: sec,
          channel: event.channel,
          programNumber: programs[event.channel],
        };
        notes.push(note);
        active.set(key, note);
        break;
      }
      case "noteOff": {
        const key = event.channel * 128 + event.noteNumber;
        const note = active.get(key);
        if (note) {
          note.endTime = sec;
          active.delete(key);
        }
        break;
      }
    }
  }
  return notes;
}

// ---------------------------------------------------------------------------
// Judgment enum
// ---------------------------------------------------------------------------

export const Judgment = Object.freeze({
  DODGE: "dodge",
  HIT: "hit",
});

// ---------------------------------------------------------------------------
// Block geometry (秒)
// ---------------------------------------------------------------------------

/** ブロックの最短長。短すぎる音は見えない/避けようがないので、この長さまで伸ばす */
export const BLOCK_MIN_DURATION = 0.22;
/** ブロックの最長長。長い音（ロングトーン）でレーンを塞ぎっぱなしにしない */
export const BLOCK_MAX_DURATION = 2.0;
/** 同一レーンで連続するブロック同士の最小の隙間 */
const LANE_GAP = 0.10;
/** プレイヤーの余裕。ブロックの前後この秒数ぶん余分に「塞がっている」とみなして経路を検証する */
const PATH_PAD = 0.04;
/**
 * 逃げ切れる保証（安心区間）の有無。
 *   true : どの瞬間も「移動が間に合って立っていられるレーン」が残るように譜面を作り、
 *          狙い撃ちも逃げ切れると確認できたときだけ行う。
 *   false: その保証を外す。ノーツは移動が間に合うかを考えずに置かれ、狙い撃ちも
 *          抽選に通れば必ず行う。避けきれずに少し当たる場面が出るが、レーン数が
 *          少なくても（2 レーンなど）ノーツの密度が保たれ、休める場所がなくなる。
 *          ただし全レーンが同時に塞がる配置（壁）だけは作らない。
 * 各関数は opts.guaranteeEscape / cfg.guaranteeEscape で個別に上書きできる。
 */
export const GUARANTEE_ESCAPE = false;
/**
 * ブロックの横幅（全レーン数に対する割合）の範囲。強さ 0〜1 に応じて MIN〜MAX の間で決まる。
 * 実際の上限は min(WIDTH_FRAC_MAX, maxCoverage)。4 レーンなら常に 1 レーン（25%）になり、
 * レーンを増やすほど幅の違いが細かく表現できる（12 レーンなら 1〜4 レーン）。
 * 幅の大きいブロックは見た目以上に避けにくいので、上限は控えめにしてある。
 * 平均で塞ぐ割合が avgCoverage を超える曲では、ここからさらに一律の倍率で細くする。
 */
const WIDTH_FRAC_MIN = 0.08;
const WIDTH_FRAC_MAX = 0.30;
/** 丸めの位相に使う黄金比の小数部（ノートの通し番号 × これ の小数部が 0〜1 に均等に散る） */
const GOLDEN_FRACTION = 0.6180339887;
/** 塞ぐ面積の平均を測る窓の半幅（秒）。ブロックの前後この秒数ぶんを 1 つの窓とする */
const OCC_HALF_WINDOW = 1.0;
/** 窓の面積の予算に対する余裕（倍）。平均は曲ごとの幅の倍率で合わせるので、これは急な超過だけを止める */
const AREA_GUARD = 1.25;
/** 狙い撃ち: プレイヤーが動き出すまでの反応時間（秒）。逃げ切れる検証ではこの間は動けないとみなす */
const AIM_REACTION = 0.25;
/** 狙い撃ち: 検証時にブロックの前後へ足す余裕（秒）。ぎりぎりの逃げ道しかない差し替えは行わない */
const AIM_SLACK = 0.1;
/** 狙い撃ち: 逃げ切れる検証の時間刻み（秒） */
const AIM_STEP = 0.02;
/** 狙い撃ち: 差し替えたノーツの終了後も、この秒数ぶん先まで逃げ道が残るかを検証する */
const AIM_HORIZON_AFTER = 2.0;
/** 狙い撃ち: 画面に現れる（描画され始める）より、この秒数ぶん早くレーンを確定する */
const AIM_LEAD_MARGIN = 0.15;

// ---------------------------------------------------------------------------
// Difficulty presets
// ---------------------------------------------------------------------------

/**
 * 難易度プリセット
 *
 * Flip Flap Notes と同じく「NPS（notes/sec）の帯」で難易度を定義し、間引きの
 * 強さは曲ごとに二分探索で逆算する。避けゲーではノートが「一定時間レーンを
 * 塞ぐブロック」になるため、タップ版よりも低い NPS を狙う。
 *
 *   EASY   ≒ 1.2〜2.0 nps — 塞ぐ幅は平均 20%・最大 35%
 *   BASIC  ≒ 2.0〜3.2 nps — 平均 25%・最大 40%
 *   NORMAL ≒ 3.2〜4.8 nps — 平均 25%・最大 45%
 *   HARD   ≒ 4.8〜7.0 nps — 平均 30%・最大 45%
 *   EXPERT ≒ 7.0〜10.0 nps — 平均 30%・最大 50%、ドラムも対象
 *
 * ブロックの横幅は 1 本ずつ変わり（下の WIDTH_FRAC_MIN/MAX）、レーン数が増えても
 * 「画面の何割が塞がるか」が同じなので難易度が変わらない。
 *
 * maxCoverage: 同時に塞がるレーン幅の合計の上限（全レーン数に対する割合。ピーク）。
 * avgCoverage: 曲全体で平均して塞がる面積（レーン×秒）の目標。ノートの数（targetNps）を
 *   優先し、超えそうなときはノートを間引くのではなく、ブロックを一律の倍率で細くして
 *   面積を合わせる（幅の違い＝多様性は残る）。長いノートが続く曲でも画面が埋まり続けず、
 *   ノートの数も減らない。ピークだけを上限にすると、長いノートの曲では常にピークまで
 *   埋まってしまう。前後 1 秒の窓での急な超過は、置くときにさらに幅を縮めて抑える。
 * minFreeFrac: 常に空けておく「連続した空きレーン」の割合（最低 2 レーン）。
 *   空きが 1 レーンずつに分断されて身動きが取れなくなるのを防ぐ（既定 25%）。

 * aimRatio: ノーツのうち、出現直前にプレイヤーのいるレーンへ差し替える割合。
 * 差し替えは逃げ切れると確認できたときだけなので、実際の割合はこれ以下になる。
 *
 * moveInterval: 譜面生成が「プレイヤーは 1 レーン動くのにこれだけ秒数が要る」
 * と仮定して逃げ切れる経路を検証するときの値。小さいほど詰め込みが許される。
 */
export const DIFFICULTIES = {
  EASY: {
    label: "EASY",
    targetNps: [1.2, 2.0],
    globalIntervalRatio: 1.15,
    maxCoverage: 0.35,
    avgCoverage: 0.20,
    moveInterval: 0.35,
    aimRatio: 0.3,
    excludeDrums: true,
  },
  BASIC: {
    label: "BASIC",
    targetNps: [2.0, 3.2],
    globalIntervalRatio: 1.15,
    maxCoverage: 0.4,
    avgCoverage: 0.25,
    moveInterval: 0.28,
    aimRatio: 0.4,
    excludeDrums: true,
  },
  NORMAL: {
    label: "NORMAL",
    targetNps: [3.2, 4.8],
    globalIntervalRatio: 1.0,
    maxCoverage: 0.45,
    avgCoverage: 0.25,
    moveInterval: 0.22,
    aimRatio: 0.5,
    excludeDrums: true,
  },
  HARD: {
    label: "HARD",
    targetNps: [4.8, 7.0],
    globalIntervalRatio: 0.9,
    maxCoverage: 0.45,
    avgCoverage: 0.3,
    moveInterval: 0.18,
    aimRatio: 0.6,
    excludeDrums: true,
  },
  EXPERT: {
    label: "EXPERT",
    targetNps: [7.0, 10.0],
    globalIntervalRatio: 0.8,
    maxCoverage: 0.5,
    avgCoverage: 0.3,
    moveInterval: 0.15,
    aimRatio: 0.7,
    excludeDrums: false,
  },
};

// ---------------------------------------------------------------------------
// Escape check (狙い撃ちの安全確認)
// ---------------------------------------------------------------------------

/** ビットマスク occupied（1 = 塞がっている）の外側で、空きレーンが連続する最大の長さ */
function largestFreeRun(occupied, laneCount) {
  let best = 0;
  let run = 0;
  for (let l = 0; l < laneCount; l++) {
    if (occupied & (1 << l)) run = 0;
    else if (++run > best) best = run;
  }
  return best;
}

/** left から width レーンぶんのビットマスク */
export function laneMask(left, width) {
  return ((1 << width) - 1) << left;
}

/**
 * プレイヤーが startLane にいるとき、ブロック列に対して常に立っていられる
 * レーンが残る（＝逃げ切れる）かを時間刻みでシミュレートする。
 *
 * masks/froms/tos: ブロックが塞ぐレーンのビットマスクと塞がっている区間 [from, to)（秒。余裕込み）。
 * t0〜tEnd を AIM_STEP 刻みで進め、立っていられるレーンの集合 reach（ビットマスク）を
 * 更新する。reach が空になったら false。
 * reactionSec の間は動けず、その後 moveInterval 秒ごとに隣のレーンへ広がれる。
 */
export function canEscape(
  masks,
  froms,
  tos,
  laneCount,
  startLane,
  t0,
  tEnd,
  moveInterval,
  reactionSec,
) {
  const allLanes = (1 << laneCount) - 1;
  let reach = 1 << startLane;
  let untilMove = reactionSec + moveInterval;
  for (let t = t0; t <= tEnd; t += AIM_STEP) {
    let blocked = 0;
    for (let k = 0; k < masks.length; k++) {
      if (froms[k] <= t && t < tos[k]) blocked |= masks[k];
    }
    const free = allLanes & ~blocked;
    reach &= free;
    if (reach === 0) return false;
    untilMove -= AIM_STEP;
    if (untilMove <= 0) {
      untilMove += moveInterval;
      reach = (reach | (reach << 1) | (reach >> 1)) & free;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Note density measurement
// ---------------------------------------------------------------------------

/**
 * windowSec 秒のスライド窓（1秒刻み）でノート数を数え、その percentile
 * 分位点を代表 NPS として返す。単純な平均（総数/曲長）だと、長い無音の
 * イントロ・アウトロや静かな間奏で全体が薄まり、サビなど実際にプレイする
 * 部分の密度感を過小評価してしまうため、分位点ベースにしている。
 * times は startTime 昇順であることを前提とする。
 */
function measureNps(times, duration, windowSec = 4, percentile = 0.7) {
  if (times.length === 0 || duration <= 0) return 0;
  if (duration <= windowSec) return times.length / duration;

  const hopSec = 1;
  const counts = [];
  let left = 0, right = 0;
  for (let t = 0; t + windowSec <= duration; t += hopSec) {
    while (left < times.length && times[left] < t) left++;
    if (right < left) right = left;
    while (right < times.length && times[right] < t + windowSec) right++;
    counts.push(right - left);
  }
  if (counts.length === 0) return times.length / duration;

  counts.sort((a, b) => a - b);
  const idx = Math.min(
    counts.length - 1,
    Math.floor(counts.length * percentile),
  );
  return counts[idx] / windowSec;
}

// ---------------------------------------------------------------------------
// Note thinning
// ---------------------------------------------------------------------------

/**
 * 難易度の設定と（実際の）レーン数から、生成と狙い撃ちで使う上限を決める。
 *   maxCover   : 同時に塞がってよいレーン数の合計（ピーク）。maxCoverage × レーン数。
 *   minFreeRun : 常に空けておく「連続した空きレーン」の長さ。空きが 1 レーンずつに
 *                分断されて身動きが取れなくなるのを防ぐ。
 *   avgCoverage: 前後 OCC_HALF_WINDOW 秒の窓で、塞がる面積（レーン×秒）の平均が
 *                全体のこの割合を超えないようにする（長いノートが続いても埋まらない）。
 */
export function resolveLimits(cfg, laneCount) {
  const maxCoverage = cfg.maxCoverage ?? 0.5;
  const minFreeRun = Math.min(
    laneCount - 1,
    cfg.minFreeRun ??
      Math.max(2, Math.ceil((cfg.minFreeFrac ?? 0.25) * laneCount)),
  );
  const maxCover = Math.max(
    1,
    Math.min(
      laneCount - minFreeRun,
      Math.floor(maxCoverage * laneCount + 1e-9),
    ),
  );
  return {
    maxCoverage,
    maxCover,
    minFreeRun,
    avgCoverage: cfg.avgCoverage ?? maxCoverage,
    moveInterval: cfg.moveInterval ?? 0.22,
    guaranteeEscape: cfg.guaranteeEscape ?? GUARANTEE_ESCAPE,
  };
}

/**
 * Step 2（レーン割当）のみを取り出した関数。密度の二分探索から繰り返し呼ぶ。
 *
 * 候補ノート（pos: 0〜1 の横位置、width: 横幅のレーン数）を、横位置に最も近い
 * 空きレーンへ順に置いていく。ブロックは [lane, lane + width) のレーンを塞ぐ。
 *   - 同時に塞がるレーン数の合計は limits.maxCover 以下。
 *   - 置いたあとも、連続した空きレーンが limits.minFreeRun 以上残る。
 *   - 前後 OCC_HALF_WINDOW 秒の窓で塞がる面積（レーン×秒）が予算 avgCoverage の
 *     AREA_GUARD 倍以内。平均の面積は thinNotes が曲ごとに幅の倍率で合わせるので、
 *     ここは急な超過だけを止める。
 *   - 残りの枠（レーン数・面積）に収まらない幅のブロックは、1 レーンまで幅を縮めて
 *     置く（ノートの数を優先する）。1 レーンでも収まらなければ見送る。
 *   - 同じレーンは LANE_GAP / minInterval の間隔を空ける。
 *   - limits.guaranteeEscape が true のときは、置いたあとも「移動が間に合って立って
 *     いられるレーン」が残ることも確かめる（reach = そのレーンのビットマスク）。
 *   ノートは startTime 昇順で 1 本ずつ確定するので、状態はレーンごとの塞がり終わり時刻
 *   などだけで済み、1 本あたり O(laneCount × width) で判定できる。
 */
function assignLanes(
  candidates,
  laneCount,
  minInterval,
  globalInterval,
  limits,
  keptIndices = null,
) {
  const { maxCover, minFreeRun, avgCoverage, moveInterval, guaranteeEscape } =
    limits;
  const laneLastStart = new Float64Array(laneCount).fill(-1e9);
  const laneLastEnd = new Float64Array(laneCount).fill(-1e9);
  const busyUntil = new Float64Array(laneCount).fill(-1e9); // 経路検証用（PATH_PAD 込み）
  const fullMask = (1 << laneCount) - 1;
  const occBudget = avgCoverage * laneCount * OCC_HALF_WINDOW * 2 * AREA_GUARD; // レーン×秒
  const placed = []; // 置いたブロックの { start, end, width }（面積の集計用）
  let placedFrom = 0;
  let reach = 1 << (laneCount >> 1); // プレイヤーの開始レーンは中央
  let tCur = -1e9;
  let globalLast = -1e9;
  const result = [];

  // tCur → to まで時間を進めたときの reach を返す（状態は変更しない）。
  const simulate = (to) => {
    let r = reach;
    let t = tCur;
    while (t < to) {
      let blocked = 0;
      let next = to;
      for (let l = 0; l < laneCount; l++) {
        const b = busyUntil[l];
        if (b > t) {
          blocked |= 1 << l;
          if (b < next) next = b;
        }
      }
      const free = fullMask & ~blocked;
      r &= free;
      if (r === 0) return 0;
      const steps = Math.min(
        laneCount,
        Math.floor((next - t) / moveInterval),
      );
      for (let s = 0; s < steps; s++) {
        const grown = (r | (r << 1) | (r >> 1)) & free;
        if (grown === r) break;
        r = grown;
      }
      t = next;
    }
    return r;
  };

  // [left, left + width) に st から置けるか
  const fits = (left, width, st, reachBefore) => {
    for (let l = left; l < left + width; l++) {
      if (st - laneLastStart[l] < minInterval) return false;
      if (st < laneLastEnd[l] + LANE_GAP) return false;
    }
    // このブロックを置いても、空きレーンが minFreeRun 以上つながっていること
    let occupied = laneMask(left, width);
    for (let l = 0; l < laneCount; l++) {
      if (laneLastEnd[l] > st) occupied |= 1 << l;
    }
    if (largestFreeRun(occupied, laneCount) < minFreeRun) return false;
    // このブロックで塞いでも、立っていられるレーンが残ること
    if (
      guaranteeEscape && (reachBefore & ~laneMask(left, width)) === 0
    ) return false;
    return true;
  };

  for (let ci = 0; ci < candidates.length; ci++) {
    const note = candidates[ci];
    const st = note.startTime;

    if (globalInterval > 0 && st - globalLast < globalInterval) continue;

    const end = Math.min(
      Math.max(note.endTime, st + BLOCK_MIN_DURATION),
      st + BLOCK_MAX_DURATION,
    );

    // 同時に塞がっているレーン数（ピーク）の残り枠
    let held = 0;
    for (let l = 0; l < laneCount; l++) {
      if (laneLastEnd[l] > st) held++;
    }

    // 前後の窓ですでに塞がっている面積と、このブロックが窓の中で塞ぐ時間
    const winStart = st - OCC_HALF_WINDOW;
    const winEnd = st + OCC_HALF_WINDOW;
    while (
      placedFrom < placed.length &&
      placed[placedFrom].start + BLOCK_MAX_DURATION <= winStart
    ) placedFrom++;
    let existing = 0;
    for (let k = placedFrom; k < placed.length; k++) {
      const b = placed[k];
      const from = b.start > winStart ? b.start : winStart;
      const to = b.end < winEnd ? b.end : winEnd;
      if (to > from) existing += b.width * (to - from);
    }
    const inWindow = Math.min(end, winEnd) - st;

    // 収まる幅: ピークの残り枠と、面積の残り予算の小さいほう
    let width = Math.min(note.width, maxCover - held);
    if (inWindow > 0) {
      const byArea = Math.floor((occBudget - existing) / inWindow + 1e-9);
      if (byArea < width) width = byArea;
    }
    if (width < 1) continue;

    const pathStart = st - PATH_PAD;
    const reachBefore = guaranteeEscape ? simulate(pathStart) : fullMask;

    // 横位置に最も近い空きを探す（同じ距離なら画面中央側を先に）
    const ideal = Math.min(
      laneCount - width,
      Math.max(0, Math.round(note.pos * laneCount - width / 2)),
    );
    const towardCenter = ideal + width / 2 <= laneCount / 2 ? 1 : -1;
    let bestLeft = -1;
    for (let off = 0; off < laneCount && bestLeft === -1; off++) {
      for (let side = 0; side < 2; side++) {
        if (off === 0 && side === 1) break;
        const left = ideal + (side === 0 ? towardCenter : -towardCenter) * off;
        if (left < 0 || left + width > laneCount) continue;
        if (fits(left, width, st, reachBefore)) {
          bestLeft = left;
          break;
        }
      }
    }
    if (bestLeft === -1) continue;

    if (guaranteeEscape) {
      reach = reachBefore & ~laneMask(bestLeft, width);
      if (pathStart > tCur) tCur = pathStart;
    }
    globalLast = st;
    for (let l = bestLeft; l < bestLeft + width; l++) {
      if (guaranteeEscape) busyUntil[l] = end + PATH_PAD;
      laneLastStart[l] = st;
      laneLastEnd[l] = end;
    }
    placed.push({ start: st, end, width });
    if (keptIndices) keptIndices.push(ci);

    result.push({
      noteNumber: note.noteNumber,
      startTime: st,
      endTime: end,
      channel: note.channel,
      programNumber: note.programNumber,
      lane: bestLeft, // ブロックの左端のレーン
      width, // 横幅（レーン数）
      duration: end - st,
      hit: false, // ブロックが判定ラインに到達済み
      missed: false, // 一度でも当たった
      judgment: null,
      holdActive: false, // 判定ラインを通過中
      tookDamage: false, // 通過中に一度でもダメージを受けた
    });
  }

  return result;
}

/**
 * candidates（クラスタ選別済みの候補ノート列）に対し、targetNps の帯に
 * 実測密度が収まるよう minInterval/globalInterval を二分探索で決定する。
 * iv（同一レーン間隔の基準値）を単一の探索変数とし、globalInterval は
 * cfg.globalIntervalRatio で連動させる。iv が大きいほど間引きが強くなり
 * 密度は単調非増加になるため、二分探索が成立する。
 * 原曲密度が下限 NPS に満たない場合や、塞ぐ面積の予算で頭打ちになる場合は
 * iv を下限側で打ち切り、無理にノートを水増ししない（削る方向にしか働かない設計）。
 */
function computeAdaptiveInterval(
  candidates,
  laneCount,
  cfg,
  laneScale,
  limits,
) {
  const [targetMin, targetMax] = cfg.targetNps ?? [1.6, 2.4];
  const globalRatio = cfg.globalIntervalRatio ?? 1.0;

  const duration = candidates.length
    ? candidates[candidates.length - 1].startTime - candidates[0].startTime
    : 0;
  if (duration <= 0) return { minInterval: 0, globalInterval: 0 };

  let lo = 0.01, hi = 2.0;
  for (let iter = 0; iter < 18; iter++) {
    const iv = (lo + hi) / 2;
    const result = assignLanes(
      candidates,
      laneCount,
      iv * laneScale,
      iv * globalRatio,
      limits,
    );
    const nps = measureNps(result.map((r) => r.startTime), duration);

    if (nps > targetMax) {
      lo = iv; // 密度が高すぎる → もっと間引く（iv を大きく）
    } else if (nps < targetMin) {
      hi = iv; // 密度が低すぎる → 間引きを弱める（iv を小さく）
    } else {
      return { minInterval: iv * laneScale, globalInterval: iv * globalRatio };
    }
  }
  return { minInterval: lo * laneScale, globalInterval: lo * globalRatio };
}

/** sorted（昇順）のうち v より小さい要素の数 */
function countLess(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** sorted（昇順）のうち v 以下の要素の数 */
function countLessOrEqual(sorted, v) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] <= v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * 同時に鳴った音（notes[from, to)）を 1 本のブロックにまとめる。
 * 音高は平均、終了は最も遅いものに合わせる。
 *   explicit: 音声の解析結果に strength があればその最大値（なければ -1）。
 *   chord   : 和音の度合い 0〜1（単音 0、2 音 0.5、3 音以上 1）。MIDI の強さの材料。
 */
function mergeCluster(notes, from, to) {
  let sum = 0;
  let end = -Infinity;
  let explicit = -1;
  let longest = notes[from];
  for (let k = from; k < to; k++) {
    const n = notes[k];
    sum += n.noteNumber;
    if (n.endTime > end) end = n.endTime;
    if (
      n.endTime - n.startTime > longest.endTime - longest.startTime
    ) longest = n;
    if (typeof n.strength === "number" && n.strength > explicit) {
      explicit = n.strength;
    }
  }
  const size = to - from;
  return {
    noteNumber: Math.round(sum / size),
    startTime: notes[from].startTime,
    endTime: end,
    channel: longest.channel,
    programNumber: longest.programNumber,
    explicit,
    chord: Math.min(1, (size - 1) / 2),
    strength: 0,
    frac: 0,
    pos: 0,
    width: 1,
  };
}

export function thinNotes(
  notes,
  laneCount = 6,
  difficulty = DIFFICULTIES.NORMAL,
  extraOpts = {},
) {
  const cfg = { ...difficulty, ...extraOpts };
  const {
    excludeDrums = true,
  } = cfg;

  const laneScale = Math.min(2.0, Math.max(0.5, 4 / laneCount));
  const limits = resolveLimits(cfg, laneCount);
  const { maxCoverage, maxCover } = limits;
  // ブロックの横幅（全レーン数に対する割合）の範囲
  const widthFracMax = Math.min(
    cfg.widthFracMax ?? WIDTH_FRAC_MAX,
    maxCoverage,
  );
  const widthFracMin = Math.min(
    cfg.widthFracMin ?? WIDTH_FRAC_MIN,
    widthFracMax,
  );

  if (!notes || notes.length === 0) return [];

  // Step 0: pre-filter
  const prefiltered = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (excludeDrums && n.channel === 9) continue;
    prefiltered.push(n);
  }

  // Step 1: 50ms 以内に同時に鳴った音（和音）を 1 本の候補ブロックにまとめる
  const CLUSTER_WIN = 0.05;
  const candidates = [];
  let i = 0;
  while (i < prefiltered.length) {
    const t = prefiltered[i].startTime;
    let j = i;
    while (
      j < prefiltered.length && prefiltered[j].startTime < t + CLUSTER_WIN
    ) j++;
    candidates.push(mergeCluster(prefiltered, i, j));
    i = j;
  }

  // 横位置: 音高の順位（曲全体での分位）を 0〜1 に写す。全レーンが均等に使われ、
  // 同じ音高は必ず同じ位置になる。
  const sortedNotes = new Float64Array(candidates.length);
  for (let k = 0; k < candidates.length; k++) {
    sortedNotes[k] = candidates[k].noteNumber;
  }
  sortedNotes.sort();

  // 強さ（幅の材料）: 音声ならオンセット強度の順位。MIDI は強度がないので、
  // 和音（音が多いほど強い）と、直前のノートからの間隔の順位（孤立した音ほど強く、
  // 速いパッセージの 1 音ほど弱い）を半分ずつ混ぜる。単音ばかりの曲でも幅がばらける。
  const gaps = new Float64Array(candidates.length);
  for (let k = 0; k < candidates.length; k++) {
    gaps[k] = k === 0
      ? Infinity
      : candidates[k].startTime - candidates[k - 1].startTime;
  }
  const sortedGaps = Float64Array.from(gaps).sort();

  for (let k = 0; k < candidates.length; k++) {
    const c = candidates[k];
    const lo = countLess(sortedNotes, c.noteNumber);
    const hi = countLessOrEqual(sortedNotes, c.noteNumber);
    c.pos = (lo + hi) / 2 / candidates.length;
    if (c.explicit >= 0) {
      c.strength = c.explicit;
    } else {
      const gLo = countLess(sortedGaps, gaps[k]);
      const gHi = countLessOrEqual(sortedGaps, gaps[k]);
      const gapRank = (gLo + gHi) / 2 / candidates.length;
      c.strength = 0.5 * c.chord + 0.5 * gapRank;
    }
    c.frac = widthFracMin + c.strength * (widthFracMax - widthFracMin);
  }

  // 幅（レーン数）: 倍率をかけた実数の幅を、ノートごとにずらした位相で切り捨てる
  // （例: 2.3 なら 7 割が 2、3 割が 3）。四捨五入だと全部同じ幅にそろってしまい、
  // 幅の多様性がなくなる。平均の面積は実数の幅のまま保たれる。
  const widthAt = (c, index, scale) =>
    Math.min(
      maxCover,
      Math.max(
        1,
        Math.floor(
          scale * c.frac * laneCount +
            ((index * GOLDEN_FRACTION) % 1),
        ),
      ),
    );
  const blockDuration = (c) =>
    Math.min(
      Math.max(c.endTime - c.startTime, BLOCK_MIN_DURATION),
      BLOCK_MAX_DURATION,
    );
  const span = candidates.length
    ? candidates[candidates.length - 1].startTime - candidates[0].startTime
    : 0;
  const setWidths = (scale) => {
    for (let k = 0; k < candidates.length; k++) {
      candidates[k].width = widthAt(candidates[k], k, scale);
    }
  };

  // Step 2: lane assignment（2 段階）
  //  1) 幅の倍率 1 で、密度の二分探索と割り当てを行い、実際に残るノートを決める。
  //  2) 残ったノートの平均の面積が avgCoverage を超えていれば、その残ったノートで
  //     面積が収まる最大の倍率を二分探索し、幅を一律に細くして割り当てなおす。
  //  ノートの数（targetNps）を優先し、面積は幅を細くして合わせる。
  setWidths(1);
  let minInterval, globalInterval;
  if (extraOpts.minInterval != null && extraOpts.globalInterval != null) {
    minInterval = extraOpts.minInterval * laneScale;
    globalInterval = extraOpts.globalInterval;
  } else {
    ({ minInterval, globalInterval } = computeAdaptiveInterval(
      candidates,
      laneCount,
      cfg,
      laneScale,
      limits,
    ));
  }

  const kept = [];
  let result = assignLanes(
    candidates,
    laneCount,
    minInterval,
    globalInterval,
    limits,
    kept,
  );

  if (span > 0) {
    const areaAt = (scale) => {
      let sum = 0;
      for (let i = 0; i < kept.length; i++) {
        const c = candidates[kept[i]];
        sum += widthAt(c, kept[i], scale) * blockDuration(c);
      }
      return sum / (laneCount * span);
    };
    if (areaAt(1) > limits.avgCoverage) {
      let lo = 0;
      let hi = 1;
      for (let iter = 0; iter < 14; iter++) {
        const mid = (lo + hi) / 2;
        if (areaAt(mid) <= limits.avgCoverage) lo = mid;
        else hi = mid;
      }
      setWidths(lo);
      result = assignLanes(
        candidates,
        laneCount,
        minInterval,
        globalInterval,
        limits,
      );
    }
  }

  if (typeof cfg.onDensityMeasured === "function") {
    cfg.onDensityMeasured(
      measureNps(result.map((r) => r.startTime), span),
      cfg.targetNps,
    );
  }

  return result;
}

// ---------------------------------------------------------------------------
// Drawing helpers
// ---------------------------------------------------------------------------

/**
 * "#rrggbb" / "rgb(r,g,b)" 形式の色に任意のアルファを付けて "rgba(r,g,b,a)" にする。
 * o.uiColor（呼び出し側が currentColor 相当として渡すテーマの文字色）を土台に
 * することで、ダーク/ライト両テーマで UI パーツが見えるようにする。
 */
function withAlpha(color, alpha) {
  let r, g, b;
  if (color.startsWith("#")) {
    const n = parseInt(color.slice(1), 16);
    r = (n >> 16) & 0xff;
    g = (n >> 8) & 0xff;
    b = n & 0xff;
  } else {
    [r, g, b] = color.match(/\d+/g).map(Number);
  }
  return `rgba(${r},${g},${b},${alpha})`;
}

const DEFAULT_LANE_COLORS = [
  "#ff6666",
  "#66ccff",
  "#ffcc66",
  "#66ff99",
  "#cc66ff",
  "#ff9966",
  "#66ffcc",
  "#ff66cc",
  "#ccff66",
  "#6699ff",
  "#b3b3ff",
  "#ffff66",
];

const DANGER_COLOR = "#ff3b3b";

// 判定FX の定義テーブル（size は論理px。描画時に dpr を掛ける）
const FX_TABLE = {
  [Judgment.DODGE]: { text: "DODGE", color: "#66ffcc", size: 16 },
  [Judgment.HIT]: { text: "HIT!", color: DANGER_COLOR, size: 22 },
};

/** 死亡演出（爆発）を見せる長さ（秒）。この後に gameOver を通知する */
const DEATH_ANIM_SEC = 1.2;

// ---------------------------------------------------------------------------
// RhythmGame
// ---------------------------------------------------------------------------

export class RhythmGame {
  onJudgment = null; // (judgment, combo, score)
  onEnded = null; // 譜面を最後まで生き延びた
  onDeath = null; // HP が 0 になった瞬間（音楽を止める用）
  onGameOver = null; // 死亡演出が終わった（結果画面へ）
  onHpChange = null; // HP が変化したとき (hp, maxHp) => void

  #endedFired = false;
  #gameOverFired = false;
  #canvas;
  #ctx;
  #pCanvas;
  #pCtx;
  #uiCanvas;
  #uiCtx;
  #opts;
  #notes = [];
  #noteIndex = 0;
  #drawCursor = 0; // 描画開始カーソル
  #aimIndex = 0; // 狙い撃ちの判定を済ませたノーツの数
  #activeNotes = []; // 判定ラインを通過中のノート
  #playerLane = 0;
  #playerVisX = 0; // 表示用のなめらかなレーン位置（レーン単位・小数）
  #judgmentFx = [];
  #particles = [];
  #score = 0;
  #combo = 0;
  #maxCombo = 0;
  #dodgeCount = 0;
  #hitCount = 0;
  #hp = 100;
  #maxHp = 100;
  #lastSentHp = 100;
  #gameOver = false;
  #deathT = 0; // 死亡時のゲーム時刻（描画をここで止める）
  #deathElapsed = 0;
  #hitFlash = 0; // 被弾時の画面フラッシュ残り時間（秒）
  #getTime = null;
  #animId = null;
  #lastFrameMs = 0;
  #lastTickTime = 0;
  #boundLoop = this.#loop.bind(this);

  // キャッシュ（フレームをまたいで再利用）
  #cachedW = 0;
  #cachedH = 0;
  #cachedHitY = 0;
  #cachedLaneW = 0;
  #cachedHintFont = "";
  #cachedBigFont = "";
  #uiDirty = true;

  constructor(canvas, options = {}) {
    if (canvas && typeof canvas === "object" && "note" in canvas) {
      this.#canvas = canvas.note;
      this.#pCanvas = canvas.particle;
      this.#uiCanvas = canvas.ui;
    } else {
      this.#canvas = this.#pCanvas = this.#uiCanvas = canvas;
    }
    this.#ctx = this.#canvas.getContext("2d");
    this.#pCtx = this.#pCanvas.getContext("2d");
    this.#uiCtx = this.#uiCanvas.getContext("2d");

    const laneCount = options.laneCount ?? 6;
    // dpr: canvas バッファは CSS サイズ × dpr。論理px（dpr=1基準）の定数は
    // 描画時に dpr を掛けて、高DPIでも見た目サイズが PC と同じになるようにする。
    const dpr = Number(options.dpr) > 0 ? Number(options.dpr) : 1;
    this.#opts = {
      laneCount,
      dpr,
      glow: options.glow ?? false,
      laneOpacity: options.laneOpacity ?? 1.0,
      scrollSpeed: options.scrollSpeed ?? 500, // 論理px/秒
      buttonZoneHeight: options.buttonZoneHeight ?? 80,
      laneColors: options.laneColors ?? DEFAULT_LANE_COLORS.slice(0, laneCount),
      uiColor: options.uiColor ?? "#ffffff",
      judgeLineColor: options.judgeLineColor ?? "",
      accentColor: options.accentColor ?? "",
      laneLineColor: options.laneLineColor ?? "",
      judgeOffset: options.judgeOffset ?? 0, // 秒 (正=遅く, 負=早く)
      startDelay: options.startDelay ?? 0,
      totalNotes: 0,
      difficulty: options.difficulty ?? DIFFICULTIES.NORMAL,
      thinExtra: options.thinExtra ?? {},
      perspective: options.perspective ?? 0.78, // 0=平面, 1=強い遠近感
      topInset: options.topInset ?? 0,
      maxHp: options.maxHp ?? 100,
      // ブロックに重なっている間、毎秒減る HP
      damagePerSecond: options.damagePerSecond ?? 50,
      // 狙い撃ちの抽選に使う乱数（0以上1未満）。テストで差し替える
      random: options.random ?? Math.random,
      guaranteeEscape: options.guaranteeEscape ?? GUARANTEE_ESCAPE,
      // 狙い撃ちの逃げ切れる確認だけを別に切り替える／調整する（既定は譜面側の設定に合わせる）
      aimGuarantee: options.aimGuarantee ?? options.guaranteeEscape ??
        GUARANTEE_ESCAPE,
      aimMoveInterval: options.aimMoveInterval ?? null,
      aimReaction: options.aimReaction ?? AIM_REACTION,
      aimSlack: options.aimSlack ?? AIM_SLACK,
    };
    this.#maxHp = this.#opts.maxHp;
    this.#hp = options.initialHp !== undefined
      ? Math.max(0, Math.min(this.#maxHp, Number(options.initialHp) || 0))
      : this.#maxHp;
    this.#lastSentHp = this.#hp;
    this.#playerLane = laneCount >> 1;
    this.#playerVisX = this.#playerLane;
  }

  // ---- Public API ---------------------------------------------------------

  setNotesRaw(laneNotes) {
    this.#notes = laneNotes;
    this.#initNotes();
    this.#opts.totalNotes = laneNotes.length;
    return laneNotes.length;
  }

  resetState() {
    this.#resetState();
  }

  setNotes(notes) {
    this.#notes = thinNotes(
      notes.slice().sort((a, b) => a.startTime - b.startTime),
      this.#opts.laneCount,
      this.#opts.difficulty,
      this.#opts.thinExtra,
    );
    this.#initNotes();
    this.#opts.totalNotes = this.#notes.length;
    return this.#notes.length;
  }

  start(getTime, startOpts = {}) {
    this.#resetState(startOpts?.preserveHp ?? false);
    this.#getTime = getTime ??
      (() => (performance.now() - this.#lastFrameMs) / 1000);
    this.#lastFrameMs = performance.now();
    this.#loop();
  }

  tick(t) {
    const now = performance.now();
    // pause 中は #lastFrameMs が止まったままなので再開後の dt が巨大になる。
    // 1フレーム分（約33ms）を上限にクランプして正常な範囲に保つ。
    const dt = Math.min((now - this.#lastFrameMs) / 1000, 0.033);
    this.#lastFrameMs = now;
    this.#step(t, dt);
  }

  /**
   * 曲終了・強制終了時に、通過中のブロックを確定して onEnded を通知する。
   * 死亡済みなら何もしない（onGameOver 側が結果を通知する）。
   */
  finalize(t = this.#lastTickTime) {
    if (this.#endedFired || this.#gameOver) return;
    for (let i = 0; i < this.#activeNotes.length; i++) {
      this.#finishNote(this.#activeNotes[i]);
    }
    this.#activeNotes.length = 0;
    this.#particles.length = 0;
    this.#lastTickTime = t;
    this.#fireEnded();
  }

  stop() {
    if (this.#animId) {
      cancelAnimationFrame(this.#animId);
      this.#animId = null;
    }
    this.#getTime = null;
  }

  /** dir: -1=左へ 1 レーン, +1=右へ 1 レーン */
  moveLane(dir) {
    if (this.#gameOver) return;
    const next = this.#playerLane + (dir < 0 ? -1 : 1);
    if (next < 0 || next >= this.#opts.laneCount) return;
    this.#playerLane = next;
    this.#uiDirty = true;
  }

  /** lane: 0〜laneCount-1 の整数で指定レーンに直接移動 */
  setLane(lane) {
    if (this.#gameOver) return;
    const target = Math.max(
      0,
      Math.min(this.#opts.laneCount - 1, Math.round(lane)),
    );
    if (target === this.#playerLane) return;
    this.#playerLane = target;
    this.#uiDirty = true;
  }

  /** HP を直接設定する（上限 maxHp、下限 0） */
  setHp(hp) {
    this.#hp = Math.max(0, Math.min(this.#maxHp, Number(hp) || 0));
    this.#lastSentHp = this.#hp;
    this.#uiDirty = true;
    if (this.#hp <= 0 && !this.#gameOver) {
      this.#die();
    }
  }

  resize(w, h, extra = {}) {
    this.#canvas.width = w;
    this.#canvas.height = h;
    if (this.#pCanvas !== this.#canvas) {
      this.#pCanvas.width = w;
      this.#pCanvas.height = h;
    }
    if (this.#uiCanvas !== this.#canvas) {
      this.#uiCanvas.width = w;
      this.#uiCanvas.height = h;
    }
    if (extra.topInset !== undefined) {
      this.#opts.topInset = extra.topInset;
    }
    if (extra.buttonZoneHeight !== undefined) {
      this.#opts.buttonZoneHeight = extra.buttonZoneHeight;
    }
    if (extra.dpr !== undefined && Number(extra.dpr) > 0) {
      this.#opts.dpr = Number(extra.dpr);
    }
    this.#invalidateCache();
  }

  updateOptions(patch = {}) {
    let dirty = false;
    const simple = [
      "scrollSpeed",
      "laneColors",
      "glow",
      "laneOpacity",
      "perspective",
      "uiColor",
      "judgeLineColor",
      "accentColor",
      "laneLineColor",
      "topInset",
      "buttonZoneHeight",
    ];
    for (const key of simple) {
      if (patch[key] !== undefined) {
        this.#opts[key] = patch[key];
        dirty = true;
      }
    }
    if (patch.dpr !== undefined && Number(patch.dpr) > 0) {
      this.#opts.dpr = Number(patch.dpr);
      dirty = true;
    }
    if (patch.judgeOffset !== undefined) {
      this.#opts.judgeOffset = patch.judgeOffset;
    }
    if (dirty) {
      this.#invalidateCache();
      this.#uiDirty = true;
    }
  }

  get score() {
    return Math.round(this.#score);
  }
  get combo() {
    return this.#combo;
  }
  get maxCombo() {
    return this.#maxCombo;
  }
  get dodgeCount() {
    return this.#dodgeCount;
  }
  get hitCount() {
    return this.#hitCount;
  }
  get hp() {
    return this.#hp;
  }
  get maxHp() {
    return this.#maxHp;
  }
  get isGameOver() {
    return this.#gameOver;
  }
  get totalNotes() {
    return this.#notes.length;
  }
  get judgedNotes() {
    return this.#dodgeCount + this.#hitCount;
  }
  get laneCount() {
    return this.#opts.laneCount;
  }
  get notes() {
    return this.#notes;
  }
  /** 譜面のどこまで進んだか（0〜1）。死亡時の到達度表示用 */
  get progress() {
    const n = this.#notes.length;
    return n ? Math.min(1, this.#noteIndex / n) : 1;
  }
  /** 回避率（%）。ブロックに一度も当たらなかったものの割合 */
  get dodgeRate() {
    const total = this.#dodgeCount + this.#hitCount;
    return total > 0 ? (this.#dodgeCount / total) * 100 : 100;
  }

  // ---- Private: reset / loop ---------------------------------------------

  /** ノーツ差し替え後の初期化。元のレーンを baseLane に控えて、カーソルを先頭に戻す */
  #initNotes() {
    const notes = this.#notes;
    for (let i = 0; i < notes.length; i++) {
      if (notes[i].baseLane === undefined) notes[i].baseLane = notes[i].lane;
      if (notes[i].width === undefined) notes[i].width = 1;
    }
    this.#noteIndex = 0;
    this.#drawCursor = 0;
    this.#aimIndex = 0;
  }

  #resetState(preserveHp = false) {
    this.#score = this.#combo = this.#maxCombo = 0;
    this.#dodgeCount = this.#hitCount = 0;
    if (!preserveHp) {
      this.#hp = this.#maxHp;
    }
    this.#lastSentHp = this.#hp;
    this.#gameOver = false;
    this.#deathT = 0;
    this.#deathElapsed = 0;
    this.#hitFlash = 0;
    this.#noteIndex = 0;
    this.#drawCursor = 0;
    this.#aimIndex = 0;
    this.#activeNotes.length = 0;
    this.#lastTickTime = 0;
    this.#endedFired = false;
    this.#gameOverFired = false;
    this.#judgmentFx = [];
    this.#particles = [];
    this.#uiDirty = true;
    this.#playerLane = this.#opts.laneCount >> 1;
    this.#playerVisX = this.#playerLane;
    for (let i = 0; i < this.#notes.length; i++) {
      const n = this.#notes[i];
      n.lane = n.baseLane; // 狙い撃ちで差し替えたレーンを元に戻す
      n.hit = false;
      n.missed = false;
      n.judgment = null;
      n.holdActive = false;
      n.tookDamage = false;
    }
  }

  #fireEnded() {
    if (this.#endedFired) return;
    this.#endedFired = true;
    this.onEnded?.();
  }

  #fireGameOver() {
    if (this.#gameOverFired) return;
    this.#gameOverFired = true;
    this.#particles.length = 0;
    this.onGameOver?.();
  }

  #invalidateCache() {
    this.#cachedW = 0; // force recalculation
    this.#uiDirty = true;
  }

  #loop() {
    if (!this.#getTime) return;
    const now = performance.now();
    const dt = Math.min((now - this.#lastFrameMs) / 1000, 0.033);
    this.#lastFrameMs = now;
    if (this.#step(this.#getTime(), dt)) {
      this.stop();
      return;
    }
    this.#animId = requestAnimationFrame(this.#boundLoop);
  }

  /**
   * 1 フレーム分の進行。t=ゲーム内時刻（秒）、dt=実時間の経過（演出用）。
   * 終了（生存クリア/死亡）を通知したら true。
   */
  #step(t, dt) {
    // ダメージはゲーム内時刻の進み量で計算する。一時停止中（t が進まない）や
    // シーク直後（t が戻る）にダメージが入らないようにするため。
    const dg = Math.min(Math.max(t - this.#lastTickTime, 0), 0.05);
    this.#lastTickTime = t;

    if (!this.#gameOver) {
      this.#aimNotes(t);
      this.#checkNotes(t + this.#opts.judgeOffset, dg);
    } else {
      this.#deathElapsed += dt;
    }
    this.#updateFx(dt);
    this.#draw(this.#gameOver ? this.#deathT : t);

    if (this.#gameOver) {
      if (this.#deathElapsed >= DEATH_ANIM_SEC) {
        this.#fireGameOver();
        return true;
      }
    } else if (
      this.#noteIndex >= this.#notes.length &&
      this.#activeNotes.length === 0 &&
      this.#particles.length === 0
    ) {
      this.#fireEnded();
      return true;
    }
    return false;
  }

  // ---- Private: aim ------------------------------------------------------

  /**
   * ノーツが画面に現れる直前に、一定の割合でプレイヤーのいるレーンへ差し替える。
   * 描画が始まってからレーンが変わると見た目が飛ぶので、必ず描画開始より前に確定する。
   * 描画開始を過ぎてしまったノーツ（フレーム落ちなど）は差し替えない。
   */
  #aimNotes(t) {
    const o = this.#opts;
    const ratio = o.difficulty.aimRatio ?? 0;
    const notes = this.#notes;
    // #drawNotes の lookahead と同じ式（判定ラインから画面上端に現れるまでの秒数）
    const hitY = this.#cachedHitY > 0 ? this.#cachedHitY : this.#canvas.height;
    const drawLookahead = hitY / (o.scrollSpeed * (o.dpr || 1)) + 0.1;
    const decideWithin = drawLookahead + AIM_LEAD_MARGIN;

    while (this.#aimIndex < notes.length) {
      const untilStart = notes[this.#aimIndex].startTime - t;
      if (untilStart > decideWithin) break;
      const index = this.#aimIndex++;
      if (ratio <= 0) continue;
      if (untilStart <= drawLookahead) continue;
      if (o.random() >= ratio) continue;
      this.#tryAim(index, t);
    }
  }

  /**
   * notes[index] のブロックを、プレイヤーのいるレーンを覆う位置へずらす（幅は変えない）。
   * プレイヤーがブロックのちょうど中央に来るように置く（端に寄るときは画面の端まで）。
   * ただし
   *  - ほかのブロックと（時間もレーンも）重ならず、
   *  - ずらしたあとも、連続した空きレーンが minFreeRun 以上残り（ブロックの間で
   *    身動きが取れなくならない）、
   *  - （aimGuarantee のとき）差し替え後もプレイヤーが今の位置から必ず逃げ切れる
   * ときだけ。条件を満たさなければ元の位置のまま。
   * 幅は変わらず、重ならない位置にしか動かさないので、同時に塞がる幅の合計は変わらない。
   */
  #tryAim(index, t) {
    const o = this.#opts;
    const notes = this.#notes;
    const note = notes[index];
    const player = this.#playerLane;
    const width = note.width;
    if (player >= note.lane && player < note.lane + width) return;

    const left = Math.min(
      o.laneCount - width,
      Math.max(0, player - ((width - 1) >> 1)),
    );
    const mask = laneMask(left, width);

    const st = note.startTime;
    const end = note.endTime;
    const guarantee = o.aimGuarantee;
    const slack = o.aimSlack;
    const horizon = guarantee
      ? end + PATH_PAD + slack + AIM_HORIZON_AFTER
      : end + LANE_GAP;

    // 検証対象: 今も塞がっている可能性のあるブロック〜horizon までの開始ブロック
    let first = index;
    const scanFrom = t - BLOCK_MAX_DURATION - PATH_PAD - slack;
    while (first > 0 && notes[first - 1].startTime >= scanFrom) first--;

    const masks = [];
    const froms = [];
    const tos = [];
    for (let j = first; j < notes.length; j++) {
      const other = notes[j];
      if (other.startTime > horizon) break;
      const otherMask = j === index ? mask : laneMask(other.lane, other.width);
      if (j !== index && (otherMask & mask) !== 0) {
        // 差し替え先のレーンで時間が重なる（隙間が足りない）なら見送る
        if (other.startTime - LANE_GAP < end && other.endTime + LANE_GAP > st) {
          return;
        }
      }
      masks.push(otherMask);
      froms.push(other.startTime);
      tos.push(other.endTime);
    }

    // ずらしたブロックと同時に塞がる各時点（このブロックの開始と、その間に始まる
    // ほかのブロックの開始）で、連続した空きレーンが minFreeRun 以上残るか
    const minFreeRun = resolveLimits(o.difficulty, o.laneCount).minFreeRun;
    for (let k = 0; k < masks.length; k++) {
      const tau = froms[k];
      if (tau < st || tau >= end) continue;
      let occupied = 0;
      for (let m = 0; m < masks.length; m++) {
        if (froms[m] <= tau && tau < tos[m]) occupied |= masks[m];
      }
      if (largestFreeRun(occupied, o.laneCount) < minFreeRun) return;
    }

    if (guarantee) {
      // 逃げ切れる検証には、余裕（PATH_PAD/slack）を足した区間を使う
      const gFroms = [];
      const gTos = [];
      for (let k = 0; k < masks.length; k++) {
        gFroms.push(froms[k] - PATH_PAD - slack);
        gTos.push(tos[k] + PATH_PAD + slack);
      }
      if (
        !canEscape(
          masks,
          gFroms,
          gTos,
          o.laneCount,
          player,
          t,
          horizon,
          o.aimMoveInterval ?? o.difficulty.moveInterval,
          o.aimReaction,
        )
      ) return;
    }
    note.lane = left;
  }

  // ---- Private: collision ------------------------------------------------

  /**
   * 毎フレーム呼び出し。判定ラインに到達したブロックを active にし、
   * プレイヤーと同じレーンの active ブロックがあれば HP を減らす。
   * te = ゲーム内時刻 + 判定オフセット、dg = 進んだゲーム内時間（秒）
   */
  #checkNotes(te, dg) {
    const notes = this.#notes;
    const active = this.#activeNotes;

    // ブロック下端(startTime)が判定ラインに到達した時点で active 開始
    while (this.#noteIndex < notes.length) {
      const note = notes[this.#noteIndex];
      if (te < note.startTime) break;
      note.holdActive = true;
      note.hit = true;
      active.push(note);
      this.#noteIndex++;
    }

    let w = 0;
    for (let i = 0; i < active.length; i++) {
      const note = active[i];

      // ブロック上端(endTime)が判定ラインを過ぎたら通過完了
      if (te > note.endTime) {
        this.#finishNote(note);
        continue;
      }

      const pl = this.#playerLane;
      if (pl >= note.lane && pl < note.lane + note.width && dg > 0) {
        this.#damage(note, dg);
        if (this.#gameOver) return;
      }
      active[w++] = note;
    }
    active.length = w;
  }

  #damage(note, dg) {
    if (!note.tookDamage) {
      note.tookDamage = true;
      note.missed = true;
      note.judgment = Judgment.HIT;
      this.#hitCount++;
      this.#combo = 0;
      // 幅のあるブロックでは、当たったのはプレイヤーのいるレーン
      this.#spawnHitSparks(this.#playerLane);
      this.#judgmentFx.push({
        judgment: Judgment.HIT,
        lane: this.#playerLane,
        alpha: 1,
      });
      this.onJudgment?.(Judgment.HIT, this.#combo, this.score);
    }
    this.#hp -= this.#opts.damagePerSecond * dg;
    this.#hitFlash = Math.max(this.#hitFlash, 0.18);
    this.#uiDirty = true;
    if (this.#hp <= 0) {
      this.#hp = 0;
      this.#die();
    }
    if (Math.abs(this.#hp - this.#lastSentHp) >= 0.5 || this.#hp === 0) {
      this.#lastSentHp = this.#hp;
      this.onHpChange?.(this.#hp, this.#maxHp);
    }
  }

  /** ブロックが通過し終えた。一度も当たらなければ DODGE として確定する */
  #finishNote(note) {
    note.holdActive = false;
    if (note.tookDamage) return; // HIT は当たった瞬間に確定済み
    note.judgment = Judgment.DODGE;
    this.#dodgeCount++;
    this.#combo++;
    if (this.#combo > this.#maxCombo) this.#maxCombo = this.#combo;
    const total = this.#opts.totalNotes;
    if (total > 0) this.#score += 1_000_000 / total;
    // 判定の演出はブロックの中央（小数のレーン位置）に出す
    const center = note.lane + (note.width - 1) / 2;
    this.#spawnDodgeParticles(center);
    this.#judgmentFx.push({ judgment: Judgment.DODGE, lane: center, alpha: 1 });
    this.#uiDirty = true;
    this.onJudgment?.(Judgment.DODGE, this.#combo, this.score);
  }

  #die() {
    this.#gameOver = true;
    this.#deathT = this.#lastTickTime;
    this.#deathElapsed = 0;
    this.#activeNotes.length = 0;
    this.#combo = 0;
    this.#uiDirty = true;
    this.#spawnExplosion();
    this.onDeath?.();
  }

  // ---- Private: FX -------------------------------------------------------

  #updateFx(dt) {
    // in-place decay（filter で配列生成しない）
    let w = 0;
    for (let i = 0; i < this.#judgmentFx.length; i++) {
      const fx = this.#judgmentFx[i];
      fx.alpha -= dt * 2.0;
      if (fx.alpha > 0) {
        this.#judgmentFx[w++] = fx;
        this.#uiDirty = true;
      }
    }
    this.#judgmentFx.length = w;

    if (this.#hitFlash > 0) {
      this.#hitFlash = Math.max(0, this.#hitFlash - dt);
      this.#uiDirty = true;
    }

    // 表示上のプレイヤー位置を目標レーンへなめらかに寄せる
    const diff = this.#playerLane - this.#playerVisX;
    if (diff !== 0) {
      this.#playerVisX = Math.abs(diff) < 0.01
        ? this.#playerLane
        : this.#playerVisX + diff * Math.min(1, dt * 24);
    }

    this.#updateParticles(dt);
  }

  #laneCenterX(lane) {
    const laneW = this.#canvas.width / this.#opts.laneCount;
    return lane * laneW + laneW / 2;
  }

  #spawnDodgeParticles(lane) {
    const d = this.#opts.dpr || 1;
    const x = this.#laneCenterX(lane);
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    const color = this.#opts.laneColors[lane % this.#opts.laneColors.length];
    for (let k = 0; k < 10; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (110 + Math.random() * 240) * d;
      const life = 0.3 + Math.random() * 0.4;
      this.#particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 90 * d,
        life,
        maxLife: life,
        color,
        size: (2.5 + Math.random() * 3.5) * d,
      });
    }
  }

  #spawnHitSparks(lane) {
    const d = this.#opts.dpr || 1;
    const x = this.#laneCenterX(lane);
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    for (let k = 0; k < 16; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (140 + Math.random() * 300) * d;
      const life = 0.25 + Math.random() * 0.35;
      this.#particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 60 * d,
        life,
        maxLife: life,
        color: DANGER_COLOR,
        size: (2.5 + Math.random() * 4) * d,
      });
    }
  }

  #spawnExplosion() {
    const d = this.#opts.dpr || 1;
    const x = this.#laneCenterX(this.#playerLane);
    const y = this.#canvas.height - this.#opts.buttonZoneHeight;
    for (let k = 0; k < 48; k++) {
      const ang = Math.random() * 6.2832;
      const spd = (150 + Math.random() * 420) * d;
      const life = 0.6 + Math.random() * 0.6;
      this.#particles.push({
        x,
        y,
        vx: Math.cos(ang) * spd,
        vy: Math.sin(ang) * spd - 120 * d,
        life,
        maxLife: life,
        color: k % 3 === 0 ? "#ffffff" : DANGER_COLOR,
        size: (3.5 + Math.random() * 6) * d,
      });
    }
  }

  #updateParticles(dt) {
    const g = 480 * (this.#opts.dpr || 1) * dt;
    let w = 0;
    for (let i = 0; i < this.#particles.length; i++) {
      const p = this.#particles[i];
      p.vy += g;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.life > 0) this.#particles[w++] = p;
    }
    this.#particles.length = w;
  }

  // ---- Private: drawing --------------------------------------------------

  #draw(t) {
    const W = this.#canvas.width;
    const H = this.#canvas.height;
    const o = this.#opts;

    // キャッシュ更新（リサイズ時のみ再計算）
    if (W !== this.#cachedW || H !== this.#cachedH) {
      this.#cachedW = W;
      this.#cachedH = H;
      this.#cachedHitY = H - o.buttonZoneHeight;
      this.#cachedLaneW = W / o.laneCount;
      const d = o.dpr || 1;
      this.#cachedHintFont = `bold ${
        Math.min(24 * d, this.#cachedLaneW * 0.3).toFixed(0)
      }px sans-serif`;
      this.#cachedBigFont = `bold ${
        Math.min(48 * d, W * 0.1).toFixed(0)
      }px sans-serif`;
      this.#uiDirty = true;
    }

    const hitY = this.#cachedHitY;
    const laneW = this.#cachedLaneW;
    const btnBot = hitY + o.buttonZoneHeight;

    // ノートレイヤー（毎フレーム）
    const ctx = this.#ctx;
    ctx.clearRect(0, 0, W, H);
    this.#drawLaneSeparators(ctx, W, laneW, hitY, btnBot, o);
    this.#drawButtons(ctx, laneW, hitY, W, btnBot, o);
    this.#drawNotes(ctx, t, laneW, hitY, H, W, btnBot, o);
    if (!this.#gameOver) {
      this.#drawPlayer(ctx, laneW, hitY, W, btnBot, o);
    }

    // パーティクル＋ダメージ演出レイヤー（毎フレーム）
    const pCtx = this.#pCtx;
    pCtx.clearRect(0, 0, W, H);
    this.#drawDamageOverlay(pCtx, W, H, o, t);
    if (this.#particles.length > 0) this.#drawParticles(pCtx, o);

    // UIレイヤー（状態変化時のみ）: HUD・判定FX
    if (this.#uiDirty) {
      const uCtx = this.#uiCtx;
      uCtx.clearRect(0, 0, W, H);
      this.#drawJudgmentFx(uCtx, laneW, hitY, o);
      this.#drawHUD(uCtx, W, H, o);
      this.#uiDirty = false;
    }
  }

  // ---- Perspective helpers ------------------------------------------------
  // 基準点を btnBot（画面最下端）にしてパース計算
  // y=btnBot → scale=1 → フル幅（左端0、右端W）
  // y=0      → scale=1-p → 中央に収束
  #sc(y, btnBot, p) {
    return p ? 1 - p + p * (y / btnBot) : 1;
  }

  #perspX(laneIdx, laneW, W, y, btnBot, p) {
    const xFull = laneIdx * laneW;
    if (!p) return xFull;
    const cx = W / 2;
    return cx + (xFull - cx) * this.#sc(y, btnBot, p);
  }

  #drawLaneSeparators(ctx, W, laneW, hitY, btnBot, o) {
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    const lineColor = o.laneLineColor || o.uiColor;
    const t = Math.max(0, Math.min(1, o.laneOpacity ?? 0.35));

    // 外枠・内側境界線（下端は左端0・右端W、上端 y=0 で中央に収束）
    ctx.strokeStyle = withAlpha(lineColor, 0.35 * t);
    ctx.lineWidth = 1 * d;
    for (let l = 0; l <= o.laneCount; l++) {
      const xBot = l === 0
        ? 0
        : l === o.laneCount
        ? W
        : this.#perspX(l, laneW, W, btnBot, btnBot, p);
      const xTop = this.#perspX(l, laneW, W, 0, btnBot, p);
      ctx.beginPath();
      ctx.moveTo(xBot, btnBot);
      ctx.lineTo(xTop, 0);
      ctx.stroke();
    }

    // 疑似床グラデーション
    if (p > 0) {
      const xTopL = this.#perspX(0, laneW, W, 0, btnBot, p);
      const xTopR = this.#perspX(o.laneCount, laneW, W, 0, btnBot, p);
      const grad = ctx.createLinearGradient(0, 0, 0, btnBot);
      grad.addColorStop(0, withAlpha(lineColor, 0.0));
      grad.addColorStop(1, withAlpha(lineColor, 0.14 * t));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.moveTo(xTopL, 0);
      ctx.lineTo(xTopR, 0);
      ctx.lineTo(W, btnBot);
      ctx.lineTo(0, btnBot);
      ctx.closePath();
      ctx.fill();
    }

    // 常時発光する判定ライン
    const judgeColor = o.judgeLineColor || o.uiColor;
    ctx.save();
    ctx.shadowColor = withAlpha(judgeColor, 0.9);
    ctx.shadowBlur = 18 * d;
    ctx.strokeStyle = withAlpha(judgeColor, 0.92);
    ctx.lineWidth = 3 * d;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(W, hitY);
    ctx.stroke();
    ctx.shadowBlur = 36 * d;
    ctx.strokeStyle = withAlpha(judgeColor, 0.35);
    ctx.lineWidth = 7 * d;
    ctx.beginPath();
    ctx.moveTo(0, hitY);
    ctx.lineTo(W, hitY);
    ctx.stroke();
    ctx.restore();
  }

  #drawNotes(ctx, t, laneW, hitY, H, W, btnBot, o) {
    const notes = this.#notes;
    const d = o.dpr || 1;
    const speed = o.scrollSpeed * d;
    // 画面上端(y=0)に現れるまでの秒数
    const lookahead = hitY / speed + 0.1;

    // 画面下端より下まで抜けたノートは以降スキップ
    while (this.#drawCursor < notes.length) {
      const n = notes[this.#drawCursor];
      const yTop = hitY - (n.endTime - t) * speed;
      if (yTop > H) {
        this.#drawCursor++;
        continue;
      }
      break;
    }

    const p = o.perspective ?? 0;
    const glow = o.glow;
    const laneColors = o.laneColors;
    const pad = Math.max(2 * d, laneW * 0.05);
    const playerLane = this.#playerLane;

    const prevAlpha = ctx.globalAlpha;
    ctx.shadowBlur = glow ? 14 * d : 0;

    // 台形ブロックを描く（y は canvas 座標。yTop < yBot）
    const trap = (lane, width, yTop, yBot, fillStyle, alpha) => {
      const scBot = this.#sc(yBot, btnBot, p);
      const scTop = this.#sc(yTop, btnBot, p);
      const xBotL = this.#perspX(lane, laneW, W, yBot, btnBot, p) + pad * scBot;
      const xBotR = this.#perspX(lane + width, laneW, W, yBot, btnBot, p) -
        pad * scBot;
      const xTopL = this.#perspX(lane, laneW, W, yTop, btnBot, p) + pad * scTop;
      const xTopR = this.#perspX(lane + width, laneW, W, yTop, btnBot, p) -
        pad * scTop;
      if (xBotR <= xBotL || xTopR <= xTopL) return;
      ctx.globalAlpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      ctx.fillStyle = fillStyle;
      ctx.beginPath();
      ctx.moveTo(xBotL, yBot);
      ctx.lineTo(xBotR, yBot);
      ctx.lineTo(xTopR, yTop);
      ctx.lineTo(xTopL, yTop);
      ctx.closePath();
      ctx.fill();
    };

    for (let i = this.#drawCursor; i < notes.length; i++) {
      const note = notes[i];
      if (note.startTime - t > lookahead) break;

      const yBot = hitY - (note.startTime - t) * speed;
      const yTop = hitY - (note.endTime - t) * speed;
      if (yTop > H || yBot < 0) continue;

      const drawTop = yTop < 0 ? 0 : yTop;
      const drawBot = yBot > H ? H : yBot;
      if (drawBot <= drawTop) continue;

      // 色: 当たったブロックは赤で固定。避けたブロックはレーン色で薄く。
      // 未判定のブロックはプレイヤーのいるレーンなら危険色（赤）で警告する。
      // 色は幅の中央のレーンの色。プレイヤーが幅のどこかにいれば危険色。
      const laneColor =
        laneColors[(note.lane + (note.width >> 1)) % laneColors.length];
      const covered = playerLane >= note.lane &&
        playerLane < note.lane + note.width;
      let color;
      let alpha = 1;
      if (note.judgment === Judgment.HIT) {
        color = DANGER_COLOR;
      } else if (note.judgment === Judgment.DODGE) {
        color = laneColor;
        alpha = 0.5;
      } else {
        color = covered ? DANGER_COLOR : laneColor;
      }

      ctx.shadowColor = color;
      if (note.holdActive) {
        // 判定ライン通過中はゆっくり脈動させる
        alpha *= 0.8 + 0.2 * Math.sin(t * 14);
      }
      trap(note.lane, note.width, drawTop, drawBot, color, alpha);

      // 進行方向の先頭（下端）に明るいハイライト
      ctx.shadowBlur = 0;
      const shineH = Math.min(10 * d, (drawBot - drawTop) * 0.3);
      if (yBot <= H && shineH > 1) {
        trap(
          note.lane,
          note.width,
          drawBot - shineH,
          drawBot,
          "rgba(255,255,255,0.35)",
          alpha,
        );
      }
      ctx.shadowBlur = glow ? 14 * d : 0;
    }

    ctx.globalAlpha = prevAlpha;
    ctx.shadowBlur = 0;
  }

  #drawButtons(ctx, laneW, hitY, W, btnBot, o) {
    const btnH = o.buttonZoneHeight;
    const glow = o.glow;
    const colors = o.laneColors;
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    const t = Math.max(0, Math.min(1, o.laneOpacity ?? 0.35));
    const fillIdleA = t * 0.6;
    const borderIdleA = t * 0.9;
    const fillPlayerA = t * 0.75;
    const gradTopA = t * 0.9;
    const gradBottomA = t * 0.25;

    for (let l = 0; l < o.laneCount; l++) {
      const color = colors[l % colors.length];
      const isPlayer = l === this.#playerLane && !this.#gameOver;

      const topL = this.#perspX(l, laneW, W, hitY, btnBot, p);
      const topR = this.#perspX(l + 1, laneW, W, hitY, btnBot, p);
      const botL = this.#perspX(l, laneW, W, btnBot, btnBot, p);
      const botR = this.#perspX(l + 1, laneW, W, btnBot, btnBot, p);

      const trapPath = () => {
        ctx.beginPath();
        ctx.moveTo(topL, hitY);
        ctx.lineTo(topR, hitY);
        ctx.lineTo(botR, btnBot);
        ctx.lineTo(botL, btnBot);
        ctx.closePath();
      };

      if (isPlayer) {
        // プレイヤーのいるレーンを強調
        ctx.save();
        ctx.shadowColor = color;
        ctx.shadowBlur = (glow ? 30 : 12) * d;
        ctx.fillStyle = withAlpha(color, fillPlayerA);
        trapPath();
        ctx.fill();
        const grad = ctx.createLinearGradient(0, hitY, 0, btnBot);
        grad.addColorStop(0, withAlpha(color, gradTopA));
        grad.addColorStop(0.4, withAlpha(color, gradBottomA));
        grad.addColorStop(1, "transparent");
        ctx.shadowBlur = 0;
        ctx.fillStyle = grad;
        trapPath();
        ctx.fill();
        ctx.restore();
      } else {
        ctx.fillStyle = withAlpha(color, fillIdleA);
        trapPath();
        ctx.fill();
      }

      // レーン境界線
      ctx.strokeStyle = withAlpha(color, isPlayer ? t : borderIdleA);
      ctx.lineWidth = 1 * d;
      ctx.beginPath();
      ctx.moveTo(topL, hitY);
      ctx.lineTo(botL, btnBot);
      ctx.stroke();
      if (l === o.laneCount - 1) {
        ctx.beginPath();
        ctx.moveTo(topR, hitY);
        ctx.lineTo(botR, btnBot);
        ctx.stroke();
      }
    }

    // 画面の左半分/右半分をタップすると 1 レーン移動する、ことを示す矢印
    ctx.font = this.#cachedHintFont;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.shadowBlur = 0;
    ctx.fillStyle = withAlpha(o.accentColor || o.uiColor, 0.45);
    const cy = hitY + btnH / 2;
    ctx.fillText("◀", W * 0.25, cy);
    ctx.fillText("▶", W * 0.75, cy);
  }

  #drawPlayer(ctx, laneW, hitY, W, btnBot, o) {
    const p = o.perspective ?? 0;
    const d = o.dpr || 1;
    const colors = o.laneColors;
    const vis = this.#playerVisX;
    const color = colors[this.#playerLane % colors.length];
    const xl = this.#perspX(vis, laneW, W, hitY, btnBot, p);
    const xr = this.#perspX(vis + 1, laneW, W, hitY, btnBot, p);
    const cx = (xl + xr) / 2;
    const cy = hitY;
    const r = Math.min(20 * d, (xr - xl) * 0.3);
    // 被弾中は白→赤に点滅
    const hurt = this.#hitFlash > 0;
    ctx.save();
    ctx.shadowColor = hurt ? DANGER_COLOR : color;
    ctx.shadowBlur = (o.glow ? 24 : 12) * d;
    ctx.fillStyle = hurt ? DANGER_COLOR : "#ffffff";
    ctx.beginPath();
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r, cy);
    ctx.lineTo(cx, cy + r * 0.6);
    ctx.lineTo(cx - r, cy);
    ctx.closePath();
    ctx.fill();
    ctx.shadowBlur = 0;
    ctx.fillStyle = color;
    const sr = r * 0.55;
    ctx.beginPath();
    ctx.moveTo(cx, cy - sr);
    ctx.lineTo(cx + sr, cy);
    ctx.lineTo(cx, cy + sr * 0.6);
    ctx.lineTo(cx - sr, cy);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /** 被弾フラッシュ・HP 低下時の縁の警告・死亡時の暗転を、画面全体に重ねる */
  #drawDamageOverlay(ctx, W, H, o, t) {
    let alpha = 0;
    if (this.#hitFlash > 0) {
      alpha = Math.min(0.5, this.#hitFlash * 2.8);
    }
    if (this.#gameOver) {
      alpha = Math.max(alpha, Math.min(0.55, this.#deathElapsed * 0.7));
    }
    if (alpha > 0) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = "#ff0000";
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // HP が 3 割を切ったら縁を赤くゆっくり脈動させる
    const ratio = this.#hp / this.#maxHp;
    if (!this.#gameOver && ratio < 0.3) {
      const pulse = 0.5 + 0.5 * Math.sin(t * 6);
      const strength = (0.3 - ratio) / 0.3; // 0→1
      const cx = W / 2, cy = H / 2;
      const r0 = Math.min(W, H) * 0.35;
      const r1 = Math.hypot(cx, cy);
      const grad = ctx.createRadialGradient(cx, cy, r0, cx, cy, r1);
      grad.addColorStop(0, "rgba(255,0,0,0)");
      grad.addColorStop(1, `rgba(255,0,0,${(0.2 + 0.3 * pulse) * strength})`);
      ctx.save();
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  #drawJudgmentFx(ctx, laneW, hitY, o) {
    if (!this.#judgmentFx.length) return;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const glow = o.glow;
    const d = o.dpr || 1;
    for (let i = 0; i < this.#judgmentFx.length; i++) {
      const fx = this.#judgmentFx[i];
      const def = FX_TABLE[fx.judgment];
      const x = fx.lane * laneW + laneW / 2;
      const y = hitY - (55 + (1 - fx.alpha) * 28) * d;
      ctx.globalAlpha = fx.alpha < 0 ? 0 : fx.alpha;
      ctx.shadowColor = def.color;
      ctx.shadowBlur = glow ? 10 * d : 0;
      ctx.font = `bold ${def.size * d}px sans-serif`;
      ctx.fillStyle = def.color;
      ctx.fillText(def.text, x, y);
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  #drawParticles(ctx, o) {
    const glow = o.glow;
    const d = o.dpr || 1;
    const prevComposite = ctx.globalCompositeOperation;
    // 加算合成で重なった光が明るく発光する
    ctx.globalCompositeOperation = "lighter";
    ctx.shadowBlur = glow ? 6 * d : 0;
    for (let i = 0; i < this.#particles.length; i++) {
      const p = this.#particles[i];
      const a = p.life / p.maxLife;
      const r = p.size * (0.5 + 0.5 * a);
      ctx.globalAlpha = a < 0 ? 0 : a;
      ctx.fillStyle = p.color;
      ctx.shadowColor = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, 6.2832);
      ctx.fill();
    }
    ctx.globalCompositeOperation = prevComposite;
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  #drawHUD(ctx, W, H, o) {
    // スコアは #scoreDisplay（DOM）側。ここでは HP バーと連続回避数、GAME OVER を描く。
    ctx.shadowBlur = 0;
    const textColor = o.accentColor || o.uiColor;
    const d = o.dpr || 1;

    // HP バー（#topnav / #hudStack の下、画面上部中央）
    const barW = Math.min(W * 0.5, 340 * d);
    const barH = 12 * d;
    const barX = (W - barW) / 2;
    const barY = (o.topInset || 0) + 8 * d;
    const ratio = Math.max(0, this.#hp / this.#maxHp);
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, barH / 2);
    ctx.fill();
    if (ratio > 0) {
      const hpColor = ratio > 0.5
        ? "#44ee66"
        : ratio > 0.25
        ? "#ffcc00"
        : DANGER_COLOR;
      if (o.glow) {
        ctx.shadowColor = hpColor;
        ctx.shadowBlur = 8 * d;
      }
      ctx.fillStyle = hpColor;
      ctx.beginPath();
      ctx.roundRect(barX, barY, barW * ratio, barH, barH / 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.strokeStyle = withAlpha(textColor, 0.4);
    ctx.lineWidth = 1 * d;
    ctx.beginPath();
    ctx.roundRect(barX, barY, barW, barH, barH / 2);
    ctx.stroke();

    ctx.font = `bold ${11 * d}px monospace`;
    ctx.fillStyle = textColor;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("HP", barX - 6 * d, barY + barH / 2);

    // 連続回避数
    if (this.#combo >= 2) {
      ctx.font = `bold ${Math.min(30 * d, W * 0.07).toFixed(0)}px sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.shadowColor = textColor;
      ctx.shadowBlur = o.glow ? 12 * d : 0;
      ctx.fillStyle = textColor;
      ctx.fillText(`${this.#combo} STREAK`, W / 2, barY + barH + 10 * d);
      ctx.shadowBlur = 0;
    }

    if (this.#gameOver) {
      ctx.font = this.#cachedBigFont;
      ctx.fillStyle = DANGER_COLOR;
      ctx.shadowColor = DANGER_COLOR;
      ctx.shadowBlur = (o.glow ? 20 : 8) * d;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("GAME OVER", W / 2, H * 0.42);
      ctx.shadowBlur = 0;
    }
  }
}
