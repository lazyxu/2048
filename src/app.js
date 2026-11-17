import { canMove, hasWon, isValidBoard, moveBoard, newBoard, spawnTile } from './game.js';

const STORAGE_KEY = '2048-ios-pwa-state-v1';
const boardEl = document.querySelector('#board');
const cellsEl = document.querySelector('#cells');
const scoreEl = document.querySelector('#score');
const bestEl = document.querySelector('#best');
const scoreGainEl = document.querySelector('#score-gain');
const undoEl = document.querySelector('#undo');
const newGameEl = document.querySelector('#new-game');
const overlayEl = document.querySelector('#game-overlay');
const overlayTitleEl = document.querySelector('#overlay-title');
const overlayTextEl = document.querySelector('#overlay-text');
const overlayContinueEl = document.querySelector('#overlay-continue');
const overlayRestartEl = document.querySelector('#overlay-restart');
const statusEl = document.querySelector('#status');
const installStatusEl = document.querySelector('#install-status');
const restartDialog = document.querySelector('#restart-dialog');
const restartConfirmEl = document.querySelector('#restart-confirm');

function validSnapshot(snapshot) {
  return snapshot && isValidBoard(snapshot.board) && Number.isSafeInteger(snapshot.score) && snapshot.score >= 0 &&
    typeof snapshot.won === 'boolean' && typeof snapshot.keepPlaying === 'boolean';
}

function restoreGame() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (raw?.version !== 1 || !validSnapshot(raw)) return null;
    const previous = validSnapshot(raw.previous) ? raw.previous : null;
    return {
      board: raw.board, score: raw.score,
      best: Number.isSafeInteger(raw.best) && raw.best >= 0 ? Math.max(raw.best, raw.score) : raw.score,
      won: raw.won, keepPlaying: raw.keepPlaying, previous,
    };
  } catch {
    // Safari private mode can block storage; the game must still be playable.
    return null;
  }
}

function initialGame(best = 0) {
  return { board: newBoard(), score: 0, best, won: false, keepPlaying: false, previous: null };
}

let game = restoreGame() ?? initialGame();
const cells = [];
for (let index = 0; index < 16; index += 1) {
  const cell = document.createElement('div');
  cell.className = 'cell';
  cell.setAttribute('role', 'gridcell');
  cellsEl.appendChild(cell);
  cells.push(cell);
}

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ...game }));
  } catch {
    // In-memory mode is preferable to a crash when storage is unavailable.
  }
}

function announce(message) {
  statusEl.textContent = message;
}

function render({ spawned = -1, merged = [], gain = 0 } = {}) {
  cells.forEach((cell, index) => {
    const value = game.board[index];
    cell.className = 'cell';
    cell.textContent = value || '';
    cell.dataset.value = value || '';
    if (value) {
      cell.classList.add('cell--filled');
      if (value > 2048) cell.classList.add('cell--super');
      if (index === spawned) cell.classList.add('cell--new');
      else if (merged.includes(index)) cell.classList.add('cell--merged');
    }
    const row = Math.floor(index / 4) + 1;
    const column = (index % 4) + 1;
    cell.setAttribute('aria-label', `第 ${row} 行第 ${column} 列：${value || '空'}`);
  });

  scoreEl.textContent = game.score.toLocaleString('zh-CN');
  bestEl.textContent = game.best.toLocaleString('zh-CN');
  undoEl.disabled = !game.previous;
  const over = !canMove(game.board);
  const showWin = game.won && !game.keepPlaying;
  const showOver = !showWin && over;
  overlayEl.hidden = !showWin && !showOver;
  if (showWin) {
    overlayTitleEl.textContent = '达成 2048！';
    overlayTextEl.textContent = '太棒了，要不要继续挑战更高数字？';
    overlayContinueEl.hidden = false;
  } else if (showOver) {
    overlayTitleEl.textContent = '游戏结束';
    overlayTextEl.textContent = `本局得分 ${game.score.toLocaleString('zh-CN')}，再挑战一次吧。`;
    overlayContinueEl.hidden = true;
  }

  scoreGainEl.classList.remove('score-gain--visible');
  if (gain) {
    scoreGainEl.textContent = `+${gain}`;
    // Force restarting the CSS animation for consecutive merges.
    void scoreGainEl.offsetWidth;
    scoreGainEl.classList.add('score-gain--visible');
  }
}

