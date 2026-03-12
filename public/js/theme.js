/* theme.js — Theme toggle + accessibility mode (loaded on all pages) */

(function () {
  const root = document.documentElement;

  // --- Read persisted state ---
  function getTheme() {
    return localStorage.getItem('bq_theme') || 'dark';
  }
  function getA11y() {
    return localStorage.getItem('bq_a11y') === 'true';
  }

  function applyTheme(theme) {
    root.setAttribute('data-theme', theme);
    localStorage.setItem('bq_theme', theme);
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.textContent = theme === 'light' ? '\u2600' : '\u263E';
    if (btn) btn.setAttribute('aria-label', theme === 'light' ? 'Byt till mörkt läge' : 'Byt till ljust läge');
  }

  function applyA11y(on) {
    if (on) {
      root.setAttribute('data-a11y', 'true');
    } else {
      root.removeAttribute('data-a11y');
    }
    localStorage.setItem('bq_a11y', on ? 'true' : 'false');
    const btn = document.getElementById('a11y-toggle');
    if (btn) btn.classList.toggle('active', on);
    if (btn) btn.setAttribute('aria-label', on ? 'Stäng av tillgänglighetsläge' : 'Aktivera tillgänglighetsläge');
  }

  // --- Inject FAB ---
  function injectFAB() {
    const fab = document.createElement('div');
    fab.className = 'settings-fab';
    fab.setAttribute('role', 'group');
    fab.setAttribute('aria-label', 'Inställningar');

    const themeBtn = document.createElement('button');
    themeBtn.className = 'fab-btn';
    themeBtn.id = 'theme-toggle';
    themeBtn.type = 'button';

    const a11yBtn = document.createElement('button');
    a11yBtn.className = 'fab-btn';
    a11yBtn.id = 'a11y-toggle';
    a11yBtn.type = 'button';
    a11yBtn.textContent = 'Aa';
    a11yBtn.style.fontSize = '0.75rem';
    a11yBtn.style.fontWeight = '700';

    fab.appendChild(a11yBtn);
    fab.appendChild(themeBtn);
    document.body.appendChild(fab);

    // Apply current state to buttons
    applyTheme(getTheme());
    applyA11y(getA11y());

    // Event listeners
    themeBtn.addEventListener('click', () => {
      const next = getTheme() === 'dark' ? 'light' : 'dark';
      applyTheme(next);
    });

    a11yBtn.addEventListener('click', () => {
      const next = !getA11y();
      applyA11y(next);
    });
  }

  // Inject when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectFAB);
  } else {
    injectFAB();
  }
})();
