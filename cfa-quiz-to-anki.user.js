// ==UserScript==
// @name         CFA Quiz Review → Anki TSV
// @namespace    patriksvault
// @version      2.0.0
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
 *   the block's previous sibling    "8 | Multiple Choice | 0 / 1 point":
 *                                   displayed number, question type, score
 *   .user_content                   Canvas's wrapper around ACTUAL prose --
 *                                   the stem, each option, each feedback
 *   [class*="screenReaderContent"]  "Correct answer:" / "Incorrect answer:"
 *                                   ahead of an option, "Not Selected" after
 *   input[type=radio]:checked       the option you picked
 *   <span>Correct Answer:</span>    labels a repeat of the right option when
 *                                   you got it wrong (layout A)
 *   h3 "Feedback"                   heads the explanation block (layout A)
 *   "Correct|Incorrect Answer Feedback:"  per-option feedback (layout B)
 *   h4 "Vignette"                   heads an item set; its .user_content is
 *                                   shared by every question nested below it
 *
 * WHAT IS IN A FIELD
 * Fields are HTML, not flattened text: paragraphs, tables, lists, sub/sup
 * and emphasis survive. Maths is converted from MathML to TeX wrapped in
 * \( ... \), which Anki's built-in MathJax renders on every platform.
 */

(function () {
  'use strict';

  // MUST match the field order of the "smrik - CFA MCQ" note type EXACTLY.
  // Anki's importer maps columns by POSITION. Topic is 7th in that note type,
  // not 1st -- getting this wrong shifts every field by one and the question
  // shows up as option A. Verify with: Tools > Manage Note Types > Fields.
  const FIELDS = ['Question', 'OptionA', 'OptionB', 'OptionC', 'CorrectAnswer', 'Explanation', 'Topic', 'Source'];
  const NOTE_TYPE = 'smrik - CFA MCQ';
  const OPTION_LETTERS = ['A', 'B', 'C'];     // the note type has three option fields
  const TOPIC_KEY = 'cfa-quiz-topic';

  const Q_SEL = '[data-quiz-question-id]';
  const SR_SEL = '[class*="screenReaderContent"]';
  const isSR = (el) => !!el && el.nodeType === 1 && /screenReaderContent/.test(el.getAttribute('class') || '');
  const norm = (s) => String(s == null ? '' : s).replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

  // ---------- MathML -> TeX ----------
  // Maths arrives two ways: MathJax output (an SVG, with the source MathML
  // kept in data-mathml) and raw <math> elements. textContent of either is
  // useless -- a fraction or square root is structure, not characters, so
  // "sqrt(0.7436) = 0.8623" flattened to "0.7436 = 0.8623". Convert the
  // structure to TeX instead; Anki renders \( ... \) with its own MathJax.
  const MO = {
    '−': '-', '×': '\\times ', '÷': '\\div ', '±': '\\pm ', '∓': '\\mp ',
    '∑': '\\sum ', '∏': '\\prod ', '∫': '\\int ', '≤': '\\le ', '≥': '\\ge ',
    '≠': '\\ne ', '≈': '\\approx ', '∞': '\\infty ', '⋅': '\\cdot ', '·': '\\cdot ',
    '→': '\\to ', '…': '\\dots ', '⁡': '', '⁢': '', '⁣': '', '⁤': '',
    '{': '\\{', '}': '\\}', '%': '\\%', '$': '\\$', '&': '\\&', '#': '\\#', '_': '\\_',
  };
  const ACCENT = {
    '¯': 'bar', '‾': 'bar', '―': 'bar', '̅': 'bar', '_': 'bar', '-': 'bar', '−': 'bar',
    '^': 'hat', 'ˆ': 'hat', '̂': 'hat', '⌢': 'hat',
    '~': 'tilde', '˜': 'tilde', '∼': 'tilde', '→': 'vec', '.': 'dot', '˙': 'dot',
  };
  const texEsc = (s) => s.replace(/[{}%$&#_]/g, (c) => '\\' + c).replace(/\\(?![{}%$&#_])/g, '\\backslash ');

  function mmlToTex(node) {
    if (node.nodeType === 3) return texEsc(norm(node.nodeValue));
    if (node.nodeType !== 1) return '';
    const els = Array.from(node.children);
    const kids = () => Array.from(node.childNodes).map(mmlToTex).join('');
    const arg = (i) => (els[i] ? mmlToTex(els[i]) : '');
    const txt = norm(node.textContent);
    switch ((node.localName || node.nodeName).toLowerCase()) {
      case 'mi': return txt.length > 1 && /^[A-Za-z]+$/.test(txt) ? '\\mathrm{' + txt + '}' : texEsc(txt);
      case 'mn': return texEsc(txt);
      case 'mo': return Object.prototype.hasOwnProperty.call(MO, txt) ? MO[txt] : texEsc(txt);
      case 'mtext': case 'ms': return txt ? '\\text{' + texEsc(txt) + '}' : '';
      case 'mspace': return '\\,';
      case 'mfrac': return els.length === 2 ? '\\frac{' + arg(0) + '}{' + arg(1) + '}' : kids();
      case 'msqrt': return '\\sqrt{' + kids() + '}';
      case 'mroot': return els.length === 2 ? '\\sqrt[' + arg(1) + ']{' + arg(0) + '}' : kids();
      case 'msup': return els.length === 2 ? '{' + arg(0) + '}^{' + arg(1) + '}' : kids();
      case 'msub': return els.length === 2 ? '{' + arg(0) + '}_{' + arg(1) + '}' : kids();
      case 'msubsup': return els.length === 3 ? '{' + arg(0) + '}_{' + arg(1) + '}^{' + arg(2) + '}' : kids();
      case 'munderover': return els.length === 3 ? '{' + arg(0) + '}\\limits_{' + arg(1) + '}^{' + arg(2) + '}' : kids();
      case 'munder': return els.length === 2 ? '\\underset{' + arg(1) + '}{' + arg(0) + '}' : kids();
      case 'mover': {
        if (els.length !== 2) return kids();
        const acc = ACCENT[norm(els[1].textContent)];
        if (!acc) return '\\overset{' + arg(1) + '}{' + arg(0) + '}';
        const base = arg(0);
        const wide = norm(els[0].textContent).length > 1;
        return '\\' + (wide && acc === 'bar' ? 'overline' : wide && acc === 'hat' ? 'widehat' : acc) + '{' + base + '}';
      }
      case 'mfenced': {
        const open = node.hasAttribute('open') ? node.getAttribute('open') : '(';
        const close = node.hasAttribute('close') ? node.getAttribute('close') : ')';
        return '\\left' + (texEsc(open) || '.') + els.map(mmlToTex).join(',') + '\\right' + (texEsc(close) || '.');
      }
      case 'mtable': {
        const rows = els.filter((r) => /^m(labeled)?tr$/i.test(r.localName || ''));
        const cols = Math.max(1, ...rows.map((r) => r.children.length));
        return '\\begin{array}{' + 'l'.repeat(cols) + '}' +
          rows.map((r) => Array.from(r.children).map(mmlToTex).join(' & ')).join(' \\\\ ') + '\\end{array}';
      }
      case 'semantics': return els.length ? mmlToTex(els[0]) : kids();
      case 'annotation': case 'annotation-xml': return '';
      default: return kids();          // math, mrow, mstyle, mpadded, mtr, mtd, ...
    }
  }

  function mathToTex(source) {
    try {
      let root = source;
      if (typeof source === 'string') {
        const doc = new DOMParser().parseFromString(source, 'text/xml');
        if (!doc.documentElement || doc.querySelector('parsererror')) return '';
        root = doc.documentElement;
      }
      return mmlToTex(root).replace(/\s+/g, ' ').trim();
    } catch (e) { return ''; }
  }

  // ---------- DOM -> field HTML ----------
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escAttr = (s) => esc(s).replace(/"/g, '&quot;');
  const BLK = '\u0001';                       // block boundary, resolved at the end
  const INLINE = { b: 'b', strong: 'b', i: 'i', em: 'i', u: 'u', sub: 'sub', sup: 'sup', s: 's', code: 'code' };
  const BLOCKS = /^(p|div|h[1-6]|blockquote|section|article|figure|figcaption|dl|dt|dd|pre|address)$/;
  const DROP = /^(svg|script|style|noscript|input|button|select|textarea|iframe|object|canvas|video|audio|label-hidden)$/;
  // Inline styles so tables look right without touching the card template.
  const TABLE_CSS = 'border-collapse:collapse;margin:6px 0';
  const CELL_CSS = 'border:1px solid #888;padding:3px 8px';

  function ser(node) {
    if (node.nodeType === 3) return esc(node.nodeValue.replace(/\s+/g, ' '));
    if (node.nodeType !== 1) return '';
    if (isSR(node)) return '';
    const tag = (node.localName || '').toLowerCase();

    if (node.hasAttribute('data-mathml') || tag === 'math') {
      const tex = mathToTex(node.hasAttribute('data-mathml') ? node.getAttribute('data-mathml') : node);
      return tex ? '\\(' + esc(tex) + '\\)' : esc(norm(node.textContent));
    }
    if (/^mjx-|^MathJax/i.test(tag) || /\bMathJax|\bMJX/.test(node.getAttribute('class') || '')) {
      // A MathJax wrapper: the source is on a descendant, or there is none.
      const m = node.querySelector('[data-mathml], math');
      return m ? ser(m) : '';
    }
    if (DROP.test(tag)) return '';
    if (tag === 'br') return '<br>';
    if (tag === 'hr') return BLK + '<hr>' + BLK;
    if (tag === 'img') {
      const src = node.currentSrc || node.src || node.getAttribute('src') || '';
      return src ? '<img src="' + escAttr(src) + '" alt="' + escAttr(node.getAttribute('alt') || '') + '">' : '';
    }

    // A caption's parts ("Exhibit 1" / "Regression Output") are separated by
    // CSS alone on the page, so they need a real space here.
    const inner = Array.from(node.childNodes).map(ser).join(tag === 'caption' ? ' ' : '');

    if (INLINE[tag]) return inner.trim() ? '<' + INLINE[tag] + '>' + inner + '</' + INLINE[tag] + '>' : inner;
    if (tag === 'span' || tag === 'font') {
      const st = node.getAttribute('style') || '';
      let out = inner;
      if (!inner.trim()) return inner;
      if (/font-weight\s*:\s*(bold|[6-9]00)/i.test(st)) out = '<b>' + out + '</b>';
      if (/font-style\s*:\s*italic/i.test(st)) out = '<i>' + out + '</i>';
      if (/text-decoration[^;]*underline/i.test(st)) out = '<u>' + out + '</u>';
      if (/vertical-align\s*:\s*super/i.test(st)) out = '<sup>' + out + '</sup>';
      if (/vertical-align\s*:\s*sub/i.test(st)) out = '<sub>' + out + '</sub>';
      return out;
    }
    if (tag === 'ul' || tag === 'ol') return BLK + '<' + tag + '>' + inner + '</' + tag + '>' + BLK;
    if (tag === 'li') return '<li>' + inner + '</li>';
    if (tag === 'table') return BLK + '<table style="' + TABLE_CSS + '">' + inner + '</table>' + BLK;
    if (tag === 'thead' || tag === 'tbody' || tag === 'tfoot' || tag === 'tr') return '<' + tag + '>' + inner + '</' + tag + '>';
    if (tag === 'caption') return '<caption style="text-align:left;font-weight:bold">' + inner + '</caption>';
    if (tag === 'th' || tag === 'td') {
      let a = '';
      ['colspan', 'rowspan'].forEach((k) => {
        const v = node.getAttribute(k);
        if (v && /^\d+$/.test(v) && v !== '1') a += ' ' + k + '="' + v + '"';
      });
      const al = ((node.getAttribute('style') || '').match(/text-align\s*:\s*(left|right|center)/i) || [])[1] ||
                 (/^(left|right|center)$/i.test(node.getAttribute('align') || '') ? node.getAttribute('align') : '');
      return '<' + tag + a + ' style="' + CELL_CSS + (al ? ';text-align:' + al.toLowerCase() : '') + '">' + inner + '</' + tag + '>';
    }
    if (BLOCKS.test(tag)) return BLK + inner + BLK;
    return inner;
  }

  function tidy(html) {
    const B = BLK;
    let s = html.replace(/[\t\r\n ]+/g, ' ').replace(/ {2,}/g, ' ');
    s = s.replace(new RegExp('\\s*(?:' + B + '\\s*)+', 'g'), B);                    // collapse runs
    // No gap needed where a block tag already breaks the line.
    s = s.replace(new RegExp('(<(?:li|td|th|caption)(?: [^>]*)?>)' + B, 'g'), '$1');
    s = s.replace(new RegExp(B + '(?=</(?:li|td|th|caption)>)', 'g'), '');
    s = s.replace(new RegExp(B + '(?=<(?:table|ul|ol|hr|li|tr|thead|tbody|tfoot))', 'g'), '');
    s = s.replace(new RegExp('(<hr>|</(?:table|ul|ol|li|tr|thead|tbody|tfoot)>)' + B, 'g'), '$1');
    s = s.replace(new RegExp('^(?:' + B + '|\\s|<br>)+|(?:' + B + '|\\s|<br>)+$', 'g'), '');
    s = s.replace(new RegExp(B, 'g'), '<br><br>');
    s = s.replace(/ ?(<\/?(?:table|thead|tbody|tfoot|tr|th|td|caption|ul|ol|li)(?: [^>]*)?>) ?/g, '$1');
    s = s.replace(/ +(<su[bp]>)/g, '$1');      // "R <sup>2</sup>" is source indentation, not a real space
    return s.replace(/ ?<br> ?/g, '<br>').replace(/(?:<br>){3,}/g, '<br><br>').trim();
  }

  const htmlOf = (el) => (el ? tidy(ser(el)) : '');

  // Plain text, for DETECTION only (letters, prefixes, emptiness).
  function textOf(el) {
    if (!el) return '';
    const c = el.cloneNode(true);
    c.querySelectorAll(SR_SEL + ', svg, script, style').forEach((n) => n.remove());
    c.querySelectorAll('p, div, li, tr, td, th, br, h1, h2, h3, h4, h5, h6')
      .forEach((n) => n.appendChild(document.createTextNode(' ')));
    return norm(c.textContent);
  }

  // Remove a leading text prefix ("A. ", "Correct Answer Feedback:") from a
  // clone, wherever in the leading markup it sits, and return the clone.
  function stripLead(el, re) {
    const c = el.cloneNode(true);
    const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    let acc = '';
    const seen = [];
    for (let n = w.nextNode(); n && seen.length < 12; n = w.nextNode()) {
      if (n.parentElement && n.parentElement.closest(SR_SEL)) continue;
      seen.push(n);
      acc += n.nodeValue;
      const m = acc.match(re);
      if (m) {
        let drop = m[0].length;
        seen.forEach((t) => {
          const k = Math.min(drop, t.nodeValue.length);
          t.nodeValue = t.nodeValue.slice(k);
          drop -= k;
        });
        return c;
      }
      if (norm(acc).length > 60) break;
    }
    return c;
  }

  // ---------- extraction ----------
  const FB_PREFIX = /^\s*(Correct|Incorrect)\s+Answer\s+Feedback\s*:?\s*/i;
  const LETTER = /^\s*([A-Z])[.)]\s+/;
  const SCORE = /(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*points?/i;

  // The header row sits directly ABOVE each block: "8 | Multiple Choice | 0 / 1 point".
  function headerOf(block) {
    const h = block.previousElementSibling;
    const out = { shown: null, type: '', gotItRight: null };
    if (!h || h.matches(Q_SEL)) return out;
    const parts = Array.from(h.children).map((c) => norm(c.textContent)).filter(Boolean);
    const all = norm(h.textContent);
    const sm = all.match(SCORE);
    if (sm) out.gotItRight = Number(sm[1]) >= Number(sm[2]);
    if (parts.length && /^\d+$/.test(parts[0])) out.shown = Number(parts[0]);
    out.type = parts.find((p) => !/^\d+$/.test(p) && !SCORE.test(p) && !/^\d+\s*points?$/i.test(p)) || '';
    return out;
  }

  // An item set: <h4>Vignette</h4> + its prose, shared by the questions
  // nested below. Without it "Based on Exhibit 1 ..." is unanswerable.
  const vignetteCache = new Map();
  function vignetteOf(block) {
    for (let a = block.parentElement; a && a !== document.body; a = a.parentElement) {
      const head = Array.from(a.children).find((c) => /^H[1-6]$/.test(c.tagName) && /^vignette$/i.test(norm(c.textContent)));
      if (!head) continue;
      if (!vignetteCache.has(a)) {
        const parts = Array.from(a.querySelectorAll('.user_content'))
          .filter((u) => !u.closest(Q_SEL) && !(u.parentElement && u.parentElement.closest('.user_content')))
          .map(htmlOf).filter(Boolean);
        vignetteCache.set(a, parts.join('<br><br>'));
      }
      return vignetteCache.get(a);
    }
    return '';
  }

  function extract() {
    vignetteCache.clear();
    const blocks = Array.from(document.querySelectorAll(Q_SEL));
    const total = blocks.length;

    return blocks.map((block, i) => {
      const hdr = headerOf(block);
      const number = i + 1;                    // running index: unique across sections
      const pageNumber = hdr.shown;            // what the page itself shows

      // --- layout A: one <h3>Feedback</h3> box for the whole question ---
      const fbHead = Array.from(block.querySelectorAll('h1,h2,h3,h4,h5,h6'))
        .find((h) => /^feedback$/i.test(norm(h.textContent)));
      const fbBox = fbHead ? fbHead.parentElement : null;
      const boxFeedback = fbBox
        ? Array.from(fbBox.querySelectorAll('.user_content')).map(htmlOf).filter(Boolean).join('<br><br>')
        : '';

      // --- one pass in DOCUMENT ORDER ---
      // Layout A nests feedback inside the option wrapper, layout B puts it in
      // a sibling one level up, so depth-based traversal cannot cope. Reading
      // order is identical in both. Within an option:
      //   [SR "Correct answer:" | "Incorrect answer:"]   optional, precedes
      //   .user_content inside <label>                   the option
      //   [.user_content "... Answer Feedback:"]         per-option feedback
      // and, when you were wrong in layout A:
      //   <span>Correct Answer:</span> .user_content     repeat of the right one
      const options = [];
      const stems = [];
      const evidence = {};                     // letter -> [why we think it is correct]
      const mark = (letter, why) => { (evidence[letter] = evidence[letter] || []).push(why); };
      let pending = '';
      let lastOption = null;

      const nodes = Array.from(block.querySelectorAll('.user_content, ' + SR_SEL + ', span'));
      nodes.forEach((el) => {
        if (isSR(el)) {
          const t = norm(el.textContent);
          if (/^correct answer/i.test(t)) pending = 'correct';         // anchored: "Incorrect answer" also contains it
          else if (/^incorrect answer/i.test(t)) pending = 'incorrect';
          return;
        }
        if (!el.classList.contains('user_content')) {
          // A bare label span, not prose.
          if (!el.children.length && /^correct answer:?$/i.test(norm(el.textContent)) && !el.closest('.user_content')) pending = 'label';
          return;
        }
        if (el.parentElement && el.parentElement.closest('.user_content')) return;   // nested wrapper
        if (fbBox && fbBox.contains(el)) return;                                     // already captured
        const txt = textOf(el);
        if (!txt) return;

        const fm = txt.match(FB_PREFIX);
        if (fm) {
          if (lastOption) {
            lastOption.fbType = fm[1].toLowerCase();
            lastOption.fbHtml = htmlOf(stripLead(el, FB_PREFIX));
            if (lastOption.fbType === 'correct') mark(lastOption.letter, 'feedback');
          }
          pending = '';
          return;
        }

        const label = el.closest('label');
        const lm = txt.match(LETTER);
        const isOption = !!label || (!!lm && (pending === 'label' || options.length > 0));
        if (isOption) {
          const letter = lm ? lm[1] : String.fromCharCode(65 + options.length);
          const html = htmlOf(lm ? stripLead(el, LETTER) : el);
          let opt = options.find((o) => o.letter === letter);
          if (!opt) {
            opt = { letter, html: '', text: '', chosen: false, fbType: '', fbHtml: '' };
            options.push(opt);
          }
          if (label || !opt.html) { opt.html = html; opt.text = lm ? txt.slice(lm[0].length).trim() : txt; }
          if (label) {
            const input = label.parentElement && label.parentElement.querySelector('input[type="radio"], input[type="checkbox"]');
            if (input && (input.checked || input.hasAttribute('checked'))) opt.chosen = true;
          }
          if (pending === 'correct') mark(letter, 'cue');
          if (pending === 'label') mark(letter, 'label');
          if (pending === 'incorrect') opt.chosen = true;
          pending = '';
          lastOption = opt;
          return;
        }

        stems.push(htmlOf(el));
      });

      options.sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));   // the page shuffles them

      // --- explanation ---
      let explanation = boxFeedback;
      const explained = options.filter((o) => o.fbHtml);
      if (!explanation && explained.length) {
        const win = explained.find((o) => o.fbType === 'correct');
        const rest = explained.filter((o) => o !== win);
        explanation = [win ? win.fbHtml : ''].concat(rest.map((o) => '<b>' + o.letter + ':</b> ' + o.fbHtml))
          .filter(Boolean).join('<br><br>');
      }

      // --- correct answer: every independent signal must agree ---
      const said = (fbBox ? textOf(fbBox) : '').replace(/^feedback\s*/i, '').match(/^([A-Z])\s+is\s+(?:the\s+)?correct\b/);
      if (said) mark(said[1], 'explanation');
      const chosen = options.find((o) => o.chosen);
      if (chosen && hdr.gotItRight === true) mark(chosen.letter, 'score');
      const candidates = Object.keys(evidence);
      const correctLetter = candidates.length === 1 ? candidates[0]
        : candidates.sort((a, b) => evidence[b].length - evidence[a].length)[0] || '';
      const conflict = candidates.length > 1;

      const isMCQ = options.length >= 2;
      return {
        number, pageNumber, total,
        type: hdr.type || (isMCQ ? 'Multiple Choice' : 'Unknown'),
        isMCQ,
        vignette: vignetteOf(block),
        question: stems.join('<br><br>'),
        options: options.map((o) => ({ letter: o.letter, html: o.html, text: o.text, chosen: o.chosen })),
        correctLetter,
        chosenLetter: chosen ? chosen.letter : '',
        explanation,
        gotItRight: hdr.gotItRight,
        evidence, conflict,
      };
    });
  }

  // ---------- output ----------
  // Tabs and newlines would break the row; everything else is HTML already.
  const cell = (s) => {
    const v = String(s == null ? '' : s).replace(/[\t\r\n]+/g, ' ').trim();
    // A field that starts with a double quote is read by Anki as a quoted
    // field, so quote any field containing one.
    return /"/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };

  function questionField(c) {
    if (!c.vignette) return c.question;
    // The card template sets the whole Question field bold; a 2,000-character
    // vignette in bold is hard to read, so reset it and leave the stem bold.
    return '<details open style="font-weight:normal;font-size:0.92em"><summary><b>Vignette</b></summary>' +
      c.vignette + '</details><hr>' + c.question;
  }

  // The #-lines are Anki's file headers (2.1.54+): they set the separator,
  // HTML mode and note type so the import dialog needs no manual settings.
  // They are NOT a column-name row -- one of those would import as a note.
  function toTSV(cards, topic) {
    const rows = ['#separator:tab', '#html:true', '#notetype:' + NOTE_TYPE];
    cards.forEach((c) => {
      const by = {};
      c.options.forEach((o) => { by[o.letter] = o.html; });
      let source = topic + ' — Question ' + (c.pageNumber || c.number) + ' of ' + c.total;
      if (c.gotItRight === false && c.chosenLetter) source += ' — you picked ' + c.chosenLetter;
      rows.push([
        questionField(c), by.A || '', by.B || '', by.C || '',
        c.correctLetter, c.explanation, topic, source,
      ].map(cell).join('\t'));
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

  // Breadcrumb: Practice Topics > CFA-26-11-LI-A: Quantitative Methods > Module 7: ...
  function detectTopic() {
    const ol = Array.from(document.querySelectorAll('ol, nav')).find((o) => /^\s*Practice Topics/i.test(o.textContent || ''));
    if (!ol) return '';
    const items = Array.from(ol.querySelectorAll('li')).map((li) => norm(li.textContent)).filter(Boolean);
    const subject = (items[1] || '').replace(/^[A-Z0-9-]+:\s*/, '');
    const quiz = items[2] || '';
    return [subject, quiz].filter(Boolean).join(' - ');
  }

  function askTopic() {
    const guess = detectTopic() || localStorage.getItem(TOPIC_KEY) || '';
    const t = prompt('Topic for these cards (fills the Topic field):', guess);
    if (t === null) return null;
    if (t) localStorage.setItem(TOPIC_KEY, t);
    return t || 'CFA';
  }

  // ---------- self-check ----------
  // Surfaces silent breakage if the platform changes its markup.
  function warnings(cards) {
    const w = [];
    const n = (f) => cards.filter(f).length;
    const add = (count, msg) => { if (count) w.push(count + ' ' + msg); };
    add(n((c) => !c.correctLetter), 'without a correct answer');
    add(n((c) => c.conflict), 'where the page gives conflicting correct answers');
    add(n((c) => c.correctLetter && !c.options.some((o) => o.letter === c.correctLetter)), 'whose correct letter is not one of the options');
    add(n((c) => !c.explanation), 'without an explanation');
    add(n((c) => !c.question), 'without question text');
    add(n((c) => c.options.some((o) => !o.html)), 'with an empty option');
    add(n((c) => c.options.length !== OPTION_LETTERS.length ||
      c.options.some((o, i) => o.letter !== OPTION_LETTERS[i])), 'without exactly options A, B, C');
    add(n((c) => c.gotItRight === null), 'with no readable score');
    return w;
  }

  // ---------- UI ----------
  let statusEl, infoEl, box;
  const status = (m) => { if (statusEl) statusEl.textContent = m; };

  function run(mistakesOnly, download) {
    const all = extract();
    if (!all.length) { alert('No questions found — are you on the quiz Review page?'); return; }
    // The note type is three-option multiple choice; anything else (the
    // occasional "Essay" matching question) has nowhere to go.
    let cards = all.filter((c) => c.isMCQ);
    const skipped = all.length - cards.length;
    if (mistakesOnly) {
      cards = cards.filter((c) => c.gotItRight === false);
      if (!cards.length) { alert('Nothing wrong on this page.'); return; }
    }
    if (!cards.length) { alert('No multiple-choice questions on this page.'); return; }
    const w = warnings(cards);
    if (w.length && !confirm('Extraction looks incomplete:\n\n• ' + w.join('\n• ') +
        '\n\nThe page markup may have changed. Continue anyway?')) return;

    const topic = askTopic();
    if (topic === null) { status('cancelled'); return; }
    const tsv = toTSV(cards, topic);
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cfa';
    const note = skipped ? ' (' + skipped + ' non-MCQ skipped)' : '';
    if (download) { save(slug + '-anki.tsv', tsv); status('downloaded ' + cards.length + note); }
    else copy(tsv).then(() => status('copied ' + cards.length + ' cards' + note))
                  .catch(() => { save(slug + '-anki.tsv', tsv); status('clipboard blocked — downloaded'); });
  }

  function panel() {
    box = document.createElement('div');
    box.id = 'cfa-anki-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;background:#1f2430;' +
      'color:#e6e6e6;font:12px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;flex-direction:column;gap:6px;min-width:190px';

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

    mk('Copy TSV — mistakes only', () => run(true, false));
    mk('Copy TSV — all', () => run(false, false));
    mk('Download .tsv', () => run(false, true));
    mk('Debug: copy parsed JSON', () => {
      const d = extract();
      copy(JSON.stringify({ warnings: warnings(d.filter((c) => c.isMCQ)), cards: d }, null, 2))
        .then(() => status('copied ' + d.length + ' parsed'));
    });

    statusEl = document.createElement('div');
    statusEl.style.cssText = 'opacity:.7;min-height:1em';
    box.appendChild(statusEl);

    infoEl = document.createElement('div');
    infoEl.style.cssText = 'opacity:.5';
    box.appendChild(infoEl);

    document.body.appendChild(box);
  }

  // Only a REVIEW page has anything to export: there every question carries a
  // score ("0 / 1 point"). While you are taking a quiz the header just says
  // "1 point", so the panel stays out of the way. The app is a single-page
  // app, so keep watching instead of deciding once.
  function reviewCount() {
    return Array.from(document.querySelectorAll(Q_SEL)).filter((b) => headerOf(b).gotItRight !== null).length;
  }

  let lastCount = -1;
  function refresh() {
    if (!document.body) return;
    const n = reviewCount();
    if (n === lastCount && box && box.isConnected) return;
    lastCount = n;
    if (!n) { if (box) box.style.display = 'none'; return; }
    if (!box || !box.isConnected) panel();
    box.style.display = 'flex';
    infoEl.textContent = n + ' question' + (n === 1 ? '' : 's') + ' detected';
    status('');
  }

  let timer = null;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; refresh(); }, 400); };
  refresh();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
})();
