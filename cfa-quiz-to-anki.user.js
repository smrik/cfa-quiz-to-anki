// ==UserScript==
// @name         CFA Quiz Review → Anki TSV
// @namespace    patriksvault
// @version      1.3.0
// @description  Extract CFA practice-quiz review questions into Anki-ready TSV for the "smrik - CFA MCQ" note type.
// @author       Patrik
// @homepageURL  https://github.com/smrik/cfa-quiz-to-anki
// @supportURL   https://github.com/smrik/cfa-quiz-to-anki/issues
// @downloadURL  https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-to-anki.user.js
// @updateURL    https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-to-anki.user.js
// @match        https://*.insproserv.net/*
// @match        https://learn.cfainstitute.org/*
// @grant        GM_setClipboard
// @run-at       document-idle
// ==/UserScript==

// Auto-update: Tampermonkey polls @updateURL, compares @version, and fetches
// @downloadURL when it is higher. THE VERSION MUST BE BUMPED OR NOTHING
// HAPPENS -- pushing new code under the same version is a silent no-op.
// Use ./bump.ps1, which bumps, commits and pushes in one step.

/*
 * The quiz lives inside an LTI iframe (insproserv.net) embedded in Canvas.
 * Userscripts run inside frames by default, so @match targets that origin.
 *
 * ANCHORS -- all semantic or Canvas-stable. The emotion classnames
 * (css-1q7flqv, css-fmkrvz ...) are content hashes that change on every
 * deploy, so nothing here depends on them.
 *
 *   [data-quiz-question-id]         one per question
 *   aria-label="Question N Review"  the question number
 *   .user_content                   Canvas's wrapper around ACTUAL prose --
 *                                   question text, each option, the
 *                                   explanation. Excludes screen-reader cues,
 *                                   so no fragile "strip the word Selected"
 *                                   regex (which used to eat the word
 *                                   "selected" out of real sentences).
 *   [class*="screenReaderContent"]  carries "Correct answer:" on the right
 *                                   option, and "Not Selected" on the others
 *   h3 "Feedback"                   heads the explanation block
 *   "N / N point"                   whether it was answered correctly
 *
 * DOM shape of one option:
 *   <div>                                  <-- option wrapper
 *     <div class="...screenReaderContent">Correct answer: </div>   (right one only)
 *     <div>                                <-- radioInput
 *       <input type="radio">
 *       <label><span><span>
 *         <div><div class="user_content">A. There is significant risk...</div></div>
 *         <span class="...screenReaderContent">Not Selected</span>
 */

