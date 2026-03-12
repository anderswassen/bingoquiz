/* teacher.js — Teacher dashboard */

const socket = io();
const code = new URLSearchParams(window.location.search).get('code');

if (!code) window.location.href = '/';

let gameState = null;
let boardSize = 5;
let freeIdx = -1;
const students = new Map();

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
// Connect & get state
// ---------------------------------------------------------------------------
socket.emit('teacher-join', { code });

socket.on('error-msg', ({ message }) => {
  showToast(message, 'error');
  setTimeout(() => window.location.href = '/', 2000);
});

socket.on('game-state', (state) => {
  gameState = state;
  boardSize = state.boardSize || 5;
  freeIdx = calcFreeIndex(boardSize);
  document.getElementById('game-title').textContent = state.title;
  document.getElementById('game-subtitle').textContent = `Läxförhör \u2014 ${boardSize}\u00d7${boardSize}`;
  document.getElementById('game-code').textContent = code;

  // Render everything
  renderQuestions();
  state.students.forEach(s => students.set(s.id, s));
  renderStudents();
  renderHesitations(state.hesitations || {});
});

// ---------------------------------------------------------------------------
// Render questions
// ---------------------------------------------------------------------------
function renderQuestions() {
  const list = document.getElementById('question-list');
  list.innerHTML = '';

  gameState.terms.forEach((term, i) => {
    const asked = gameState.askedQuestions.includes(i);
    const active = gameState.currentQuestionIndex === i;

    const li = document.createElement('li');
    li.className = `question-item${asked && !active ? ' asked' : ''}${active ? ' active' : ''}`;
    li.innerHTML = `
      <span class="q-num">${i + 1}</span>
      <span class="q-text">${esc(term.question)}</span>
      <span class="q-answer">${esc(term.answer)}</span>
      <button class="btn btn-primary ask-btn" data-index="${i}" ${asked ? 'disabled' : ''}>
        ${active ? 'Aktiv' : 'Ställ fråga'}
      </button>
    `;
    list.appendChild(li);
  });

  // Ask buttons
  list.querySelectorAll('.ask-btn:not([disabled])').forEach(btn => {
    btn.addEventListener('click', () => {
      const qi = parseInt(btn.dataset.index);
      socket.emit('ask-question', { code, questionIndex: qi });
    });
  });

  updateQuestionsProgress();
}

function updateQuestionsProgress() {
  const asked = gameState.askedQuestions.length;
  const total = gameState.terms.length;
  document.getElementById('questions-progress').textContent = `${asked} / ${total} ställda`;
}

// ---------------------------------------------------------------------------
// Render students
// ---------------------------------------------------------------------------
function renderStudents() {
  const list = document.getElementById('student-list');
  const noStudents = document.getElementById('no-students');

  if (students.size === 0) {
    noStudents.classList.remove('hidden');
    list.innerHTML = '';
  } else {
    noStudents.classList.add('hidden');
    list.innerHTML = '';

    students.forEach((s) => {
      const correct = s.correctCount || 0;
      const wrong = s.wrongCount || 0;
      const streak = s.bestStreak || 0;
      const li = document.createElement('li');
      li.className = `student-item${s.hasBingo ? ' has-bingo' : ''}`;
      li.innerHTML = `
        <span class="s-name ${s.connected ? '' : 'disconnected'}">${esc(s.name)}${!s.connected ? ' (frånkopplad)' : ''}</span>
        <span class="streak-indicator" title="Närmast bingo: ${streak}/${boardSize}">
          <span class="streak-bar"><span class="streak-fill" style="width: ${(streak / boardSize) * 100}%"></span></span>
          <span class="streak-label">${streak}/${boardSize}</span>
        </span>
        <span class="badge badge-green">${correct} rätt</span>
        <span class="badge badge-red">${wrong} fel</span>
        ${s.hasBingo ? '<span class="badge badge-amber">BINGO</span>' : ''}
      `;
      li.addEventListener('click', () => openStudentModal(s.id));
      list.appendChild(li);
    });
  }

  document.getElementById('student-count-badge').textContent = `${students.size} anslutna`;
  document.getElementById('aq-student-count').textContent = students.size;
}

