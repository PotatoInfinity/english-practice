# Edge-case audit: corpus.json (6797 rows) vs scripts/merge.py

Method: read merge.py in full; sampled all 10 categories; wrote probe scripts
under /tmp (probe1..21). Rebuilt corpus in a scratch dir (`cp -r data scripts`,
`mkdir src-tauri`, ran merge.py): output identical to committed corpus
(6797 rows, 0 diff in gap-triples). Findings below are pipeline properties,
not stale data. `norm` = lowercase + collapse-whitespace.

Global gap: repairs run in fixed order (0 lead-conj -> 2 binomial-suffix ->
3 dup-until -> 4 kw-gap -> 6 kw-widen -> 5 dup-adjacent) with NO post-pass and
NO final invariant check (`full == prefix + answer + suffix` is never asserted;
`validate` runs pre-repair only, `canon` can break what `validate` approved).

## C1. Self-answering prompts (answer verbatim in prompt)

`validate`/`warn` never compare prompt to full_answer. Rows where
prompt-minus-`(KEYWORD)`-bracket equals full_answer (student copies instead of
recalling). Counts: wordform 166/570, blank_fill 135/539, prep_idiom 96/660,
rephrase 41/1055, figurative 7/737, inversion 7/504, light_verb 4/598, binomial 2/515.

- wordform: prompt `A dictionary is a very useful tool for learners. (USE)`,
  frame `A dictionary is a very ___ tool for learners.`, answer `useful`.
  Prompt hands over the inflected form; keyword `USE` is decorative.
- wordform: prompt `A good teacher is tolerant with slow learners. (TOLERATE)`,
  frame `A good teacher is ___ with slow learners.`, answer `tolerant`.
- blank_fill: prompt `Applicants must fill out the questionnaire in black ink.`,
  frame `Applicants must fill ___ the questionnaire in black ink.`, answer `out`,
  keyword `out`. Prompt == full_answer; keyword == answer: zero task.
- prep_idiom: prompt `Apart from music, he likes sport. (apart)`, frame `` +
  `apart from` + `music, he likes sport.`. Gap at position 0 with keyword `apart`
  already inside the answer.
- rephrase: prompt `Bored with the lecture, he doodled in his notebook.`,
  keyword `BORED`, frame `` + `Bored with the lecture,` + `he doodled...`.
  Answer is the prompt's own first clause.
- inversion: prompt `No way will the board ratify such a reckless merger. (WAY)`,
  frame `No way` + `will the board ratify` + `such a reckless merger.`.
  Prompt == full_answer; only word order is tested, lexis fully given.

Why missed: only check is `warn` "keyword appears in neither answer nor full"
(one direction). No prompt-vs-full similarity predicate exists.
Fix: post-`canon` quarantine rule per gap-category (all except mcq/three_in_one):
`if norm(strip_bracket(prompt)) == norm(full.rstrip('.')): quarantine("prompt reproduces target")`.
Softer variant: `if norm(answer) in norm(prompt_without_parens): flag("answer leaks in prompt")`
with per-category allow-list (default deny). `strip_bracket = re.sub(r"\([A-Za-z' -]{1,30}\)\s*[.?]?\s*$", "", p)`.

## C2. keyword == bare answer (gap tests nothing new)

2789 rows have `norm(keyword) == norm(answer)` (mcq 726, blank_fill 468,
figurative 451, three_in_one 401, binomial 342, light_verb 249, rephrase 128,
wordform 24). repair-6 (`repaired_kw_widen`, 488 hits) is the only rule that
widens the gap, but its glue sets are tiny (`OFTO = {"of","to"}` on the right;
`ENDSTOP` halts left-run immediately; mcq/three_in_one/inversion excluded), so
most survive:

- binomial: prompt `Do not put the cart before the load. (HORSE)`,
  frame `Do not put the cart before the` + `horse` + `.`. `R` is `.`
  (no fullmatch) so no widening; keyword adds nothing to the gap.
- binomial: prompt `He bored with a brace in the workshop. (BIT)`,
  frame `He bored with a brace and` + `bit` + `in the workshop.`.
  `L="and"` in CONJ blocks left take, `R="in"` not in OFTO blocks right take.
