# Contributing

Thanks for helping make Vue Doctor sharper.

## Local Setup

```bash
npm install
npm run check
npm run test:coverage
```

Useful commands:

```bash
npm run test
npm run lint
npm run typecheck
npm run build
npx vue-doctor tests/fixtures
```

## Rule Guidelines

Rules should be:

- Vue-specific or especially common in Vue codebases.
- Actionable, with a clear fix path.
- Conservative enough to avoid noisy false positives.
- Covered by tests with at least one positive and one clean fixture.

Each diagnostic needs:

- a stable rule name,
- a category,
- an error or warning severity,
- a short message,
- a helpful next step.

## Pull Requests

Before opening a PR:

1. Add or update tests.
2. Run `npm run check`.
3. Update `README.md` if the CLI, config, or public rule list changed.
4. Add a `CHANGELOG.md` entry for user-visible behavior.

## Release Flow

This repo uses plain npm scripts for now:

```bash
npm version patch # or minor/major, based on the semver notes below
npm publish --access public
git push --follow-tags
```

Use semver:

- Patch: bug fixes and rule false-positive reductions.
- Minor: new rules, new config keys, new output fields.
- Major: breaking CLI/API/config changes.