// ---------------------------------------------------------------------------
// Student detail modal
// ---------------------------------------------------------------------------
function openStudentModal(studentId) {
  const s = students.get(studentId);
  if (!s) return;

  document.getElementById('modal-student-name').textContent = s.name;
  document.getElementById('modal-correct').textContent = `${s.correctCount || 0} rätt`;
  document.getElementById('modal-wrong').textContent = `${s.wrongCount || 0} fel`;
  document.getElementById('modal-bingo-status').textContent = s.hasBingo ? 'BINGO!' : 'Ingen bingo';

  const boardEl = document.getElementById('modal-board');
  boardEl.innerHTML = '';
  boardEl.style.gridTemplateColumns = `repeat(${boardSize}, 1fr)`;

  (s.board || []).forEach((cell, i) => {
    const mark = s.marks[i];
    const div = document.createElement('div');
    let cls = 'mini-cell';
    if (i === freeIdx) cls += ' free';
    else if (mark.marked && mark.correct) cls += ' correct';
    else if (mark.marked && !mark.correct) cls += ' wrong';
    div.className = cls;
    div.textContent = cell.answer || cell;
    boardEl.appendChild(div);
  });

  document.getElementById('student-modal').classList.add('visible');
}

document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('student-modal').classList.remove('visible');
});
document.getElementById('student-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) {
    e.currentTarget.classList.remove('visible');
  }
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------
socket.on('student-joined', (s) => {
  students.set(s.id, s);
  renderStudents();
  showToast(`${s.name} har anslutit.`, 'success');
});

socket.on('student-reconnected', ({ id }) => {
  const s = students.get(id);
  if (s) s.connected = true;
  renderStudents();
});

socket.on('student-disconnected', ({ id }) => {
  const s = students.get(id);
  if (s) s.connected = false;
  renderStudents();
});

socket.on('question-active', ({ questionIndex, answer }) => {
  gameState.currentQuestionIndex = questionIndex;
  if (!gameState.askedQuestions.includes(questionIndex)) {
    gameState.askedQuestions.push(questionIndex);
  }
  renderQuestions();

  // Show banner (reset reveal state)
  const banner = document.getElementById('aq-banner');
  banner.classList.add('visible');
  banner.classList.remove('revealed');
  document.getElementById('aq-question').textContent = gameState.terms[questionIndex].question;
  document.getElementById('aq-answer').textContent = answer;
  document.getElementById('aq-response-count').textContent = '0';
  document.getElementById('reveal-btn').disabled = false;
  document.getElementById('reveal-btn').textContent = 'Visa svaret';
});

socket.on('student-update', (data) => {
  const s = students.get(data.id);
  if (!s) return;
  s.marks = data.marks;
  s.hasBingo = data.hasBingo;
  s.correctCount = data.correctCount;
  s.wrongCount = data.wrongCount;
  s.bestStreak = data.bestStreak;

  renderStudents();

  // Update hesitations if included
  if (data.hesitations) {
    renderHesitations(data.hesitations);
  }

  // Update response count (count unique students who have answered this round)
  if (gameState.currentQuestionIndex !== null) {
    let responded = 0;
    students.forEach(st => {
      // A student has responded if they have any mark that wasn't there before
      // Simple heuristic: count from the update
      const totalMarked = st.marks.filter(m => m.marked).length;
      const freeCount = freeIdx >= 0 ? 1 : 0;
      if (totalMarked > freeCount) responded++;
    });
    // This overcounts — use a simpler approach: track per question
    // For now, just increment
    const el = document.getElementById('aq-response-count');
    const prev = parseInt(el.textContent || '0');
    // Only increment if this is a new answer (not a change)
    if (!data.lastAnswer) return;
    el.textContent = Math.min(students.size, prev + 1);
  }
});

socket.on('student-bingo', ({ id, name }) => {
  const log = document.getElementById('bingo-log');
  if (log.textContent === 'Ingen bingo än.') log.innerHTML = '';

  const s = students.get(id);
  const correct = s ? s.correctCount || 0 : '?';
  const wrong = s ? s.wrongCount || 0 : '?';

  const entry = document.createElement('div');
  entry.className = 'gap-row mb-1';
  entry.innerHTML = `
    <span class="badge badge-amber">BINGO</span>
    <strong>${esc(name)}</strong>
    <span class="badge badge-green">${correct} rätt</span>
    <span class="badge badge-red">${wrong} fel</span>
    <span class="text-muted" style="font-size: 0.75rem;">${new Date().toLocaleTimeString('sv-SE')}</span>
  `;
  log.appendChild(entry);

  showToast(`${name} ropar BINGO! (${correct} rätt, ${wrong} fel)`, 'success');
});