- figurative: prompt `She broke the news gently to the family. (BROKE4)`,
  frame `She broke` + `the news` + `gently to the family.`. Also C13 (sense tag).
- blank_fill: prompt `Detectives are looking into the cause of the fire.`,
  frame `Detectives are looking` + `into` + `the cause of the fire.`,
  keyword `into`. Keyword == answer == the only missing word.
- light_verb: prompt `Buses operate a regular service here. (service)`,
  frame `Buses run a regular` + `service` + `here.`.

Why missed: repair-6 predicate `kw6 and (na6 == kw6 ...)` enters but all four
absorption paths (`left_run`, `right_run`, `take_L`, `take_R`) fail closed on
common glue (`in/for/with/at/on` on the right; articles/pronouns on the left).
Fix: extend right-glue to a real preposition set
(`OFTO | {"in","on","at","for","with","from","into","about","over","after"}`)
and left-run stop set to exclude only true blockers; then add post-repair
invariant for gap categories: `if norm(keyword)==norm(answer): quarantine("bare-keyword gap")`
unless category in ("mcq","three_in_one") where keyword is a topic tag by contract
(schema change: document that contract; currently nothing states it).

## C3. Wordform rows with zero transformation

24/570 wordform rows have answer identical to keyword (case aside), so the
"word formation" task is transcription:

- `He bought a cheap red ___ toy. (PLASTIC)` -> answer `plastic`.
- `She bought a fashionable ___ handbag. (LEATHER)` -> answer `leather`.
- `It was obvious that he had not studied. (OBVIOUS)` -> answer `obvious`,
  frame `It was` + `obvious` + `that...` (gap tests a free adjective, no affix).
- `Only adults are legally responsible for the damage. (RESPONSIBLE)` ->
  answer `responsible`.

Why missed: no rule compares keyword to answer for wordform (repair-6's
`na6 == kw6` branch fires but absorption finds no glue, leaving the row).
Fix: hard rule for wordform only:
`if norm(keyword)==norm(answer): quarantine("wordform: no transformation")`.
These are source errors (material words like plastic/leather/grey/tomato used as
attributive nouns), not drills; route to purge list, not repair.

## C4. full_answer not reproducible from frame (stale/ghost material)

66 rows where `norm(prefix + answer + suffix) != norm(full)` (inversion 40,
blank_fill 17, figurative/prep/rephrase 9). The student answering exactly as
marked produces a different (often ungrammatical) sentence than `full_answer`,
which the grader/teacher view trusts blindly:

- inversion x9 `Only after` + answer starting `after ...`:
  pre `Only after`, ans `after finishing his homework was he allowed to play.`,
  suf ``, full `Only after finishing his homework was he allowed to play.`
  (single `after`). Filling the gap yields `...after after finishing...`.
  Same pattern x7 for `Only by` + `by ...` (e.g. ans
  `by adopting sustainable practices can farmers secure food supplies.`).
- prep_idiom: pre `We must take`, ans `into account`, suf `of all hidden costs.`,
  full `We must take into account all hidden costs.` Filling the gap yields
  `take into account of` (ungrammatical); the frame's `of` is stale.
- prep_idiom: pre `The old cottage was put`, ans `up for sale`, suf `purchase.`,
  full `The old cottage was put up for sale.` Suffix `purchase.` is dead text
  repair-2 should have cut (first word `purchase` not in PREPS, no comma) but
  full was already "fixed" while suffix was left behind.
- rephrase: pre `The announcement`, ans `took by surprise`, suf `everyone`,
  full `The announcement took everyone by surprise.` Frame order
  (`took by surprise everyone`) is ungrammatical; object must precede the phrase.
- rephrase: pre `His injury was so severe`, ans `as to rule him out`,
  suf `him from the tournament`,
  full `...as to rule him out from the tournament.` Filling the gap duplicates
  `him` (`...out him from...`).
- prep_idiom: pre `The price went`, ans `down by`, suf `over time.`,
  full `The price went down by ten percent over time.` Full contains `ten
  percent`, present in NEITHER frame nor answer (ghost material from source).

