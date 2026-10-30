# omp-compact-tools

Fold omp tool calls into a single line, or group consecutive calls into one summary row. Display only — tool calls, results, and what the model sees are unchanged.

English | [中文](README.zh-CN.md)

## Three modes

- `default` — omp's normal full tool cards.
- `line` (default) — one line per tool call, truncated to the terminal width.
- `group` — consecutive tool calls collapse into one summary row.

`line` looks like this:

```text
❯ Bash: ls -la · 12 lines
● Read /path/to/file.ts
⌕ Grep: TODO 3 matches · 2 files
✎ Edit: /path/to/file.ts +3/-1
```

`group` looks like this:

```text
• 4 tools: Bash · Read · Grep · Edit
```

Press `Ctrl+O` in any mode to expand and see the original tool cards.

## Install

### Option 1: omp plugin command (recommended)

```bash
omp plugin install github:OneLastHuman/omp-compact-tools
```

Restart omp after installing.

### Option 2: copy the extension file

Copy `extensions/omp-compact-tools.ts` to:

```text
~/.omp/agent/extensions/omp-compact-tools.ts
```

Then restart omp.

### Local development

```bash
omp plugin link /path/to/omp-compact-tools
```

## Usage

Inside omp:

```text
/compact-tools                 # cycle default → line → group
/compact-tools line            # one line per call
/compact-tools group           # group consecutive calls
/compact-tools default         # back to omp's normal display
/compact-tools status          # show the current mode
```

Or edit `~/.omp/agent/compact-tools.json`:

```json
{ "mode": "line" }
```

Restart omp after changing the file.

## Uninstall

```bash
omp plugin uninstall omp-compact-tools
```

If you copied the file manually, delete `~/.omp/agent/extensions/omp-compact-tools.ts`.

## Notes

- Requires omp 18.13 or newer. Tested on 18.13.3 and 18.14.0.
- Display only: tool calls, results, and what the model sees are unchanged.
- Records already written to terminal history may need one `Ctrl+O` toggle after switching modes.
- This repo only contains the tool-call folding extension. It does not include prompts or personal configuration.

## License

MIT