// ---------------------------------------------------------------------------
// Hesitations panel
// ---------------------------------------------------------------------------
function renderHesitations(hesitations) {
  const panel = document.getElementById('hesitation-panel');
  const entries = Object.entries(hesitations).sort((a, b) => b[1] - a[1]);

  if (entries.length === 0) {
    panel.innerHTML = '<span class="text-muted" style="font-size: 0.82rem;">Inga tveksamheter registrerade än.</span>';
    return;
  }

  // Resolve term IDs to answer text
  const termMap = {};
  if (gameState) {
    gameState.terms.forEach(t => { termMap[t.id] = t.answer; });
  }

  panel.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'hesitation-list';
  entries.forEach(([termId, count]) => {
    const item = document.createElement('span');
    item.className = 'hesitation-item';
    item.innerHTML = `${esc(termMap[termId] || termId)} <span class="h-count">${count}</span>`;
    list.appendChild(item);
  });
  panel.appendChild(list);
}

// ---------------------------------------------------------------------------
// Reveal correct answer
// ---------------------------------------------------------------------------
document.getElementById('reveal-btn').addEventListener('click', () => {
  if (gameState.currentQuestionIndex === null) return;
  socket.emit('reveal-answer', { code });
});

socket.on('answer-revealed-teacher', ({ questionIndex, correctAnswer }) => {
  const banner = document.getElementById('aq-banner');
  banner.classList.add('revealed');
  document.getElementById('reveal-btn').disabled = true;
  document.getElementById('reveal-btn').textContent = 'Visat';

  gameState.currentQuestionIndex = null;
  renderQuestions();
});

// ---------------------------------------------------------------------------
// End game & results
// ---------------------------------------------------------------------------
document.getElementById('end-game-btn').addEventListener('click', () => {
  if (!confirm('Vill du avsluta spelet och se resultaten?')) return;
  socket.emit('end-game', { code });
});

socket.on('game-results', (data) => {
  showResultsModal(data);
});

function showResultsModal(data) {
  const statsEl = document.getElementById('results-stats');
  statsEl.innerHTML = `
    <span class="badge badge-blue">${data.totalAsked} / ${data.totalQuestions} frågor ställda</span>
    <span class="badge badge-green">Snitt: ${data.avgCorrect} rätt</span>
    <span class="badge badge-purple">${data.results.length} elever</span>
  `;

  const rankEl = document.getElementById('results-ranking');
  rankEl.innerHTML = '';
  const table = document.createElement('table');
  table.className = 'results-table';
  table.innerHTML = `
    <thead><tr>
      <th>#</th><th>Namn</th><th>Rätt</th><th>Fel</th><th>Bingo</th><th>Streak</th>
    </tr></thead>
  `;
  const tbody = document.createElement('tbody');
  data.results.forEach((r, i) => {
    const tr = document.createElement('tr');
    tr.className = r.hasBingo ? 'bingo-row' : '';
    tr.innerHTML = `
      <td>${i + 1}</td>
      <td>${esc(r.name)}</td>
      <td>${r.correctCount}</td>
      <td>${r.wrongCount}</td>
      <td>${r.hasBingo ? 'Ja' : 'Nej'}</td>
      <td>${r.bestStreak}/${data.boardSize}</td>
    `;
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  rankEl.appendChild(table);

  const hardEl = document.getElementById('results-hard-terms');
  if (data.hardTerms.length > 0) {
    hardEl.innerHTML = '';
    const htList = document.createElement('div');
    htList.className = 'hesitation-list';
    data.hardTerms.forEach(t => {
      const item = document.createElement('span');
      item.className = 'hesitation-item';
      item.title = t.question;
      item.innerHTML = `${esc(t.answer)} <span class="h-count">${t.hesitations}</span>`;
      htList.appendChild(item);
    });
    hardEl.appendChild(htList);
  } else {
    hardEl.innerHTML = '<span class="text-muted">Inga svåra begrepp registrerade.</span>';
  }

  // Per-question stats
  renderQuestionStats(data.questionStats || []);

  // Store for CSV export
  window._lastResults = data;

  document.getElementById('results-modal').classList.add('visible');
}

// Per-question stats rendering
function renderQuestionStats(stats) {
  const el = document.getElementById('results-question-stats');
  if (!stats || stats.length === 0) {
    el.innerHTML = '<span class="text-muted" style="font-size: 0.82rem;">Inga frågor ställda.</span>';
    return;
  }
  el.innerHTML = '';
  stats.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'question-stat-row';
    const correctW = s.correctPct;
    const wrongW = s.totalStudents > 0 ? Math.round((s.wrongCount / s.totalStudents) * 100) : 0;
    const noW = 100 - correctW - wrongW;

    let distHtml = '';
    if (s.distractors.length > 0) {
      distHtml = '<div class="distractor-list">' +
        s.distractors.slice(0, 3).map(d =>
          `<span class="distractor-item">${esc(d.answer)} <span class="h-count">${d.count}</span></span>`
        ).join('') + '</div>';
    }

    row.innerHTML = `
      <div class="stat-header">
        <span class="stat-q-num">${i + 1}.</span>
        <span class="stat-q-text">${esc(s.question)}</span>
        <span class="stat-pct">${s.correctPct}%</span>
      </div>
      <div class="stat-bar">
        <div class="stat-bar-correct" style="width:${correctW}%" title="${s.correctCount} rätt"></div>
        <div class="stat-bar-wrong" style="width:${wrongW}%" title="${s.wrongCount} fel"></div>
        <div class="stat-bar-noans" style="width:${noW}%" title="${s.noAnswerCount} ej svarat"></div>
      </div>
      <div class="stat-detail">
        <span class="text-muted" style="font-size:0.7rem">Svar: ${esc(s.correctAnswer)}</span>
        ${distHtml}
      </div>
    `;
    el.appendChild(row);
  });
}

