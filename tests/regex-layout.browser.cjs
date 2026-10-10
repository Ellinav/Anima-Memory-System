const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require('playwright');

// Use the same jQuery/Sortable assets as the host application, not a DOM mock.
const source = path.resolve(process.env.ANIMA_SOURCE_ROOT || path.join(__dirname, '..'));
assert(process.env.SILLYTAVERN_ROOT, 'Set SILLYTAVERN_ROOT to a SillyTavern checkout (for browser assets).');
const host = path.resolve(process.env.SILLYTAVERN_ROOT);
const output = process.env.ANIMA_UI_OUTPUT;
const consumers = [
  ['summary.js', 'anima_regex_list_pre'],
  ['summary.js', 'anima_regex_list_post'],
  ['status.js', 'status_regex_list_container'],
  ['rag.js', 'rag_regex_list'],
  ['bm25.js', 'bm25_regex_list'],
];
const rules = [
  { type: 'extract', regex: '/<content>(.*?)<\\/content>/gs', enabled: true },
  { type: 'exclude', regex: '/<!--(?:状态更新|状态校准|世界书备注):[\\s\\S]*?-->/g', enabled: true },
  { type: 'extract', regex: '/<(正文|content|story_content)\\b[^>]*>([\\s\\S]*?)<\\/\\1>/g', enabled: false },
];

