/* play.js — Student bingo board */

const socket = io();
const params = new URLSearchParams(window.location.search);
const code = params.get('code');

if (!code) window.location.href = '/';

let playerId = sessionStorage.getItem(`bq_pid_${code}`);
let playerName = sessionStorage.getItem('bq_name') || '';
let board = [];
let marks = [];
let boardSize = 5;
let freeIdx = -1;
let currentQuestionIndex = null;
let currentRoundCell = null;        // cell index selected THIS round (can change)
let hasBingo = false;
let timerInterval = null;
let timerExpired = false;

function calcFreeIndex(size) {
  return size % 2 === 1 ? Math.floor(size * size / 2) : -1;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function showToast(msg, type = 'info') {
  const c = document.getElementById('toasts');
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.textContent = msg;
  c.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// ---------------------------------------------------------------------------
// Timer
// ---------------------------------------------------------------------------
function startTimer(deadline) {
  clearTimer();
  if (!deadline) return;

  timerExpired = false;
  const bar = document.getElementById('timer-bar');
  const fill = document.getElementById('timer-fill');
  const text = document.getElementById('timer-text');
  bar.classList.remove('hidden');
  bar.classList.remove('urgent');

  const totalMs = deadline - Date.now();
  if (totalMs <= 0) { expireTimer(); return; }

  timerInterval = setInterval(() => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      expireTimer();
      return;
    }
    const pct = (remaining / totalMs) * 100;
    const secs = Math.ceil(remaining / 1000);
    fill.style.width = pct + '%';
    text.textContent = secs + 's';

    if (remaining <= 5000) {
      bar.classList.add('urgent');
    }
  }, 100);
}

function clearTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  const bar = document.getElementById('timer-bar');
  if (bar) { bar.classList.add('hidden'); bar.classList.remove('urgent'); }
}

function expireTimer() {
  clearTimer();
  timerExpired = true;
  const bar = document.getElementById('timer-bar');
  const fill = document.getElementById('timer-fill');
  const text = document.getElementById('timer-text');
  bar.classList.remove('hidden');
  bar.classList.add('urgent');
  fill.style.width = '0%';
  text.textContent = 'Tiden är ute!';

  // Disable cell clicks visually
  document.querySelectorAll('.bingo-cell.clickable').forEach(el => {
    el.classList.remove('clickable');
    el.classList.add('disabled');
  });
}

// ---------------------------------------------------------------------------
// Name entry
// ---------------------------------------------------------------------------
const joinSection = document.getElementById('join-section');
const gameSection = document.getElementById('game-section');
const nameInput = document.getElementById('name-input');

if (playerName || playerId) {
  joinSection.classList.add('hidden');
  gameSection.classList.remove('hidden');
  socket.emit('student-join', { code, name: playerName, playerId });
}

// Auto-rejoin on reconnect (keeps student connected through review phase etc.)
socket.on('connect', () => {
  if (playerId) {
    socket.emit('student-join', { code, name: playerName, playerId });
  }
});

document.getElementById('name-submit').addEventListener('click', () => {
  const name = nameInput.value.trim();
  if (!name) {
    showToast('Du måste skriva in ditt namn.', 'error');
    return;
  }
  playerName = name;
  sessionStorage.setItem('bq_name', name);
  joinSection.classList.add('hidden');
  gameSection.classList.remove('hidden');
  socket.emit('student-join', { code, name, playerId });
});

nameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('name-submit').click();
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
socket.on('error-msg', ({ message }) => {
  showToast(message, 'error');
  setTimeout(() => window.location.href = '/', 2500);
});

socket.on('board-assigned', (data) => {
  playerId = data.playerId;
  sessionStorage.setItem(`bq_pid_${code}`, playerId);
  playerName = data.name;

  boardSize = data.boardSize || 5;
  freeIdx = calcFreeIndex(boardSize);
  board = data.board;
  marks = data.marks;
  hasBingo = data.hasBingo;

  document.getElementById('display-name').textContent = playerName;

  if (data.currentQuestion) {
    currentQuestionIndex = data.currentQuestion.index;
    currentRoundCell = data.currentQuestion.currentCell;
    showQuestion(data.currentQuestion.question);
    if (data.currentQuestion.deadline) startTimer(data.currentQuestion.deadline);
  }

  renderBoard();

  if (hasBingo) {
    document.getElementById('bingo-banner').classList.add('visible');
  }
});

socket.on('question-asked', ({ index, question, deadline }) => {
  currentQuestionIndex = index;
  currentRoundCell = null;
  timerExpired = false;
  showQuestion(question);
  renderBoard();
  if (deadline) startTimer(deadline); else clearTimer();
});

