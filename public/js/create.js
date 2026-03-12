/* create.js — Teacher creates a quiz (with question pool support) */

// ---------------------------------------------------------------------------
// PIN gate
// ---------------------------------------------------------------------------
let verifiedPin = sessionStorage.getItem('bq_teacher_pin') || '';

(async function checkPinGate() {
  try {
    const res = await fetch('/api/auth/status');
    const { pinRequired } = await res.json();

    if (!pinRequired) {
      // No PIN configured — show create form directly
      document.getElementById('create-section').classList.remove('hidden');
      return;
    }

    // If we have a stored PIN, verify it
    if (verifiedPin) {
      const check = await fetch('/api/auth/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: verifiedPin }),
      });
      if (check.ok) {
        document.getElementById('create-section').classList.remove('hidden');
        return;
      }
      sessionStorage.removeItem('bq_teacher_pin');
      verifiedPin = '';
    }

    // Show PIN gate
    document.getElementById('pin-gate').classList.remove('hidden');

    document.getElementById('pin-submit').addEventListener('click', submitPin);
    document.getElementById('pin-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitPin();
    });
  } catch {
    // Can't reach server — show form anyway, server will reject on create
    document.getElementById('create-section').classList.remove('hidden');
  }
})();

async function submitPin() {
  const pin = document.getElementById('pin-input').value.trim();
  if (!pin) { showToast('Ange en lärarkod.', 'error'); return; }

  try {
    const res = await fetch('/api/auth/verify-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin }),
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(data.error || 'Fel kod.', 'error');
      return;
    }
    verifiedPin = pin;
    sessionStorage.setItem('bq_teacher_pin', pin);
    document.getElementById('pin-gate').classList.add('hidden');
    document.getElementById('create-section').classList.remove('hidden');
  } catch {
    showToast('Kunde inte ansluta till servern.', 'error');
  }
}

// ---------------------------------------------------------------------------

const termsContainer = document.getElementById('terms-container');
const termCount = document.getElementById('term-count');

let boardSize = 5;
let currentPoolId = '';        // '' = custom mode
let poolQuestions = [];        // all questions from active pool
let usedPoolIndices = new Set(); // indices currently in the form

const sizeConfig = {
  3: { cells: 9,  hasFree: true,  minTerms: 8  },
  4: { cells: 16, hasFree: false, minTerms: 16 },
  5: { cells: 25, hasFree: true,  minTerms: 24 },
};

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

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------------------------------------------------------------------------
// Row management
// ---------------------------------------------------------------------------
function createRow(question = '', answer = '', poolIndex = null) {
  const row = document.createElement('div');
  row.className = 'term-row';
  if (poolIndex !== null) row.dataset.poolIndex = poolIndex;

  const num = termsContainer.children.length + 1;
  const swapBtn = poolIndex !== null
    ? `<button class="btn btn-swap swap-btn" title="Byt ut fråga" aria-label="Byt ut fråga ${num}">&#8635;</button>`
    : `<span></span>`;

  row.innerHTML = `
    <span class="row-num">${num}</span>
    <input type="text" class="q-input" placeholder="Fråga..." value="${escapeHtml(question)}">
    <input type="text" class="a-input" placeholder="Svar / term..." value="${escapeHtml(answer)}">
    <button class="btn btn-icon remove-row" title="Ta bort" aria-label="Ta bort rad ${num}">&times;</button>
    ${swapBtn}
  `;

  row.querySelector('.remove-row').addEventListener('click', () => {
    if (row.dataset.poolIndex !== undefined) {
      usedPoolIndices.delete(parseInt(row.dataset.poolIndex));
    }
    row.remove();
    renumber();
    updateCount();
  });

  const swapEl = row.querySelector('.swap-btn');
  if (swapEl) {
    swapEl.addEventListener('click', () => replacePoolQuestion(row));
  }

  termsContainer.appendChild(row);
  updateCount();
  return row;
}

