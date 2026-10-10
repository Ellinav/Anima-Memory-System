# JSON response regressions

Run with Node.js 22.7+ (no install or browser required):

```sh
node --test tests/model-json.test.cjs
```

The suite imports the actual browser-compatible parser and vendored repair
library. It executes the summary parsing/saving section in an isolated VM with
dictionary and worldbook writes captured in memory, so malformed responses must
fail before either write. Inputs are synthetic, anonymized examples.

Coverage includes unescaped dialogue quotes, nested tags mistaken for summaries,
status updates, incomplete responses, dictionary extraction, schema validation,
plain-text compatibility, and preservation of existing escapes and content.
