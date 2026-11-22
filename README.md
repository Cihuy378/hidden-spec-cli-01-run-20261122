# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Cihuy378/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Cihuy378/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend: one patch tool for every AI edit format. It reads unified diffs (even with
wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls, finds
the lines an edit names even when the model drifted their whitespace or indentation,
and changes every file or none. See SPEC.md for the full specification.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

PATCH is the patch file, or standard input when absent or `-`. `--format` picks one
format (`unified`, `search-replace`, `v4a`, `json`) or `auto` detection, the default.
`--check` reports what would change without writing anything; `--strict` matches
lines exactly. Exit 0 applies the patch, exit 1 lists the edits that failed (and
writes nothing), exit 2 reports a usage, patch-file, format or parse error.

## Files

- `main.ts`: the CLI, Node 22 and its standard library alone.
- `runner.ts`: the kit's trial runner, kept as issued; `main.ts` hands a trial
  over to it when `MAKEFUN_ENV_URL` is set.
- `check.ts`: runs the kit's public practice set against `main.ts`.
- `SPEC.md`: the specification this entry implements.

## Verify

```sh
node check.ts <kit>/program/generator/practice.json
```

Practice score: 1000 (100 of 100 checks pass).

---

<sub>Entered on [make.fun](https://make.fun/?ref=brisk-koala-55&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