function renumber() {
  [...termsContainer.children].forEach((row, i) => {
    row.querySelector('.row-num').textContent = i + 1;
  });
}

function updateCount() {
  let filled = 0;
  termsContainer.querySelectorAll('.term-row').forEach(r => {
    const q = r.querySelector('.q-input').value.trim();
    const a = r.querySelector('.a-input').value.trim();
    if (q && a) filled++;
  });
  const min = sizeConfig[boardSize].minTerms;
  termCount.textContent = `${filled} / minst ${min} frågor`;
}

function updateMinInfo() {
  const cfg = sizeConfig[boardSize];
  document.getElementById('min-info').textContent =
    `Ange minst ${cfg.minTerms} frågor med tillhörande svar (termer som visas på ${boardSize}\u00d7${boardSize}-brickan).`;
}

function getTerms() {
  const terms = [];
  termsContainer.querySelectorAll('.term-row').forEach((row, i) => {
    const q = row.querySelector('.q-input').value.trim();
    const a = row.querySelector('.a-input').value.trim();
    if (q && a) terms.push({ id: `t${i}`, question: q, answer: a });
  });
  return terms;
}

// ---------------------------------------------------------------------------
// Pool logic
// ---------------------------------------------------------------------------
async function loadPools() {
  try {
    const res = await fetch('/api/pools');
    const pools = await res.json();
    const picker = document.getElementById('pool-picker');

    pools.forEach(p => {
      const btn = document.createElement('button');
      btn.className = 'btn pool-option';
      btn.dataset.pool = p.id;
      btn.innerHTML = `${p.name}<span class="pool-count">${p.description} &mdash; ${p.count} frågor</span>`;
      picker.appendChild(btn);
    });

    // Wire up click handlers for all pool buttons (including "Egna frågor")
    picker.querySelectorAll('.pool-option').forEach(btn => {
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-checked', btn.classList.contains('active') ? 'true' : 'false');
      btn.addEventListener('click', () => {
        picker.querySelectorAll('.pool-option').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
        btn.classList.add('active');
        btn.setAttribute('aria-checked', 'true');
        selectPool(btn.dataset.pool);
      });
    });
  } catch {
    // Pools couldn't load — custom mode only
  }
}

async function selectPool(poolId) {
  currentPoolId = poolId;
  poolQuestions = [];
  usedPoolIndices = new Set();

  if (!poolId) {
    // Custom mode
    document.getElementById('pool-actions').classList.add('hidden');
    clearAllRows();
    const n = sizeConfig[boardSize].minTerms + 1;
    for (let i = 0; i < n; i++) createRow();
    return;
  }

  try {
    const res = await fetch(`/api/pools/${poolId}`);
    const pool = await res.json();
    poolQuestions = pool.questions;

    document.getElementById('quiz-title').value = pool.name + ' — ' + pool.description;
    document.getElementById('pool-info').textContent = `${pool.questions.length} frågor i poolen`;
    document.getElementById('pool-actions').classList.remove('hidden');

    fillFromPool();
  } catch {
    showToast('Kunde inte ladda frågebanken.', 'error');
  }
}

function fillFromPool() {
  clearAllRows();
  usedPoolIndices = new Set();

  const needed = sizeConfig[boardSize].minTerms;
  const indices = shuffleArray(poolQuestions.map((_, i) => i)).slice(0, needed);

  indices.forEach(idx => {
    usedPoolIndices.add(idx);
    const q = poolQuestions[idx];
    createRow(q.question, q.answer, idx);
  });
}

function clearAllRows() {
  termsContainer.innerHTML = '';
}

