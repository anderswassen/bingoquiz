const express = require('express');
const http = require('http');
const fs = require('fs');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

app.get('/api/version', (_req, res) => res.json({ version: pkg.version }));

// ---------------------------------------------------------------------------
// Question pools — load from /data/*.json at startup
// ---------------------------------------------------------------------------
const pools = new Map();
const dataDir = path.join(__dirname, 'data');
if (fs.existsSync(dataDir)) {
  fs.readdirSync(dataDir).filter(f => f.endsWith('.json')).forEach(file => {
    const pool = JSON.parse(fs.readFileSync(path.join(dataDir, file), 'utf8'));
    pools.set(pool.id, pool);
  });
}
console.log(`Loaded ${pools.size} question pool(s)`);

app.get('/api/pools', (_req, res) => {
  const list = [];
  pools.forEach(p => list.push({ id: p.id, name: p.name, description: p.description, count: p.questions.length }));
  res.json(list);
});

app.get('/api/pools/:id', (req, res) => {
  const pool = pools.get(req.params.id);
  if (!pool) return res.status(404).json({ error: 'Frågebanken hittades inte.' });
  res.json(pool);
});

// ---------------------------------------------------------------------------
// In-memory game store
// ---------------------------------------------------------------------------
const games = new Map();

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = '';
    for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  } while (games.has(code));
  return code;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function freeIndex(size) {
  return size % 2 === 1 ? Math.floor(size * size / 2) : -1;
}

function generateBoard(terms, size) {
  const fi = freeIndex(size);
  const need = fi >= 0 ? size * size - 1 : size * size;
  const selected = shuffle(terms).slice(0, need);
  if (fi >= 0) {
    const FREE = { id: '__free__', question: '', answer: 'FRITT' };
    return [...selected.slice(0, fi), FREE, ...selected.slice(fi)];
  }
  return selected;
}

function checkBingo(marks, size) {
  const fi = freeIndex(size);
  const ok = marks.map((m, i) => i === fi || (m.marked && m.correct));
  for (let r = 0; r < size; r++) {
    if (Array.from({ length: size }, (_, c) => ok[r * size + c]).every(Boolean)) return true;
  }
  for (let c = 0; c < size; c++) {
    if (Array.from({ length: size }, (_, r) => ok[r * size + c]).every(Boolean)) return true;
  }
  if (Array.from({ length: size }, (_, i) => ok[i * size + i]).every(Boolean)) return true;
  if (Array.from({ length: size }, (_, i) => ok[i * size + (size - 1 - i)]).every(Boolean)) return true;
  return false;
}

function bestStreak(marks, size) {
  const fi = freeIndex(size);
  const ok = marks.map((m, i) => i === fi || (m.marked && m.correct));
  let best = 0;
  for (let r = 0; r < size; r++) {
    let count = 0;
    for (let c = 0; c < size; c++) if (ok[r * size + c]) count++;
    best = Math.max(best, count);
  }
  for (let c = 0; c < size; c++) {
    let count = 0;
    for (let r = 0; r < size; r++) if (ok[r * size + c]) count++;
    best = Math.max(best, count);
  }
  let d1 = 0, d2 = 0;
  for (let i = 0; i < size; i++) {
    if (ok[i * size + i]) d1++;
    if (ok[i * size + (size - 1 - i)]) d2++;
  }
  return Math.max(best, d1, d2);
}

function snapshotRound(game) {
  if (game.currentQuestionIndex === null) return;
  const qi = game.currentQuestionIndex;
  const correctTerm = game.terms[qi];
  const answers = new Map();
  const distractors = {};
  let correctCount = 0;
  let noAnswerCount = 0;

  game.students.forEach((student, playerId) => {
    const cellIndex = game.currentRoundAnswers.get(playerId);
    if (cellIndex === undefined || cellIndex === null) {
      answers.set(playerId, { cellIndex: null, chosenTermId: null, chosenAnswer: null, correct: false });
      noAnswerCount++;
      return;
    }
    const chosenTerm = student.board[cellIndex];
    const isCorrect = chosenTerm.id === correctTerm.id;
    answers.set(playerId, { cellIndex, chosenTermId: chosenTerm.id, chosenAnswer: chosenTerm.answer, correct: isCorrect });
    if (isCorrect) {
      correctCount++;
    } else {
      if (!distractors[chosenTerm.id]) distractors[chosenTerm.id] = { answer: chosenTerm.answer, count: 0 };
      distractors[chosenTerm.id].count++;
    }
  });

  game.questionHistory.push({
    questionIndex: qi,
    termId: correctTerm.id,
    question: correctTerm.question,
    correctAnswer: correctTerm.answer,
    answers,
    correctCount,
    wrongCount: game.students.size - correctCount - noAnswerCount,
    noAnswerCount,
    distractors,
    totalStudents: game.students.size,
  });
}