Why missed: repair-3 dedups only the literal trigger `until`
(`norm(prefix)[-1:]==["until"] and answer.startswith("until ")`); `after`/`by`
copies never handled. repair-2's PREPS-membership test (`of` in PREPS) keeps
`of all hidden costs.` although `take into account of` is wrong. Nothing ever
recomputes or diffs `full` against the frame.
Fix: (a) generalise repair-3 to any trigger word:
`m = re.match(r"(\w+)\s", norm(answer)); if norm(prefix).split()[-1:] == [m.1] and category=="inversion": strip + recount`;
(b) terminal invariant for all non-mcq/non-t3 rows:
`assert norm(prefix+" "+answer+" "+suffix) == norm(full)` (mod trailing period,
`'\s+([.,;:!?])'`) else quarantine("frame/full divergence").

## C5. Separable-phrasal gap placed as if inseparable + particle doubling

repair-5 (`repaired_dup_adj`, 18 hits) strips duplication only when an entire
adjacent frame token equals the WHOLE answer. It misses particle-overlap
(`up to`+`to`, `out of`+`of`) and separable verbs whose object sits between
verb and particle in `full` but after the gap in the frame (17 blank_fill rows):

- pre `Could you fill`, ans `in`, suf `me on what happened at the meeting?`,
  full `Could you fill me in on what happened at the meeting?` Gap position
  teaches `fill in me` (wrong); correct order lives only in `full`.
- pre `The hotel put`, ans `up`, suf `us for two nights...`,
  full `The hotel put us up for two nights...` (`put up us` if filled as marked).
- pre `The terrorists gave`, ans `up`, suf `themselves to the police.`,
  full `The terrorists gave themselves up...` (same fault).
- pre `She filled`, ans `in for`, suf `for her sick colleague...`,
  full `She filled in for her sick colleague...` (filled: `in for for`).
- pre `He owned`, ans `up to`, suf `to breaking the window.`,
  full `He owned up to breaking...` (filled: `up to to breaking`).
- pre `The results fell`, ans `short of`, suf `of our expectations.`,
  full `...fell short of our expectations.` (filled: `short of of`).

Why missed: repair-5 compares `norm(toks[0]) == na` (whole-answer equality);
`for` != `in for`, `to` != `up to`, so no strip. No rule models
verb+particle+preposition overlap or separability.
Fix: (a) overlap rule: while the answer's trailing token(s) equal the suffix's
leading token(s) (case-insensitive, 1-2 tokens: `up to|to`, `out of|of`,
`down to|to`, `in for|for`, `away with|with`, `back on|on`), strip from suffix
and rebuild full; (b) separability check: for phrasal answers, if
`full != frame-fill` but `full` contains `verb ... answer...` with an object
pronoun/noun between, move the gap: quarantine("separable gap misplaced") for
human re-split, since auto-fix needs a parse.

## C6. repair-6 manufactures leading-conjunction answers (repair-0 never re-runs)

repair-0 (`repaired_lead_conj`, 32 hits) strips `and|or|nor|but` from answer
start, but runs BEFORE repair-6 (`repaired_kw_widen`, 488 hits), whose left-run
absorption does not stop at conjunctions (ENDSTOP lacks `and/or/but/yet/so`).
Result: 5 rows in corpus whose answer begins with a conjunction:

- binomial: pre `He keeps chopping`, ans `and switching change`, suf `.`,
  full `He keeps chopping and switching change.`
  (source: pre `He keeps chopping and switching`, ans `change`, suf ` plans.`;
  repair-2 cut the suffix, then left-run absorbed `switching` AND `and`.)
- binomial: pre `He won by hook`, ans `or by crook`, suf `.`,
  full `He won by hook or by crook.`
  (source suf ` cheating.` cut by repair-2; left-run absorbed `by`,`or`.)
- binomial: pre `Take it`, ans `or leave`, suf `.`,
  full `Take it or leave.` (left-run absorbed `or`; also C-alternative: true
  idiom is `take it or leave it`, truncated).
- binomial: pre `The mission is do`, ans `or die`, suf `.`,
  full `The mission is do or die.`