socket.on('cell-changed', ({ oldCellIndex, newCellIndex }) => {
  // Un-mark old cell (if any)
  if (oldCellIndex !== null && oldCellIndex !== undefined) {
    marks[oldCellIndex] = { marked: false, correct: false };
    const oldEl = document.querySelector(`.bingo-cell[data-index="${oldCellIndex}"]`);
    if (oldEl) {
      oldEl.classList.remove('marked', 'selected');
    }
  }

  // Mark new cell
  marks[newCellIndex] = { marked: true, correct: marks[newCellIndex].correct };
  currentRoundCell = newCellIndex;

  const newEl = document.querySelector(`.bingo-cell[data-index="${newCellIndex}"]`);
  if (newEl) {
    newEl.classList.add('marked', 'selected', 'just-marked');
    setTimeout(() => newEl.classList.remove('just-marked'), 400);
  }

  updateCellStates();
});

socket.on('you-got-bingo', () => {
  hasBingo = true;
  document.getElementById('bingo-banner').classList.add('visible');
  launchConfetti();
});

socket.on('answer-revealed', ({ correctCellIndex, selectedCellIndex, wasCorrect, correctAnswer }) => {
  currentQuestionIndex = null;
  currentRoundCell = null;
  clearTimer();

  // Flash the correct cell green
  if (correctCellIndex >= 0) {
    const correctEl = document.querySelector(`.bingo-cell[data-index="${correctCellIndex}"]`);
    if (correctEl) {
      correctEl.classList.add('reveal-correct');
      setTimeout(() => correctEl.classList.remove('reveal-correct'), 3000);
    }
  }

  // Flash the selected cell red if wrong
  if (selectedCellIndex !== null && !wasCorrect) {
    const wrongEl = document.querySelector(`.bingo-cell[data-index="${selectedCellIndex}"]`);
    if (wrongEl) {
      wrongEl.classList.add('reveal-wrong');
      setTimeout(() => wrongEl.classList.remove('reveal-wrong'), 3000);
    }
  }

  // Remove pulsing selection state
  document.querySelectorAll('.bingo-cell.selected').forEach(el => el.classList.remove('selected'));
  updateCellStates();

  // Update question box
  const box = document.getElementById('question-box');
  box.innerHTML = `<div class="cq-text" style="color: var(--wasabi);">Rätt svar: ${esc(correctAnswer)}</div>`;
  setTimeout(() => {
    box.innerHTML = '<div class="cq-waiting">Väntar på nästa fråga...</div>';
  }, 4000);
});

socket.on('review-question-student', (data) => {
  // Show review overlay
  const overlay = document.getElementById('review-overlay');
  overlay.classList.remove('hidden');

  document.getElementById('review-num').textContent = data.reviewIndex + 1;
  document.getElementById('review-total').textContent = data.totalQuestions;
  document.getElementById('review-q').textContent = data.question;

  const resultEl = document.getElementById('review-result');
  const myAnswerEl = document.getElementById('review-my-answer');

  if (data.myAnswer === null) {
    resultEl.className = 'review-result no-answer';
    resultEl.textContent = 'Du svarade inte';
    myAnswerEl.textContent = '';
  } else if (data.wasCorrect) {
    resultEl.className = 'review-result correct';
    resultEl.textContent = 'Rätt!';
    myAnswerEl.textContent = `Ditt svar: ${data.myAnswer}`;
  } else {
    resultEl.className = 'review-result wrong';
    resultEl.textContent = 'Fel';
    myAnswerEl.innerHTML = `Ditt svar: ${esc(data.myAnswer)}<br>Rätt svar: <strong>${esc(data.correctAnswer)}</strong>`;
  }

  // Highlight cells on board
  document.querySelectorAll('.bingo-cell.review-correct, .bingo-cell.review-wrong').forEach(el => {
    el.classList.remove('review-correct', 'review-wrong');
  });

  if (data.correctCellIndex >= 0) {
    const correctEl = document.querySelector(`.bingo-cell[data-index="${data.correctCellIndex}"]`);
    if (correctEl) correctEl.classList.add('review-correct');
  }
  if (data.myCellIndex !== null && !data.wasCorrect) {
    const wrongEl = document.querySelector(`.bingo-cell[data-index="${data.myCellIndex}"]`);
    if (wrongEl) wrongEl.classList.add('review-wrong');
  }
});

