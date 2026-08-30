# dsh-acp — a complete ACP server for DeepSeek Harness

[![CI](https://github.com/HarnessDesk/dsh-acp/actions/workflows/ci.yml/badge.svg)](https://github.com/HarnessDesk/dsh-acp/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Drive [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) from any
[Agent Client Protocol](https://agentclientprotocol.com) client — and actually see what it did.

## Why this exists

DeepSeek Harness ships an ACP server of its own, `@deepseek-ai/dsh-acp`. Its source
states its scope plainly:

> Emit only committed assistant text. Raw chunks, reasoning, tools, plans, titles,
> and retry markers are presentation or trace data and stay off the automation wire.

That is the right decision for the job it was built for — it is an *automation*
bridge, and its README says so. It is the wrong decision for a person watching a
conversation. Driven through it, a fifteen-minute run that loaded two skills, wrote
an 822-line file, built a virtualenv and ran a browser test arrives as two
paragraphs of prose. No tool calls. No reasoning. No token counts, so no
context-usage indicator.

This adapter makes the opposite choice. Same harness, same session, everything on
the wire.

| | `@deepseek-ai/dsh-acp` | this |
|---|---|---|
| Assistant text | ✅ committed messages | ✅ streamed |
| Reasoning | — | ✅ `agent_thought_chunk` |
| Tool calls | — | ✅ `tool_call` / `tool_call_update`, with output |
| Plans (`todo_write`) | — | ✅ `plan` |
| Token usage | — | ✅ `usage_update` + `PromptResponse.usage` |
| Context composition | — | ✅ system / tools / messages, from the harness's own meter |
| Model / effort / sandbox mode | — | ✅ ACP `configOptions` |
| Conversation list | ✅ `session/list` (stored) | ✅ live **and** stored, with the harness's own titles |
| Reopen a conversation | ✅ `session/resume` | ✅ `session/resume` |
| …and see what it said | — `session/load` refused | ✅ `session/load` replays the whole log |
| Permission prompts | ✅ allow / reject | ✅ + allow-always |

### Reopening a conversation

ACP separates two verbs that sound alike, and the difference decides whether a
client can draw anything:

- **`session/resume`** puts an agent back on a stored session and *explicitly
  does not replay history*.
- **`session/load`** replays it.

`@deepseek-ai/dsh-acp` implements resume and lists `session/load` under its
refused surfaces, which is coherent for an automation bridge that keeps no
transcript. For a client a person is looking at, it means reopening a
conversation gives a live agent above an empty pane.

This adapter implements both. Replay is a fold, not a second mapper: the store
keeps the same `SessionEvent` log the live feed carries, so the events go back
through the same projection and come out as the updates the client would have
received the first time — user turns, reasoning, tool calls with their results,
plans and titles included.

Both capabilities are declared from what is actually mounted. A composition
without `@deepseek-ai/dsh-session-persistence` gets `loadSession: false` and no
`resume`, and lists only what is live — rather than a promise this adapter
cannot keep.

Token usage follows ACP's [Session Context Size and Cost](https://agentclientprotocol.com/rfds/session-usage)
RFD, including its rule that cached tokens still occupy the context window.

## Install

```bash
npm install @harnessdesk/dsh-acp
```

You need a DeepSeek Harness installation alongside it — a global `@deepseek-ai/dsh`,
or a checkout. The adapter finds it from the working directory, from the directory of
the composition you point it at, or from its own package, in that order.

## Use

Mount the plugin in a harness composition, alongside an agent spine:

```yaml
- id: spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro

- id: acp
  name: '@harnessdesk/dsh-acp'
  config:
    provider: deepseek-official
    model: deepseek-v4-pro
    models: [deepseek-v4-pro, deepseek-v4-flash]
```

Then point a client at the binary:

```bash
harnessdesk-dsh-acp --config ./cordis.yml
```

Stdout carries JSON-RPC frames and nothing else, so the composition must not mount a
stdout logger — the harness's own ACP compositions omit one for the same reason.

### In Zed

```jsonc
{
  "agent_servers": {
    "DeepSeek Harness": {
      "command": "harnessdesk-dsh-acp",
      "args": ["--config", "/path/to/cordis.yml"]
    }
  }
}
```

### In HarnessDesk

Add an entry to `~/.harnessdesk/agents.json`:

```json
{
  "id": "dsh",
  "name": "DeepSeek Harness",
  "brand": "deepseek",
  "command": "harnessdesk-dsh-acp",
  "args": ["--config", "/path/to/cordis.yml"]
}
```

## Configuration

| key | meaning |
|---|---|
| `provider` | provider route for created agents, e.g. `deepseek-official` |
| `model` | model for created agents, e.g. `deepseek-v4-pro` |
| `models` | models to offer in the picker; fewer than two offers none |
| `efforts` | reasoning levels to offer; defaults to `off, low, high, max` |

## Design

Three rules, each of which exists because of a specific failure:

**The mapper is pure.** `SessionProjection` takes harness events and returns ACP
updates, with no I/O and no harness imports, so the whole vocabulary is testable in
milliseconds against events recorded from a real session log rather than events
invented by the author.

**The harness is typed structurally, not imported.** Its packages move on
independent version lines — `dsh-session` at `0.0.1-rc.1` while `dsh-agent` is at
`0.1.0-rc.6` — so an adapter that pinned them would need a release every time any one
of them moved. What we actually depend on is the session-event vocabulary, which the
harness itself treats as a compatibility surface. Nothing is vendored: the adapter is
a few hundred lines beside your harness, not a copy of it.

**Unknown events are ignored, never fatal.** The harness's vocabulary grows. An
adapter that threw on a new event type would break on an upgrade it could have
survived.

### Token accounting

Two details that are easy to get wrong, and wrong in ways that look plausible:

*Context fill is the latest request, not the sum of every step.* The harness sends the
whole conversation on each step, so summing steps reports a session far larger than
the model ever saw.

*ACP's `inputTokens` is the whole input; the harness's is the part that missed cache.*
Passing the harness's number through unchanged makes a 12,574-token prompt render as
157 tokens. The adapter converts, so `cachedReadTokens` stays a share of `inputTokens`
and "% cached" means the same thing here as for every other agent.

### Context composition

A composition that mounts `@deepseek-ai/dsh-token-meter` and
`@deepseek-ai/dsh-session-projection` gets two things nothing on the event stream
can supply.

**Occupancy that survives compaction.** The meter's `contextPressure` projection
reports what the *next* request would cost — a provider-anchored sample repriced for
everything the conversation has gained or lost since. Compaction reports no usage of
its own, so an indicator built from `assistant/chunk` alone stays stale until the next
request happens to run; this one drops the moment the conversation is compacted. The
adapter prefers it and falls back to the per-request sum when no meter is mounted.

**What the prompt is made of.** The `contextBreakdown` projection prices the system
prompt, the tool schemas and the conversation separately, and the adapter carries all
three on `usage_update._meta.harnessdesk.contextBreakdown`, beside the occupancy they
explain:

```jsonc
{
  "sessionUpdate": "usage_update",
  "used": 43574, "size": 1000000,
  "_meta": { "harnessdesk": { "contextBreakdown": {
    "approximate": true,
    "source": "DeepSeek Harness token meter",
    "segments": [
      { "id": "system",   "label": "System prompt", "tokens": 44 },
      { "id": "tools",    "label": "Tool schemas",  "tokens": 771, "count": 3 },
      { "id": "messages", "label": "Messages",      "tokens": 325 }
    ]
  } } }
}
```

`approximate` is not decoration. The segments come from the meter's fixed density
estimate while `used` is anchored to what the provider actually charged, so the two
are in different units of truth and the segments will not sum to `used`. The harness
says so itself, and this adapter passes the warning along rather than dropping it. No
total is sent, and none should be inferred by subtraction — render these as shares of
a composition, never as slices of the ring.

Only `count`, the number of tool schemas in the request envelope, is exact; it is read
off `request/header`, which the adapter otherwise leaves alone. Pricing that envelope
here would mean shipping a tokenizer and guessing at DeepSeek's, when the harness
already prices it with the estimator it prices everything else with.

Everything in this section is optional. `ctx.inject(['sessionProjections'], …)` never
runs in a composition without the registry, and a client that ignores `_meta` still
gets the ring.

## Status

Working and tested end to end against a real harness: streaming, reasoning, tool
calls with output, plans, usage, permission prompts, the three session controls, and
a conversation list carrying the harness's own session titles.

A listed conversation only has a name if the composition generates one. The title
service and its provider are separate plugins, and mounting them is what turns a row
from a truncated first prompt into "Maximum landing score breakdown":

```yaml
- id: session-title
  name: '@deepseek-ai/dsh-session-title'
  config: { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 }

- id: session-title-llm
  name: '@deepseek-ai/dsh-session-title-first-prompt-llm'
  config:
    targetWords: 5
    targetCjkCharacters: 10
    maxInputBytes: 4096
    maxOutputTokens: 64
    timeoutMs: 60000
    provider: deepseek-official
    model: deepseek-v4-flash
```

The service alone gives a word-count fallback title; the provider names the
conversation with a cheap route instead. Without either, `session/list` still answers
with a cwd and a preview, and `title` is `null`.

Not implemented yet:

- `session/load` — the capability is advertised as `false` rather than being claimed
  and then failing. Because of this, `session/list` reports the conversations this
  process is holding rather than reading the harness's persisted store, so a
  conversation does not yet survive a restart.
- Live `session/set_model` and `session/set_config_option`; the options are reported,
  but changing one mid-session is not wired.
- **MCP server pass-through — refused, out loud.** The harness does host MCP
  servers, through `@deepseek-ai/dsh-mcp-client`, but it connects them at
  composition time: one plugin instance per server in `cordis.yml`. Nothing on
  the ACP wire can add one to a harness that is already composed, and this
  adapter will not edit somebody's composition on their behalf. So a non-empty
  `mcpServers` on `session/new` is refused with an error naming the parameter.

  It is worth being explicit about why that is better than the alternative.
  Until 0.3.0 this adapter accepted the parameter and ignored it, which left
  the client believing its tools had reached the model. They had not, and the
  only symptom was an agent that said it could not do something it had been
  told it could. A refusal naming `mcpServers` is the one answer a client can
  act on: it retries without the server and reports which tools are missing.

## Development

```bash
npm install
npm run verify   # typecheck, test, build
```

## License

MIT.
