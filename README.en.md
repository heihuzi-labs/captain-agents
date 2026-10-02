<div align="center">

# Captain Agents · 船长派活

Let one AI run the show and hand the coding work to the Codex, Grok and Cursor CLIs on your Mac, plus DeepSeek running through Codex.

[简体中文](README.md) · English

</div>

![The board](docs/images/board.png)

## What it is

If you pay for more than one AI coding tool, the obvious idea is to let one of them, say Claude, act as the lead: it splits the work, hands pieces to the others, and only reviews and signs off.

Try that for a few days and the cracks show. Who is doing what, and how far they got, lives only in the lead's chat, and it's gone once the chat gets compacted. Every dispatch needs the right restrictions on the other vendor's CLI; forget them once and the worker can touch files it shouldn't. A worker says "all tests pass" and a rerun says otherwise. After a while, who is good at bug fixes, who oversells, and who is cheapest is just a vague feeling.

Captain Agents is the small tool that pins that routine down:

- One command gives each job its own git worktree and sends the brief out. The same brief can go to several workers at once so you can compare.
- Workers only write inside their worktree, only reach their own vendor's model servers, can't read your secrets or other vendors' logins, and can't change any AI's global config. The limits live in the code, a self-check runs daily, and nothing gets dispatched if it fails.
- When a job is done, the lead reruns the checks outside the sandbox and records the result, instead of taking the worker's word for it.
- The lead scores every job and leaves a note. Over time that adds up to a profile per worker: completion rate, pass rate, time, quota spent. The next time you pick someone, you have something to go on.

On your side there is a desktop app. The board shows what's running and what's done; open a job to see progress, leave the lead a note, or pick "use this one". The dispatching, verifying and merging are done by the lead from the command line.

> Formerly piework (派活工作台). The desktop app still carries that name for now, the CLI is called `xagents` and keeps its data in `~/.xagents`; a later release will rename them. The app and CLI messages are in Chinese for now; commands and flags are plain ASCII.

## A quick look

<table>
<tr>
<td width="50%"><img src="docs/images/job.png" alt="Job details"><br><sub>A job: what it's for, where it's at, a note to the lead</sub></td>
<td width="50%"><img src="docs/images/history.png" alt="History"><br><sub>History: one brief sent to two workers, with their scores and notes</sub></td>
</tr>
<tr>
<td><img src="docs/images/stats-dark.png" alt="Performance"><br><sub>Performance: how much got done, how much got used, what it cost</sub></td>
<td><img src="docs/images/settings-workers.png" alt="Workers and models"><br><sub>Settings: allowed workers and efforts, how many at once, when to stop on quota</sub></td>
</tr>
<tr>
<td><img src="docs/images/settings-connect-dark.png" alt="Connect AIs"><br><sub>One-click connect, so Claude, Codex, Grok and Cursor all remember to use piework</sub></td>
<td><img src="docs/images/decide.png" alt="Pick one"><br><sub>Both workers finished: pick the one to use, or neither</sub></td>
</tr>
</table>

## Getting it running

You need a Mac (only tested on Apple silicon so far), Node.js 24 or newer, and pnpm. Also install and sign in to at least one of: [Codex](https://github.com/openai/codex) (by default the copy bundled with the ChatGPT app; set `XAGENTS_CODEX` to use another), the Grok CLI `grok`, or the Cursor CLI `cursor-agent`. For DeepSeek, install Codex and run `xagents login deepseek`, then paste your DeepSeek API key (pay per use). Codex keeps the key in a separate folder of its own, so your ChatGPT login is not touched.

```sh
git clone https://github.com/heihuzi-labs/captain-agents.git && cd captain-agents
pnpm install
ln -s "$PWD/bin/xagents" ~/.local/bin/xagents

xagents selfcheck                    # pass the sandbox self-check first
xagents project add demo ~/code/demo --verify "npm test"
xagents run task.md --summary "Add remember-me to the login page" --who codex:high
xagents wait <job-id>
xagents verify <job-id>
```

`task.md` is the brief for the worker: what to do and what to leave alone. There's an example in [docs/examples/task.md](docs/examples/task.md) (in Chinese). The follow-up commands for deciding, scoring and cleaning up are all in `xagents --help`.

To make an AI the lead, tell it to run `xagents guide` first; it gets the full commander's manual plus the current state of this machine. If you'd rather not repeat that, run `xagents connect claude` (same for `codex` and `cursor`; Grok shares Claude's file) to put that line into its persistent instructions. There's also a skill for Claude Code in [skill/SKILL.md](skill/SKILL.md).

The desktop app:

```sh
npm run install-app      # package it and put it in /Applications
```

During development you can also run it with `npm run build && npx electron .`.

## Settings

Most settings live in the app: which workers and reasoning efforts are allowed, whether fast mode is on, how many jobs may run at once, and at what quota level to stop dispatching. They can only be stricter than the defaults, never looser.

Two things are set by hand. To keep a private folder of yours away from workers too, add `"denyReadHome": [".my-secrets"]` (relative to your home directory) to `~/.xagents/config.json`. For a project's own sensitive folders, pass `--deny-read` when you register it (relative to the repo). The registry lives in `~/.xagents`; set `XAGENTS_HOME` to move it.

## About safety

Codex is restricted through its own permission profile; Grok and Cursor additionally run inside [sandbox-runtime](https://github.com/anthropics/sandbox-runtime). Every rule in the sandbox templates came from an actual probe, and the notes are in [docs/research/](docs/research/) (in Chinese).

It has limits. The self-check only probes the locations it lists and can't prove everything else is safe. Grok and Cursor need to read their own logins to start at all. Vendor CLIs update themselves and may rename flags; the self-check will notice dispatch breaking, but someone still has to fix it. And the tool won't merge code for you or tell you whether a change is right.

If you find a security problem, please report it privately through GitHub Security Advisories rather than a public issue.

## Development

The core lives in `src/core/` and is shared by the CLI (`src/cli/`) and the desktop app (`app/`, Electron + React).

```sh
npm run verify     # typecheck, core tests, UI tests, build, real-window smoke test
```

Tests stay offline, never touch your real `~/.xagents`, and use stand-ins for every worker. The screenshots in this README come from the smoke test with fake data; to include your local vendor icons, run `XAGENTS_E2E_ICONS=~/.xagents/icons npm run test:e2e`. Conventions are in [AGENTS.md](AGENTS.md) and the design in [docs/design.md](docs/design.md) (in Chinese).

## License

[MIT](LICENSE). Captain Agents is not affiliated with OpenAI, xAI, Anysphere (Cursor) or Anthropic; their names and icons belong to them.

---

<sub>Part of the Captain series from [heihuzi-labs](https://github.com/heihuzi-labs): **Captain Agents** · [Captain Kube](https://github.com/heihuzi-labs/captain-kube) · [Captain Ops](https://github.com/heihuzi-labs/captain-ops) · [Captain Password](https://github.com/heihuzi-labs/captain-password) · [Captain Todo](https://github.com/heihuzi-labs/captain-todo)</sub>