function fixture() {
  const gcCode = fs.readFileSync(path.join(source, 'scripts/status_gc_ui.js'), 'utf8');
  const gcListStart = gcCode.indexOf('<div id="gc_regex_list_container"');
  const gcHeaderStart = gcCode.lastIndexOf('<div class="anima-flex-row', gcListStart);
  const gcHtml = gcCode.slice(gcHeaderStart, gcCode.indexOf('</div>', gcListStart) + 6);
  const gcRenderStart = gcCode.indexOf('const renderGCRegex = () => {');
  const gcRenderEnd = gcCode.indexOf('\n  // ==========================================', gcRenderStart);
  assert(gcHeaderStart > 0 && gcRenderStart > 0 && gcRenderEnd > gcRenderStart);
  const gcRender = gcCode.slice(gcRenderStart, gcRenderEnd);
  const panels = consumers.map(([file, id], index) => {
    const code = fs.readFileSync(path.join(source, 'scripts', file), 'utf8');
    const end = code.indexOf(`<div id="${id}"`);
    const start = code.lastIndexOf('<div class="anima-flex-row', end);
    assert(start >= 0 && end > start, `Missing rule header: ${id}`);
    const close = code.indexOf('</div>', end) + 6;
    return `<section class="anima-card" data-panel="${index}" ${index ? 'hidden' : ''}>
      ${code.slice(start, close)}
    </section>`;
  }).join('');
  return `<!doctype html><html lang="zh"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link rel="stylesheet" href="/st/css/fontawesome.min.css">
    <link rel="stylesheet" href="/st/css/solid.min.css">
    <link rel="stylesheet" href="/extension/style.css">
    <style>body {margin:0} [hidden] {display:none !important}</style>
    <div id="anima-overlay"><div class="anima-header-bar">
      <div class="anima-brand"><i class="fa-solid fa-bars"></i> Anima Memory System</div>
      <i class="fa-solid fa-xmark"></i></div>
      <div class="anima-main-layout"><div class="anima-content-area">
        <div class="anima-tab-content active">${panels}
          <section class="anima-card" data-panel="5" id="anima-gc-management-modal" hidden>${gcHtml}</section>
        </div>
      </div></div></div>
    <script src="/st/lib/jquery-3.5.1.min.js"></script>
    <script src="/st/lib/jquery-ui.min.js"></script>
    <script src="/st/lib/jquery.ui.touch-punch.min.js"></script>
    <script type="module">
      import { RegexListComponent } from '/extension/scripts/regex_ui.js';
      window.models = ${JSON.stringify(consumers.map(() => rules))};
      window.components = ${JSON.stringify(consumers)}.map(([, id], i) => {
        const component = new RegexListComponent(id, () => window.models[i],
          data => { window.models[i] = data; });
        component.render(); return component;
      });
      const gcSettings = { regex_list: ${JSON.stringify(rules.map(rule => ({ type: rule.type, content: rule.regex })))} };
      const escapeHtml = text => $('<div>').text(text).html();
      const renderGCPrompts = () => {};
      ${gcRender}
      window.gcSettings = gcSettings;
      renderGCRegex();
      window.ready = true;
    </script>`;
}

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  if (pathname === '/') {
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(fixture()); return;
  }
  const root = pathname.startsWith('/extension/') ? source : path.join(host, 'public');
  const relative = pathname.replace(/^\/(extension|st)\//, '');
  const file = path.resolve(root, relative);
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
    res.writeHead(404); res.end(); return;
  }
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ANIMA_CHROMIUM_PATH ? { executablePath: process.env.ANIMA_CHROMIUM_PATH } : {}) });
  let checks = 0;
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready);
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'regex-initial.png') });
    }
    for (const width of [320, 360, 390, 430, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const [index, [, id]] of consumers.entries()) {
        await page.evaluate(index => {
          document.querySelectorAll('[data-panel]').forEach((panel, i) => panel.hidden = i !== index);
        }, index);
        const list = page.locator(`#${id}`);
        const row = list.locator('.anima-regex-item').first();
        const text = row.locator('.regex-text');
        assert.equal(await text.innerText(), rules[0].regex);
        const geometry = await row.evaluate(element => {
          const body = element.closest('.anima-content-area');
          const text = element.querySelector('.regex-text');
          const row = element.getBoundingClientRect();
          return { textOverflow: text.scrollWidth > text.clientWidth + 1,
            bodyOverflow: body.scrollWidth > body.clientWidth + 1,
            outside: [...element.querySelectorAll('button, label, .regex-text')].some(child => {
              const box = child.getBoundingClientRect();
              return box.width && (box.right > row.right + 1 || box.left < row.left - 1);
            }) };
        });
        if (width <= 768) assert.equal(geometry.textOverflow, false, `${id}: clipped text at ${width}px`);
        assert.equal(geometry.bodyOverflow || geometry.outside, false, `${id}: overflowing controls at ${width}px`);
        await row.locator('.btn-edit').click();
        const field = row.locator('.edit-input');
        assert.equal(await field.inputValue(), rules[0].regex);
        assert(await field.evaluate(el => el.getBoundingClientRect().width) >= (width <= 768 ? 140 : 100));
        assert.equal(await row.evaluate(element => {
          const row = element.getBoundingClientRect();
          return [...element.querySelectorAll('.edit-mode > *')].some(child => {
            const box = child.getBoundingClientRect();
            return box.width && (box.right > row.right + 1 || box.left < row.left - 1);
          });
        }), false, `${id}: overflowing editor at ${width}px`);
        await field.fill('/<正文>(.*?)<\\/正文>/gs');
        await row.locator('.btn-cancel').click();
        assert.equal(await text.innerText(), rules[0].regex);
        checks++;
      }
      await page.evaluate(() => document.querySelectorAll('[data-panel]').forEach((panel, i) => panel.hidden = i !== 5));
      const gcField = page.locator('.gc-regex-content').first();
      assert.equal(await gcField.inputValue(), rules[0].regex);
      assert(await gcField.evaluate(el => el.getBoundingClientRect().width) >= (width <= 768 ? 140 : 100));
      assert.equal(await page.locator('.gc-regex-item').first().evaluate(el => {
        const row = el.getBoundingClientRect();
        const body = el.closest('.anima-content-area');
        return body.scrollWidth > body.clientWidth + 1 || [...el.children].some(child => {
          const rect = child.getBoundingClientRect();
          return rect.right > row.right + 1 || rect.left < row.left - 1;
        });
      }), false, `GC: overflowing controls at ${width}px`);
      checks++;
    }
    await page.locator('.gc-regex-content').first().fill('/GC-edited/g');
    assert.equal(await page.evaluate(() => window.gcSettings.regex_list[0].content), '/GC-edited/g');
    await page.locator('.gc-regex-type').first().selectOption('exclude');
    assert.equal(await page.evaluate(() => window.gcSettings.regex_list[0].type), 'exclude');
    await page.locator('.gc-regex-delete').first().click();
    assert.equal(await page.evaluate(() => window.gcSettings.regex_list.length), 2);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.querySelectorAll('[data-panel]').forEach((panel, i) => panel.hidden = i !== 0));
    if (output) {
      fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, 'regex-mobile.png') });
    }
    const row = page.locator('#anima_regex_list_pre .anima-regex-item').first();
    await row.locator('.btn-edit').click();
    if (output) await page.screenshot({ path: path.join(output, 'regex-mobile-edit.png') });
    const revised = '/<正文>(.*?)<\\/正文>/gs';
    await row.locator('.edit-input').fill(revised);
    await row.locator('.edit-type').selectOption('exclude');
    await row.locator('.btn-save').click();
    assert.equal(await row.locator('.regex-text').innerText(), revised);
    assert.equal(await row.locator('.anima-tag').innerText(), '排除');
    await row.locator('.anima-switch').tap();
    assert.equal(await page.evaluate(() => window.models[0][0].enabled), false);
    await row.locator('.btn-del').click();
    assert.equal(await page.evaluate(() => window.models[0].length), 2);
    await page.evaluate(() => window.components[0].addRule('/added/g', 'extract'));
    assert.equal(await page.evaluate(() => window.models[0].at(-1).regex), '/added/g');
    await page.evaluate(() => {
      const list = $('#anima_regex_list_pre');
      list.prepend(list.children().last());
      list.sortable('option', 'stop').call(list[0], {}, {});
    });
    assert.equal(await page.evaluate(() => window.models[0][0].regex), '/added/g');
    await page.setViewportSize({ width: 1280, height: 844 });
    await page.evaluate(rules => { window.models[0] = rules; window.components[0].render(); }, rules);
    if (output) await page.screenshot({ path: path.join(output, 'regex-desktop.png') });
    assert.deepEqual(errors, []);
    console.log(`PASS: ${checks} consumer/viewport combinations; edit/cancel/save/toggle/delete/add/sort; no page errors.`);
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
