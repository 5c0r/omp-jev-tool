# omp-jev-tool

OMP-only extension for Oh My Pi 18.3.4+. Finds relevant **currently registered**
tools, including active and inactive tools, without running them.

## Install

```sh
omp install github:5c0r/omp-jev-tool#feat/omp-jev-tool
```

This branch install is for PR review. After merge to default branch, use
`omp install github:5c0r/omp-jev-tool`. Git installs use OMP's bundled Judge;
the large `@oh-my-pi/pi-coding-agent` package is a **development-only** type/test
dependency, not a runtime dependency. No TypeSafe API key is configured here.

## Use

- `/jev-tool <task>`: show scored matches and Judge diagnostics.
- `jev_tool` model-facing tool: same search, with `task` string parameter.
- `/jev-tool-config` or `/jev-tool-config status`: show active-profile settings
  and file path (`omp config path` gives the profile directory).
- `/jev-tool-config set <key> <value>`: update settings for subsequent calls,
  including after restart.

| Setting | Default | Values |
| --- | --- | --- |
| `debug` | `true` | `true`, `false` |
| `autoSuggest` | `false` | `true`, `false` |
| `checkCalls` | `false` | `true`, `false` |
| `threshold` | `0.65` | finite number from 0 to 1 |
| `timeoutMs` | `10000` | integer from 100 to 20000 |

Config lives at `<active agent dir>/jev-tool.json`, separate from plugin files.
Writes lock, fresh-read, then atomically replace file; a crash holding
`jev-tool.json.lock` fails closed until stale lock is removed manually.

Each registered candidate gets a native Judge yes probability; bounded
16-candidate batches cover the full inventory. Accepted hits include name,
description, active state, score/gauge, and parameter schema where available.
Output displays top five per group with explicit omitted counts; all candidates
are still judged. Debug mode shows rejected/unjudged groups. Results report
actual provider/model, elapsed time, token usage/cost, and any Judge error.
Scores measure **tool relevance**, not correctness of proposed arguments.
Judge calls can incur provider charges.

`autoSuggest` is opt-in and default-off. Judge work starts after `agent_start`,
never inside the input-sensitive `before_agent_start` hook. After a complete
successful report, accepted tools are added by union with the current active
list; existing tools are never removed or restored. Up to three accepted
matches arrive as a non-interrupting aside. OMP approvals and execution stay
unchanged.

Migration: `autoSelect` was removed and is now rejected as an unknown setting.
Remove it from `jev-tool.json`; set `autoSuggest` to `true` to opt into v2
additive routing and aside suggestions. The default remains off.

`checkCalls` compares model tool choice against the most recent prompt, **not
raw tool arguments**, and advises only callable (active) alternatives above
threshold. Enabling `autoSuggest` or `checkCalls` sends prompt context to the
configured Judge provider. If Judge lacks auth, fails, returns malformed
answers, or times out, no tools are activated and no aside is sent (including
after a partially scored batch). A new prompt or `agent_end` cancels old work;
stale results are silently discarded. Explicit search still reports Judge
errors. No extra model fallback.

OMP's public `sendMessage` is fire-and-forget; the host normalizes images before
rechecking whether the agent is streaming. If a turn ends after the extension's
final check but before that host check, an idle aside can start a turn. The
public `setActiveTools` API also has no cancellation signal. The extension
checks immediately before dispatch, but this narrow host-side race is not
atomic or structurally eliminated.

## Develop

```sh
bun install --frozen-lockfile
bun test
bun run typecheck
```
