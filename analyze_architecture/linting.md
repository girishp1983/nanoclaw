# Linting and Quality Checks

## Where rules are defined (absolute paths)

Project root:

`/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw`

1. Prettier formatting rules

`/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/.prettierrc`

- Current rule: `"singleQuote": true`

2. Script entry points for checks

`/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/package.json`

- `typecheck`: runs `tsc --noEmit`
- `format`: runs `prettier --write "src/**/*.ts"`
- `format:check`: runs `prettier --check "src/**/*.ts"`

3. TypeScript strictness for main app

`/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/tsconfig.json`

- Enforces compile-time checks (not formatting), including `strict: true`.

4. TypeScript strictness for agent-runner

`/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/container/agent-runner/tsconfig.json`

- Separate TS ruleset for `container/agent-runner/src`, also `strict: true`.

5. CI enforcement workflow

`/Users/girpatil/Documents/Coding/ClaudeCode/cowork/nanoclaw/.github/workflows/test.yml`

- On PRs to `main`, CI runs:
  - `npm ci`
  - `npx tsc --noEmit`
  - `npx vitest run`

Note:

- No ESLint config is present in this repository (`.eslintrc*` / `eslint.config.*` not found).

## Role of package.json vs CI enforcer

`package.json` role:

- Defines local project metadata, dependencies, and runnable scripts.
- It is the source of truth for how developers run build/test/format/type-check commands.

CI enforcer (`.github/workflows/test.yml`) role:

- Executes required checks in a clean GitHub runner for pull requests.
- Acts as a merge gate by enforcing consistency and quality before code reaches `main`.

In short:

- `package.json` defines what commands exist.
- CI workflow defines which commands are mandatory for PR validation.
