# dsh-sop-guard

[中文](README.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that turns a skill's `SOP.json` checklist into enforced per-step allowlists. When a skill ships a checklist, the model has to declare which step it is on, and the harness refuses any file write, shell command, or code program that the current step does not allow.

The refusal happens before the tool runs. A denied call has no side effects.

## Why

Skills tell a model what to do. They cannot make it do that. Two failures show up often: the model skips an analysis step and jumps to a confident answer, or it takes the shortest path through a documented process because the shortest path is cheaper. Prompt wording does not fix either one, because a prompt is a suggestion.

This plugin moves the process from the prompt into the tool gate. The model cannot write a file in a step that does not allow writing.

## Install

Not on npm yet. Install from the repository:

```sh
npm install github:ExpertKT/dsh-sop-guard
```

Then add it to your profile's bundle list. The plugin registers itself through `cordis.patch.yml`:

```yaml
- insert:
    - id: sop-guard
      name: dsh-sop-guard
      config: {}
```

Config keys (all optional):

| Key | Default | Meaning |
| --- | --- | --- |
| `mode` | `enforce` | `enforce` denies the call. `warn` writes the same denial text to the log and lets the call through. Any other value fails at load. |
| `stateDir` | `~/.dsh/sop-guard/flows` | Where the armed flow is persisted per session. `false` keeps it in memory only. |

## The checklist

Put `SOP.json` next to a skill's `SKILL.md`. Loading that skill arms the flow for the session.

```json
{
  "version": 1,
  "steps": [
    {
      "id": "inspect",
      "title": "Read the repo state",
      "tools": ["pwsh"],
      "commands": ["^git status\\b", "^git branch\\b"]
    },
    {
      "id": "review",
      "title": "Read the failing test and the module it covers",
      "tools": [],
      "witness": true
    },
    {
      "id": "await-approval",
      "title": "Show the plan and wait for a person",
      "tools": [],
      "approval": true
    },
    {
      "id": "write",
      "title": "Apply the change",
      "tools": ["write", "edit"]
    },
    {
      "id": "commit",
      "title": "Commit with the conventional message",
      "tools": ["pwsh"],
      "commands": ["^git add\\b", "^git commit\\b"]
    }
  ]
}
```

Step fields:

- `id` — lowercase letters, digits, hyphens; up to 24 characters; `done` is reserved.
- `title` — shown in denial messages and status output.
- `tools` — the tool names this step allows. Omit it to leave the step ungated.
- `commands` — regular expressions matched against shell command text. A step that allows `pwsh` or `bash` but omits `commands` rejects every shell call, because there is nothing to check it against.
- `witness` — the step changes nothing, but the model has to have read something first. One successful `read`, `read_image`, `glob`, or `grep` call satisfies it. A shell that happens to read does not count.
- `approval` — the step cannot be advanced until a human runs `/sop approve`. The flag is per step, not per flow, and is not persisted: a resumed session asks again.

A `gatedTools` array at the top level adds tool names to the gate's watch list for every step.

## How the model talks to it

The plugin registers one tool, `sop_step`:

- `sop_step({ step: "inspect" })` declares the current step. The declaration covers the whole step; it is not consumed per call.
- `sop_step({ step: "review", evidence: "..." })` advances. Evidence is at least 8 characters and describes what the previous step found. If that step declared tools, the harness also requires one observed successful call, so a rejected shell command with a non-zero exit code does not count.
- `sop_step({ skill: "name" })` switches which armed flow is active.
- `sop_step({})` returns the current state.
- `sop_step({ step: "done", evidence: "..." })` ends the flow early. Ending drops the whole gate, so it has the same bar as advancing: declare the current step, show one successful call in tool-declaring steps, a real read in `witness` steps, and human confirmation in `approval` steps. The host logs who ended it, at which step, and why.

After advancing, the new step is undeclared. The model has to declare it before using a gated tool. Without that rule, one declaration would open every later step.

The model also sees the current step in its runtime context, re-stated whenever the step changes. That is there for the failure this plugin can't gate: a model that forgot a checklist existed reads its own position before the next call.

## The human escape hatch

`/sop` prints the armed flow and its position. `/sop approve` confirms the current step when the checklist marks it `"approval": true` — without it the model is stuck there, and the confirmation covers that one step only. `/sop off` drops the flow for that session and deletes its state file. Use it when a checklist is wrong, or when the model is stuck against a rule you wrote badly. Only the human gets these two exits.

## What it actually enforces

Every gated call is checked against the declared step:

- `write`, `edit`, `delete`, `move`, `copy`, `apply_patch` pass only if the step names them.
- `pwsh` and `bash` pass only if the step names them *and* every command segment matches the step's patterns.
- Shell command strings are split on `;`, `&`, `|`, and newlines outside quotes, and each segment is checked. `2>&1` is recognized as a descriptor copy, not a command break.
- A shell that carries its own command (`pwsh -Command "..."`, `bash -c "..."`) is checked on the inner command, not on the word `pwsh`. A shell told to read its command from a file or standard input is rejected, because there is nothing to check. Two levels of shell nesting are rejected for the same reason.
- Encoded-command flags (`-EncodedCommand`, `-enc`) are rejected.
- A step that does not allow file-writing tools cannot reach the same effect through `Set-Content`, `Out-File`, `Remove-Item`, `cp`, `mv`, `mkdir`, `tee`, `dd` and similar.
- `run_code` program bodies are scanned for module literals. `node:fs` in a step that disallows file writes is rejected. `node:child_process` in a step that declares tools is rejected.
- A step marked `approval` cannot be advanced by `sop_step` until a human has run `/sop approve`.

Three things make the gate survivable in practice:

- Denials name the step, the reason, the allowed tools, the allowed commands, the next step, and the checklist path.
- A denial is raised before the tool body runs, so nothing is half-written.
- Advancing and ending both need evidence *and* observed work, so the model cannot walk through a flow, or exit it, by declaring steps without doing them.

## What it is not

Read this part before trusting it with anything.

**It is not a sandbox.** The command check is lexical. It looks at the command text the model wrote, not at what that command does after expansion. `$HOME` expands after the check. A script file the model wrote earlier can do anything the step allowed the write tool for.

**`evidence` is a self-report.** The plugin can prove a tool ran. It cannot prove the model read the right file, or that its stated conclusion follows from what it read. `witness` raises the bar from "any tool succeeded" to "a read tool succeeded", which is a smaller hole, not a closed one. A model that wants to pass can pass by calling `read` on any file.

**Program scanning is text matching.** Module names built at runtime — `"node:" + "fs"` — are not caught.

**An approval step needs a person at the keyboard.** The harness does not report its own approval decisions to plugins, and on some installs every approval prompt is auto-granted anyway. So the plugin uses its own handshake: a step marked `"approval": true` cannot be advanced until a human types `/sop approve`. The flag is per step and lives only in memory — a resumed session has to ask again. The plugin can prove someone typed the command; it cannot prove that person read what the model showed them.

**Subagents inherit the flow, not the declaration.** A child agent starts with the parent's step but has to declare it again. Observed work and `/sop approve` confirmations are counted separately.

**The runtime text is Chinese.** Denial messages, the `sop_step` description, and the system-prompt rules are written in Chinese; that is the primary language for this project. An English checklist works, but the messages telling the model what it did wrong stay in Chinese. This README is the English companion, not the primary one.

**Persistence is per session, in one JSON file.** Two processes restoring the same session id are arbitrated by a lock file. A read-only home directory turns persistence off with a warning; the gate keeps working.

If you need enforcement that holds against a model actively trying to escape, put the allowlist in the OS or in a container. This plugin is for models that are trying to be helpful and sometimes cut corners.

## Status

`1.0.0`. The deny path, the command allowlist, the evidence gate, and the observed-work gate were exercised against a real checklist in a live harness, but on a build from before the last few changes. The runtime-context broadcast, `/sop off`, `/sop approve`, the `witness` read rule, and the `run_code` program check have unit tests only. Treat live testing as still owed. Run the suite from a clone before trusting a change:

```sh
node test/guard.test.mjs
```

Design decisions and known limits live in [DESIGN.md](DESIGN.md) (Chinese). `examples/sop-demo/` holds a loadable skill and checklist; the suite checks it stays in step with the README examples. The suite and the example ship in the npm package too; after installing, run `node node_modules/dsh-sop-guard/test/guard.test.mjs` to check your copy.

## License

MIT.