// ---------------------------------------------------------------------------
// REST — create & check games
// ---------------------------------------------------------------------------
app.post('/api/games', (req, res) => {
  const { title, terms, boardSize: rawSize } = req.body;
  const size = [3, 4, 5].includes(rawSize) ? rawSize : 5;
  const hasFree = size % 2 === 1;
  const minTerms = hasFree ? size * size - 1 : size * size;

  if (!terms || terms.length < minTerms) {
    return res.status(400).json({ error: `Minst ${minTerms} frågor krävs för en ${size}×${size}-bricka.` });
  }
  const code = generateCode();
  games.set(code, {
    code,
    title: title || 'BingoQuiz',
    terms,
    boardSize: size,
    currentQuestionIndex: null,
    askedQuestions: new Set(),
    students: new Map(),
    teacherSocketId: null,
    currentRoundAnswers: new Map(),   // playerId → cellIndex
    hesitations: new Map(),           // termId → count (abandoned clicks)
    questionHistory: [],              // per-question stats, populated at reveal
    reviewPhase: false,
    reviewIndex: -1,
  });
  res.json({ code });
});

app.get('/api/games/:code', (req, res) => {
  const game = games.get(req.params.code.toUpperCase());
  if (!game) return res.status(404).json({ error: 'Spelet hittades inte.' });
  res.json({ exists: true, title: game.title, termCount: game.terms.length });
});

// ---------------------------------------------------------------------------
// Socket.io
// ---------------------------------------------------------------------------
function emitReviewQuestion(game, teacherSocket) {
  const h = game.questionHistory[game.reviewIndex];
  const total = game.questionHistory.length;

  // Send to teacher
  teacherSocket.emit('review-question', {
    reviewIndex: game.reviewIndex,
    totalQuestions: total,
    questionIndex: h.questionIndex,
    question: h.question,
    correctAnswer: h.correctAnswer,
    correctCount: h.correctCount,
    wrongCount: h.wrongCount,
    noAnswerCount: h.noAnswerCount,
    totalStudents: h.totalStudents,
    correctPct: h.totalStudents > 0 ? Math.round((h.correctCount / h.totalStudents) * 100) : 0,
    distractors: Object.values(h.distractors).sort((a, b) => b.count - a.count),
  });

  // Send personalized data to each student
  game.students.forEach((student, playerId) => {
    const correctTerm = game.terms[h.questionIndex];
    const correctCellIndex = student.board.findIndex(c => c.id === correctTerm.id);
    const studentAnswer = h.answers.get(playerId);

    const sock = io.sockets.sockets.get(student.socketId);
    if (sock) {
      sock.emit('review-question-student', {
        reviewIndex: game.reviewIndex,
        totalQuestions: total,
        question: h.question,
        correctAnswer: h.correctAnswer,
        myAnswer: studentAnswer ? studentAnswer.chosenAnswer : null,
        wasCorrect: studentAnswer ? studentAnswer.correct : false,
        correctCellIndex,
        myCellIndex: studentAnswer ? studentAnswer.cellIndex : null,
      });
    }
  });
}

