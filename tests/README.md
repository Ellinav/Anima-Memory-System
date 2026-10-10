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

## Regex list browser regression

The layout check uses the actual rule component, CSS, five consumer headers
and the independent GC rule renderer,
with jQuery/Sortable assets from a SillyTavern checkout. Install Playwright in
your development environment and its Chromium browser, then run:

```sh
SILLYTAVERN_ROOT=/path/to/SillyTavern node tests/regex-layout.browser.cjs
```

Set `ANIMA_UI_OUTPUT` to a screenshot directory if desired. The check covers
320/360/390/430/768/1280px widths, visible regex text, control/input bounds,
editing, cancellation, saving, toggling, adding, deleting and the sorting save
callback. It does not exercise physical touch dragging or a logged-in profile.
