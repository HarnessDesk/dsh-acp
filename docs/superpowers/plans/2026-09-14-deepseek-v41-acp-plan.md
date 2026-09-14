# DeepSeek V4.1 ACP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep `@harnessdesk/dsh-acp` as HarnessDesk’s renderer-facing adapter, advertise DeepSeek’s current `deepseek-flash` route as “DeepSeek V4.1 Flash” beside `deepseek-v4-pro`, and add an explicit automation-only compatibility lane against DeepSeek’s official ACP bridge.

**Architecture:** The HarnessDesk adapter remains responsible for human-facing transcript projection, replay, plans, usage, permissions, and model controls. The official DSH ACP process is used only as an external automation contract probe; its capabilities are compared at the ACP initialize/session boundary and are never routed into HarnessDesk’s renderer. The model route is changed in the HarnessDesk profile and docs, while old session logs continue to carry their recorded model IDs during resume.

**Tech Stack:** TypeScript, Vitest, Node.js child processes, JSON-RPC over stdio, DeepSeek Harness profile YAML, Markdown documentation.

## Global Constraints

- Do not replace or import DeepSeek’s official ACP bridge into the HarnessDesk renderer-facing path.
- Use `deepseek-flash` for new Flash sessions; retain `deepseek-v4-pro` as the second selectable route.
- Keep legacy model IDs readable in historical session events and resume routes; do not advertise retired IDs in the new picker.
- Do not require credentials, network access, or a DeepSeek API call for the default unit-test suite.
- Keep compatibility checks opt-in and automation-scoped so normal CI remains deterministic.
- Preserve unrelated dirty work and commit only this feature’s changes.

---

### Task 1: Pin the new model catalogue and labels

**Files:**
- Create: `test/options.test.ts`
- Modify: `src/options.ts:15-26, 36-41`

**Interfaces:**
- Consumes: `AdapterConfig`, `sessionConfigOptions`, `chosenForRoute`.
- Produces: stable display labels for `deepseek-flash`, `deepseek-v4-pro`, and the legacy `deepseek-v4-flash` ID.

- [ ] **Step 1: Write the failing tests**

