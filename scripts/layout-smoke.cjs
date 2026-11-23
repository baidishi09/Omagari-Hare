'use strict';

const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.join(root, 'test-results', 'layout');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(output, 'profile-'));
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function captureNative(application, name) {
  // Electron's native capture honors webContents zoom. CDP full-page capture
  // uses unzoomed clip dimensions and can cut off half the view at 200%.
  const encoded = await application.evaluate(async ({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('settings.html'));
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(null))))');
    const image = await window.webContents.capturePage();
    return image.toPNG().toString('base64');
  });
  fs.writeFileSync(path.join(output, name), Buffer.from(encoded, 'base64'));
}

async function readScene(page) {
  return page.evaluate(() => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left: box.left, top: box.top + scrollY, right: box.right, bottom: box.bottom + scrollY, width: box.width, height: box.height };
    };
    const room = document.querySelector('.room');
    const image = document.querySelector('.room-background');
    const actor = document.querySelector('.scene-actor');
    const bounds = rect(room);
    const cover = Math.max(room.clientWidth / image.naturalWidth, room.clientHeight / image.naturalHeight);
    const expectedFoot = bounds.bottom - image.naturalHeight * 0.16 * cover;
    const actualFoot = rect(actor).top + actor.clientWidth * 201 / 192;
    const compact = matchMedia('(max-width:760px),(max-height:500px)').matches;
    const targets = ['.room-name', '.settings-entry', '.room-greeting', '.habit-note', '.scene-actor', '.action-bar', '.room-tip'];
    if (document.getElementById('interaction-feedback').textContent) targets.push('.interaction-feedback');
    const boxes = targets.map(selector => ({ selector, ...rect(document.querySelector(selector)) }));
    const collisions = [];
    for (let first = 0; first < boxes.length; first++) {
      for (let second = first + 1; second < boxes.length; second++) {
        const a = boxes[first], b = boxes[second];
        if (compact && [a.selector, b.selector].includes('.scene-actor') && [a.selector, b.selector].includes('.interaction-feedback')) continue;
        if (a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top) collisions.push([a.selector, b.selector]);
      }
    }
    const fontRules = {
      '#idle-status': 12, '.settings-entry': 12, '.note-copy': 12, '.note-link': 12,
      '.room-action': 12, '.field-help': 12, '.idle-control p': 12, '.switch-row small': 12,
      '.interaction-help': 12, '#save-status': 12, '.room-name small': 11, '.room-tip': 11,
      '.note-title': 11, '.range-endpoints': 11,
    };
    const smallFonts = Object.entries(fontRules).flatMap(([selector, minimum]) => Array.from(document.querySelectorAll(selector))
      .filter(element => parseFloat(getComputedStyle(element).fontSize) < minimum)
      .map(element => ({ selector, minimum, actual: getComputedStyle(element).fontSize })));
    return {
      viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight, room: bounds, boxes, collisions,
      expectedFoot, actualFoot, smallFonts,
      source: { width: image.naturalWidth, height: image.naturalHeight },
      compact,
    };
  });
}

async function assertActionFeedback(application, page, name) {
  for (const action of ['wave', 'jump', 'walk', 'home', 'pause', 'pause']) {
    const button = page.locator(`#${action}-button`);
    await button.scrollIntoViewIfNeeded();
    await button.click();
    await page.evaluate(() => window.hare.getState());
    await page.waitForFunction(() => document.getElementById('interaction-feedback').textContent.length > 0);
    await page.evaluate(() => {
      const feedback = document.getElementById('interaction-feedback');
      feedback.textContent = '当前动作暂时无法完成，请稍后重新打开窗口再试。'.repeat(4).slice(0, 60);
      feedback.classList.add('error');
    });
    const layout = await page.evaluate(() => {
      const feedback = document.getElementById('interaction-feedback').getBoundingClientRect();
      const overlaps = box => feedback.left < box.right && feedback.right > box.left
        && feedback.top < box.bottom && feedback.bottom > box.top;
      return {
        visible: feedback.left >= 0 && feedback.top >= 0 && feedback.right <= innerWidth && feedback.bottom <= innerHeight,
        textLength: document.getElementById('interaction-feedback').textContent.length,
        collisions: ['.room-name', '.settings-entry', '.room-greeting', '.habit-note', '.action-bar']
          .filter(selector => overlaps(document.querySelector(selector).getBoundingClientRect())),
      };
    });
    assert.equal(layout.textLength, 60);
    assert(layout.visible, `${name} ${action}: feedback is visible beside the scrolled action bar`);
    assert.deepEqual(layout.collisions, [], `${name} ${action}: longest feedback avoids text and controls`);
  }
  await captureNative(application, `${name}-action-feedback.png`);
}

