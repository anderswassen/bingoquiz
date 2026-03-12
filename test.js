/* test.js — BingoQuiz integration tests
 *
 * Run:  node test.js
 *
 * Starts the server on a random port, runs all tests via socket.io-client
 * and HTTP fetch, then exits with code 0 (pass) or 1 (fail).
 */

const http = require('http');
const { Server } = require('socket.io');
const ioClient = require('socket.io-client');

// ---------------------------------------------------------------------------
// Minimal test runner
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, msg) {
  if (!condition) throw new Error(msg);
}

function assertEq(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function assertInRange(val, min, max, msg) {
  if (val < min || val > max) throw new Error(`${msg}: ${val} not in [${min}, ${max}]`);
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    failures.push({ name, err: err.message });
    console.log(`  ✗ ${name} — ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Server setup (import server internals by requiring it fresh)
// ---------------------------------------------------------------------------
let serverInstance, io, port;

async function startServer() {
  // We load server.js code manually to control the port
  const express = require('express');
  const path = require('path');
  const fs = require('fs');

  const app = express();
  const srv = http.createServer(app);
  io = new Server(srv);

  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

  // -- Copy server logic inline so we test the real code --
  // (We re-import the key functions and routes from server.js via eval-free approach)
  // Instead, let's just start the actual server on a dynamic port.

  return new Promise((resolve) => {
    // Kill any existing and start fresh
    delete require.cache[require.resolve('./server.js')];

    // Monkey-patch to capture the server instance
    const origListen = http.Server.prototype.listen;
    let captured = false;

    http.Server.prototype.listen = function (...args) {
      if (!captured) {
        captured = true;
        serverInstance = this;
        // Override port to 0 for random assignment
        args[0] = 0;
        const result = origListen.apply(this, args);
        http.Server.prototype.listen = origListen; // restore
        return result;
      }
      return origListen.apply(this, args);
    };

    require('./server.js');

    // Wait for server to be listening
    const check = setInterval(() => {
      if (serverInstance && serverInstance.address()) {
        clearInterval(check);
        port = serverInstance.address().port;
        resolve();
      }
    }, 50);
  });
}

function url() {
  return `http://localhost:${port}`;
}

function connect() {
  return ioClient(url(), { transports: ['websocket'], forceNew: true });
}

function waitFor(socket, event, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${event}"`)), timeout);
    socket.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

async function fetchJSON(path, opts = {}) {
  const res = await fetch(`${url()}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  return { status: res.status, data: await res.json() };
}

// Generate 24 unique terms for a 5x5 board
function makeTerms(n = 24) {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    question: `Question ${i}?`,
    answer: `Answer${i}`,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
async function runTests() {
  console.log('\n🧪 BingoQuiz Test Suite\n');

  // =========================================================================
  console.log('— REST API —');
  // =========================================================================

  await test('POST /api/games creates a game', async () => {
    const { status, data } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Test', terms: makeTerms(), boardSize: 5 }),
    });
    assertEq(status, 200, 'status');
    assert(data.code && data.code.length === 6, 'code should be 6 chars');
  });

  await test('POST /api/games rejects too few terms', async () => {
    const { status } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Fail', terms: makeTerms(5), boardSize: 5 }),
    });
    assertEq(status, 400, 'status');
  });

  await test('POST /api/games accepts 4x4 with 16 terms', async () => {
    const { status, data } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: '4x4', terms: makeTerms(16), boardSize: 4 }),
    });
    assertEq(status, 200, 'status');
    assert(data.code, 'should return code');
  });

  await test('POST /api/games accepts 3x3 with 8 terms', async () => {
    const { status, data } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: '3x3', terms: makeTerms(8), boardSize: 3 }),
    });
    assertEq(status, 200, 'status');
    assert(data.code, 'should return code');
  });

  await test('GET /api/games/:code returns game info', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Lookup', terms: makeTerms(), boardSize: 5 }),
    });
    const { status, data } = await fetchJSON(`/api/games/${created.code}`);
    assertEq(status, 200, 'status');
    assertEq(data.exists, true, 'exists');
    assertEq(data.title, 'Lookup', 'title');
  });

  await test('GET /api/games/:code 404 for unknown', async () => {
    const { status } = await fetchJSON('/api/games/ZZZZZZ');
    assertEq(status, 404, 'status');
  });

  await test('GET /api/pools returns pool list', async () => {
    const { status, data } = await fetchJSON('/api/pools');
    assertEq(status, 200, 'status');
    assert(Array.isArray(data), 'should be array');
  });

  // =========================================================================
  console.log('\n— Socket.io: Teacher & Student Join —');
  // =========================================================================

  await test('Teacher joins and receives game-state', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'JoinTest', terms: makeTerms(), boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    const state = await waitFor(teacher, 'game-state');

    assertEq(state.title, 'JoinTest', 'title');
    assertEq(state.boardSize, 5, 'boardSize');
    assertEq(state.terms.length, 24, 'terms count');
    assert(Array.isArray(state.students), 'students array');
    assertEq(state.students.length, 0, 'no students yet');

    teacher.disconnect();
  });

  await test('Teacher gets error for invalid code', async () => {
    const teacher = connect();
    teacher.emit('teacher-join', { code: 'BADCOD' });
    const err = await waitFor(teacher, 'error-msg');
    assert(err.message, 'should have error message');
    teacher.disconnect();
  });

  await test('Student joins and receives board-assigned', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'StudentJoin', terms: makeTerms(), boardSize: 5 }),
    });

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Alice' });
    const board = await waitFor(student, 'board-assigned');

    assert(board.playerId, 'should have playerId');
    assertEq(board.name, 'Alice', 'name');
    assertEq(board.boardSize, 5, 'boardSize');
    assertEq(board.board.length, 25, 'board cells');
    assertEq(board.marks.length, 25, 'marks');
    assertEq(board.hasBingo, false, 'no bingo yet');

    // Free center cell (index 12 for 5x5)
    assertEq(board.marks[12].marked, true, 'free cell marked');
    assertEq(board.board[12].id, '__free__', 'free cell id');

    student.disconnect();
  });

  await test('Teacher is notified when student joins', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Notify', terms: makeTerms(), boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Bob' });
    const joined = await waitFor(teacher, 'student-joined');

    assertEq(joined.name, 'Bob', 'student name');
    assert(joined.id, 'student id');
    assertEq(joined.correctCount, 0, 'correctCount');
    assertEq(joined.wrongCount, 0, 'wrongCount');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Student reconnects with playerId', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reconnect', terms: makeTerms(), boardSize: 5 }),
    });

    const s1 = connect();
    s1.emit('student-join', { code: created.code, name: 'Carol' });
    const b1 = await waitFor(s1, 'board-assigned');
    s1.disconnect();

    // Reconnect with same playerId
    const s2 = connect();
    s2.emit('student-join', { code: created.code, name: 'Carol', playerId: b1.playerId });
    const b2 = await waitFor(s2, 'board-assigned');

    assertEq(b2.playerId, b1.playerId, 'same playerId');
    assertEq(b2.name, 'Carol', 'same name');

    s2.disconnect();
  });

  // =========================================================================
  console.log('\n— Socket.io: Ask Question & Submit Answer —');
  // =========================================================================

  await test('Teacher asks question, student receives it', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'AskQ', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Dave' });
    await waitFor(student, 'board-assigned');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });

    const [active, asked] = await Promise.all([
      waitFor(teacher, 'question-active'),
      waitFor(student, 'question-asked'),
    ]);

    assertEq(active.questionIndex, 0, 'teacher gets questionIndex');
    assertEq(active.answer, terms[0].answer, 'teacher gets answer');
    assertEq(asked.index, 0, 'student gets index');
    assertEq(asked.question, terms[0].question, 'student gets question text');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Student submits answer and gets cell-changed', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Submit', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Eve' });
    const board = await waitFor(student, 'board-assigned');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Click a non-free, non-marked cell
    const cellIndex = board.board[0].id === '__free__' ? 1 : 0;
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex });

    const changed = await waitFor(student, 'cell-changed');
    assertEq(changed.oldCellIndex, null, 'no previous cell');
    assertEq(changed.newCellIndex, cellIndex, 'new cell index');

    // Teacher receives update
    const update = await waitFor(teacher, 'student-update');
    assertEq(update.id, board.playerId, 'student id');
    assert(update.marks[cellIndex].marked, 'cell should be marked');
    assert(typeof update.bestStreak === 'number', 'bestStreak included');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Student can change answer (hesitation tracked)', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Change', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Frank' });
    const board = await waitFor(student, 'board-assigned');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Pick two non-free cells
    const cells = board.board.map((c, i) => i).filter(i => i !== 12); // exclude free cell
    const cell1 = cells[0];
    const cell2 = cells[1];

    // First answer
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell1 });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    // Change answer
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell2 });
    const changed2 = await waitFor(student, 'cell-changed');
    assertEq(changed2.oldCellIndex, cell1, 'old cell unmarked');
    assertEq(changed2.newCellIndex, cell2, 'new cell marked');

    const update2 = await waitFor(teacher, 'student-update');
    assert(!update2.marks[cell1].marked, 'old cell no longer marked');
    assert(update2.marks[cell2].marked, 'new cell is marked');

    // Hesitation should be recorded
    const abandonedTermId = board.board[cell1].id;
    assert(update2.hesitations[abandonedTermId] >= 1, 'hesitation recorded');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Feature 8: Best Streak (Nearest-to-Bingo) —');
  // =========================================================================

  await test('bestStreak starts at 1 for 5x5 (free cell counts)', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Streak', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Greta' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question and answer correctly
    // Find which term is at a cell on the board, then ask that question
    const nonFreeCell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    const termId = board.board[nonFreeCell].id;
    const termIndex = terms.findIndex(t => t.id === termId);

    teacher.emit('ask-question', { code: created.code, questionIndex: termIndex });
    await waitFor(student, 'question-asked');

    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: nonFreeCell });
    await waitFor(student, 'cell-changed');

    const update = await waitFor(teacher, 'student-update');
    // bestStreak should be at least 1 (the free cell alone gives 1 in center row/col/diag)
    assertInRange(update.bestStreak, 1, 5, 'bestStreak after 1 correct answer');

    teacher.disconnect();
    student.disconnect();
  });

  await test('bestStreak included in game-state on teacher join', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'StreakState', terms, boardSize: 5 }),
    });

    // Student joins first
    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Helga' });
    await waitFor(student, 'board-assigned');

    // Teacher joins after
    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    const state = await waitFor(teacher, 'game-state');

    assertEq(state.students.length, 1, 'one student');
    assert(typeof state.students[0].bestStreak === 'number', 'bestStreak in game-state');
    assertInRange(state.students[0].bestStreak, 1, 5, 'bestStreak value');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Feature 4: Reveal Correct Answer —');
  // =========================================================================

  await test('Reveal sends correct answer to student', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Reveal', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Ida' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question 0
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Student answers (pick any non-free cell)
    const cellIdx = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cellIdx });
    await waitFor(student, 'cell-changed');

    // Teacher reveals
    teacher.emit('reveal-answer', { code: created.code });

    const [revealed, teacherRevealed] = await Promise.all([
      waitFor(student, 'answer-revealed'),
      waitFor(teacher, 'answer-revealed-teacher'),
    ]);

    assertEq(revealed.correctAnswer, terms[0].answer, 'student gets correct answer text');
    assert(typeof revealed.correctCellIndex === 'number', 'student gets correctCellIndex');
    assert(typeof revealed.wasCorrect === 'boolean', 'student gets wasCorrect');
    assert(revealed.selectedCellIndex !== null, 'student gets selectedCellIndex');

    assertEq(teacherRevealed.questionIndex, 0, 'teacher gets questionIndex');
    assertEq(teacherRevealed.correctAnswer, terms[0].answer, 'teacher gets correctAnswer');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Reveal with correct answer sets wasCorrect=true', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'RevealCorrect', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Jens' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question 0 — find where term 0 is on this student's board
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const correctCell = board.board.findIndex(c => c.id === terms[0].id);
    if (correctCell >= 0 && correctCell !== 12) {
      student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: correctCell });
      await waitFor(student, 'cell-changed');

      teacher.emit('reveal-answer', { code: created.code });
      const revealed = await waitFor(student, 'answer-revealed');

      assertEq(revealed.wasCorrect, true, 'wasCorrect should be true');
      assertEq(revealed.correctCellIndex, correctCell, 'correctCellIndex matches selected');
    } else {
      // Term not on board (unlikely with 24/24) — just reveal without answer
      teacher.emit('reveal-answer', { code: created.code });
      const revealed = await waitFor(student, 'answer-revealed');
      assertEq(revealed.selectedCellIndex, null, 'no selection');
    }

    teacher.disconnect();
    student.disconnect();
  });

  await test('Reveal clears current question (no double reveal)', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'DoubleReveal', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const activeP = waitFor(teacher, 'question-active');
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await activeP;

    const revealP = waitFor(teacher, 'answer-revealed-teacher');
    teacher.emit('reveal-answer', { code: created.code });
    await revealP;

    // Second reveal should not trigger (no active question)
    teacher.emit('reveal-answer', { code: created.code });

    // Wait briefly — no event should come
    const gotSecond = await Promise.race([
      waitFor(teacher, 'answer-revealed-teacher', 500).then(() => true).catch(() => false),
      new Promise(r => setTimeout(() => r(false), 600)),
    ]);
    assertEq(gotSecond, false, 'no second reveal event');

    teacher.disconnect();
  });

  await test('Student who did not answer gets null selectedCellIndex on reveal', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'NoAnswer', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Karl' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Student does NOT answer — teacher reveals
    teacher.emit('reveal-answer', { code: created.code });
    const revealed = await waitFor(student, 'answer-revealed');

    assertEq(revealed.selectedCellIndex, null, 'no selection');
    assertEq(revealed.wasCorrect, false, 'wasCorrect false for no answer');
    assertEq(revealed.correctAnswer, terms[0].answer, 'correct answer provided');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Feature 3: End Game & Results —');
  // =========================================================================

  await test('End game returns results to teacher', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'EndGame', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    // Add two students
    const s1 = connect();
    s1.emit('student-join', { code: created.code, name: 'Lisa' });
    const b1 = await waitFor(s1, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    const s2 = connect();
    s2.emit('student-join', { code: created.code, name: 'Mats' });
    const b2 = await waitFor(s2, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question and have student 1 answer correctly
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(s1, 'question-asked');
    await waitFor(s2, 'question-asked');

    const correctCell1 = b1.board.findIndex(c => c.id === terms[0].id);
    if (correctCell1 >= 0 && correctCell1 !== 12) {
      s1.emit('submit-answer', { code: created.code, playerId: b1.playerId, cellIndex: correctCell1 });
      await waitFor(s1, 'cell-changed');
      await waitFor(teacher, 'student-update');
    }

    // End game
    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assertEq(results.title, 'EndGame', 'title');
    assertEq(results.boardSize, 5, 'boardSize');
    assertEq(results.totalQuestions, 24, 'totalQuestions');
    assertEq(results.totalAsked, 1, 'totalAsked');
    assertEq(results.results.length, 2, 'two students in results');
    assert(Array.isArray(results.hardTerms), 'hardTerms is array');

    // Results should be sorted by correctCount desc
    assert(results.results[0].correctCount >= results.results[1].correctCount, 'sorted by correct desc');

    // Each result has required fields
    results.results.forEach(r => {
      assert(r.name, 'has name');
      assert(typeof r.correctCount === 'number', 'has correctCount');
      assert(typeof r.wrongCount === 'number', 'has wrongCount');
      assert(typeof r.hasBingo === 'boolean', 'has hasBingo');
      assert(typeof r.bestStreak === 'number', 'has bestStreak');
    });

    teacher.disconnect();
    s1.disconnect();
    s2.disconnect();
  });

  await test('End game sends game-ended to students', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'EndNotify', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Nils' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('end-game', { code: created.code });

    const [results, ended] = await Promise.all([
      waitFor(teacher, 'game-results'),
      waitFor(student, 'game-ended'),
    ]);

    assert(results, 'teacher gets results');
    assertEq(ended.title, 'EndNotify', 'student gets game title');

    teacher.disconnect();
    student.disconnect();
  });

  await test('End game with no students returns empty results', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Empty', terms: makeTerms(), boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assertEq(results.results.length, 0, 'no students');
    assertEq(results.avgCorrect, 0, 'avgCorrect is 0');
    assertEq(results.totalAsked, 0, 'no questions asked');

    teacher.disconnect();
  });

  await test('End game includes hesitation data in hardTerms', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Hesitate', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Olga' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Click one cell, then change to another (creates hesitation)
    const cells = board.board.map((c, i) => i).filter(i => i !== 12 && board.board[i].id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cells[0] });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cells[1] });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    // End game
    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assert(results.hardTerms.length >= 1, 'should have at least 1 hard term');
    assert(results.hardTerms[0].answer, 'hard term has answer');
    assert(results.hardTerms[0].question, 'hard term has question');
    assert(results.hardTerms[0].hesitations >= 1, 'hard term has hesitation count');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Board Size Variants —');
  // =========================================================================

  await test('3x3 board has free center (index 4) and 9 cells', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: '3x3', terms: makeTerms(8), boardSize: 3 }),
    });

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Per' });
    const board = await waitFor(student, 'board-assigned');

    assertEq(board.boardSize, 3, 'boardSize');
    assertEq(board.board.length, 9, '9 cells');
    assertEq(board.board[4].id, '__free__', 'center is free');
    assertEq(board.marks[4].marked, true, 'free cell pre-marked');

    student.disconnect();
  });

  await test('4x4 board has no free cell and 16 cells', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: '4x4', terms: makeTerms(16), boardSize: 4 }),
    });

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Quist' });
    const board = await waitFor(student, 'board-assigned');

    assertEq(board.boardSize, 4, 'boardSize');
    assertEq(board.board.length, 16, '16 cells');
    // No free cell — no cell should have id '__free__'
    const freeCount = board.board.filter(c => c.id === '__free__').length;
    assertEq(freeCount, 0, 'no free cell in 4x4');

    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Edge Cases —');
  // =========================================================================

  await test('Cannot submit answer when no question is active', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'NoQ', terms, boardSize: 5 }),
    });

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Rita' });
    const board = await waitFor(student, 'board-assigned');

    // Try submitting without a question being asked
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: 0 });

    // Should not get cell-changed
    const got = await Promise.race([
      waitFor(student, 'cell-changed', 500).then(() => true).catch(() => false),
      new Promise(r => setTimeout(() => r(false), 600)),
    ]);
    assertEq(got, false, 'no cell-changed without active question');

    student.disconnect();
  });

  await test('Cannot click free cell', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'FreeClick', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Sven' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Try clicking the free cell (index 12 for 5x5)
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: 12 });

    const got = await Promise.race([
      waitFor(student, 'cell-changed', 500).then(() => true).catch(() => false),
      new Promise(r => setTimeout(() => r(false), 600)),
    ]);
    assertEq(got, false, 'no cell-changed for free cell click');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Cannot click same cell twice', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'SameCell', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Tina' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const cell = board.board[0].id === '__free__' ? 1 : 0;
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });
    await waitFor(student, 'cell-changed');

    // Click same cell again
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });

    const got = await Promise.race([
      waitFor(student, 'cell-changed', 500).then(() => true).catch(() => false),
      new Promise(r => setTimeout(() => r(false), 600)),
    ]);
    assertEq(got, false, 'no cell-changed for same cell click');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Feature 5: Per-Question Statistics (questionStats) —');
  // =========================================================================

  await test('End game includes questionStats in results', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'QStats', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Astrid' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question 0 and have student answer
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const cell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    // Reveal answer (this triggers snapshotRound)
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    // End game
    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assert(Array.isArray(results.questionStats), 'questionStats is array');
    assertEq(results.questionStats.length, 1, 'one question snapshot');

    const qs = results.questionStats[0];
    assertEq(qs.questionIndex, 0, 'questionIndex');
    assertEq(qs.question, terms[0].question, 'question text');
    assertEq(qs.correctAnswer, terms[0].answer, 'correctAnswer');
    assertEq(qs.totalStudents, 1, 'totalStudents');
    assert(typeof qs.correctCount === 'number', 'has correctCount');
    assert(typeof qs.wrongCount === 'number', 'has wrongCount');
    assert(typeof qs.noAnswerCount === 'number', 'has noAnswerCount');
    assert(typeof qs.correctPct === 'number', 'has correctPct');
    assertEq(qs.correctCount + qs.wrongCount + qs.noAnswerCount, 1, 'counts add up to totalStudents');

    teacher.disconnect();
    student.disconnect();
  });

  await test('questionStats tracks correct vs wrong answers', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'QStatsAccuracy', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    // Two students
    const s1 = connect();
    s1.emit('student-join', { code: created.code, name: 'Karin' });
    const b1 = await waitFor(s1, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    const s2 = connect();
    s2.emit('student-join', { code: created.code, name: 'Lars' });
    const b2 = await waitFor(s2, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question 0
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(s1, 'question-asked');
    await waitFor(s2, 'question-asked');

    // S1 answers correctly
    const correctCell1 = b1.board.findIndex(c => c.id === terms[0].id);
    if (correctCell1 >= 0 && correctCell1 !== 12) {
      s1.emit('submit-answer', { code: created.code, playerId: b1.playerId, cellIndex: correctCell1 });
      await waitFor(s1, 'cell-changed');
      await waitFor(teacher, 'student-update');
    }

    // S2 answers wrong (pick a cell that is NOT the correct answer)
    const wrongCell2 = b2.board.findIndex((c, i) => i !== 12 && c.id !== '__free__' && c.id !== terms[0].id);
    if (wrongCell2 >= 0) {
      s2.emit('submit-answer', { code: created.code, playerId: b2.playerId, cellIndex: wrongCell2 });
      await waitFor(s2, 'cell-changed');
      await waitFor(teacher, 'student-update');
    }

    // Reveal
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    // End game
    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    const qs = results.questionStats[0];
    assertEq(qs.totalStudents, 2, 'two students');
    // At least one correct and one wrong (if cells were found)
    if (correctCell1 >= 0 && correctCell1 !== 12 && wrongCell2 >= 0) {
      assertEq(qs.correctCount, 1, 'one correct');
      assertEq(qs.wrongCount, 1, 'one wrong');
      assert(qs.distractors.length >= 1, 'has distractors');
      assert(qs.distractors[0].answer, 'distractor has answer');
      assert(qs.distractors[0].count >= 1, 'distractor has count');
    }

    teacher.disconnect();
    s1.disconnect();
    s2.disconnect();
  });

  await test('questionStats records noAnswer for students who did not answer', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'QStatsNoAns', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Maria' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question but student does NOT answer
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // Reveal without student answering
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    const qs = results.questionStats[0];
    assertEq(qs.noAnswerCount, 1, 'one no-answer');
    assertEq(qs.correctCount, 0, 'zero correct');
    assertEq(qs.wrongCount, 0, 'zero wrong');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Multiple revealed questions produce multiple questionStats entries', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'QStatsMulti', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Nora' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Round 1
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    // Round 2
    teacher.emit('ask-question', { code: created.code, questionIndex: 1 });
    await waitFor(student, 'question-asked');
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    // Round 3
    teacher.emit('ask-question', { code: created.code, questionIndex: 2 });
    await waitFor(student, 'question-asked');
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assertEq(results.questionStats.length, 3, 'three question snapshots');
    assertEq(results.questionStats[0].questionIndex, 0, 'first q index');
    assertEq(results.questionStats[1].questionIndex, 1, 'second q index');
    assertEq(results.questionStats[2].questionIndex, 2, 'third q index');

    teacher.disconnect();
    student.disconnect();
  });

  await test('End game without reveal snapshots pending round', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'QStatsPending', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Oscar' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question, student answers, but teacher ends game without revealing
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const cell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assertEq(results.questionStats.length, 1, 'pending round was snapshotted');
    assertEq(results.questionStats[0].questionIndex, 0, 'correct question index');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Feature 11: Review Phase —');
  // =========================================================================

  await test('Start review sends review-question to teacher', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Review', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Petra' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask + reveal one question to populate questionHistory
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    // End game
    teacher.emit('end-game', { code: created.code });
    await waitFor(teacher, 'game-results');

    // Start review
    teacher.emit('start-review', { code: created.code });
    const review = await waitFor(teacher, 'review-question');

    assertEq(review.reviewIndex, 0, 'reviewIndex is 0');
    assertEq(review.totalQuestions, 1, 'totalQuestions');
    assertEq(review.question, terms[0].question, 'question text');
    assertEq(review.correctAnswer, terms[0].answer, 'correctAnswer');
    assert(typeof review.correctCount === 'number', 'has correctCount');
    assert(typeof review.wrongCount === 'number', 'has wrongCount');
    assert(typeof review.correctPct === 'number', 'has correctPct');
    assert(Array.isArray(review.distractors), 'has distractors');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Start review sends review-question-student to students', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'ReviewStudent', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Rikard' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask, answer, reveal
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const cell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });
    await waitFor(student, 'cell-changed');

    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(student, 'answer-revealed');

    // End game
    teacher.emit('end-game', { code: created.code });
    await waitFor(teacher, 'game-results');

    // Start review
    const studentReviewP = waitFor(student, 'review-question-student');
    teacher.emit('start-review', { code: created.code });
    const review = await studentReviewP;

    assertEq(review.reviewIndex, 0, 'reviewIndex');
    assertEq(review.question, terms[0].question, 'question');
    assertEq(review.correctAnswer, terms[0].answer, 'correctAnswer');
    assert(typeof review.wasCorrect === 'boolean', 'has wasCorrect');
    assert(typeof review.correctCellIndex === 'number', 'has correctCellIndex');
    // myAnswer should be non-null since student answered
    assert(review.myAnswer !== undefined, 'has myAnswer');
    assert(review.myCellIndex !== undefined, 'has myCellIndex');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Review-next advances and review-ended fires after last question', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'ReviewNav', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Sofia' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask + reveal two questions
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    teacher.emit('ask-question', { code: created.code, questionIndex: 1 });
    await waitFor(student, 'question-asked');
    teacher.emit('reveal-answer', { code: created.code });
    await waitFor(teacher, 'answer-revealed-teacher');

    // End game
    teacher.emit('end-game', { code: created.code });
    await waitFor(teacher, 'game-results');

    // Start review — should get question 0
    teacher.emit('start-review', { code: created.code });
    const r1 = await waitFor(teacher, 'review-question');
    assertEq(r1.reviewIndex, 0, 'first review index');

    // Next — should get question 1
    teacher.emit('review-next', { code: created.code });
    const r2 = await waitFor(teacher, 'review-question');
    assertEq(r2.reviewIndex, 1, 'second review index');

    // Next again — should end review
    const endedP = waitFor(student, 'review-ended');
    teacher.emit('review-next', { code: created.code });
    await endedP;

    teacher.disconnect();
    student.disconnect();
  });

  await test('Start review with no questions does nothing', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'ReviewEmpty', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    // End game without asking any questions
    teacher.emit('end-game', { code: created.code });
    await waitFor(teacher, 'game-results');

    // Start review — no questionHistory
    teacher.emit('start-review', { code: created.code });

    const got = await Promise.race([
      waitFor(teacher, 'review-question', 500).then(() => true).catch(() => false),
      new Promise(r => setTimeout(() => r(false), 600)),
    ]);
    assertEq(got, false, 'no review-question when no questions asked');

    teacher.disconnect();
  });

  // =========================================================================
  console.log('\n— Response Time & Change-Mind Analysis —');
  // =========================================================================

  await test('questionStats includes response time data', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'RespTime', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Tina' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const cell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    const qs = results.questionStats[0];
    assert(qs.avgResponseMs !== null, 'has avgResponseMs');
    assert(qs.avgResponseMs >= 0, 'avgResponseMs is non-negative');
    assert(qs.medianResponseMs !== null, 'has medianResponseMs');
    assertEq(typeof qs.changedToCorrect, 'number', 'has changedToCorrect');
    assertEq(typeof qs.changedToWrong, 'number', 'has changedToWrong');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Per-student avgResponseMs in results', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'StudentTime', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Vera' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    const cell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__');
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: cell });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assert(results.results[0].avgResponseMs !== null, 'student has avgResponseMs');
    assert(results.results[0].avgResponseMs >= 0, 'student avgResponseMs non-negative');

    teacher.disconnect();
    student.disconnect();
  });

  await test('Change-mind: wrong→right tracked as changedToCorrect', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'ChangeMind', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Wilma' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // First: click a wrong cell
    const wrongCell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__' && c.id !== terms[0].id);
    student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: wrongCell });
    await waitFor(student, 'cell-changed');
    await waitFor(teacher, 'student-update');

    // Then: click the correct cell
    const correctCell = board.board.findIndex(c => c.id === terms[0].id);
    if (correctCell >= 0 && correctCell !== 12) {
      student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: correctCell });
      await waitFor(student, 'cell-changed');
      await waitFor(teacher, 'student-update');
    }

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    const qs = results.questionStats[0];
    if (correctCell >= 0 && correctCell !== 12) {
      assertEq(qs.changedToCorrect, 1, 'one changed to correct');
      assertEq(qs.changedToWrong, 0, 'zero changed to wrong');
    }

    teacher.disconnect();
    student.disconnect();
  });

  await test('Change-mind: right→wrong tracked as changedToWrong', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'ChangeMind2', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Xena' });
    const board = await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    // First: click the correct cell
    const correctCell = board.board.findIndex(c => c.id === terms[0].id);
    if (correctCell >= 0 && correctCell !== 12) {
      student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: correctCell });
      await waitFor(student, 'cell-changed');
      await waitFor(teacher, 'student-update');

      // Then: click a wrong cell
      const wrongCell = board.board.findIndex((c, i) => i !== 12 && c.id !== '__free__' && c.id !== terms[0].id);
      student.emit('submit-answer', { code: created.code, playerId: board.playerId, cellIndex: wrongCell });
      await waitFor(student, 'cell-changed');
      await waitFor(teacher, 'student-update');
    }

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    const qs = results.questionStats[0];
    if (correctCell >= 0 && correctCell !== 12) {
      assertEq(qs.changedToWrong, 1, 'one changed to wrong');
      assertEq(qs.changedToCorrect, 0, 'zero changed to correct');
    }

    teacher.disconnect();
    student.disconnect();
  });

  await test('No answer gives null responseMs', async () => {
    const terms = makeTerms();
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'NoAnswer', terms, boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Ylva' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    // Ask question but student does NOT answer
    teacher.emit('ask-question', { code: created.code, questionIndex: 0 });
    await waitFor(student, 'question-asked');

    teacher.emit('end-game', { code: created.code });
    const results = await waitFor(teacher, 'game-results');

    assertEq(results.results[0].avgResponseMs, null, 'no answer → null avgResponseMs');
    assertEq(results.questionStats[0].avgResponseMs, null, 'no answers → null question avgResponseMs');

    teacher.disconnect();
    student.disconnect();
  });

  // =========================================================================
  console.log('\n— Edge Cases —');
  // =========================================================================

  await test('Disconnect marks student as disconnected', async () => {
    const { data: created } = await fetchJSON('/api/games', {
      method: 'POST',
      body: JSON.stringify({ title: 'Disconnect', terms: makeTerms(), boardSize: 5 }),
    });

    const teacher = connect();
    teacher.emit('teacher-join', { code: created.code });
    await waitFor(teacher, 'game-state');

    const student = connect();
    student.emit('student-join', { code: created.code, name: 'Ulf' });
    await waitFor(student, 'board-assigned');
    await waitFor(teacher, 'student-joined');

    student.disconnect();
    const disc = await waitFor(teacher, 'student-disconnected');
    assert(disc.id, 'disconnect event has student id');

    teacher.disconnect();
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
(async () => {
  try {
    await startServer();
    console.log(`Server started on port ${port}`);
    await runTests();
  } catch (err) {
    console.error('Setup error:', err);
    process.exit(1);
  } finally {
    console.log(`\n${'='.repeat(50)}`);
    console.log(`Results: ${passed} passed, ${failed} failed`);
    if (failures.length > 0) {
      console.log('\nFailures:');
      failures.forEach(f => console.log(`  • ${f.name}: ${f.err}`));
    }
    console.log();

    // Force exit (socket.io keeps event loop alive)
    process.exit(failed > 0 ? 1 : 0);
  }
})();
