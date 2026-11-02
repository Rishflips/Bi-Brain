# Plan 7 (sweep and calibrate): rulings and follow-ups

Recorded while executing `docs/superpowers/plans/2026-11-01-sweep-calibrate.md`, as `Ruling: <decision> — <why> — <cost if wrong>`.

- Ruling: accept R1 (Clef DURABLE_LOW 0.25 -> 0.20) on the single live case (decision scored 0.23) — below the line is only a x0.9 rank demotion, never an exclusion; the owner is told it rests on n=1 — if wrong, a few low-value notes rank slightly higher.
- Ruling: accept R3 (report opens SQLite read-only via node:sqlite, not Storage, whose constructor writes) and R4 (no note-text flag at all) — stricter privacy — none.
- Ruling: B1 fixture note "Hydra status paused" with no full stop (the status grammar needs no punctuation) — none.
- Ruling: I1 the native proof counter counts only the exact /api/v1/agent/recall path; the hook stays on (real-user fidelity); a test pins the counter — if wrong, the proof miscounts and the owner sees a false result.
- Ruling: I2 every DB error after open is one plain sentence and exit 2, no e.message — none.
- Ruling: I3 Task 6 tests get 60 s timeouts — none.
- Ruling: M1-M12 applied as suggested (wording "does not change your data or settings"; stderr refusals; null-prototype maps; docs API/AGENT_INTEGRATION; count agreement; spec sentence; finally close) — none.
- Ruling: parked — non-200 counter case not unit-tested (the check is in the script's hook); workspace cleanup skipped only if the root guard throws (cannot in practice) — cosmetic.
- Ruling: Task 4 SAFE_KEY tightened to /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/u — the brief's regex admitted __proto__ and its own test failed — if wrong, a legitimate key starting with _ is hidden from the report.
- Ruling: parked — no test pins the empty-dense row or the secret-quietened row (code paths verified by reading) — if wrong, a future change could add a field there unnoticed.
- Ruling: parked — `--db --json` treats --json as the path (gives a plain refusal); KNOWN_MIGRATION duplicates Storage's literal 7 (a future migration makes the report refuse a newer brain until updated — safe failure); one vacuous existsSync assertion in the newer-brain test — low cost.
- Ruling: the Fable final review runs on Tasks 1-6 (88e8756..ee27999) BEFORE Task 7, so the full gate runs once after any fix wave (same as plan 6) — none.
- Ruling: one fix wave (Sonnet) covers I1 plus M1-M7 and M9 where each is small; M8 ("Codex hook on, expected to...") is carried into Task 7's docs — none.
- Ruling: Task 7 is split. A Sonnet implementer writes the docs (owner calibrate docs, API/AGENT_INTEGRATION log fields, NATIVE_CLIENT_SETUP with M8's "expected to" wording, no "model-free" claim per M7). The controller then runs the full gate and fills in the BUILD_STATE/README counts — none.
- Ruling: dependency advisories are out of scope (plan 7 is sweep/calibrate; the gate is high-only); report them to the owner and offer a follow-up — if wrong, moderate advisories stay open a little longer.

## Parked for later

- Moderate dependency advisories, all published after plan 6:
  - `@hono/node-server` has a non-breaking fix via `npm audit fix`.
  - `glob` and `minimatch`, through `@fastify/static` and ESLint, can only be fixed by a breaking downgrade.
  - The CI gate is `--audit-level=high`, so it still passes.
- Three frozen billing test files need the Windows folder `C:/Users/Gowrishankar/AppData/Local/Temp/opencode` to exist. If a temp cleanup removes it, 75 tests fail with "The approved Windows fixture base is missing". Creating the folder fixes it.
- The owner still owes these runs: `npm run calibrate` on real data (it needs 20 answers per question before it suggests anything), `npm run proof:search`, and `scripts/native-client-proof.ts`.