- blank_fill: pre `The prize went to him`, ans `and her`, suf `.`,
  full `The prize went to him and her.`

Why missed: single linear pass, no fixpoint; ENDSTOP has no conjunctions/
prepositions (`and,or,but,by`), so `left_run` happily absorbs frame glue into
the answer, and the pure-regrouping check (`norm(new)==norm(old)`) approves
because token multiset is unchanged.
Fix: (a) add conjunctions + prepositions to the left-run stop set
(`ENDSTOP |= {"and","or","nor","but","yet","so","by","at","on","in","of","to","for","with"}`);
(b) run repairs to fixpoint (max 3 iterations) or at minimum re-run repair-0
after repair-6; (c) terminal predicate: `if norm(answer).split()[0] in
("and","or","nor","but"): quarantine("leading conjunction")`.

## C7. MCQ structural rot: letters as alternatives, `...` frames, 3-option row

- alternatives hold the answer LETTER, not alternate phrasings, in ALL 1083 mcq
  rows (`Counter: ('A',) 557, ('B',) 179, ('C',) 176, ('D',) 171`).
  `canon`'s alt filter (`norm(a)!=norm(ans)`) cannot catch single letters, and
  the frontend contract for `alternatives` (accepted paraphrases, cf. `fuzzy_accept`)
  is silently violated: e.g. ans `air`, alts `['A']`, opts
  `['air','sky','cloud','wind']`.
- 125/1083 mcq rows have placeholder frames: pre `...`, suf `...`,
  full `... air...` (e.g. `The project is still up in the ____; nothing has been
  decided.`; `He spilt the ____ about the exam leak...`; `His business went ____
  after the crisis...`). `derive_full` only synthesises `full_answer` when it is
  EMPTY, so source-supplied garbage (`... air...`) passes `validate` (non-empty
  strings) untouched.
- 1 mcq row has 3 options in corpus despite `validate` requiring exactly 4:
  prompt `The court must stay ____ from political pressure.`, ans `independent`,
  opts `['inherent','intimate','independent']`. Source had 4 with a duplicate
  (`["inherent","intimate","inherent","independent"]`); `validate` counted 4
  pre-canon, then `canon`'s `dict.fromkeys` dedup shrank it to 3. No
  post-canon re-validation exists.

Why missed: validation-before-canonicalization ordering; `derive_full` treats
any non-empty `full_answer` as authoritative; `alternatives` semantics for mcq
unchecked.
Fix (schema + order): (a) for mcq, require
`all(len(a)>1 or a.upper() not in "ABCD" for a in alternatives)` else drop/flag
("letter leak"); better, schema change: mcq rows must not carry `alternatives`
at all (fuzzy-accept the option text; store correct index separately if needed);
(b) reject placeholder frames: `if set([pre.strip(), suf.strip()]) <= {"...",""}: derive from prompt.replace("____", ans)` and if prompt lacks the
stem, quarantine; (c) move `validate` AFTER `canon` (or add a second
`validate_canon` pass: mcq options still 4 and answer still in options,
inversion answer still >=3 tokens).

## C8. MCQ distractors: ambiguous, ungrammatical, or duplicated

`validate` checks only `answer in options`; distractor quality is never examined.

- Ambiguous (two options fit): prompt `The scientist is ____ respected in her
  field.`, opts `['highly','deeply','bitterly','utterly']`, ans `highly` —
  `deeply respected` is equally idiomatic, so the item has two correct answers.
- Ambiguous + broken distractor: prompt `A: "Would you like some more cake?"
  B: "____. I'm on a diet."`, opts `["I'm good","I'm well","I'm fine price","I'm nice"]`,
  ans `I'm good` — `I'm well` also fits the refusal context, while
  `I'm fine price` is word salad (truncated `I'm fine`?).
- Unidiomatic distractor: prompt `A: "You broke my phone!" B: "____! It was an
  accident."`, opts `['Calm down','Cool off the phone','Quiet up','Silent down']` —
  `Cool off the phone` is not English (conflates `cool off` + `hang up`).

