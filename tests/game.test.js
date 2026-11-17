import test from 'node:test';
import assert from 'node:assert/strict';
import { canMove, emptyBoard, hasWon, isValidBoard, moveBoard, newBoard, spawnTile } from '../src/game.js';

const board = (...rows) => rows.flat();

test('new board starts with exactly two tiles', () => {
  const initial = newBoard(() => 0);
  assert.equal(initial.filter(Boolean).length, 2);
  assert.equal(initial[0], 2);
  assert.equal(initial[1], 2);
  assert.equal(initial.length, 16);
});

test('spawn chooses a free cell and creates a 4 at 10% probability', () => {
  const initial = emptyBoard();
  initial[0] = 2;
  const spawned = spawnTile(initial, () => 0.99);
  assert.equal(spawned.index, 15);
  assert.equal(spawned.value, 4);
  assert.equal(spawned.board[0], 2);
  assert.equal(initial[15], 0); // pure
});

test('spawn on full board has no side effects', () => {
  const original = Array(16).fill(2);
  const spawned = spawnTile(original, () => 0);
  assert.equal(spawned.index, -1);
  assert.deepEqual(spawned.board, original);
});

test('left combines matching pairs exactly once and counts score', () => {
  const input = board([2, 2, 2, 2], [4, 4, 8, 8], [0, 2, 0, 2], [0, 0, 0, 0]);
  const result = moveBoard(input, 'left');
  assert.deepEqual(result.board, board([4, 4, 0, 0], [8, 16, 0, 0], [4, 0, 0, 0], [0, 0, 0, 0]));
  assert.equal(result.scoreGain, 4 + 4 + 8 + 16 + 4);
  assert.deepEqual(result.mergedIndices, [0, 1, 4, 5, 8]);
  assert.equal(result.moved, true);
  assert.deepEqual(input[0], 2); // pure
});

test('a freshly merged tile cannot merge again in same move', () => {
  const input = board([2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  const result = moveBoard(input, 'left');
  assert.deepEqual(result.board.slice(0, 4), [4, 4, 0, 0]);
  assert.equal(result.scoreGain, 4);
});

test('right slides and merges from the right edge', () => {
  const input = board([2, 2, 4, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  const result = moveBoard(input, 'right');
  assert.deepEqual(result.board.slice(0, 4), [0, 0, 4, 4]);
  assert.equal(result.scoreGain, 4);
});

test('up and down operate by columns', () => {
  const input = board([2, 0, 0, 4], [2, 0, 0, 4], [4, 0, 0, 0], [4, 0, 0, 0]);
  assert.deepEqual(moveBoard(input, 'up').board, board([4, 0, 0, 8], [8, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]));
  assert.deepEqual(moveBoard(input, 'down').board, board([0, 0, 0, 0], [0, 0, 0, 0], [4, 0, 0, 0], [8, 0, 0, 8]));
});

test('no-op move is flagged and gains no points', () => {
  const input = board([2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2, 4], [8, 16, 32, 64]);
  const result = moveBoard(input, 'left');
  assert.equal(result.moved, false);
  assert.equal(result.scoreGain, 0);
  assert.equal(canMove(input), false);
});

test('full board with adjacent twins still has moves', () => {
  const input = board([2, 4, 8, 16], [32, 64, 128, 256], [512, 1024, 2, 4], [8, 16, 32, 32]);
  assert.equal(canMove(input), true);
});

test('win detection and state validation', () => {
  const input = board([2048, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]);
  assert.equal(hasWon(input), true);
  assert.equal(isValidBoard(input), true);
  assert.equal(isValidBoard([...input.slice(0, 15), 3]), false);
  assert.equal(isValidBoard([]), false);
  assert.throws(() => moveBoard(input, 'diagonal'), RangeError);
});
