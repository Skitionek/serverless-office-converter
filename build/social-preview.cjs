#!/usr/bin/env node
/* Renders the link-preview image (Open Graph / Twitter card) from build/social-preview.html, the
 * PNG icons from web/icon.svg, and the app screenshot that the browser's install dialog shows
 * (web/screenshot-wide.png, converting the test fixtures), with headless Chromium.
 *
 *   node build/social-preview.cjs                 # web/social-preview.png, icons and screenshot
 *   node build/social-preview.cjs --github x.png  # 1280×640 image for the repository's
 *                                                 # Settings → General → Social preview
 *
 * Needs playwright (npm install --no-save playwright, or NODE_PATH to a global install) and
 * Python with Pillow. The image is designed for the Inter font; other fonts work but change
 * the look.
 */
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { chromium } = require('playwright');

// WhatsApp shows no preview when the image is larger than about 300 KB; a 256-colour palette
// keeps it near 130 KB and looks the same.
const QUANTIZE = `import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
im.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(sys.argv[1], optimize=True)`;

const WEB = path.join(__dirname, '..', 'web');
const FIXTURES = path.join(__dirname, '..', 'test', 'fixtures');
const TEMPLATE = 'file://' + path.join(__dirname, 'social-preview.html');
const argv = process.argv.slice(2);

// [file, size, background]: iOS fills transparent icons with black, so its icon gets a backdrop.
const ICONS = [
    ['icon-192.png', 192, 'transparent'],
    ['icon-512.png', 512, 'transparent'],
    ['apple-touch-icon.png', 180, '#ffffff'],
];

// [fixture, name shown, target]
const SCREENSHOT_FILES = [
    ['sample.docx', 'Quarterly report.docx', 'pdf'],
    ['sample.xlsx', 'Sales by region.xlsx', 'pdf'],
    ['sample.pptx', 'Product launch.pptx', 'pdf'],
    ['sample.md', 'Meeting notes.md', 'docx'],
];

const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
    '.json': 'application/json', '.webmanifest': 'application/manifest+json',
    '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png',
};

// Serves web/ like GitHub Pages (under a project path) and converts the fixtures in the page.
async function appScreenshot(browser, out) {
    const prefix = '/serverless-office-converter/';
    const server = http.createServer((req, res) => {
        const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(prefix.length)) || 'index.html';
        const file = path.join(WEB, rel);
        if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
            return res.writeHead(404).end();
        }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        fs.createReadStream(file).pipe(res);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        await page.goto(`http://127.0.0.1:${server.address().port}${prefix}`);
        await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30000 });
        const files = SCREENSHOT_FILES.map(([fixture, name, target]) => (
            { name, target, b64: fs.readFileSync(path.join(FIXTURES, fixture)).toString('base64') }));
        await page.evaluate(async (files) => {
            const conv = window.officeConverter;
            await conv.engine.start(); // conversion times without the engine's start-up
            conv.addFiles(files.map((f) => new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name)));
            conv.items.forEach((item, i) => { item.row.querySelector('.file-target').value = files[i].target; });
            await conv.runQueue();
            const deadline = Date.now() + 120000;
            const thumbs = [...document.querySelectorAll('office-thumbnail')];
            while (Date.now() < deadline && thumbs.some((t) => !['ready', 'error'].includes(t.getAttribute('state')))) {
                await new Promise((r) => setTimeout(r, 100));
            }
            document.activeElement.blur();
            document.documentElement.style.zoom = '0.8'; // the header, the drop zone and every row
            scrollTo(0, 0);
        }, files);
        await page.screenshot({ path: out });
        execFileSync('python3', ['-c', QUANTIZE, out]);
        console.log(out, '1280×800', fs.statSync(out).size, 'bytes');
    } finally {
        server.close();
    }
}

async function main() {
    const browser = await chromium.launch();
    try {
        const shoot = async (width, height, out) => {
            const page = await browser.newPage({ viewport: { width, height } });
            await page.goto(TEMPLATE);
            await page.evaluate(() => document.fonts.ready);
            await page.screenshot({ path: out });
            await page.close();
            execFileSync('python3', ['-c', QUANTIZE, out]);
            console.log(out, `${width}×${height}`, fs.statSync(out).size, 'bytes');
        };
        if (argv.includes('--github')) {
            await shoot(1280, 640, path.resolve(argv[argv.indexOf('--github') + 1]));
            return;
        }
        await shoot(1200, 630, path.join(WEB, 'social-preview.png'));

        const svg = fs.readFileSync(path.join(WEB, 'icon.svg'), 'utf8');
        for (const [name, size, background] of ICONS) {
            const page = await browser.newPage({ viewport: { width: size, height: size } });
            const pad = background === 'transparent' ? 0 : Math.round(size * 0.1);
            await page.setContent(`<style>html,body{margin:0;background:${background}}
                svg{display:block;width:${size - 2 * pad}px;height:${size - 2 * pad}px;margin:${pad}px}</style>${svg}`);
            const out = path.join(WEB, name);
            await page.screenshot({ path: out, omitBackground: background === 'transparent' });
            await page.close();
            console.log(out, `${size}×${size}`, fs.statSync(out).size, 'bytes');
        }
        await appScreenshot(browser, path.join(WEB, 'screenshot-wide.png'));
    } finally {
        await browser.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