socket.on('review-ended', () => {
  const overlay = document.getElementById('review-overlay');
  const resultEl = document.getElementById('review-result');
  resultEl.className = 'review-result';
  resultEl.textContent = 'Genomgången är klar!';
  document.getElementById('review-q').textContent = '';
  document.getElementById('review-my-answer').textContent = '';

  document.querySelectorAll('.bingo-cell.review-correct, .bingo-cell.review-wrong').forEach(el => {
    el.classList.remove('review-correct', 'review-wrong');
  });

  setTimeout(() => overlay.classList.add('hidden'), 3000);
});

socket.on('answer-too-late', () => {
  showToast('Tiden har gått ut!', 'error');
});

socket.on('game-ended', ({ title }) => {
  currentQuestionIndex = null;
  currentRoundCell = null;
  clearTimer();
  const box = document.getElementById('question-box');
  box.innerHTML = '<div class="cq-text">Spelet är avslutat! Tack för att du deltog.</div>';
  document.querySelectorAll('.bingo-cell').forEach(el => {
    el.classList.remove('selected', 'clickable');
    el.classList.add('disabled');
  });
});

// ---------------------------------------------------------------------------
// Confetti celebration
// ---------------------------------------------------------------------------
function launchConfetti() {
  const canvas = document.createElement('canvas');
  canvas.className = 'confetti-canvas';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const colors = ['#34d399', '#38bdf8', '#ffb830', '#ff5c7c', '#a78bfa', '#fff'];
  const pieces = [];

  for (let i = 0; i < 150; i++) {
    pieces.push({
      x: Math.random() * canvas.width,
      y: Math.random() * canvas.height - canvas.height,
      w: Math.random() * 10 + 4,
      h: Math.random() * 6 + 2,
      color: colors[Math.floor(Math.random() * colors.length)],
      vx: (Math.random() - 0.5) * 4,
      vy: Math.random() * 4 + 2,
      rot: Math.random() * Math.PI * 2,
      rotSpeed: (Math.random() - 0.5) * 0.15,
      opacity: 1,
    });
  }

  let frame = 0;
  function animate() {
    frame++;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;
    pieces.forEach(p => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.rot += p.rotSpeed;
      if (frame > 120) p.opacity -= 0.015;

      if (p.opacity > 0 && p.y < canvas.height + 20) {
        alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, p.opacity);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
    });

    if (alive) {
      requestAnimationFrame(animate);
    } else {
      canvas.remove();
    }
  }
  requestAnimationFrame(animate);
}

// ---------------------------------------------------------------------------
// Render board
// ---------------------------------------------------------------------------
function renderBoard() {
  const container = document.getElementById('bingo-board');
  container.innerHTML = '';
  container.style.gridTemplateColumns = `repeat(${boardSize}, 1fr)`;

  board.forEach((cell, i) => {
    const div = document.createElement('div');
    div.className = 'bingo-cell';
    div.dataset.index = i;
    div.textContent = cell.answer;
    div.setAttribute('role', 'gridcell');
    div.setAttribute('aria-label', cell.answer);

    if (i === freeIdx) {
      div.classList.add('free');
      div.setAttribute('aria-pressed', 'true');
    } else if (marks[i] && marks[i].marked) {
      div.classList.add('marked');
      div.setAttribute('aria-pressed', 'true');
      if (i === currentRoundCell) {
        div.classList.add('selected');
      }
    } else {
      div.setAttribute('aria-pressed', 'false');
    }

    div.addEventListener('click', () => onCellClick(i));
    container.appendChild(div);
  });

  updateCellStates();
}

function isLockedCell(index) {
  // A cell is "locked" (from a previous round) if it's marked but NOT the current round's selection
  if (index === freeIdx) return true;
  if (!marks[index] || !marks[index].marked) return false;
  return index !== currentRoundCell;
}

function updateCellStates() {
  document.querySelectorAll('.bingo-cell').forEach(cell => {
    const i = parseInt(cell.dataset.index);
    cell.classList.remove('disabled', 'clickable');

    if (i === freeIdx) return;

    // Locked cells from previous rounds
    if (isLockedCell(i)) return;

    // No active question
    if (currentQuestionIndex === null) {
      cell.classList.add('disabled');
      return;
    }

    // Current round selection — clickable (to allow switching to another)
    // Other unmarked cells — clickable
    cell.classList.add('clickable');
  });
}

function onCellClick(index) {
  if (index === freeIdx) return;
  if (currentQuestionIndex === null) return;
  if (timerExpired) return;
  if (isLockedCell(index)) return;
  if (index === currentRoundCell) return; // already selected

  socket.emit('submit-answer', { code, playerId, cellIndex: index });
}

// ---------------------------------------------------------------------------
// Question display
// ---------------------------------------------------------------------------
function showQuestion(text) {
  const box = document.getElementById('question-box');
  box.innerHTML = `<div class="cq-text">${esc(text)}</div>`;
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
