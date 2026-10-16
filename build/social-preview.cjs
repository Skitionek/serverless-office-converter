#!/usr/bin/env node
/* Renders the link-preview image (Open Graph / Twitter card) from build/social-preview.html and
 * the PNG icons from web/icon.svg, with headless Chromium.
 *
 *   node build/social-preview.cjs                 # web/social-preview.png and the web/*.png icons
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
const path = require('path');
const { chromium } = require('playwright');

// WhatsApp shows no preview when the image is larger than about 300 KB; a 256-colour palette
// keeps it near 130 KB and looks the same.
const QUANTIZE = `import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
im.quantize(256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG).save(sys.argv[1], optimize=True)`;

const WEB = path.join(__dirname, '..', 'web');
const TEMPLATE = 'file://' + path.join(__dirname, 'social-preview.html');
const argv = process.argv.slice(2);

// [file, size, background]: iOS fills transparent icons with black, so its icon gets a backdrop.
const ICONS = [
    ['icon-192.png', 192, 'transparent'],
    ['icon-512.png', 512, 'transparent'],
    ['apple-touch-icon.png', 180, '#ffffff'],
];

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
    } finally {
        await browser.close();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
