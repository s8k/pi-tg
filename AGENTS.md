# AGENTS.md

Instructions for AI coding agents working in this repo.

## API spec sources

When implementing or verifying API behavior, use the following as the source of
truth:

1. **Telegram Bot API** (latest):
   <https://core.telegram.org/bots/api>
   — Bot API methods, update objects, message entities, rate limits (429 /
   `retry_after`), `parse_mode: HTML` rules, the 4096-char message limit, etc.

2. **Pi coding agent docs** (latest):
   <https://github.com/earendil-works/pi/tree/main/packages/coding-agent/docs>
   — extension API, TUI/session APIs, events, and command handling used by
   `index.ts` and the wiring in `src/wiring.ts`.

Always check the *latest* version of these docs; do not rely on cached or
outdated assumptions. If a behavior differs between your local knowledge and
the live docs, the live docs win.

## Terminal commands: always use a timeout

Never run a command that could take long (searches, `grep`, `find`, builds,
tests, network calls) without a timeout. There have been cases where `grep`
commands ran for 500+ seconds and never finished until manually killed.

- Pass a timeout to the bash tool (e.g. 30–60 s) for any command that could
  scan or wait for a long time.
- Scope searches to the repo's own code — never let them wander into
  `node_modules/` or other large generated dirs (exclude them explicitly,
  e.g. `grep -r --exclude-dir=node_modules …`).
- If a command hits the timeout, do not just re-run it blindly: diagnose
  (wrong path? missing exclusion? too-broad pattern?) and retry narrowed, or
  note it and move on.
