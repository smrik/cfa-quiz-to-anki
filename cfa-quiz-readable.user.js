// ==UserScript==
// @name         CFA Quiz — Readable Text
// @namespace    patriksvault
// @version      1.0.0
// @description  Loosens the cramped line height on CFA practice-quiz questions and caps the line length, so long ethics stems are readable.
// @author       Patrik
// @homepageURL  https://github.com/smrik/cfa-quiz-to-anki
// @supportURL   https://github.com/smrik/cfa-quiz-to-anki/issues
// @downloadURL  https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-readable.user.js
// @updateURL    https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-readable.user.js
// @match        https://*.insproserv.net/*
// @match        https://learn.cfainstitute.org/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addValueChangeListener
// @run-at       document-start
// ==/UserScript==

// Auto-update works the same way as cfa-quiz-to-anki.user.js: the @version
// MUST be bumped or Tampermonkey ignores the push.
//   ./bump.ps1 -File cfa-quiz-readable.user.js

/*
 * The quiz renders inside an LTI iframe (insproserv.net) embedded in Canvas,
 * so this runs in both origins. Same anchors as the Anki script, because the
 * emotion classnames (css-xxxxxx) are content hashes that change per deploy:
 *
 *   [data-quiz-question-id]   one per question
 *   .user_content             wrapper around real prose: the stem, each
 *                             option, the explanation
 *
 * WHAT IT CHANGES
 *   line height   the page ships roughly 1.15; default here is 1.6
 *   line length   stems run ~125 characters per line on a wide monitor;
 *                 capped at 80ch. Anything holding a table or image is left
 *                 full width so exhibits are not squeezed.
 *   paragraphs    a gap between paragraphs in multi-paragraph stems
 *
 * CONTROLS (click inside the question first so the quiz frame has focus)
 *   Alt+Shift+Up / Down   line height +/- 0.05
 *   Alt+Shift+W           cycle line length: 80ch, 95ch, 65ch, off
 *   Alt+Shift+R           toggle the whole thing on/off
 * The same actions are in the Tampermonkey menu. Settings persist and are
 * shared between the Canvas page and the quiz frame.
 */