// ---------------------------------------------------------------------------
// Review phase
// ---------------------------------------------------------------------------
document.getElementById('start-review-btn').addEventListener('click', () => {
  if (!socket.connected) {
    showToast('Anslutningen till servern har tappats. Ladda om sidan.', 'error');
    return;
  }
  socket.emit('start-review', { code });
  document.getElementById('results-modal').classList.remove('visible');
  showToast('Startar genomgång...', 'info');
});

document.getElementById('review-next-btn').addEventListener('click', () => {
  socket.emit('review-next', { code });
});

socket.on('review-question', (data) => {
  const modal = document.getElementById('review-modal');
  modal.classList.add('visible');

  document.getElementById('review-progress').textContent = `${data.reviewIndex + 1} / ${data.totalQuestions}`;
  document.getElementById('review-q-text').textContent = data.question;
  document.getElementById('review-answer-text').textContent = data.correctAnswer;

  // Distribution bar
  const distEl = document.getElementById('review-dist');
  const correctW = data.correctPct;
  const wrongW = data.totalStudents > 0 ? Math.round((data.wrongCount / data.totalStudents) * 100) : 0;
  const noW = 100 - correctW - wrongW;
  distEl.innerHTML = `
    <div class="stat-bar" style="height:12px;border-radius:6px;">
      <div class="stat-bar-correct" style="width:${correctW}%"></div>
      <div class="stat-bar-wrong" style="width:${wrongW}%"></div>
      <div class="stat-bar-noans" style="width:${noW}%"></div>
    </div>
    <div class="gap-row mt-1" style="font-size:0.75rem;">
      <span style="color:var(--wasabi)">${data.correctCount} rätt (${correctW}%)</span>
      <span style="color:var(--hot)">${data.wrongCount} fel</span>
      <span style="color:var(--text-tertiary)">${data.noAnswerCount} ej svarat</span>
    </div>
  `;

  // Distractors
  const dEl = document.getElementById('review-distractors');
  if (data.distractors.length > 0) {
    dEl.innerHTML = '<span class="section-label" style="margin-bottom:0.4rem">Vanligaste felsvar</span><div class="hesitation-list">' +
      data.distractors.map(d =>
        `<span class="hesitation-item" style="border-color:var(--btn-danger-border);background:var(--badge-red-bg);color:var(--hot)">${esc(d.answer)} <span class="h-count">${d.count}</span></span>`
      ).join('') + '</div>';
  } else {
    dEl.innerHTML = '';
  }

  // Update button text
  const btn = document.getElementById('review-next-btn');
  if (data.reviewIndex >= data.totalQuestions - 1) {
    btn.textContent = 'Avsluta genomgång';
  } else {
    btn.textContent = 'Nästa fråga';
  }
});

socket.on('review-ended', () => {
  document.getElementById('review-modal').classList.remove('visible');
  showToast('Genomgången är klar!', 'success');
});

document.getElementById('review-modal').addEventListener('click', (e) => {
  // Don't allow closing by clicking outside during review — teacher must use Next
});

document.getElementById('results-close').addEventListener('click', () => {
  document.getElementById('results-modal').classList.remove('visible');
});
document.getElementById('results-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('visible');
});

// CSV export
document.getElementById('export-csv-btn').addEventListener('click', () => {
  const data = window._lastResults;
  if (!data) return;

  const rows = [['Plats', 'Namn', 'Rätt', 'Fel', 'Bingo', 'Streak']];
  data.results.forEach((r, i) => {
    rows.push([i + 1, r.name, r.correctCount, r.wrongCount, r.hasBingo ? 'Ja' : 'Nej', `${r.bestStreak}/${data.boardSize}`]);
  });

  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${data.title.replace(/[^a-zA-Z0-9åäöÅÄÖ ]/g, '_')}_resultat.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exporterad!', 'success');
});

// ---------------------------------------------------------------------------
function esc(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}
