/**
 * rhythm-game-worker.js
 * Worker adapter for RhythmGame (Flip Flap Dodge).
 *
 * main → worker : init / setNotes / start / tick / stop / moveLane / setLane /
 *                 updateOptions / resize
 * worker → main : noteCount / judgment / judgmentDetail / ended /
 *                 dying（HP 0 になった瞬間） / gameOver（死亡演出が終わった）
 */

import { RhythmGame } from "./rhythm-game.js";

let game = null;

function postDetail(dead) {
  self.postMessage({
    type: "judgmentDetail",
    score: game.score,
    combo: game.maxCombo,
    dodge: game.dodgeCount,
    hit: game.hitCount,
    hp: game.hp,
    maxHp: game.maxHp,
    progress: game.progress,
    dead,
  });
}

self.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case "init": {
      game = new RhythmGame(
        {
          note: msg.noteCanvas,
          particle: msg.particleCanvas,
          ui: msg.uiCanvas,
        },
        msg.options ?? {},
      );
      game.onJudgment = (judgment, combo, score) => {
        self.postMessage({ type: "judgment", judgment, combo, score });
      };
      game.onEnded = () => {
        // 詳細カウントを送ってから ended
        postDetail(false);
        self.postMessage({ type: "ended" });
      };
      game.onDeath = () => {
        // 結果画面用の集計は死亡時点で確定するので、ここで送っておく
        postDetail(true);
        self.postMessage({ type: "dying" });
      };
      game.onGameOver = () => {
        self.postMessage({ type: "gameOver" });
      };
      break;
    }

    case "setNotes": {
      if (!game) break;
      const n = game.setNotesRaw(msg.notes);
      self.postMessage({ type: "noteCount", count: n });
      break;
    }

    case "start": {
      if (game) game.resetState();
      break;
    }

    case "tick": {
      if (!game) break;
      game.tick(msg.currentTime);
      break;
    }

    case "stop": {
      if (game) {
        // 曲終了で tick が止まる前に通過中のブロックを確定し、
        // judgmentDetail + ended を送る（スコアが 0 のまま結果画面に
        // 行かないようにする）
        if (msg.finalize !== false) {
          game.finalize(msg.currentTime);
        }
        game.stop();
      }
      break;
    }

    case "moveLane": {
      if (game) game.moveLane(msg.dir);
      break;
    }

    case "setLane": {
      if (game) game.setLane(msg.lane);
      break;
    }

    case "updateOptions": {
      if (game) game.updateOptions(msg.patch);
      break;
    }

    case "resize": {
      if (game) {
        game.resize(msg.width, msg.height, {
          topInset: msg.topInset,
          buttonZoneHeight: msg.buttonZoneHeight,
          dpr: msg.dpr,
        });
      }
      break;
    }
  }
};
