/** Pure 2048 rules. Board is a flat, row-major array of 16 values. */
export const SIZE = 4;
export const CELL_COUNT = SIZE * SIZE;

function randomUnit(random) {
  const value = Number(random());
  return Number.isFinite(value) ? Math.max(0, Math.min(0.999999999999, value)) : 0;
}

export function emptyBoard() {
  return Array(CELL_COUNT).fill(0);
}

export function spawnTile(board, random = Math.random) {
  const free = [];
  board.forEach((value, index) => {
    if (value === 0) free.push(index);
  });

  if (!free.length) return { board: [...board], index: -1, value: 0 };
  const index = free[Math.floor(randomUnit(random) * free.length)];
  const value = randomUnit(random) < 0.9 ? 2 : 4;
  const next = [...board];
  next[index] = value;
  return { board: next, index, value };
}

export function newBoard(random = Math.random) {
  const first = spawnTile(emptyBoard(), random);
  return spawnTile(first.board, random).board;
}

function lineIndices(line, direction) {
  const result = [];
  for (let offset = 0; offset < SIZE; offset += 1) {
    if (direction === 'left') result.push(line * SIZE + offset);
    if (direction === 'right') result.push(line * SIZE + (SIZE - 1 - offset));
    if (direction === 'up') result.push(offset * SIZE + line);
    if (direction === 'down') result.push((SIZE - 1 - offset) * SIZE + line);
  }
  return result;
}

/** Apply a move WITHOUT spawning a tile; the controller spawns only on legal moves. */
export function moveBoard(board, direction) {
  if (!['left', 'right', 'up', 'down'].includes(direction)) {
    throw new RangeError(`Unknown direction: ${direction}`);
  }
  const next = emptyBoard();
  const mergedIndices = [];
  let scoreGain = 0;

  for (let line = 0; line < SIZE; line += 1) {
    const indices = lineIndices(line, direction);
    const values = indices.map(index => board[index]).filter(Boolean);
    const compressed = [];

    for (let i = 0; i < values.length; i += 1) {
      if (i + 1 < values.length && values[i] === values[i + 1]) {
        const merged = values[i] * 2;
        compressed.push(merged);
        scoreGain += merged;
        mergedIndices.push(indices[compressed.length - 1]);
        i += 1;
      } else {
        compressed.push(values[i]);
      }
    }

    indices.forEach((index, position) => {
      next[index] = compressed[position] ?? 0;
    });
  }

  return {
    board: next,
    moved: next.some((value, index) => value !== board[index]),
    scoreGain,
    mergedIndices,
  };
}

export function canMove(board) {
  if (board.includes(0)) return true;
  for (let row = 0; row < SIZE; row += 1) {
    for (let col = 0; col < SIZE; col += 1) {
      const index = row * SIZE + col;
      if (col < SIZE - 1 && board[index] === board[index + 1]) return true;
      if (row < SIZE - 1 && board[index] === board[index + SIZE]) return true;
    }
  }
  return false;
}

export function hasWon(board) {
  return board.some(value => value >= 2048);
}

export function isValidBoard(board) {
  return Array.isArray(board) && board.length === CELL_COUNT && board.every(value =>
    Number.isSafeInteger(value) && (value === 0 || (value >= 2 && (value & (value - 1)) === 0))
  );
}