(function () {
  'use strict';

  const DEFAULTS = { enabled: true, lineHeight: 1.6, maxWidth: 80 };
  const WIDTHS = [80, 95, 65, 0];          // 0 = no cap
  const LH_MIN = 1.1, LH_MAX = 2.4, LH_STEP = 0.05;
  const STYLE_ID = 'cfa-readable-style';

  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
  const get = (k) => {
    try {
      if (hasGM) return GM_getValue(k, DEFAULTS[k]);
      const raw = localStorage.getItem('cfa-readable-' + k);
      return raw == null ? DEFAULTS[k] : JSON.parse(raw);
    } catch (e) { return DEFAULTS[k]; }
  };
  const set = (k, v) => {
    try {
      if (hasGM) GM_setValue(k, v);
      else localStorage.setItem('cfa-readable-' + k, JSON.stringify(v));
    } catch (e) { /* storage blocked: the change still applies this session */ }
  };

  const state = {
    enabled: !!get('enabled'),
    lineHeight: Number(get('lineHeight')) || DEFAULTS.lineHeight,
    maxWidth: Number(get('maxWidth')),
  };
  if (!Number.isFinite(state.maxWidth) || state.maxWidth < 0) state.maxWidth = DEFAULTS.maxWidth;

  // Canvas itself uses .user_content on ordinary course pages. Only restyle
  // those inside a quiz question there; inside the quiz frame every
  // .user_content is quiz prose, so take all of them.
  const inQuizFrame = /(^|\.)insproserv\.net$/i.test(location.hostname);
  const Q = '[data-quiz-question-id]';
  const UC = inQuizFrame ? '.user_content' : Q + ' .user_content';

  // MathJax sizes its own boxes; never touch anything inside it.
  const NOT_MATH = ':not(:where(mjx-container, .MathJax, .MathJax_SVG, .MathJax_Display, svg, math) *)';
  const TEXT_TAGS = 'p, div, span, li, td, th, label, strong, em, b, i, u, a, blockquote';

  function css() {
    const lh = state.lineHeight.toFixed(2);
    let out =
      `${Q}, ${UC} { line-height: ${lh} !important; }\n` +
      // Children often carry their own tight line-height; make them follow.
      `${UC} :where(${TEXT_TAGS})${NOT_MATH} { line-height: inherit !important; }\n` +
      `${UC} p:not(:last-child) { margin-bottom: 0.7em !important; }\n` +
      `${UC} li:not(:last-child) { margin-bottom: 0.3em !important; }\n`;
    if (state.maxWidth > 0) {
      out += `${UC}:not(:has(table, img, pre)) { max-width: ${state.maxWidth}ch !important; }\n`;
    }
    return out;
  }

  function render() {
    let el = document.getElementById(STYLE_ID);
    if (!state.enabled) { if (el) el.remove(); return; }
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      // document-start: <head> may not exist yet.
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css();
  }

  // ---------- feedback ----------
  let toastEl, toastTimer;
  function toast(msg) {
    if (!document.body) return;
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;top:16px;transform:translateX(-50%);' +
        'z-index:2147483647;background:#1f2430;color:#e6e6e6;font:13px/1.4 system-ui,sans-serif;' +
        'padding:6px 12px;border-radius:6px;box-shadow:0 4px 16px rgba(0,0,0,.35);' +
        'pointer-events:none;transition:opacity .2s';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.opacity = '0'; }, 1200);
  }

  const describe = () => (state.enabled
    ? `line height ${state.lineHeight.toFixed(2)} · width ${state.maxWidth ? state.maxWidth + 'ch' : 'full'}`
    : 'readable text off');

  function update(key, value) {
    state[key] = value;
    set(key, value);
    render();
    toast(describe());
  }

  // ---------- actions ----------
  const clamp = (v) => Math.min(LH_MAX, Math.max(LH_MIN, Math.round(v * 100) / 100));
  const nudge = (d) => update('lineHeight', clamp(state.lineHeight + d));
  const cycleWidth = () => {
    const i = WIDTHS.indexOf(state.maxWidth);
    update('maxWidth', WIDTHS[(i + 1) % WIDTHS.length]);
  };
  const toggle = () => update('enabled', !state.enabled);
  const reset = () => {
    Object.keys(DEFAULTS).forEach((k) => { state[k] = DEFAULTS[k]; set(k, DEFAULTS[k]); });
    render();
    toast(describe());
  };

  document.addEventListener('keydown', (e) => {
    if (!e.altKey || !e.shiftKey || e.ctrlKey || e.metaKey) return;
    let fn = null;
    if (e.code === 'ArrowUp') fn = () => nudge(LH_STEP);
    else if (e.code === 'ArrowDown') fn = () => nudge(-LH_STEP);
    else if (e.code === 'KeyW') fn = cycleWidth;
    else if (e.code === 'KeyR') fn = toggle;
    if (!fn) return;
    e.preventDefault();
    e.stopPropagation();
    fn();
  }, true);

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Toggle readable text (Alt+Shift+R)', toggle);
    GM_registerMenuCommand('Looser lines (Alt+Shift+Up)', () => nudge(LH_STEP));
    GM_registerMenuCommand('Tighter lines (Alt+Shift+Down)', () => nudge(-LH_STEP));
    GM_registerMenuCommand('Cycle line length (Alt+Shift+W)', cycleWidth);
    GM_registerMenuCommand('Reset to defaults', reset);
  }

  // A change made in one frame (or tab) should reach the others.
  if (typeof GM_addValueChangeListener === 'function') {
    Object.keys(DEFAULTS).forEach((k) => {
      GM_addValueChangeListener(k, (name, oldV, newV, remote) => {
        if (!remote) return;
        state[k] = newV;
        render();
      });
    });
  }

  render();
})();