async function assertDrawer(page) {
  await page.locator('#settings-button').click();
  const layout = await page.evaluate(() => {
    const dialog = document.querySelector('dialog');
    const content = document.querySelector('.drawer-content');
    const bounds = dialog.getBoundingClientRect();
    return {
      top: bounds.top, left: bounds.left, right: bounds.right, bottom: bounds.bottom,
      width: innerWidth, height: innerHeight, scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth,
      contentWidth: content.clientWidth, contentScrollWidth: content.scrollWidth,
    };
  });
  assert(layout.top >= -1 && layout.left >= -1 && layout.right <= layout.width + 1 && layout.bottom <= layout.height + 1,
    `drawer fits CSS viewport: ${JSON.stringify(layout)}`);
  assert(layout.scrollWidth <= layout.clientWidth + 1 && layout.contentScrollWidth <= layout.contentWidth + 1,
    `drawer has no horizontal clipping: ${JSON.stringify(layout)}`);
  for (const selector of ['#idle-minutes', '#speed', '#pet-height', '#display', '#always-on-top', '#click-through', '#launch-at-login']) {
    await page.locator(selector).scrollIntoViewIfNeeded();
    const visible = await page.locator(selector).evaluate(element => {
      const box = element.getBoundingClientRect();
      const area = document.querySelector('.drawer-content').getBoundingClientRect();
      return box.top >= area.top - 1 && box.bottom <= area.bottom + 1;
    });
    assert(visible, `${selector} reachable through drawer scrolling`);
  }
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#settings-button').evaluate(element => document.activeElement === element), true);
}

async function main() {
  const application = await electron.launch({ args: [root, `--data-dir=${profile}`, '--settings'], timeout: 30000 });
  const errors = [];
  application.on('window', page => page.on('pageerror', error => errors.push(error.message)));
  try {
    let page;
    for (let count = 0; count < 100 && !page; count++) {
      page = application.windows().find(item => item.url().endsWith('settings.html'));
      if (!page) await sleep(50);
    }
    assert(page, 'settings page exists');
    await page.waitForLoadState('load');
    await page.waitForFunction(() => document.querySelector('.room-background').naturalWidth > 0);
    await page.waitForFunction(() => document.getElementById('phase-label').textContent === '我在这里。');
    await page.evaluate(() => document.fonts.ready);
    await application.evaluate(({ powerMonitor }) => { powerMonitor.getSystemIdleTime = () => 0; });
    const reports = [];
    for (const zoom of [1, 2]) {
      for (const [width, height] of [[1000, 790], [800, 640], [1280, 720], [1440, 900]]) {
        const name = `${width}x${height}-${zoom * 100}`;
        await application.evaluate(({ BrowserWindow }, value) => {
          const window = BrowserWindow.getAllWindows().find(item => item.webContents.getURL().endsWith('settings.html'));
          window.setSize(value.width, value.height);
          window.webContents.setZoomFactor(value.zoom);
        }, { width, height, zoom });
        await page.evaluate(() => scrollTo(0, 0));
        await sleep(250);
        // Exercise a bounded failure message as well as the quiet default state.
        await page.evaluate(() => {
          const feedback = document.getElementById('interaction-feedback');
          feedback.textContent = '这次动作暂时没有完成，请稍后重新打开窗口再试。';
          feedback.classList.add('error');
        });
        const layout = await readScene(page);
        reports.push({ name, ...layout });
        assert.deepEqual(layout.source, { width: 1536, height: 1024 });
        assert(layout.documentWidth <= layout.viewport.width + 1, `${name}: horizontal content fits`);
        assert.deepEqual(layout.collisions, [], `${name}: scene items do not overlap: ${JSON.stringify(layout)}`);
        assert(Math.abs(layout.actualFoot - layout.expectedFoot) < 1, `${name}: feet remain on illustrated desktop`);
        assert.deepEqual(layout.smallFonts, [], `${name}: body and control fonts are readable`);
        if (!layout.compact) assert(layout.documentHeight <= layout.viewport.height + 1, `${name}: normal layout does not require scrolling`);
        for (const box of layout.boxes) {
          assert(box.left >= -1 && box.right <= layout.viewport.width + 1 && box.top >= -1 && box.bottom <= layout.documentHeight + 1,
            `${name}: ${box.selector} fits reachable document`);
        }
        await captureNative(application, `${name}-home.png`);
        if (layout.compact) {
          for (const [section, selector] of [['middle', '#habits-button'], ['bottom', '.action-bar']]) {
            await page.locator(selector).scrollIntoViewIfNeeded();
            await captureNative(application, `${name}-${section}.png`);
          }
        }
        await page.locator('#wave-button').scrollIntoViewIfNeeded();
        await page.locator('#wave-button').click();
        if (zoom === 2 && width <= 1000) await assertActionFeedback(application, page, name);
        await assertDrawer(page);
        await page.locator('#settings-button').click();
        await captureNative(application, `${name}-drawer.png`);
        await page.keyboard.press('Escape');
        console.log(`Passed ${name}: image-relative feet, readable copy, collision-free controls, reachable page and drawer.`);
      }
    }
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(reports, null, 2));
    assert.deepEqual(errors, []);
    console.log('Layout smoke passed for four native window sizes at 100% and 200% zoom.');
  } finally {
    await application.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