function replacePoolQuestion(row) {
  const currentIdx = parseInt(row.dataset.poolIndex);
  const currentAnswers = new Set();
  termsContainer.querySelectorAll('.term-row').forEach(r => {
    const a = r.querySelector('.a-input').value.trim().toLowerCase();
    if (a) currentAnswers.add(a);
  });

  // Find an unused pool question whose answer isn't already in use
  const available = [];
  poolQuestions.forEach((q, i) => {
    if (!usedPoolIndices.has(i) && !currentAnswers.has(q.answer.toLowerCase())) {
      available.push(i);
    }
  });

  if (available.length === 0) {
    showToast('Alla frågor i poolen är redan använda.', 'error');
    return;
  }

  const newIdx = available[Math.floor(Math.random() * available.length)];
  const newQ = poolQuestions[newIdx];

  usedPoolIndices.delete(currentIdx);
  usedPoolIndices.add(newIdx);

  row.dataset.poolIndex = newIdx;
  row.querySelector('.q-input').value = newQ.question;
  row.querySelector('.a-input').value = newQ.answer;
  row.classList.add('just-swapped');
  setTimeout(() => row.classList.remove('just-swapped'), 600);
  updateCount();
}

// ---------------------------------------------------------------------------
// Size picker
// ---------------------------------------------------------------------------
document.querySelectorAll('.size-option').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.size-option').forEach(b => { b.classList.remove('active'); b.setAttribute('aria-checked', 'false'); });
    btn.classList.add('active');
    btn.setAttribute('aria-checked', 'true');
    boardSize = parseInt(btn.dataset.size);
    updateMinInfo();

    // If pool is active, re-fill with correct count
    if (currentPoolId) {
      fillFromPool();
    }
    updateCount();
  });
});

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
const defaultRows = sizeConfig[boardSize].minTerms + 1;
for (let i = 0; i < defaultRows; i++) createRow();
termsContainer.addEventListener('input', updateCount);
updateMinInfo();
loadPools();

// Add row
document.getElementById('add-row-btn').addEventListener('click', () => {
  const row = createRow();
  row.querySelector('.q-input').focus();
});

// Shuffle all (pool mode)
document.getElementById('shuffle-all-btn').addEventListener('click', () => {
  if (currentPoolId) fillFromPool();
});

// Bulk import toggle
document.getElementById('toggle-bulk-btn').addEventListener('click', () => {
  document.getElementById('bulk-area').classList.toggle('hidden');
});

// Parse bulk input
document.getElementById('parse-bulk-btn').addEventListener('click', () => {
  const text = document.getElementById('bulk-input').value.trim();
  if (!text) return;

  const lines = text.split('\n').filter(l => l.trim());
  let added = 0;
  for (const line of lines) {
    let parts = line.split('\t');
    if (parts.length < 2) parts = line.split(';');
    if (parts.length >= 2) {
      const q = parts[0].trim();
      const a = parts[1].trim();
      if (q && a) { createRow(q, a); added++; }
    }
  }
  showToast(`${added} frågor importerade.`, 'success');
  document.getElementById('bulk-input').value = '';
  document.getElementById('bulk-area').classList.add('hidden');
});

// Create game
document.getElementById('create-btn').addEventListener('click', async () => {
  const title = document.getElementById('quiz-title').value.trim() || 'BingoQuiz';
  const terms = getTerms();
  const min = sizeConfig[boardSize].minTerms;

  if (terms.length < min) {
    showToast(`Du behöver minst ${min} ifyllda frågor för ${boardSize}\u00d7${boardSize}. Du har ${terms.length}.`, 'error');
    return;
  }

  const answers = terms.map(t => t.answer.toLowerCase());
  const dupes = answers.filter((a, i) => answers.indexOf(a) !== i);
  if (dupes.length > 0) {
    showToast(`Dubbletter bland svaren: "${dupes[0]}". Varje svar måste vara unikt.`, 'error');
    return;
  }

  const btn = document.getElementById('create-btn');
  btn.disabled = true;

  try {
    const res = await fetch('/api/games', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, terms, boardSize, pin: verifiedPin }),
    });
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Något gick fel.', 'error');
      btn.disabled = false;
      return;
    }
    window.location.href = `/teacher.html?code=${data.code}`;
  } catch {
    showToast('Kunde inte ansluta till servern.', 'error');
    btn.disabled = false;
  }
});
