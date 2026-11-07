# Configuration

## Top-level keys

| Key | Default | Meaning |
|-----|---------|---------|
| `commandPrefix` | `"m-"` | Prefix of the **slash** commands, see [Commands](commands.md). |
| `maxIterations` | `15` | Blocked stops per phase. |
| `update` | `mode` `"notify"` | Update checks; see [Updates](updates.md#modes). |
| `phases` | `plan` → `review` | The phase graph. |
| `feature` | see below | Feature-mode settings. |
| `list` | `["a","b"]` | A list of letters, written with an escaped bar: a\|b. |
| `emptyBlock` | `{}` |  |
| `unicodeKey-é` | `"ü"` | Описание ключа с юникодом. |

```
| Fence | Meaning |
|-------|---------|
| `maxIterations` | A table inside a code fence is not read. |
```

## Environment variables

| Variable | Effect |
|----------|--------|
| `MINI_DISABLED=1` | All hooks become no-ops. |
| `MINI_PYTHON=/path/to/python` | Not read by engine.py in this fixture. |
| `CI` (any value) | Update checks behave as `off`. |
