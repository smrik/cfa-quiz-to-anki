# cfa-quiz-to-anki

Tampermonkey userscript that scrapes a CFA Institute practice-quiz **Review**
page and emits Anki-ready TSV.

The quiz runs inside an LTI iframe (`insproserv.net`) embedded in Canvas
(`learn.cfainstitute.org`), so the script matches both origins.

## Install

Open the raw file with Tampermonkey installed and it offers to install:

<https://raw.githubusercontent.com/smrik/cfa-quiz-to-anki/main/cfa-quiz-to-anki.user.js>

`@updateURL` and `@downloadURL` point back at that raw URL, so pushing a
**version-bumped** commit to `main` updates the installed copy.

## Editing workflow

```powershell
# edit cfa-quiz-to-anki.user.js, then:
./bump.ps1                       # 1.3.0 -> 1.3.1, syntax-check, commit, push
./bump.ps1 -Part minor           # 1.3.1 -> 1.4.0
./bump.ps1 -Message "fix maths"  # custom commit message
```

Three things that bite:

- **The version must increase.** Tampermonkey compares `@version`; pushing new
  code under the same number is a silent no-op. `bump.ps1` exists so this
  cannot be forgotten.
- **Updates are not instant.** Tampermonkey checks on its own schedule (daily
  by default). To force one: Tampermonkey dashboard → *Installed userscripts* →
  the ⟳ icon, or *Utilities → Check for userscript updates*.
- **`raw.githubusercontent.com` caches for ~5 minutes.** A push is not visible
  at the raw URL immediately.

The repo must be **public** — Tampermonkey fetches the raw URL unauthenticated.

## Using it

1. Finish a quiz, open its **Review** page
2. A panel appears bottom-right
3. Set **Topic** (e.g. `Quantitative Methods - Module 7`) — it is remembered
4. **Copy TSV — mistakes only** (recommended) or **all**
5. Anki → File → Import

Import settings:

| Setting | Value |
|---|---|
| Field separator | Tab |
| Note type | `smrik - CFA MCQ` |
| First row is field names | **No** — there is no header row |
| Allow HTML in fields | Yes |

## Column order — the one thing to keep in sync

Anki imports by column **position**. A header row does not reorder anything,
which is why the file has none. `FIELDS` in the script must match the note
type's field order exactly:

```
Question, OptionA, OptionB, OptionC, CorrectAnswer, Explanation, Topic, Source
```

Note that `Topic` is **seventh**. Getting this wrong shifts every field by one
and the question renders as option A. If the note type's fields are ever
reordered (Anki → Tools → Manage Note Types → Fields), update `FIELDS` to match.

## How the scraping works

Anchors are semantic or Canvas-stable. The emotion classnames
(`css-1q7flqv`, …) are content hashes that change on every deploy, so nothing
depends on them.

| Anchor | Carries |
|---|---|
| `[data-quiz-question-id]` | one per question |
| `.user_content` | actual prose — question, options, explanation |
| `[class*="screenReaderContent"]` | `Correct answer:` / `Not Selected` |
| `h3` "Feedback" | the explanation block (layout A) |
| `N / N point` | whether it was answered correctly |

Three traps the code works around, all found on real pages:

1. **Two feedback layouts.** Questions 1–5 use one `<h3>Feedback</h3>` block;
   6+ put `Correct Answer Feedback:` inline under each option. Layout A nests
   feedback inside the option wrapper, layout B in a sibling one level up — so
   the code walks **document order** rather than the tree, since reading order
   is identical in both.
2. **MathJax renders to SVG**, so `textContent` yields nothing. The source
   MathML survives in `data-mathml` and is converted to readable text
   (`√( )`, `(a)/(b)`, superscripts).
3. **Question numbers restart** per section (1–5, then 1–16), so `aria-label`
   is not unique. The running index is used instead.

Full notes, including the Obsidian-side vault integration, live in
`System/CFA Quiz Extractor.md` in the vault.