function move(direction) {
  if ((game.won && !game.keepPlaying) || !canMove(game.board)) return;
  const result = moveBoard(game.board, direction);
  if (!result.moved) return;

  game.previous = {
    board: [...game.board], score: game.score,
    won: game.won, keepPlaying: game.keepPlaying,
  };
  const spawn = spawnTile(result.board);
  game.board = spawn.board;
  game.score += result.scoreGain;
  game.best = Math.max(game.best, game.score);
  game.won = game.won || hasWon(game.board);
  persist();
  render({ spawned: spawn.index, merged: result.mergedIndices, gain: result.scoreGain });

  if (game.won && !game.keepPlaying) announce('恭喜，你合成了 2048！');
  else if (!canMove(game.board)) announce('没有可移动的方块，游戏结束。');
  else if (result.scoreGain) announce(`合并获得 ${result.scoreGain} 分，当前 ${game.score} 分。`);
  else announce('方块已移动。');
}

function restart() {
  game = initialGame(game.best);
  persist();
  render();
  announce('新游戏开始，向任意方向滑动。');
  boardEl.focus({ preventScroll: true });
}

newGameEl.addEventListener('click', () => {
  if (game.score === 0 || !canMove(game.board)) {
    restart();
  } else if (typeof restartDialog.showModal === 'function') {
    restartDialog.showModal();
  } else if (window.confirm('确定要重新开始吗？当前进度将被清除。')) {
    restart();
  }
});
restartConfirmEl.addEventListener('click', () => {
  restartDialog.close();
  restart();
});

undoEl.addEventListener('click', () => {
  if (!game.previous) return;
  const previous = game.previous;
  game = { ...game, ...previous, board: [...previous.board], previous: null };
  persist();
  render();
  announce('已撤销上一步。');
  boardEl.focus({ preventScroll: true });
});

overlayContinueEl.addEventListener('click', () => {
  game.keepPlaying = true;
  persist();
  render();
  announce('继续挑战 4096！');
  boardEl.focus({ preventScroll: true });
});
overlayRestartEl.addEventListener('click', restart);

const keyDirections = {
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
  a: 'left', d: 'right', w: 'up', s: 'down',
};
document.addEventListener('keydown', event => {
  if (event.altKey || event.ctrlKey || event.metaKey || restartDialog.open) return;
  const direction = keyDirections[event.key] ?? keyDirections[event.key.toLowerCase()];
  if (!direction) return;
  event.preventDefault();
  move(direction);
});

// Pointer events work in Safari/iOS installed PWAs and avoid duplicate touch/click moves.
let startPointer = null;
boardEl.addEventListener('pointerdown', event => {
  if (event.pointerType === 'mouse' || !overlayEl.hidden) return;
  startPointer = { x: event.clientX, y: event.clientY, id: event.pointerId };
  // Retain the swipe even if the finger leaves the board before release.
  try { boardEl.setPointerCapture?.(event.pointerId); } catch { /* Synthetic pointer events */ }
});
boardEl.addEventListener('pointerup', event => {
  if (!startPointer || event.pointerId !== startPointer.id) return;
  const dx = event.clientX - startPointer.x;
  const dy = event.clientY - startPointer.y;
  startPointer = null;
  if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
  if (Math.abs(dx) > Math.abs(dy) * 1.15) move(dx > 0 ? 'right' : 'left');
  else if (Math.abs(dy) > Math.abs(dx) * 1.15) move(dy > 0 ? 'down' : 'up');
});
boardEl.addEventListener('pointercancel', () => { startPointer = null; });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
      // App remains available online if Service Worker registration fails.
    });
  });
}

const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
installStatusEl.textContent = standalone ? '已安装到主屏幕 · 支持离线游玩' : '可添加到主屏幕 · 支持离线游玩';
render();
