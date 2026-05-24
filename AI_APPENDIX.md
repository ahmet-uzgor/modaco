# AI Collaboration Appendix

> **Reviewer note for the candidate (please remove or rewrite before
> submitting):** This file was drafted by Claude (the AI used for most of
> the implementation) based on what actually happened during the build
> sessions. The plan explicitly warns against fabricated AI mistakes;
> every example below is a real moment from this codebase's history. You
> should still read it end-to-end, adjust the voice to your own, drop any
> example you don't remember firsthand, and add or swap in better ones
> you do remember. The interviewer will probe — speak to what you
> actually saw.

## 1. Tools used

- **Claude Code (Anthropic Claude, sonnet/opus depending on the task)** —
  used for the bulk of the architectural conversation, the implementation
  of each phase, and the code-review style critique inside each commit
  message. Claude had read access to `modaco-implementation-plan.md`
  throughout, so it knew the non-negotiables before writing a line of
  code.
- **VS Code with the Claude Code extension** — for in-editor file
  diffs, running shell commands against the local Docker stack, and
  approving destructive operations explicitly.
- **No GitHub Copilot, no Cursor, no chat-only frontends.** A single
  agent in the loop with the codebase made the AI-mistake corrections
  much easier to trace.

## 2. The two most critical prompts

### Prompt A — phase kickoff with the plan as source of truth

The very first turn that mattered was a single sentence: a pointer to
`modaco-implementation-plan.md` plus the directive *"read it and do
Phase 1 — Nest.js inside this folder, don't create a new one"*. Two
things in that prompt did the heavy lifting:

- **Naming the plan as the source of truth.** Without that, the model
  would have defaulted to its own opinionated stack. The plan's
  "Common AI Mistakes to Watch For" section (§18) was particularly
  important here — Claude actively avoided patterns it would otherwise
  have suggested (e.g. computing `effective_price` at read time, JS
  `number` for money, individual `INSERTs` for materialization).
- **A small but firm constraint up front.** "Don't create a new folder"
  pre-empted Claude's default `nest new modaco-promotion-api` and forced
  it to scaffold in place, which kept the git history clean.

### Prompt B — committing each step of each phase separately

Mid-way through, I told the model: *"git add and commit with conventional
commit; after this do add and commit for each step separately in
phase"*. That single sentence reshaped the entire collaboration from
"one big diff per phase" into a granular history where every commit is
buildable, reviewable, and reverts cleanly. The plan itself doesn't
prescribe a commit cadence; this was the prompt that made the git log
match the case study's "show your work" expectation.

## 3. The most significant AI mistake and how it was corrected

**The mistake:** in the ingest processor's bulk `INSERT` of
`ingest_row_results`, Claude wrote an `UNNEST` over four parallel arrays —
`batch_ids`, `row_keys`, `statuses`, `errors`. The first three are pure
text arrays. The `errors` array was deliberately nullable: `null` for OK
rows, a string for FAILED rows. Claude passed the JS array straight to
Prisma's `$executeRaw` template literal, the same pattern that worked
for the bulk product upsert.

The first time this ran in a test where *every* row failed (or every
row succeeded), the array was either all-string or all-null and Prisma
serialized it fine. The first time it ran with a *mixed* array —
`[null, 'sku: must contain at least 1 character', null]` — Postgres
rejected it with `ERROR: improper binary format in array element 2`.
The entire ingest batch was rolled back and recorded as `FAILED`.

**How I noticed:** the partial-failure e2e test passed when run in
isolation and failed when run after the happy-path test. That ordering
sensitivity was suspicious — it implied state leakage, but the test
suite already truncated tables between specs. Running the suite with
`--testNamePattern` to isolate the failing test and grepping the logs
for `ingest batch failed` surfaced the actual Prisma error.

**The fix:** an empty-string sentinel. `null` is encoded as `''` on the
way out of Node, the SQL `SELECT` clause uses `NULLIF(error_message,
'')` on the way in. Same semantics, but Prisma's `text[]` parameter
binding stops choking. Two-line patch
([processor.service.ts](src/ingest/processor.service.ts), see the
`recordRowResults` method).

**What confirmed the fix:** the partial-failure e2e test now passes
deterministically regardless of run order, and the four-test ingest
suite is green. More importantly, the underlying invariant — null
`error_message` means "no error" — is preserved end-to-end; the
sentinel never leaks out of the SQL.

What this taught me about working with the AI: Claude's patterns are
locally correct (UNNEST over parallel arrays is the right shape) but
the tool stack details (Prisma's specific `text[]` parameter behaviour
on mixed-null arrays) can quietly break. The fix wasn't subtle once the
error was in hand — but reading the actual Postgres error message
mattered, and so did not trusting that "the same shape worked over
here" implies "it'll work over there".

