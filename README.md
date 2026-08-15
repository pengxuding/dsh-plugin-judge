# dsh-plugin-judge · Plugin Value Auditor for DeepSeek Harness

> Judge whether a DeepSeek Harness plugin is worth using: pre-install review,
> post-install audit, and re-audit reminders when the model changes.

[中文文档](README.zh.md)

## The problem this plugin solves

Plugins fall into two natures:

- **Capability plugins** give the model new abilities (new tools, skills, MCP
  servers, services, commands) — like giving the model "an extra hand".
- **Constraint plugins** impose rules and guardrails on the model (injecting
  system prompt sections, personas, AGENTS.md rules, intercepting
  `agent/pre-step` / `tools/pre-execute`, `restrict` / `guard` on tools, or
  `complete: true` wholesale prompt replacement) — like putting the model
  "in a cage".

Constraint plugins carry a hidden cost: the model will follow the rules
faithfully (compliance looks great), but it performs *worse* on the task you
actually care about — rules crowd the context and suppress the model's own
judgment, putting a low ceiling over a capable model. Worse, as models get
upgraded, many "patch rules for the old model" turn from patches into
ceilings, and the plugin becomes obsolete or even harmful.

**So a plugin's value is not a property of the plugin alone — it is a binary
relation of "plugin × current model".** That is exactly what this plugin
evaluates.

## Features

| Feature | When | How |
| --- | --- | --- |
| Pre-install review | Before installing | `/plugin-audit <github:owner/repo or npm:pkg>` command, the `judge_plugin` tool, or the settings-page input. Fetches the plugin source → static scan + LLM judge → a "worth installing?" verdict |
| Post-install audit | Already installed | Enumerates installed bundles from the profile → scans and classifies each (capability / constraint / cosmetic / hybrid) → constraint-risk score → settings-page report panel |
| Model-switch reminders | When the model changes | Watches the default model → flags plugins whose verdict depended on the old model → overlay popup reminder to re-audit |

## How it judges (two layers combined)

1. **Rule heuristics (free, deterministic)**: scans the plugin source and its
   injected content for signals, weights them into a 0–100 constraint-risk
   score, and classifies the plugin as capability / constraint / cosmetic /
   hybrid.
2. **LLM judge (fine-grained, on demand)**: hands the scan result, the injected
   content summary, and **the current model's identity** to a model and asks
   whether these rules *help or suppress this specific model*, returning a
   verdict with reasons.

## Usage

```sh
# Install (requires an existing web profile)
dsh plugin --profile web add dsh-plugin-judge

# Or install from source
dsh plugin --profile web add <path-to-this-repo>
```

After installing and restarting the harness:

- Type `/plugin-audit github:some/repo` in chat for a pre-install review;
- Or let the model call the `judge_plugin` tool directly;
- The settings panel gains a **Plugin Judge** page: scan reports for every
  installed plugin, a pre-install review input, and audit history;
- After a model switch, if any plugins need re-auditing, a floating reminder
  pops up on the page.

## Design

### Data flow

```
Installed plugins: profile manifest (~/.dsh/profiles/<profile>/package.json → dsh.profile.bundles)
                   + each package's package.json / lib source (read locally via node:fs)
Candidate plugins: package.json + entry source fetched from npm registry / jsDelivr / GitHub raw (Node fetch)
Heuristic scan:   capability signals (+) vs constraint signals (−), weighted → class + risk score
LLM judge:        llm.stream (generative verdict, carrying the current model identity) → verdict + reasons
Model watch:      agentDefaultModel.currentSelection() polling (fallback: agent/request waterfall observation)
Persistence:      ~/.dsh/plugin-judge/audits.json (audit history + model fingerprint)
Bridge:           Host ctx.connection.rpc.handle('/plugin-judge', …) ← Client rpc.call polling
Reminders:        Host produces pending-reminders → Client polls → shell.overlay popup
Reports:          Client settings.section "Plugin Judge" page + judge_plugin tool card
```

### Signal table (heuristics)

Capability signals: `tools.register` / `defineTool` / skills / MCP /
`webServer.register` / `registerFetchProvider` / `commands.register` /
`provide(` …

Constraint signals: `systemPrompt.section` / `ctx.systemPrompt` / persona /
writing AGENTS.md / `agent/pre-step` / `tools/pre-execute` / `tools/execute`
waterfall listeners / `restrict(` / `guard(` / `complete: true` wholesale
replacement / strong-directive density (must, never, always, MUST, NEVER,
必须、不得、禁止) / fixed-template instructions (strictly follow, exact
format, 严格按照、按以下格式) …

### Layout

```
judgePlugin/
├── package.json          # dsh.bundle.patch + dsh.client.inject + exports (Node >= 18)
├── cordis.patch.yml      # insert: plugin-judge
├── lib/
│   └── index.js          # Host half: inventory / source fetching / heuristic scan / LLM judge /
│                         # model watch & reminders / tool & command / connection RPC bridge / persistence
└── client/
    └── client.js         # Client half (__ModuleLoader__ format, no build step):
                          # settings.section report panel + shell.overlay model-switch reminder popup
```

### Disclaimer

Verdicts are advisory opinions produced by heuristics plus a model judge —
not a security audit. Installing any plugin runs third-party code on your
machine with your own permissions; read the source before you install.