Add tests that assert `sessionConfigOptions({ model: 'deepseek-flash', models: ['deepseek-flash', 'deepseek-v4-pro'] })` returns a model option whose current value is `deepseek-flash` and whose labels are exactly `DeepSeek V4.1 Flash` and `DeepSeek V4 Pro`. Add a compatibility assertion that the legacy `deepseek-v4-flash` ID remains rendered as `DeepSeek V4 Flash` when a historical composition still offers it.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -- --run test/options.test.ts`

Expected: FAIL because the current generic formatter produces `Deepseek Flash` and `Deepseek V4 Pro`.

- [ ] **Step 3: Implement the minimal label map**

Add explicit entries to the private `LABELS` map in `src/options.ts`:

```ts
'deepseek-flash': 'DeepSeek V4.1 Flash',
'deepseek-v4-pro': 'DeepSeek V4 Pro',
'deepseek-v4-flash': 'DeepSeek V4 Flash',
```

Update the nearby model example to use `deepseek-flash`.

- [ ] **Step 4: Run the focused test and verify it passes**

Run: `npm test -- --run test/options.test.ts`

Expected: PASS with all option-label assertions green.

- [ ] **Step 5: Commit**

```bash
git add test/options.test.ts src/options.ts
git commit -m "feat: label current DeepSeek model routes"
```

### Task 2: Update the shipped HarnessDesk profile and documentation

**Files:**
- Modify: `profile/harnessdesk.patch.yml:18-23`
- Modify: `README.md` model examples and compatibility notes
- Modify: `/Users/aivilo/.codex/worktrees/bbec/HarnessDesk/docs/getting-started.md:89-156`

**Interfaces:**
- Consumes: the labels and route IDs from Task 1.
- Produces: new sessions defaulting to `deepseek-flash` and offering exactly `deepseek-flash` plus `deepseek-v4-pro`.

- [ ] **Step 1: Add a profile-shape regression test**

Create `test/profile.test.ts` with a deterministic YAML-text assertion that reads `profile/harnessdesk.patch.yml` and verifies the inserted `harnessdesk-acp` config has `model: deepseek-flash` and the ordered `models` list `['deepseek-flash', 'deepseek-v4-pro']`. The assertion must also verify that no retired `deepseek-v4-flash` entry remains in the shipped picker configuration.

- [ ] **Step 2: Run the regression test and verify it fails**

Run: `npm test -- --run test/profile.test.ts`

Expected: FAIL against the current V4 Flash profile.

- [ ] **Step 3: Update the profile and examples**

Change the profile’s default and model list to `deepseek-flash` and `deepseek-v4-pro`. Update current README and the sibling HarnessDesk checkout’s `docs/getting-started.md` examples to match. Add one short note that `deepseek-v4-flash` remains a legacy route for historical sessions but is not a new-session choice.

- [ ] **Step 4: Run the profile regression test and documentation scan**

Run: `npm test -- --run test/profile.test.ts` and `rg -n 'deepseek-v4-flash' README.md profile`

Expected: the test passes; remaining matches are only the explicit legacy-compatibility note, not a current default or picker list.

- [ ] **Step 5: Commit**

```bash
git add profile/harnessdesk.patch.yml README.md
git commit -m "feat: default HarnessDesk DeepSeek sessions to V4.1 Flash"
```

The HarnessDesk documentation change is committed separately in the HarnessDesk checkout with its own focused commit.

### Task 3: Add an opt-in official ACP automation compatibility probe

**Files:**
- Create: `test/official-acp.test.ts`
- Modify: `package.json` scripts
- Modify: `.github/workflows/ci.yml` only if the existing workflow can run the probe without credentials; otherwise document the opt-in command in `README.md` without adding it to the default job.

**Interfaces:**
- Consumes: an official DSH executable from `DSH_OFFICIAL_BIN` and optional JSON arguments from `DSH_OFFICIAL_ARGS`.
- Produces: a deterministic ACP automation check for `initialize`, `session/new`, and clean process shutdown; it does not prompt the model or render HarnessDesk UI.

- [ ] **Step 1: Write the failing probe test**

Create an opt-in Vitest test that spawns the official process only when `DSH_OFFICIAL_BIN` is set, sends newline-delimited JSON-RPC for `initialize` and `session/new` with an absolute temporary cwd and an empty MCP list, asserts a successful ACP response plus `agentCapabilities` and `configOptions` shape, then terminates the child. Without the environment variable, mark the test skipped with a message naming the opt-in command.

- [ ] **Step 2: Run the probe in its default disabled state**

Run: `npm test -- --run test/official-acp.test.ts`

Expected: SKIP, with no process spawned and no credential/network requirement.

- [ ] **Step 3: Implement the JSON-RPC probe**

Use a small test-local stdio client with request IDs, line buffering, a bounded timeout, and guaranteed `SIGTERM` cleanup. Default `DSH_OFFICIAL_ARGS` to `['--profile', 'acp']`; pass `DSH_HOME` through only when the caller supplied it. Assert only the official automation contract: initialization succeeds, a fresh session can be created, and the result does not claim HarnessDesk-only transcript replay fields.

- [ ] **Step 4: Run the opt-in probe against the local official DSH checkout**

Run from the official DSH checkout’s built CLI:

```bash
DSH_OFFICIAL_BIN=/Users/aivilo/code-shane/deepseek/deepseek-harness/apps/cli/lib/bin.js \
DSH_OFFICIAL_ARGS='["--profile","acp"]' \
npm test -- --run test/official-acp.test.ts
```

Expected: PASS for the official automation surface, or a concrete boot/configuration failure that identifies the missing official profile dependency. No model prompt is sent.

- [ ] **Step 5: Document the boundary**

Document the opt-in command and state explicitly that this probe protects the automation subset only; HarnessDesk continues to launch `@harnessdesk/dsh-acp` for renderer-facing sessions.

- [ ] **Step 6: Commit**

```bash
git add test/official-acp.test.ts package.json .github/workflows/ci.yml README.md
git commit -m "test: probe official DSH ACP automation contract"
```

### Task 4: Verify both repositories and review the final diff

**Files:**
- Modify: none beyond the files above.

- [ ] **Step 1: Verify the dsh-acp repository**

Run: `npm run verify` in `/Users/aivilo/code-shane/deepseek/harnessdesk-dsh-acp`.

Expected: typecheck, unit tests, and build all exit 0.

- [ ] **Step 2: Verify the HarnessDesk documentation change**

Run: `pnpm verify` in the sibling HarnessDesk checkout.

Expected: the full repository gate exits 0, or any pre-existing unrelated failure is reported with its exact command and output.

- [ ] **Step 3: Inspect both diffs and status**

Run `git status --short --branch` and `git diff --check` in both repositories, then inspect the complete diffs. Confirm no credentials, real account identifiers, or machine-specific paths were added to tracked files.

- [ ] **Step 4: Report commits and remaining compatibility work**

Report the focused commit hashes, the exact model IDs/labels now shipped, the official ACP probe command and result, and any upstream ACP capability that was intentionally not adopted because it belongs to the automation-only or renderer-facing boundary.