## 4. Other notable corrections

- **Prisma "drift" on every new migration.** The Phase 1 init migration
  contains hand-written SQL for the partial indexes the plan called
  for (`idx_promotions_active_window` and friends). Prisma's DSL
  can't express `WHERE` clauses on indexes, so every subsequent
  `migrate dev` ran detected the partial index as "missing" and tried
  to re-create the full version. I caught it the first time I tried
  to add the `compute_effective_price` SQL function and Prisma
  generated a one-line migration recreating an index I'd deliberately
  dropped. **Fix:** dropped the `@@index` annotation from
  `prisma/schema.prisma` so Prisma stops claiming it should exist.
  Drift detection is silent now.

- **`Decimal#toString()` trims trailing zeros.** Claude initially
  asserted in `money.spec.ts` that `toScale(money('1.004')).toString()
  === '1.00'`. That's wrong — `Decimal.toString` returns `'1'`, no
  trailing zeros. The two-decimal padding is `formatMoney`'s job.
  Caught by the unit suite the first time it ran; one-line test fix.
  Small but representative — the AI's mental model of the library
  was off by one method.

- **Nest's `ConflictException` body shape.** The first version of the
  promotion-conflict e2e test asserted `response.body.message`
  matched an object. Nest serializes a payload object passed to
  `ConflictException` to the *top level* of the response body, not
  under `.message`. The test failure was unmistakable when I read it,
  but the wrong assumption came from a halfremembered Nest convention.
  One-line test fix.

- **JobRunner shutdown race in e2e tests.** Tests that posted a
  CATEGORY-scope promotion enqueued background materialization. When
  the test file's `afterAll` ran `app.close()`, `PrismaService.onModuleDestroy`
  sometimes disconnected the client before the JobRunner's drain
  finished. The job then hit "Transaction not found". **Fix:** every
  e2e spec now calls `ctx.jobs.flush()` in `afterEach` and again in
  `afterAll` before `app.close()`. Background work always lands
  against a live Prisma connection.

- **CSV empty cells aren't `undefined`.** The Zod schema for the
  vendor ingest row had `vendor_cost: decimalString.optional()`.
  `csv-parse` with `columns: true` emits `''` for blank cells, not
  `undefined`. `''` failed the regex, recorded the row as `FAILED`,
  and a 4-row fixture turned into a 2-row insert. **Fix:** a Zod
  `preprocess` step that maps `''` to `undefined` before the
  `.optional()` branch picks it up. Generic enough to add for any
  future optional CSV column.

- **`decimalString` regex was too strict.** The same Zod schema
  insisted on `\d+(\.\d{1,2})?` for `base_price`. Vendor feeds in
  the wild ship 3-decimal prices (`99.995`). The pricing rule was
  supposed to be the one normalising to two decimals, but the
  schema rejected the row before the rule got a chance. **Fix:**
  loosened the regex to `\d+(\.\d+)?` so the pricing rule owns
  HALF_UP rounding end-to-end.

## 5. Where AI was genuinely helpful

Being honest about what AI did well matters as much as what it got
wrong:

- **Test scaffolding.** Every spec in `test/` and every `.spec.ts`
  alongside source was scaffolded by Claude in one pass and then
  iterated under my guidance. The `e2e-utils.ts` harness in
  particular — global setup with a `modaco_test` Postgres DB, a
  truncate-between-tests helper, the `JobRunner.flush()` plumbing —
  is something I'd have built more slowly by hand.

- **Long-form documentation in commit messages.** The commit log on
  this branch reads almost as well as this appendix because Claude
  wrote each commit body to my standing instruction to explain *why*,
  not *what*. That's a force multiplier for code review.

- **SQL ergonomics.** The bulk `INSERT ... SELECT ... FROM UNNEST(...)`
  pattern for the materialization service and the ingest processor
  came directly from Claude's first draft. I tweaked it (see the
  mixed-null `text[]` story above) but the shape was right and saved
  me time I'd have spent reading the Postgres docs.

- **Prompt-resistance to bad ideas.** Several times Claude flagged
  that something the plan called out as an anti-pattern was about to
  be implemented, and proactively avoided it. The most visible
  example: when I asked it to add ingest, the response started with a
  recap of the splitter+SQS+processor design and never even
  considered "let's stream the whole file in one Lambda".

Net assessment: the collaboration produced a better artefact than I
would have produced solo in the same time budget, and the failure
modes were the ones the plan predicted — small tool-detail mistakes
caught by tests, not architectural drift.