Why missed: no distractor audit of any kind (not even "distractor != answer
modulo case", which C7's dup row also violates).
Fix: cheap automatic gates — (1) near-duplicate options
(`difflib.SequenceMatcher > 0.85` or shared stem) quarantine for review
(catches the `inherent/inherent` collapse and `I'm fine price` class via
language-model-free anomaly? no — keep human queue); (2) flag synonym-cluster
options (WordNet/collocation list for degree adverbs: highly/deeply/greatly)
as "needs two-key check"; (3) schema change: add optional `distractor_notes`
and require human sign-off tag for dialogue-response items, which are the
ambiguity hotspot.

## C9. Inversion frames: split triggers, doubled `after/after`, stacked adjuncts

- Split fronted trigger: pre `Not`, ans `until it was explained`,
  suf `did she understand the problem.`,
  full `Not until it was explained did she understand the problem.`
  (`She did not understand the problem until it was explained. (until)`).
  The gap splits the adjunct (`Not |___| did...`) instead of testing the
  inversion (`Not until it was explained |___|`). repair-3 only strips `until`
  when prefix ENDS with it; bare `Not` never matches.
- Doubled trigger (same 16 rows as C4, inversion facet): `Only after` +
  `after finishing...`; `Only by` + `by adopting...` — gap includes a copy of
  the prefix's last word(s).
- Stacked time adjuncts: pre `At no time`, ans `during the journey did she
  feel safe.` / `during the trial was the victim present.` /
  `that night did the guard leave his post.` Fulls (`At no time during the
  journey did she...`) are grammatical but stylistically broken (double time
  reference); the natural answer excludes the adjunct
  (`did she feel safe during the journey`).
- Missing comma after fronted conditional: bare-`Had` rows split 11 with comma
  vs 6 without: `Had he driven carefully there would have been no crash.`,
  `Had he studied he would have passed.`, `Had I known I would have helped.`,
  `Had it not rained we would have gone`, `Had they left earlier they would
  have arrived` vs `Had I known the answer, I would have raised my hand.`

Why missed: `validate` for inversion only counts answer tokens (>=3);
`warn` checks an auxiliary in the first 6 tokens of prefix+answer (36 warnings
fired) but nothing checks trigger integrity, adjunct stacking, or punctuation.
Fix: (a) trigger-integrity rule: maintain
`TRIGGERS = {"not until","only after","only by","only if","only when","no sooner","not only",...}` —
if `norm(prefix)` is a strict prefix of a trigger and `norm(answer)` starts
with the remainder, merge trigger into prefix and quarantine("split trigger");
(b) dedup rule generalised from repair-3 (see C4 fix);
(c) punctuation rule: `if full matches ^Had\s[^,]+?\s(would|will|...): suggest comma`
— at minimum enforce consistency: quarantine inversion fulls where a fronted
conditional clause lacks a comma.

## C10. Sentence punctuation stored inside answers (528 rows)

- inversion 360 rows: ans `did he show any sign of regret.` /
  `did the witness lie to the police.` / `was the price mentioned in the talk.`
  (trailing `.` baked into the gap answer).
- rephrase 167 rows: ans `he is poor,` / `it was cold,` / `All else failing,`
  (`All else failing,` + `we can take the night train.` — leading capital +
  trailing comma inside the answer).
- mcq 1 row similarly affected.

Why missed: `canon` strips whitespace only; no `re.sub(r"[.!?;,:\s]+$", "", ans)`
anywhere; `validate` never inspects answer characters. Downstream effects:
`full_answer` assembly double-punctuates, `norm`-based dedup/conflict keys treat
`regret.` and `regret` as different (near-dup leak), and answer-length token
counts shift.
Fix: in `canon`, `ans = re.sub(r"\s+", " ", e["answer"]).strip().rstrip(".!?")`
then handle commas: quarantine (not strip) answers ending `,` for rephrase
(sentence-initial adjuncts should be re-split: prefix should carry them or the
answer lowercased without comma), strip otherwise. Add
`validate` rule: `if re.search(r"[.!?]$", answer): fatal`.

## C11. three_in_one: untested fit, uppercase leak, vacuous prompt

- 401/536 rows have `keyword == answer` (all `Fill ONE word...` rows, e.g.
  `speech`/`cool`/`utter`); the remaining 135 phrasal rows have keyword = bare
  verb (`put` for `put forward`). No validator checks that the word fits all
  three sentences — the ONLY check is `____` present in each option — and
  several triples stretch or break:
  - ans `speech`: `The pupil read his poem aloud with clear ____.` (`clear
    speech` is unnatural; `clear voice/delivery` expected) and `Interjections
    are the smallest part of ____.` (factually wrong: interjections are a part
    of speech, not "the smallest" one).
  - ans `calm`: `The hall stayed ____ during the sad news.` (a hall cannot be
    calm; inanimate-subject stretch) alongside `The pilot asked all to stay
    ____ and seated.`
  - ans `empty`: `The promise proved a set of ____ words.` (`a set of empty
    words` is an odd collocation masking the test).
- `derive_full` leaks the answer in ALL CAPS:
  full `'The wind shouted' is a figure of SPEECH called personification. / ...`
  Any UI showing `full_answer` as explanation reveals the key; and the
  uppercase transform is lossy for phrasal answers.
- prompt is content-free (`Fill ONE word/phrasal verb that fits all three
  sentences`) with `gap_prefix/suffix` always empty — the only category allowed
  empty frames, but nothing enforces "exactly this category may do that", and
  gap-conflict dedup keys on an empty frame + generic prompt, so two different
  T3 sets with identical options but different answers would silently keep-first.

Why missed: category-specific contracts live only in two `if` branches of
`validate`; fitness is human-only by design but there is not even a mechanical
sanity net (agreement, POS).
Fix: (a) mechanical pre-screens that quarantine for human review:
article-agreement (`a ____` + vowel-initial answer), determiner-number
(`these/those/many ____` + singular), duplicated-sense options (two of three
sentences share >70% token overlap — paraphrase dupes, not distinct senses);
(b) schema change: `derive_full` must not uppercase — store
`full_answer` with the natural-cased answer (or drop `full_answer` for T3 and
render `options` with the accepted word, since grading already needs the word);
(c) `validate`: T3 `keyword` must equal answer (single) or be its head verb
(phrasal) — currently 401 equal by accident of sourcing, not by check.

## C12. Difficulty labels are unvalidated and internally inconsistent

`canon` only clamps to {1,2,3}. Distributions prove divergent source rubrics:
blank_fill has NO d1 (273 d2 / 266 d3); inversion is 474 d3 / 30 d2 / 0 d1;
wordform and mcq have no d1 at all; binomial is bimodal (232 d1 / 59 d2 /
224 d3, i.e. two merged conventions). Same-construct pairs sit at opposite ends:

- Adjective order (identical task): `He lives in a ____ house...`
  (`beautiful large old stone`) d3 vs `He drives a ____ van...`
  (`big old white German`) d2.
- `comply`: prep_idiom `They fully comply with safety rules. (COMPLY2)` d1
  (also self-answering, C1) vs blank_fill `All citizens must comply ____
  traffic regulations.` d3.
- Trivial-at-d3: `The project is still up in the ____` (`up in the air`,
  one of the commonest idioms) d3; wordform `A good teacher is tolerant...`
  `(TOLERATE)` d3 for a regular -ant adjective; `She has just bought ____`
  (basic adjective order) d3.
- Hard-at-d1: light_verb d1 bucket (354 rows) holds items like `cast doubt on`
  / `shed light on` style material (spot-check; full audit needs a pass).

Why missed: difficulty is free-form per source file; merge never audits,
normalises, or cross-checks it.
Fix: (a) immediate: per-category distribution report in merge output with a
fail threshold (e.g. any level holding <5% of a category with n>200, or
identical-task divergence) — quarantine nothing, but block silent acceptance;
(b) structural: schema change — replace author-assigned 1/2/3 with a computed
prior (length + frequency band of answer + category base rate, e.g.
`base = {"inversion":3, "rephrase":3, ...}`) plus optional human override field
`difficulty_override`; SRS (`srs_update`) should consume empirical success
rates to converge labels over time rather than trusting source integers.

## C13. Sense-tagged keywords (BROKE3, POSES2, HIGHLY2, COMPLY2) have no schema

Keyword values like `BROKE3`, `BROKE4`, `POSES2`, `DEEP2`, `HIGHLY2`, `COMPLY2`
appear in figurative/wordform rows (e.g. `He broke his long silence at the
meeting. (BROKE3)`, ans `silence`; `Rising costs pose a problem. (POSES2)`,
ans `problem`; `They fully comply with safety rules. (COMPLY2)`). They can
NEVER occur in text, so `warn`'s "keyword appears in neither answer nor full"
fires on them as noise (410 warnings, mostly this + inflections), and `canon`'s
bracket-derivation (`m.group(1)`) would propagate the digits into any keyword-
dependent feature (hints, distractor generation, search).

Why missed: keyword is an untyped string; no distinction between surface form,
lemma, and sense id.
Fix (schema change): split into `keyword` (surface/lemma form as shown to the
learner: `BROKE`) + optional `sense` (id string: `BROKE3`), with
`validate: if re.fullmatch(r"[A-Z]+\d+", keyword): fatal("sense tag in keyword; use sense field")`
plus a one-time migration `re.sub(r"\d+$", "", kw)` -> `keyword`,
digits -> `sense`. Update `warn` to compare the lemma, silencing ~410 noisy
warnings and leaving only genuine inflection mismatches (RUN/ran, MAKE/made —
201 wordform + 109 light_verb + 84 prep_idiom rows where keyword is the base
form; decide per category whether that is intended and encode it).

## C14. Wrong alternative answers and truncated binomials

`alternatives` are never substituted into the frame to test grammaticality, and
binomial "idioms" are never checked against a canonical list:

- binomial alt `turn` for ans `twists and turns`
  (`The road has twists and turns.` -> `*The road has twists and turn.`).
- binomial alt `dry` for ans `cut and dried`
  (`The decision was cut and dried.` -> `*The decision was cut and dry.` —
  misspelling of `dried`).
- binomial alt `haw` for ans `hawed`
  (`She hemmed and hawed.` -> `*She hemmed and haw.` — bare form after -ed).
- light_verb alt `chase to` for ans `chase`: full is `Police gave chase the
  robber through streets.` — NEITHER answer (`*gave chase the robber`) NOR
  alternative fits the stored frame; the alternative is the evidence that the
  frame is missing `to` (`gave chase to the robber` / `gave chase to`).
- Truncated idiom stored as canonical: prompt `Take it or keep it. (LEAVE)`,
  frame `Take it` + `or leave` + `.`, full `Take it or leave.` The actual idiom
  is `take it or leave it`; the lone `it` was eaten (compare sibling row
  `Take it or leave it`-shaped source `Take it or ___ it keep it.` whose suffix
  repair-2 mangled). Similarly `Give me the short.` (prompt `Give me the
  summary briefly. (short)`) is not an idiom at all (`in short...`? `short and
  sweet`? unrecoverable — purge, not repair).

Why missed: alternatives bypass all frame logic (`canon` only norm-dedups them
against the answer); repair-2's suffix truncation (`first not in PREPS and no
comma -> cut to "."`) can amputate true complements (`it keep it.` ->
`suffix "."`, producing the truncated `Take it or leave.`).
Fix: (a) alternative-acceptance test: for each alt, rebuild
`prefix + alt + suffix` and require (i) token-bag compatibility with full
(same multiset modulo the answer span) and (ii) a POS/shape sanity proxy
(same token count ±1, same head word class via suffix rules: -ed/-s preserved);
quarantine failures as ("alt ungrammatical: ..."); (b) binomial allow-list:
`full` must contain a pair-link (`and|or|nor|not only|from.*to|by.*by`) or match
a curated idiom list, else quarantine("unpaired binomial"); (c) constrain
repair-2: only truncate the suffix when the REMAINDER after the binomial still
parses as an adjunct (starts with comma or PREPS + NP), never a bare pronoun/
noun (`it`, `plans`?) — `Take it or leave it keep it.`-style pileups need human
re-split, not silent amputation.
