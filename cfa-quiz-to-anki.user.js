// ==UserScript==
// @name         CFA Quiz Review → Anki TSV
// @namespace    patriksvault
// @version      2.1.0
// @description  Highlight CFA practice-quiz questions as you go, then export the review to Anki (TSV for the "smrik - CFA MCQ" note type) or Obsidian (Markdown).
// @author       Patrik
// @homepageURL  https://github.com/smrik/cfa-quiz-to-anki
// @supportURL   https://github.com/smrik/cfa-quiz-to-anki/issues
// @downloadURL  https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-to-anki.user.js
// @updateURL    https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-to-anki.user.js
// @match        https://*.insproserv.net/*
// @match        https://learn.cfainstitute.org/*
// @grant        GM_setClipboard
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
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
 *
 * HIGHLIGHTS
 * Select text in a question (while taking the quiz or on the review) and
 * pick a colour from the small bar, or press Alt+1/2/3. Alt+0 removes.
 * Each highlight is saved immediately, keyed by the question's id plus a
 * fingerprint of its text, and re-drawn whenever that question is on screen.
 * Exports carry them: <mark> in Anki fields, ==text== in Markdown.
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
    if (node.nodeType === 3) {
      const v = node.nodeValue;
      const plain = (t) => esc(t.replace(/\s+/g, ' '));
      const segs = markMap.get(node);          // highlights on this text node
      if (!segs || !segs.length) return plain(v);
      let out = '', pos = 0;
      segs.slice().sort((x, y) => x.a - y.a).forEach((sg) => {
        const a = Math.max(pos, Math.min(sg.a, v.length));
        const b = Math.max(a, Math.min(sg.b, v.length));
        if (b <= a || !COLORS[sg.c]) return;
        out += plain(v.slice(pos, a)) + '<mark style="background:' + COLORS[sg.c].bg + ';color:#111">' + plain(v.slice(a, b)) + '</mark>';
        pos = b;
      });
      return out + plain(v.slice(pos));
    }
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
    // The clone's text nodes are new objects; carry the highlights across.
    const wa = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const wb = document.createTreeWalker(c, NodeFilter.SHOW_TEXT);
    for (let a = wa.nextNode(), b = wb.nextNode(); a && b; a = wa.nextNode(), b = wb.nextNode()) {
      const m = markMap.get(a);
      if (m) markMap.set(b, m.map((x) => ({ a: x.a, b: x.b, c: x.c })));
    }
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
          const m = markMap.get(t);
          if (m && k) {
            markMap.set(t, m.map((x) => ({ a: Math.max(0, x.a - k), b: Math.max(0, x.b - k), c: x.c })).filter((x) => x.b > x.a));
          }
        });
        return c;
      }
      if (norm(acc).length > 60) break;
    }
    return c;
  }

  // ---------- reading a question block ----------
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

  // One pass in DOCUMENT ORDER over a block's prose, labelling each piece.
  // Layout A nests feedback inside the option wrapper, layout B puts it in a
  // sibling one level up, so depth-based traversal cannot cope; reading order
  // is identical in both. Within an option:
  //   [SR "Correct answer:" | "Incorrect answer:"]   optional, precedes
  //   .user_content inside <label>                   the option
  //   [.user_content "... Answer Feedback:"]         per-option feedback
  // and, when you were wrong in layout A:
  //   <span>Correct Answer:</span> .user_content     repeat of the right one
  //
  // Both the exporter and the highlighter use this, so a highlight made on
  // "option B" while taking the quiz lands on option B in the review.
  //   role 'stem'   key s0, s1 ...     the question
  //   role 'opt'    key o:B            an option (may occur twice, same key)
  //   role 'optfb'  key f:B            feedback attached to an option
  //   role 'fb'     key F0, F1 ...     the shared Feedback box
  function classify(block) {
    const fbHead = Array.from(block.querySelectorAll('h1,h2,h3,h4,h5,h6'))
      .find((h) => /^feedback$/i.test(norm(h.textContent)));
    const fbBox = fbHead ? fbHead.parentElement : null;
    const items = [];
    let pending = '';
    let lastLetter = '';
    let optionCount = 0;
    let stemN = 0;
    let fbN = 0;
    const seen = {};

    Array.from(block.querySelectorAll('.user_content, ' + SR_SEL + ', span')).forEach((el) => {
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
      if (fbBox && fbBox.contains(el)) { items.push({ el, role: 'fb', key: 'F' + fbN++ }); return; }
      const txt = textOf(el);
      if (!txt) return;

      const fm = txt.match(FB_PREFIX);
      if (fm) {
        if (lastLetter) items.push({ el, role: 'optfb', key: 'f:' + lastLetter, letter: lastLetter, fbType: fm[1].toLowerCase() });
        pending = '';
        return;
      }

      const label = el.closest('label');
      const lm = txt.match(LETTER);
      if (label || (lm && (pending === 'label' || optionCount > 0))) {
        const letter = lm ? lm[1] : String.fromCharCode(65 + optionCount);
        if (!seen[letter]) { seen[letter] = true; optionCount++; }
        const input = label && label.parentElement
          ? label.parentElement.querySelector('input[type="radio"], input[type="checkbox"]') : null;
        items.push({
          el, role: 'opt', key: 'o:' + letter, letter, inLabel: !!label, hasLetter: !!lm, cue: pending,
          checked: !!(input && (input.checked || input.hasAttribute('checked'))),
          text: lm ? txt.slice(lm[0].length).trim() : txt,
        });
        pending = '';
        lastLetter = letter;
        return;
      }

      items.push({ el, role: 'stem', key: 's' + stemN++ });
    });
    return { items, fbBox };
  }

  // ---------- identity ----------
  // "Really sure the IDs don't overlap": a record is keyed by the page's
  // question id AND a fingerprint of the question's own text (first stem
  // paragraph + the options). Two questions can only share a record if both
  // match. If the platform ever shows the same question under another id,
  // the fingerprint alone still finds it.
  function hash(str) {
    let h1 = 0xdeadbeef ^ str.length, h2 = 0x41c6ce57 ^ str.length;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
  }

  function fingerprint(items) {
    const stem = items.find((it) => it.role === 'stem');
    const opts = {};
    items.filter((it) => it.role === 'opt').forEach((it) => { if (it.inLabel || !opts[it.letter]) opts[it.letter] = it.text; });
    const body = (stem ? textOf(stem.el) : '') + '|' + Object.keys(opts).sort().map((l) => l + ':' + opts[l]).join('|');
    return hash(body.toLowerCase());
  }

  // ---------- highlight store ----------
  // Saved the moment a highlight changes, so an unfinished quiz loses nothing.
  // Tampermonkey storage is per script, not per site, so the quiz frame and a
  // later review page see the same data.
  const hasGM = typeof GM_getValue === 'function' && typeof GM_setValue === 'function' &&
                typeof GM_listValues === 'function' && typeof GM_deleteValue === 'function';
  const LS = 'cfa-anki:';
  const HL = 'hl:';
  const store = {
    keys() {
      try {
        return hasGM ? GM_listValues() : Object.keys(localStorage).filter((k) => k.startsWith(LS)).map((k) => k.slice(LS.length));
      } catch (e) { return []; }
    },
    get(k) {
      try {
        if (hasGM) return GM_getValue(k, null);
        const raw = localStorage.getItem(LS + k);
        return raw == null ? null : JSON.parse(raw);
      } catch (e) { return null; }
    },
    set(k, v) { try { if (hasGM) GM_setValue(k, v); else localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { if (hasGM) GM_deleteValue(k); else localStorage.removeItem(LS + k); } catch (e) { /* nothing to do */ } },
  };

  let records = null;                         // key -> record, loaded once, refreshed on focus
  function loadRecords() {
    records = new Map();
    store.keys().filter((k) => k.startsWith(HL)).forEach((k) => {
      const r = store.get(k);
      if (r && Array.isArray(r.marks)) records.set(k, r);
    });
  }
  function findRecord(kind, id, fp) {
    if (!records) loadRecords();
    const exact = HL + kind + ':' + (kind === 'q' ? id + ':' : '') + fp;
    if (records.has(exact)) return { key: exact, rec: records.get(exact) };
    if (kind === 'q') {
      const same = Array.from(records.entries()).filter(([, r]) => r.kind === 'q' && r.fp === fp);
      if (same.length === 1) return { key: same[0][0], rec: same[0][1] };
    }
    return { key: exact, rec: null };
  }
  function saveRecord(key, rec) {
    if (!rec.marks.length) { records.delete(key); store.del(key); return; }
    rec.t = Date.now();
    records.set(key, rec);
    if (!store.set(key, rec)) toast('Could not save highlight \u2014 storage is full or blocked');
  }

  // ---------- highlight engine ----------
  // Drawn with the CSS Custom Highlight API: ranges are painted without
  // touching the DOM, so the app's own rendering is never disturbed.
  const COLORS = {
    y: { name: 'Yellow', bg: '#ffe566' },
    g: { name: 'Green', bg: '#a8e6a1' },
    p: { name: 'Pink', bg: '#ffb3c7' },
  };
  const canPaint = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function';
  const NO_TEXT = SR_SEL + ', [data-mathml], math, svg, script, style, mjx-container, .MathJax, .MathJax_SVG';

  // A section's text with whitespace collapsed, plus where each character
  // lives. Offsets are in THIS string, so they survive re-rendering.
  function textMap(el) {
    const at = [];
    let text = '';
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.parentElement && n.parentElement.closest(NO_TEXT)) continue;
      const v = n.nodeValue;
      for (let i = 0; i < v.length; i++) {
        const ch = v[i];
        if (/\s/.test(ch) || ch === '\u00a0') {
          if (!text || text[text.length - 1] === ' ') continue;
          text += ' ';
        } else text += ch;
        at.push({ node: n, off: i });
      }
    }
    return { text, at };
  }

  // A mark is stored as the quoted text and which occurrence of it -- not as
  // character positions, which shift if anything upstream changes.
  function occurrences(text, quote) {
    const out = [];
    if (!quote) return out;
    for (let i = text.indexOf(quote); i !== -1; i = text.indexOf(quote, i + 1)) out.push(i);
    return out;
  }
  function resolve(mark, map) {
    const occ = occurrences(map.text, mark.q);
    if (!occ.length) return null;
    const s = occ[Math.min(mark.n || 0, occ.length - 1)];
    return { s, e: s + mark.q.length, c: mark.c };
  }
  function encode(iv, map) {
    const q = map.text.slice(iv.s, iv.e);
    return { q, n: occurrences(map.text, q).indexOf(iv.s), c: iv.c };
  }
  function rangeOf(map, s, e) {
    const r = document.createRange();
    r.setStart(map.at[s].node, map.at[s].off);
    r.setEnd(map.at[e - 1].node, map.at[e - 1].off + 1);
    return r;
  }

  // Every highlightable section currently on the page.
  let sections = [];
  const markMap = new Map();                  // text node -> [{a, b, c}] for the exporter
  function scanSections() {
    const out = [];
    const blocks = Array.from(document.querySelectorAll(Q_SEL));
    blocks.forEach((block) => {
      const { items } = classify(block);
      if (!items.length) return;
      const id = block.getAttribute('data-quiz-question-id') || '';
      const fp = fingerprint(items);
      const stem = items.find((it) => it.role === 'stem');
      const title = stem ? textOf(stem.el).slice(0, 90) : '';
      items.forEach((it) => out.push({ kind: 'q', id, fp, title, block, el: it.el, k: it.key }));
    });
    if (blocks.length) {
      // Prose outside any question -- a vignette. It has no id, so its own
      // text is its identity.
      Array.from(document.querySelectorAll('.user_content')).forEach((el) => {
        if (el.closest(Q_SEL) || el.closest('#cfa-anki-panel')) return;
        if (el.parentElement && el.parentElement.closest('.user_content')) return;
        const t = textOf(el);
        if (t.length < 20) return;
        out.push({ kind: 'v', id: '', fp: hash(t.toLowerCase()), title: t.slice(0, 90), block: null, el, k: 'p' });
      });
    }
    return out;
  }

  let paintedCount = 0;
  function paint() {
    sections = scanSections();
    markMap.clear();
    paintedCount = 0;
    const layers = {};
    Object.keys(COLORS).forEach((c) => { layers[c] = canPaint ? new Highlight() : null; });
    sections.forEach((sec) => {
      const { rec } = findRecord(sec.kind, sec.id, sec.fp);
      if (!rec) return;
      const mine = rec.marks.filter((m) => m.k === sec.k);
      if (!mine.length) return;
      const map = textMap(sec.el);
      mine.forEach((m) => {
        const iv = resolve(m, map);
        if (!iv || !COLORS[iv.c]) return;
        paintedCount++;
        if (layers[iv.c]) layers[iv.c].add(rangeOf(map, iv.s, iv.e));
        for (let i = iv.s; i < iv.e; i++) {
          const { node, off } = map.at[i];
          const list = markMap.get(node) || markMap.set(node, []).get(node);
          const last = list[list.length - 1];
          // contiguous, or separated only by whitespace the map collapsed away
          if (last && last.c === iv.c && /^\s*$/.test(node.nodeValue.slice(last.b, off))) last.b = Math.max(last.b, off + 1);
          else list.push({ a: off, b: off + 1, c: iv.c });
        }
      });
    });
    if (canPaint) Object.keys(COLORS).forEach((c) => CSS.highlights.set('cfa-hl-' + c, layers[c]));
  }

  // The parts of the current selection that fall inside a section.
  function selectionSpans() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return [];
    const range = sel.getRangeAt(0);
    const spans = [];
    sections.forEach((sec) => {
      if (!sec.el.isConnected || !range.intersectsNode(sec.el)) return;
      const map = textMap(sec.el);
      let s = -1, e = -1;
      for (let i = 0; i < map.at.length; i++) {
        const { node, off } = map.at[i];
        let inside = false;
        try { inside = range.comparePoint(node, off) === 0 && range.comparePoint(node, off + 1) === 0; } catch (err) { inside = false; }
        if (inside) { if (s < 0) s = i; e = i + 1; }
      }
      while (s >= 0 && s < e && map.text[s] === ' ') s++;
      while (e > s && map.text[e - 1] === ' ') e--;
      if (s >= 0 && e > s) spans.push({ sec, map, s, e });
    });
    return spans;
  }

  // Replace whatever lies under [s, e) in one section with colour c (or
  // nothing, when clearing), then store the section's marks again.
  function rewrite(span, c) {
    const { sec, map, s, e } = span;
    const found = findRecord(sec.kind, sec.id, sec.fp);
    const rec = found.rec || { v: 1, kind: sec.kind, id: sec.id, fp: sec.fp, title: sec.title, topic: detectTopic(), marks: [] };
    const others = rec.marks.filter((m) => m.k !== sec.k);
    const mine = rec.marks.filter((m) => m.k === sec.k);
    const lost = mine.filter((m) => !resolve(m, map));          // text not on screen right now: leave alone
    let ivs = mine.map((m) => resolve(m, map)).filter(Boolean);
    const next = [];
    ivs.forEach((iv) => {
      if (iv.e <= s || iv.s >= e) { next.push(iv); return; }
      if (iv.s < s) next.push({ s: iv.s, e: s, c: iv.c });
      if (iv.e > e) next.push({ s: e, e: iv.e, c: iv.c });
    });
    if (c) next.push({ s, e, c });
    next.forEach((iv) => {                                       // a cut can leave a ragged edge of spaces
      while (iv.s < iv.e && map.text[iv.s] === ' ') iv.s++;
      while (iv.e > iv.s && map.text[iv.e - 1] === ' ') iv.e--;
    });
    next.sort((a, b) => a.s - b.s);
    ivs = [];
    next.filter((iv) => iv.e > iv.s).forEach((iv) => {           // join neighbours of the same colour
      const last = ivs[ivs.length - 1];
      if (last && last.c === iv.c && map.text.slice(last.e, iv.s).trim() === '') last.e = iv.e;
      else ivs.push({ s: iv.s, e: iv.e, c: iv.c });
    });
    rec.marks = others.concat(lost, ivs.map((iv) => Object.assign({ k: sec.k }, encode(iv, map))));
    if (!rec.title) rec.title = sec.title;
    saveRecord(found.key, rec);
  }

  function applyToSelection(c) {
    const spans = selectionSpans();
    if (!spans.length) return false;
    spans.forEach((sp) => rewrite(sp, c));
    const sel = window.getSelection();
    if (sel) sel.removeAllRanges();
    hideBar();
    paint();
    updateInfo();
    return true;
  }

  // ---------- highlight UI ----------
  let bar = null;
  function hideBar() { if (bar) bar.style.display = 'none'; }
  function buildBar() {
    bar = document.createElement('div');
    bar.id = 'cfa-hl-bar';
    bar.style.cssText = 'position:fixed;z-index:2147483647;display:none;gap:6px;align-items:center;' +
      'background:#1f2430;padding:5px 7px;border-radius:7px;box-shadow:0 3px 12px rgba(0,0,0,.4)';
    const btn = (title, css, text, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.title = title;
      b.textContent = text;
      b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid #1f2430;cursor:pointer;' +
        'padding:0;font:12px/1 system-ui,sans-serif;outline:1px solid rgba(255,255,255,.35);' + css;
      // mousedown would clear the selection before the click arrives
      b.addEventListener('mousedown', (ev) => ev.preventDefault());
      b.addEventListener('click', (ev) => { ev.preventDefault(); ev.stopPropagation(); fn(); });
      bar.appendChild(b);
    };
    Object.keys(COLORS).forEach((c, i) => btn(COLORS[c].name + ' (Alt+' + (i + 1) + ')', 'background:' + COLORS[c].bg, '', () => applyToSelection(c)));
    btn('Remove highlight (Alt+0)', 'background:#3b4252;color:#e6e6e6', '\u00d7', () => applyToSelection(null));
    document.body.appendChild(bar);
  }
  function showBar() {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed || !selectionSpans().length) { hideBar(); return; }
    if (!bar || !bar.isConnected) buildBar();
    const rects = sel.getRangeAt(0).getClientRects();
    const r = rects.length ? rects[rects.length - 1] : sel.getRangeAt(0).getBoundingClientRect();
    bar.style.display = 'flex';
    const w = bar.offsetWidth || 120, h = bar.offsetHeight || 34;
    let top = r.bottom + 8;
    if (top + h > window.innerHeight - 4) top = Math.max(4, r.top - h - 8);
    bar.style.top = top + 'px';
    bar.style.left = Math.min(Math.max(4, r.right - w / 2), window.innerWidth - w - 4) + 'px';
  }

  let toastEl = null, toastTimer = null;
  function toast(msg) {
    if (!document.body) return;
    if (!toastEl || !toastEl.isConnected) {
      toastEl = document.createElement('div');
      toastEl.style.cssText = 'position:fixed;left:50%;bottom:20px;transform:translateX(-50%);z-index:2147483647;' +
        'background:#1f2430;color:#e6e6e6;font:12px/1.4 system-ui,sans-serif;padding:6px 12px;border-radius:6px;' +
        'box-shadow:0 4px 16px rgba(0,0,0,.35);pointer-events:none';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.style.display = 'none'; }, 2500);
  }

  let selTimer = null;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(showBar, 180);
  });
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const m = /^(?:Digit|Numpad)([0-3])$/.exec(e.code);
    if (!m) return;
    const c = m[1] === '0' ? null : Object.keys(COLORS)[Number(m[1]) - 1];
    if (applyToSelection(c)) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  if (canPaint) {
    const st = document.createElement('style');
    st.textContent = Object.keys(COLORS)
      .map((c) => '::highlight(cfa-hl-' + c + '){background-color:' + COLORS[c].bg + ';color:#111}').join('\n');
    (document.head || document.documentElement).appendChild(st);
  }

  // ---------- extraction ----------
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

  const countMarks = (s) => (String(s).match(/<mark /g) || []).length;

  function extract() {
    paint();                                  // marks must be current: the serializer reads them
    vignetteCache.clear();
    const blocks = Array.from(document.querySelectorAll(Q_SEL));
    const total = blocks.length;

    return blocks.map((block, i) => {
      const hdr = headerOf(block);
      const number = i + 1;                    // running index: unique across sections
      const pageNumber = hdr.shown;            // what the page itself shows
      const { items, fbBox } = classify(block);

      const evidence = {};                     // letter -> [why we think it is correct]
      const mark = (letter, why) => { (evidence[letter] = evidence[letter] || []).push(why); };

      const boxFeedback = items.filter((it) => it.role === 'fb').map((it) => htmlOf(it.el)).filter(Boolean).join('<br><br>');
      const stems = items.filter((it) => it.role === 'stem').map((it) => htmlOf(it.el));

      const options = [];
      items.forEach((it) => {
        if (it.role === 'opt') {
          let opt = options.find((o) => o.letter === it.letter);
          if (!opt) {
            opt = { letter: it.letter, html: '', text: '', chosen: false, fbType: '', fbHtml: '' };
            options.push(opt);
          }
          // The same option can legitimately appear twice; prefer the label copy.
          if (it.inLabel || !opt.html) {
            opt.html = htmlOf(it.hasLetter ? stripLead(it.el, LETTER) : it.el);
            opt.text = it.text;
          }
          if (it.checked) opt.chosen = true;
          if (it.cue === 'correct') mark(it.letter, 'cue');
          if (it.cue === 'label') mark(it.letter, 'label');
          if (it.cue === 'incorrect') opt.chosen = true;
        } else if (it.role === 'optfb') {
          const opt = options.find((o) => o.letter === it.letter);
          if (opt) {
            opt.fbType = it.fbType;
            opt.fbHtml = htmlOf(stripLead(it.el, FB_PREFIX));
            if (it.fbType === 'correct') mark(it.letter, 'feedback');
          }
        }
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
      const vignette = vignetteOf(block);
      const question = stems.join('<br><br>');
      const outOptions = options.map((o) => ({ letter: o.letter, html: o.html, text: o.text, chosen: o.chosen }));
      return {
        id: block.getAttribute('data-quiz-question-id') || '',
        number, pageNumber, total,
        type: hdr.type || (isMCQ ? 'Multiple Choice' : 'Unknown'),
        isMCQ, vignette, question,
        options: outOptions,
        correctLetter,
        chosenLetter: chosen ? chosen.letter : '',
        explanation,
        gotItRight: hdr.gotItRight,
        highlights: countMarks(vignette) + countMarks(question) + countMarks(explanation) +
          outOptions.reduce((n, o) => n + countMarks(o.html), 0),
        evidence, conflict,
      };
    });
  }

  // ---------- Anki output ----------
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
      let source = topic + ' \u2014 Question ' + (c.pageNumber || c.number) + ' of ' + c.total;
      if (c.gotItRight === false && c.chosenLetter) source += ' \u2014 you picked ' + c.chosenLetter;
      rows.push([
        questionField(c), by.A || '', by.B || '', by.C || '',
        c.correctLetter, c.explanation, topic, source,
      ].map(cell).join('\t'));
    });
    return rows.join('\n');
  }

  // ---------- Obsidian output ----------
  // The field HTML uses a small, known set of tags, so it converts cleanly.
  const mdText = (s) => s.replace(/\\/g, '\\\\').replace(/([*$|])/g, '\\$1').replace(/</g, '&lt;');
  function mdWrap(sym, s, close) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? m[1] + sym + m[2] + (close || sym) + m[3] : s;
  }
  function mdInline(node) {
    if (node.nodeType === 3) {
      // \( tex \) -> $tex$, everything else escaped
      return node.nodeValue.split(/(\\\(.+?\\\))/).map((part) => {
        const m = part.match(/^\\\((.+)\\\)$/);
        return m ? '$' + m[1].trim() + '$' : mdText(part);
      }).join('');
    }
    if (node.nodeType !== 1) return '';
    const tag = node.localName;
    const inner = () => Array.from(node.childNodes).map(mdInline).join('');
    if (tag === 'br') return '\n';
    if (tag === 'b') return mdWrap('**', inner());
    if (tag === 'i') return mdWrap('*', inner());
    if (tag === 'mark') {
      const bg = ((node.getAttribute('style') || '').match(/background:\s*(#[0-9a-f]+)/i) || [])[1] || COLORS.y.bg;
      return bg.toLowerCase() === COLORS.y.bg ? mdWrap('==', inner())
        : mdWrap('<mark style="background:' + bg + '">', inner(), '</mark>');
    }
    if (tag === 'u' || tag === 'sub' || tag === 'sup' || tag === 's' || tag === 'code') return mdWrap('<' + tag + '>', inner(), '</' + tag + '>');
    if (tag === 'img') return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
    if (tag === 'hr') return '\n\n---\n\n';
    if (tag === 'ul' || tag === 'ol') {
      // Continuation lines (a table or second paragraph inside an item) are
      // indented so they stay part of that item.
      const lines = Array.from(node.children).filter((li) => li.localName === 'li')
        .map((li, i) => (tag === 'ol' ? (i + 1) + '. ' : '- ') +
          mdInline(li).trim().replace(/\n{3,}/g, '\n\n').split('\n').map((l, j) => (j && l ? '    ' + l : l)).join('\n'));
      return '\n\n' + lines.join('\n') + '\n\n';
    }
    if (tag === 'li') return inner();
    if (tag === 'table') return '\n\n' + mdTable(node) + '\n\n';
    return inner();
  }
  function mdTable(table) {
    const cap = table.querySelector('caption');
    const rows = Array.from(table.querySelectorAll('tr'));
    const spans = table.querySelector('[colspan], [rowspan]');
    const capText = cap ? mdInline(cap).trim() : '';
    const head = capText ? '**' + capText + '**\n\n' : '';
    if (spans || !rows.length) {
      // Merged cells have no Markdown form; keep the table as HTML.
      const c = table.cloneNode(true);
      c.querySelectorAll('caption').forEach((x) => x.remove());
      c.querySelectorAll('[style]').forEach((x) => x.removeAttribute('style'));
      return head + c.outerHTML;
    }
    const cells = rows.map((tr) => Array.from(tr.children).map((td) => mdInline(td).trim().replace(/\n+/g, '<br>') || ' '));
    const width = Math.max(...cells.map((r) => r.length));
    const line = (r) => '| ' + Array.from({ length: width }, (_, i) => r[i] || ' ').join(' | ') + ' |';
    return head + [line(cells[0]), '|' + ' --- |'.repeat(width)].concat(cells.slice(1).map(line)).join('\n');
  }
  function htmlToMd(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html');
    return mdInline(doc.body).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  const quoteBlock = (md) => md.split('\n').map((l) => ('> ' + l).trimEnd()).join('\n');

  function toMarkdown(cards, topic) {
    const scored = cards.filter((c) => c.gotItRight !== null);
    const right = scored.filter((c) => c.gotItRight).length;
    const today = new Date().toISOString().slice(0, 10);
    const out = [
      '---',
      'topic: "' + topic.replace(/"/g, '\\"') + '"',
      'source: CFA Institute practice quiz',
      'exported: ' + today,
      'questions: ' + cards.length,
      'score: ' + right + '/' + scored.length,
      'tags:',
      '  - cfa/practice',
      '---',
      '',
      '# ' + topic,
      '',
    ];
    let lastVignette = '';
    cards.forEach((c) => {
      const verdict = c.gotItRight === true ? '\u2713' : c.gotItRight === false ? '\u2717' : '';
      // An item set shares one vignette: print it once, above its first question.
      if (c.vignette && c.vignette !== lastVignette) out.push('> [!quote]- Vignette', quoteBlock(htmlToMd(c.vignette)), '');
      lastVignette = c.vignette;
      out.push('## Q' + (c.pageNumber || c.number) + (verdict ? ' ' + verdict : '') + (c.highlights ? ' \u00b7 highlighted' : ''), '');
      out.push(htmlToMd(c.question), '');
      c.options.forEach((o) => {
        const isRight = o.letter === c.correctLetter;
        const body = o.letter + '. ' + htmlToMd(o.html).replace(/\n+/g, ' ');
        out.push('- ' + (isRight ? '**' + body + '** \u2713' : body) + (o.chosen && !isRight ? ' \u2190 your answer' : ''));
      });
      if (c.options.length) out.push('');
      const title = c.isMCQ
        ? 'Answer: ' + (c.correctLetter || '?') + (c.gotItRight === false && c.chosenLetter ? ' \u00b7 you picked ' + c.chosenLetter : '')
        : 'Explanation';
      // Folded by default, so the note can be used to test yourself again.
      out.push('> [!' + (c.gotItRight === false ? 'failure' : 'success') + ']- ' + title, quoteBlock(htmlToMd(c.explanation) || '(no explanation)'), '');
      if (c.id) out.push('^q' + c.id, '');
    });
    return out.join('\n');
  }

  function save(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: (type || 'text/plain') + ';charset=utf-8' }));
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
    const ids = cards.map((c) => c.id).filter(Boolean);
    add(ids.length - new Set(ids).size, 'sharing a question id with another on this page');
    return w;
  }

  // ---------- panel ----------
  const SCOPE_KEY = 'cfa-quiz-scope';
  const SCOPES = {
    mistakes: { label: 'Mistakes only', keep: (c) => c.gotItRight === false, none: 'Nothing wrong on this page.' },
    all: { label: 'All questions', keep: () => true, none: 'No questions on this page.' },
    highlighted: { label: 'Highlighted only', keep: (c) => c.highlights > 0, none: 'No highlighted questions on this page.' },
  };
  let statusEl, infoEl, box, scopeEl;
  const status = (m) => { if (statusEl) statusEl.textContent = m; };

  // kind: 'anki' (multiple choice only -- the note type has three option
  // fields) or 'md' (everything, including the odd "Essay" question).
  function run(kind, download) {
    const all = extract();
    if (!all.length) { alert('No questions found \u2014 are you on the quiz Review page?'); return; }
    const scope = SCOPES[scopeEl ? scopeEl.value : 'mistakes'] || SCOPES.mistakes;
    const usable = kind === 'anki' ? all.filter((c) => c.isMCQ) : all;
    const cards = usable.filter(scope.keep);
    const skipped = kind === 'anki' ? all.filter(scope.keep).length - cards.length : 0;
    if (!cards.length) { alert(scope.none); return; }
    const w = warnings(cards.filter((c) => c.isMCQ));
    if (w.length && !confirm('Extraction looks incomplete:\n\n\u2022 ' + w.join('\n\u2022 ') +
        '\n\nThe page markup may have changed. Continue anyway?')) return;

    const topic = askTopic();
    if (topic === null) { status('cancelled'); return; }
    const text = kind === 'anki' ? toTSV(cards, topic) : toMarkdown(cards, topic);
    const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'cfa';
    const file = kind === 'anki' ? slug + '-anki.tsv' : slug + '.md';
    const mime = kind === 'anki' ? 'text/tab-separated-values' : 'text/markdown';
    const what = cards.length + (kind === 'anki' ? ' cards' : ' questions') + (skipped ? ' (' + skipped + ' non-MCQ skipped)' : '');
    if (download) { save(file, text, mime); status('downloaded ' + what); }
    else copy(text).then(() => status('copied ' + what))
                   .catch(() => { save(file, text, mime); status('clipboard blocked \u2014 downloaded'); });
  }

  function panel() {
    box = document.createElement('div');
    box.id = 'cfa-anki-panel';
    box.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483646;background:#1f2430;' +
      'color:#e6e6e6;font:12px/1.4 system-ui,sans-serif;padding:10px 12px;border-radius:8px;' +
      'box-shadow:0 4px 16px rgba(0,0,0,.35);display:none;flex-direction:column;gap:6px;min-width:200px';

    const t = document.createElement('div');
    t.textContent = 'Quiz \u2192 Anki / Obsidian';
    t.style.cssText = 'font-weight:600;opacity:.75';
    box.appendChild(t);

    scopeEl = document.createElement('select');
    scopeEl.title = 'Which questions to export';
    scopeEl.style.cssText = 'border:0;border-radius:5px;padding:5px 6px;background:#2e3440;color:#e6e6e6;font:12px system-ui,sans-serif';
    Object.keys(SCOPES).forEach((k) => {
      const o = document.createElement('option');
      o.value = k; o.textContent = SCOPES[k].label;
      scopeEl.appendChild(o);
    });
    try { const s = localStorage.getItem(SCOPE_KEY); if (s && SCOPES[s]) scopeEl.value = s; } catch (e) { /* default */ }
    scopeEl.onchange = () => { try { localStorage.setItem(SCOPE_KEY, scopeEl.value); } catch (e) { /* not fatal */ } };
    box.appendChild(scopeEl);

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

    mk('Anki: copy TSV', () => run('anki', false));
    mk('Anki: download .tsv', () => run('anki', true));
    mk('Obsidian: copy Markdown', () => run('md', false));
    mk('Obsidian: download .md', () => run('md', true));
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
  // "1 point", so the panel stays out of the way (highlighting still works).
  // The app is a single-page app, so keep watching instead of deciding once.
  function reviewCount() {
    return Array.from(document.querySelectorAll(Q_SEL)).filter((b) => headerOf(b).gotItRight !== null).length;
  }

  let shownCount = -1;
  function updateInfo() {
    if (!infoEl) return;
    const s = shownCount + ' question' + (shownCount === 1 ? '' : 's') +
      ' \u00b7 ' + paintedCount + ' highlight' + (paintedCount === 1 ? '' : 's');
    // Writing identical text would still count as a page change and wake the
    // observer again, forever.
    if (infoEl.textContent !== s) infoEl.textContent = s;
  }
  function refresh() {
    if (!document.body) return;
    paint();
    const n = reviewCount();
    if (!n) { if (box) box.style.display = 'none'; shownCount = 0; return; }
    if (!box || !box.isConnected) panel();
    box.style.display = 'flex';
    if (n !== shownCount && statusEl && statusEl.textContent) status('');
    shownCount = n;
    updateInfo();
  }

  // ---------- backup ----------
  function exportBackup() {
    loadRecords();
    const data = { app: 'cfa-quiz-to-anki', version: 1, exported: new Date().toISOString(), records: Object.fromEntries(records) };
    save('cfa-highlights-backup.json', JSON.stringify(data, null, 1), 'application/json');
    toast('Saved ' + records.size + ' highlighted questions');
  }
  function importBackup() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = () => {
      const f = input.files && input.files[0];
      if (!f) return;
      f.text().then((txt) => {
        const data = JSON.parse(txt);
        if (!data || data.app !== 'cfa-quiz-to-anki' || !data.records) throw new Error('not a highlight backup');
        loadRecords();
        let added = 0;
        Object.keys(data.records).forEach((k) => {
          const r = data.records[k];
          if (!k.startsWith(HL) || !r || !Array.isArray(r.marks)) return;
          const mine = records.get(k);
          if (mine && (mine.t || 0) >= (r.t || 0)) return;       // keep whichever is newer
          records.set(k, r); store.set(k, r); added++;
        });
        refresh();
        toast('Imported ' + added + ' highlighted questions');
      }).catch((err) => toast('Import failed: ' + err.message));
    };
    input.click();
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Export highlights backup (JSON)', exportBackup);
    GM_registerMenuCommand('Import highlights backup', importBackup);
  }

  let timer = null;
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; refresh(); }, 400); };
  refresh();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  // Another tab may have added highlights since this one loaded.
  window.addEventListener('focus', () => { loadRecords(); schedule(); });
})();
