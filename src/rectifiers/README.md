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
- `enabled: true`: for historical `type: "thinking"` blocks only, removes an
  empty-string `signature`; deletes the block when `thinking` is absent, not a
  string, or an empty string. All other content blocks pass through unchanged.

When enabled, it also normalizes top-level Anthropic reasoning options:

- `thinking.type: "adaptive"` becomes `"enabled"`.
- An existing `reasoning_effort` is preserved. Otherwise,
  `output_config.effort` is mapped to it: `low` stays unchanged;
  `medium` and `hight` become `high`; every other supplied value becomes
  `xhigh`. If both fields are absent, `reasoning_effort` defaults to `low`.
- A missing `thinking.budget_tokens` is filled from the normalized effort:
  `low` = 1024, `high` = 4096, `xhigh` = 16000.

If removing a block leaves a message empty, the gateway rejects the request
locally instead of deleting the message and changing conversation history.
Restart the gateway after changing configuration.
