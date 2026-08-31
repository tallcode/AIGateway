# Request rectifiers

Rectifiers are global request compatibility transforms. They run for every
matching protocol before endpoint-specific adapters.

## Anthropic thinking

Configure it in `config.json`:

```json
{
  "rectifiers": {
    "anthropicThinking": {
      "enabled": true
    }
  }
}
```

- `enabled: false`: bypass the rectifier without changing request content.
- `enabled: true`: normalize top-level Anthropic reasoning options.

The behavior is driven by the model's `reasoning` config block (copied
verbatim from OpenRouter's model list — `mandatory`, `default_enabled`,
`supports_max_tokens`, `supported_efforts`, `default_effort`). Models without
a `reasoning` block keep the legacy behavior described at the end.

- `thinking.type: "adaptive"` always becomes `"enabled"`: it is Claude-native
  and the gateway's upstreams take the legacy `enabled + budget_tokens` shape.
- `thinking.type: "disabled"` is overridden to `"enabled"` only when
  `reasoning.mandatory: true` (the model cannot turn thinking off, e.g.
  glm-5.3 — "该模型始终思考，不支持关闭思考") or when the model has no
  `reasoning` block (legacy safety). With `mandatory: false`, `disabled`
  passes through and effort/budget injection is skipped.
- Effort resolution: client `reasoning_effort` → `output_config.effort` →
  model `reasoning.default_effort` → `low`. Client values are fitted into the
  model's `supported_efforts` with a preference order that favors more
  thinking (e.g. requested `high` prefers `xhigh` → `high` → `max`); when
  nothing matches, the model's `default_effort` (or `low`) is used.
- A missing `thinking.budget_tokens` is filled from the resolved effort:
  `low`/`minimal` = 1024, `medium`/`high` = 4096, `xhigh`/`max` = 16000.
- `output_config` itself is removed after its `effort` is consumed: it is a
  Claude-native field the gateway's upstreams do not understand, and neither
  rig nor rust-genai ever forwards it. Disabled rectifier → left untouched.

Legacy behavior (no `reasoning` block configured):

- `adaptive` and `disabled` both become `enabled`.
- Effort mapping: `low` and `medium` stay unchanged; `hight` (Claude Code's
  spelling variant) becomes `high`; everything else — including `high` —
  becomes `xhigh`. Default is `low`.
- Budget fill: `low` = 1024, `medium`/`high` = 4096, `xhigh` = 16000.

If rectifier or adapter rules would leave the request with no messages or an
empty message content array, the gateway rejects the request locally instead
of forwarding a broken conversation history.
Restart the gateway after changing configuration.
