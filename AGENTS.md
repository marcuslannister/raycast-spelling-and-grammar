## Agent skills

### Issue tracker

Issues live in this repo's GitHub Issues, through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Releases

- `CHANGELOG.md` follows Raycast's format. Date entries with real `YYYY-MM-DD` dates: `{PR_MERGE_DATE}` is only for PRs to `raycast/extensions`, and this extension is not in the store.
- Tags are bare versions, such as `0.8`.
- A GitHub Release takes the tag as its title and the matching `CHANGELOG.md` section as its notes.
- `origin` is a fork of `flash286/raycast-spelling-and-grammar`. Pass `--repo` with the `origin` owner/name to `gh` release commands, so they target the fork.

## Checks

- Run `npm ci` before `npm test`. Without `node_modules`, the test scripts' `npx tsc` fetches an unrelated npm package.
- `npm run lint` always fails with `Invalid author "flash286"`, because the upstream author has no Raycast account. Read the ESLint and Prettier lines as the lint result.
- Prettier already flags existing lines in `package.json` and `scripts/test-request.mjs`. Format only the lines you change.