(function () {
  'use strict';

  // MUST match the field order of the "smrik - CFA MCQ" note type EXACTLY.
  // Anki's importer maps columns by POSITION; a header row does not reorder
  // them. Topic is 7th in that note type, not 1st -- getting this wrong shifts
  // every field by one and the question shows up as option A.
  // Verify with: Tools > Manage Note Types > Fields.
  const FIELDS = ['Question', 'OptionA', 'OptionB', 'OptionC', 'CorrectAnswer', 'Explanation', 'Topic', 'Source'];
  const TOPIC_KEY = 'cfa-quiz-topic';

  // ---------- MathML → readable text ----------
  // MathJax renders to SVG, so textContent yields nothing. The source MathML
  // is preserved in data-mathml; turn it into something readable on a card.
  function mathmlToText(mathml) {
    let doc;
    try { doc = new DOMParser().parseFromString(mathml, 'text/xml'); } catch (e) { return ''; }
    if (!doc || !doc.documentElement || doc.querySelector('parsererror')) return '';
    const walk = (node) => {
      if (node.nodeType === 3) return node.nodeValue;
      const els = Array.from(node.children);
      const kids = () => Array.from(node.childNodes).map(walk).join('');
      switch (node.nodeName.toLowerCase()) {
        case 'msqrt': return '√(' + kids() + ')';
        case 'mfrac': return els.length === 2 ? '(' + walk(els[0]) + ')/(' + walk(els[1]) + ')' : kids();
        case 'msup': {
          if (els.length !== 2) return kids();
          const base = walk(els[0]), exp = walk(els[1]).trim();
          const sup = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
                        '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };
          return base + (sup[exp] || '^' + exp);
        }
        case 'msub': return els.length === 2 ? walk(els[0]) + '_' + walk(els[1]) : kids();
        case 'annotation': return '';
        default: return kids();
      }
    };
    return walk(doc.documentElement).replace(/\s+/g, ' ').trim();
  }

  function textOf(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    clone.querySelectorAll('[data-mathml]').forEach((m) => {
      const t = mathmlToText(m.getAttribute('data-mathml'));
      m.replaceWith(document.createTextNode(t ? ' ' + t + ' ' : ''));
    });
    clone.querySelectorAll('svg, script, style').forEach((n) => n.remove());
    // Block elements carry no whitespace of their own, so a question followed
    // by a data table flattened to "...variance is unknown.1020-8...". Give
    // every block boundary a space before collapsing to text.
    clone.querySelectorAll('p, div, li, tr, td, th, h1, h2, h3, h4, h5, h6')
      .forEach((n) => n.appendChild(document.createTextNode(' ')));
    return clone.textContent.replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
  }

  const isSR = (el) => el && /screenReaderContent/.test(el.className || '');

  // ---------- extraction ----------
  const FB_PREFIX = /^\s*(Correct|Incorrect)\s+Answer\s+Feedback\s*:\s*/i;

  // "N / N point" sits in a header ABOVE each question block, not inside it.
  function scoreBefore(block) {
    let n = block.previousElementSibling;
    for (let i = 0; i < 6 && n; i++, n = n.previousElementSibling) {
      const m = (n.textContent || '').match(/(\d+)\s*\/\s*(\d+)\s*point/i);
      if (m) return m[1] === m[2];
    }
    const p = block.parentElement;
    const m = p ? (p.textContent || '').match(/(\d+)\s*\/\s*(\d+)\s*point/i) : null;
    return m ? m[1] === m[2] : null;
  }

  function extract() {
    const blocks = Array.from(document.querySelectorAll('[data-quiz-question-id]'));
    const total = blocks.length;

    return blocks.map((block, i) => {
      // The review page is split into sections, so aria-label numbering
      // RESTARTS (1..5 then 1..16). Use the running index for anything that
      // must be unique; keep the page's own number for reference.
      const numMatch = (block.getAttribute('aria-label') || '').match(/Question\s+(\d+)/i);
      const pageNumber = numMatch ? Number(numMatch[1]) : null;
      const number = i + 1;

      const gotItRight = scoreBefore(block);

      // --- feedback, layout A: a single <h3>Feedback</h3> block ---
      const heads = Array.from(block.querySelectorAll('h1,h2,h3,h4,h5,h6'));
      const fbHead = heads.find((h) => h.textContent.trim().toLowerCase() === 'feedback');
      const fbBox = fbHead ? fbHead.parentElement : null;
      let explanation = fbBox
        ? Array.from(fbBox.querySelectorAll('.user_content')).map(textOf).join(' ').trim()
        : '';

      // --- one pass in DOCUMENT ORDER ---
      // Depth-based traversal cannot cope: layout A nests per-option feedback
      // inside the option wrapper, layout B puts it in a sibling one level up.
      // Reading order is identical in both, so walk that instead.
      //
      // Order within an option:
      //   [SR "Correct answer:" | "Incorrect answer:"]   (optional, precedes)
      //   .user_content inside <label>                   the option text
      //   [SR "Not Selected"]                            ignored
      //   [.user_content "…Answer Feedback:"]            per-option feedback
      const options = [];
      const stems = [];
      let correctLetter = '';
      let chosenLetter = '';
      let pendingCue = '';
      let lastOption = null;

      block.querySelectorAll('.user_content, [class*="screenReaderContent"]').forEach((el) => {
        if (isSR(el)) {
          const t = el.textContent.trim();
          // Anchored: /correct answer/ also matches "Incorrect answer".
          if (/^correct answer/i.test(t)) pendingCue = 'correct';
          else if (/^incorrect answer/i.test(t)) pendingCue = 'incorrect';
          return;
        }
        if (fbBox && fbBox.contains(el)) return;   // layout A, already captured
        const txt = textOf(el);
        if (!txt) return;

        const fm = txt.match(FB_PREFIX);
        if (fm) {
          if (lastOption) {
            lastOption.fbType = fm[1].toLowerCase();
            lastOption.fbText = txt.slice(fm[0].length).trim();
          }
          return;
        }

        // An option: either inside its <label>, or (occasionally) loose in the
        // markup, in which case it still looks like "B. ...". Either way the
        // letter identifies it, so upsert rather than push -- the same option
        // can legitimately be encountered twice.
        const inLabel = !!el.closest('label');
        const lm = txt.match(/^([A-Z])[.)]\s*/);
        if (inLabel || lm) {
          const letter = lm ? lm[1] : String.fromCharCode(65 + options.length);
          const text = lm ? txt.slice(lm[0].length).trim() : txt;
          const existing = options.find((o) => o.letter === letter);
          if (existing) {
            // Prefer the label copy; keep whichever cue we have seen.
            if (inLabel && text) existing.text = text;
            if (pendingCue) existing.cue = pendingCue;
            lastOption = existing;
          } else {
            lastOption = { letter, text, cue: pendingCue, fbType: '', fbText: '' };
            options.push(lastOption);
          }
          pendingCue = '';
          return;
        }

        stems.push(txt);
      });

      options.forEach((o) => {
        if (o.cue === 'correct' || o.fbType === 'correct') correctLetter = o.letter;
        if (o.cue === 'incorrect') chosenLetter = o.letter;
      });

      // Explanation preference: the dedicated Feedback block, else the feedback
      // attached to the CORRECT option (not to the one you picked).
      if (!explanation) {
        const win = options.find((o) => o.fbType === 'correct') ||
                    options.find((o) => o.letter === correctLetter && o.fbText);
        if (win) explanation = win.fbText;
      }

      // Last resort: on questions answered wrongly with no per-option feedback,
      // the page marks only YOUR pick and never reveals the right option --
      // there the explanation names it ("B is correct. ..."). The three
      // sources are complementary; together they cover every question.
      if (!correctLetter) {
        const em = explanation.match(/^\s*([A-Z])\s+is\s+correct\b/);
        if (em) correctLetter = em[1];
      }

      const question = stems.join(' ').trim();

      return { number, pageNumber, total, question, options, correctLetter, chosenLetter, explanation, gotItRight };
    });
  }

  // ---------- output ----------
  const clean = (s) => String(s == null ? '' : s)
    .replace(/\t/g, ' ').replace(/\r?\n/g, '<br>').replace(/\s+/g, ' ').trim();

  // No header row. Anki imports by column POSITION, and a header line just
  // becomes a note whose fields are the literal strings "Question", "OptionA"…
  // (which is exactly what happened on the first import). Column order here
  // mirrors FIELDS, which mirrors the note type.
  function toTSV(cards, topic) {
    const rows = [];
    cards.forEach((c) => {
      const by = {};
      c.options.forEach((o) => { by[o.letter] = o.text; });
      rows.push([
        c.question, by.A || '', by.B || '', by.C || '',
        c.correctLetter, c.explanation, topic,
        `${topic} — Question ${c.number} of ${c.total}`,
      ].map(clean).join('\t'));
    });
    return rows.join('\n');
  }

  function save(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/tab-separated-values;charset=utf-8' }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
  }

  const copy = (t) => (typeof GM_setClipboard === 'function'
    ? (GM_setClipboard(t, 'text'), Promise.resolve())
    : navigator.clipboard.writeText(t));

  function askTopic() {
    const prev = localStorage.getItem(TOPIC_KEY) || '';
    const t = prompt('Topic for these cards (fills the Topic field):', prev);
    if (t) localStorage.setItem(TOPIC_KEY, t);
    return t || 'CFA';
  }

  // ---------- self-check ----------
  // Surfaces silent breakage if the platform changes its markup.
  function warnings(cards) {
    const w = [];
    const noCorrect = cards.filter((c) => !c.correctLetter).length;
    const noExpl = cards.filter((c) => !c.explanation).length;
    const noQ = cards.filter((c) => !c.question).length;
    const oddOpts = cards.filter((c) => c.options.length < 2).length;
    if (noCorrect) w.push(`${noCorrect} without a correct answer`);
    if (noExpl) w.push(`${noExpl} without an explanation`);
    if (noQ) w.push(`${noQ} without question text`);
    if (oddOpts) w.push(`${oddOpts} with <2 options`);
    return w;
  }

  // ---------- UI ----------
  let statusEl;
  const status = (m) => { if (statusEl) statusEl.textContent = m; };

  function run(mistakesOnly, download) {
    let cards = extract();
    if (!cards.length) { alert('No questions found — are you on the quiz Review page?'); return; }
    if (mistakesOnly) {
      cards = cards.filter((c) => c.gotItRight === false);
      if (!cards.length) { alert('Nothing wrong on this page.'); return; }
    }
    const w = warnings(cards);
    if (w.length && !confirm('Extraction looks incomplete:\n\n• ' + w.join('\n• ') +
        '\n\nThe page markup may have changed. Continue anyway?')) return;

    const topic = askTopic();
    const tsv = toTSV(cards, topic);
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cfa';
    if (download) { save(`${slug}-anki.tsv`, tsv); status(`downloaded ${cards.length}`); }
    else copy(tsv).then(() => status(`copied ${cards.length} cards`))
                  .catch(() => { save(`${slug}-anki.tsv`, tsv); status('clipboard blocked — downloaded'); });
  }

  function panel() {
    if (document.getElementById('cfa-anki-panel')) return;
    const box = document.createElement('div');
    box.id = 'cfa-anki-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1f2430;' +
      'color:#e6e6e6;font:12px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:6px;min-width:190px';

    const t = document.createElement('div');
    t.textContent = 'Quiz → Anki';
    t.style.cssText = 'font-weight:600;opacity:.75';
    box.appendChild(t);

    const mk = (label, fn) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.style.cssText = 'cursor:pointer;border:0;border-radius:5px;padding:5px 8px;background:#3b4252;' +
        'color:#e6e6e6;font:12px system-ui,sans-serif;text-align:left';
      b.onmouseenter = () => (b.style.background = '#4c566a');
      b.onmouseleave = () => (b.style.background = '#3b4252');
      b.onclick = fn;
      box.appendChild(b);
    };

    mk('Copy TSV — all', () => run(false, false));
    mk('Copy TSV — mistakes only', () => run(true, false));
    mk('Download .tsv', () => run(false, true));
    mk('Debug: copy parsed JSON', () => {
      const d = extract();
      copy(JSON.stringify({ warnings: warnings(d), cards: d }, null, 2))
        .then(() => status(`copied ${d.length} parsed`));
    });

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'opacity:.7;min-height:1em';
    box.appendChild(statusEl);

    const n = document.querySelectorAll('[data-quiz-question-id]').length;
    const info = document.createElement('div');
    info.style.cssText = 'opacity:.5';
    info.textContent = `${n} question${n === 1 ? '' : 's'} detected`;
    box.appendChild(info);

    document.body.appendChild(box);
  }

  // The review page renders asynchronously.
  if (document.querySelector('[data-quiz-question-id]')) panel();
  else {
    const obs = new MutationObserver(() => {
      if (document.querySelector('[data-quiz-question-id]')) { panel(); obs.disconnect(); }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  }
})();
