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
- `enabled: true`: normalize top-level Anthropic reasoning options:

- `thinking.type: "adaptive"` and `thinking.type: "disabled"` both become
  `"enabled"` (some upstream "always-thinking" models, e.g. glm-5.3, reject
  requests that turn thinking off).
- An existing `reasoning_effort` is preserved. Otherwise,
  `output_config.effort` is mapped to it: `low` and `medium` stay unchanged;
  `hight` (spelling variant) becomes `high`; every other supplied value
  (including `high`) becomes `xhigh`. If both fields are absent,
  `reasoning_effort` defaults to `low`.
- A missing `thinking.budget_tokens` is filled from the normalized effort:
  `low` = 1024, `medium`/`high` = 4096, `xhigh` = 16000.
- `output_config` itself is removed after its `effort` is consumed: it is a
  Claude-native field the gateway's upstreams do not understand, and neither
  rig nor rust-genai ever forwards it. Disabled rectifier → left untouched.

If rectifier or adapter rules would leave the request with no messages or an
empty message content array, the gateway rejects the request locally instead
of forwarding a broken conversation history.
Restart the gateway after changing configuration.