io.on('connection', (socket) => {

  // ---- Teacher joins ----
  socket.on('teacher-join', ({ code }) => {
    const game = games.get(code);
    if (!game) return socket.emit('error-msg', { message: 'Spelet hittades inte.' });

    game.teacherSocketId = socket.id;
    socket.join(`game:${code}`);
    socket.join(`teacher:${code}`);

    const students = [];
    game.students.forEach((s, id) => {
      students.push({
        id,
        name: s.name,
        board: s.board,
        marks: s.marks,
        hasBingo: s.hasBingo,
        connected: s.connected,
        correctCount: s.marks.filter(m => m.marked && m.correct).length - (freeIndex(game.boardSize) >= 0 ? 1 : 0),
        wrongCount: s.marks.filter(m => m.marked && !m.correct).length,
        bestStreak: bestStreak(s.marks, game.boardSize),
      });
    });

    socket.emit('game-state', {
      title: game.title,
      terms: game.terms,
      boardSize: game.boardSize,
      currentQuestionIndex: game.currentQuestionIndex,
      askedQuestions: [...game.askedQuestions],
      hesitations: Object.fromEntries(game.hesitations),
      students,
    });
  });

  // ---- Student joins ----
  socket.on('student-join', ({ code, name, playerId }) => {
    const game = games.get(code);
    if (!game) return socket.emit('error-msg', { message: 'Spelet hittades inte.' });

    // Reconnect?
    let student = playerId ? game.students.get(playerId) : null;

    if (student) {
      student.socketId = socket.id;
      student.connected = true;
      socket.join(`game:${code}`);

      socket.emit('board-assigned', {
        playerId,
        name: student.name,
        boardSize: game.boardSize,
        board: student.board.map(t => ({ id: t.id, answer: t.answer })),
        marks: student.marks,
        currentQuestion: game.currentQuestionIndex !== null ? {
          index: game.currentQuestionIndex,
          question: game.terms[game.currentQuestionIndex].question,
          alreadyAnswered: game.currentRoundAnswers.has(playerId),
          currentCell: game.currentRoundAnswers.get(playerId) ?? null,
        } : null,
        hasBingo: student.hasBingo,
      });

      io.to(`teacher:${code}`).emit('student-reconnected', { id: playerId });
    } else {
      const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const board = generateBoard(game.terms, game.boardSize);
      const fi = freeIndex(game.boardSize);
      const totalCells = game.boardSize * game.boardSize;
      const marks = Array.from({ length: totalCells }, (_, i) => ({
        marked: i === fi,
        correct: i === fi,
      }));

      student = { id, socketId: socket.id, name, board, marks, hasBingo: false, connected: true };
      game.students.set(id, student);
      socket.join(`game:${code}`);

      socket.emit('board-assigned', {
        playerId: id,
        name,
        boardSize: game.boardSize,
        board: board.map(t => ({ id: t.id, answer: t.answer })),
        marks,
        currentQuestion: game.currentQuestionIndex !== null ? {
          index: game.currentQuestionIndex,
          question: game.terms[game.currentQuestionIndex].question,
          alreadyAnswered: false,
          currentCell: null,
        } : null,
        hasBingo: false,
      });

      io.to(`teacher:${code}`).emit('student-joined', {
        id,
        name,
        board: student.board,
        marks,
        hasBingo: false,
        connected: true,
        correctCount: 0,
        wrongCount: 0,
      });
    }
  });

  // ---- Teacher asks a question ----
  socket.on('ask-question', ({ code, questionIndex }) => {
    const game = games.get(code);
    if (!game) return;

    // Snapshot previous round if teacher moves on without revealing
    snapshotRound(game);

    game.currentQuestionIndex = questionIndex;
    game.askedQuestions.add(questionIndex);
    game.currentRoundAnswers = new Map();

    const q = game.terms[questionIndex];
    io.to(`game:${code}`).emit('question-asked', {
      index: questionIndex,
      question: q.question,
    });

    socket.emit('question-active', { questionIndex, answer: q.answer });
  });

  // ---- Student submits answer ----
  socket.on('submit-answer', ({ code, playerId, cellIndex }) => {
    const game = games.get(code);
    if (!game || game.currentQuestionIndex === null) return;

    const student = game.students.get(playerId);
    if (!student) return;
    const fi = freeIndex(game.boardSize);
    if (cellIndex === fi) return;

    // Don't allow clicking cells marked in PREVIOUS rounds
    const previousCell = game.currentRoundAnswers.get(playerId);
    if (student.marks[cellIndex].marked && cellIndex !== previousCell) return;

    // Clicking the same cell again — ignore
    if (cellIndex === previousCell) return;

    // --- Un-mark previous selection for this round (if any) ---
    let oldCellIndex = null;
    if (previousCell !== undefined) {
      oldCellIndex = previousCell;
      student.marks[previousCell] = { marked: false, correct: false };

      // Record hesitation on the abandoned term
      const abandonedTerm = student.board[previousCell];
      if (abandonedTerm.id !== '__free__') {
        game.hesitations.set(abandonedTerm.id, (game.hesitations.get(abandonedTerm.id) || 0) + 1);
      }
    }

    // --- Mark new selection ---
    const clickedTerm = student.board[cellIndex];
    const correctTerm = game.terms[game.currentQuestionIndex];
    const isCorrect = clickedTerm.id === correctTerm.id;

    student.marks[cellIndex] = { marked: true, correct: isCorrect };
    game.currentRoundAnswers.set(playerId, cellIndex);

    // Tell student: unmark old, mark new (no correctness info)
    socket.emit('cell-changed', { oldCellIndex, newCellIndex: cellIndex });

    // Check bingo
    const hadBingo = student.hasBingo;
    student.hasBingo = checkBingo(student.marks, game.boardSize);

    if (student.hasBingo && !hadBingo) {
      socket.emit('you-got-bingo');
      io.to(`teacher:${code}`).emit('student-bingo', { id: playerId, name: student.name });
    }

    // Full update to teacher
    io.to(`teacher:${code}`).emit('student-update', {
      id: playerId,
      marks: student.marks,
      hasBingo: student.hasBingo,
      correctCount: student.marks.filter(m => m.marked && m.correct).length - (fi >= 0 ? 1 : 0),
      wrongCount: student.marks.filter(m => m.marked && !m.correct).length,
      bestStreak: bestStreak(student.marks, game.boardSize),
      lastAnswer: { cellIndex, correct: isCorrect, questionIndex: game.currentQuestionIndex },
      hesitations: Object.fromEntries(game.hesitations),
    });
  });

  // ---- Teacher reveals correct answer ----
  socket.on('reveal-answer', ({ code }) => {
    const game = games.get(code);
    if (!game || game.currentQuestionIndex === null) return;

    const correctTerm = game.terms[game.currentQuestionIndex];

    // Send each student their personal reveal info
    game.students.forEach((student, playerId) => {
      const selectedCell = game.currentRoundAnswers.get(playerId);
      const correctCellIndex = student.board.findIndex(c => c.id === correctTerm.id);
      const wasCorrect = selectedCell !== undefined && student.board[selectedCell].id === correctTerm.id;

      const sock = io.sockets.sockets.get(student.socketId);
      if (sock) {
        sock.emit('answer-revealed', {
          correctCellIndex,
          selectedCellIndex: selectedCell ?? null,
          wasCorrect,
          correctAnswer: correctTerm.answer,
        });
      }
    });

    // Snapshot round data before clearing
    snapshotRound(game);

    // Notify teacher
    socket.emit('answer-revealed-teacher', {
      questionIndex: game.currentQuestionIndex,
      correctAnswer: correctTerm.answer,
    });

    // Clear current question
    game.currentQuestionIndex = null;
    game.currentRoundAnswers = new Map();
  });

  // ---- Teacher ends the game ----
  socket.on('end-game', ({ code }) => {
    const game = games.get(code);
    if (!game) return;

    // Snapshot any pending round
    snapshotRound(game);
    game.currentQuestionIndex = null;
    game.currentRoundAnswers = new Map();

    const fi = freeIndex(game.boardSize);
    const results = [];
    game.students.forEach((s, id) => {
      const correct = s.marks.filter(m => m.marked && m.correct).length - (fi >= 0 ? 1 : 0);
      const wrong = s.marks.filter(m => m.marked && !m.correct).length;
      results.push({
        id,
        name: s.name,
        correctCount: correct,
        wrongCount: wrong,
        hasBingo: s.hasBingo,
        bestStreak: bestStreak(s.marks, game.boardSize),
      });
    });

    results.sort((a, b) => b.correctCount - a.correctCount || a.wrongCount - b.wrongCount);

    const totalAsked = game.askedQuestions.size;
    const avgCorrect = results.length > 0
      ? Math.round((results.reduce((sum, r) => sum + r.correctCount, 0) / results.length) * 10) / 10
      : 0;

    const hardTerms = [];
    game.hesitations.forEach((count, termId) => {
      const term = game.terms.find(t => t.id === termId);
      if (term) hardTerms.push({ answer: term.answer, question: term.question, hesitations: count });
    });
    hardTerms.sort((a, b) => b.hesitations - a.hesitations);

    socket.emit('game-results', {
      title: game.title,
      boardSize: game.boardSize,
      totalQuestions: game.terms.length,
      totalAsked,
      avgCorrect,
      results,
      hardTerms: hardTerms.slice(0, 15),
      questionStats: game.questionHistory.map(h => ({
        questionIndex: h.questionIndex,
        question: h.question,
        correctAnswer: h.correctAnswer,
        correctCount: h.correctCount,
        wrongCount: h.wrongCount,
        noAnswerCount: h.noAnswerCount,
        totalStudents: h.totalStudents,
        correctPct: h.totalStudents > 0 ? Math.round((h.correctCount / h.totalStudents) * 100) : 0,
        distractors: Object.values(h.distractors).sort((a, b) => b.count - a.count),
      })),
    });

    io.to(`game:${code}`).emit('game-ended', { title: game.title });
  });

  // ---- Teacher starts review phase ----
  socket.on('start-review', ({ code }) => {
    const game = games.get(code);
    if (!game || game.questionHistory.length === 0) return;

    game.reviewPhase = true;
    game.reviewIndex = 0;
    emitReviewQuestion(game, socket);
  });

  socket.on('review-next', ({ code }) => {
    const game = games.get(code);
    if (!game || !game.reviewPhase) return;

    game.reviewIndex++;
    if (game.reviewIndex >= game.questionHistory.length) {
      game.reviewPhase = false;
      io.to(`game:${code}`).emit('review-ended');
      return;
    }
    emitReviewQuestion(game, socket);
  });

  // ---- Disconnect ----
  socket.on('disconnect', () => {
    games.forEach((game) => {
      game.students.forEach((student) => {
        if (student.socketId === socket.id) {
          student.connected = false;
          io.to(`teacher:${game.code}`).emit('student-disconnected', { id: student.id });
        }
      });
    });
  });
});

// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BingoQuiz running on http://localhost:${PORT}`);
});
