#!/usr/bin/env node
// Boot agentgui with a fixture DB on an ephemeral port and capture a set of PNGs.
// Uses puppeteer-core with a system-provided chromium (set CHROME or it autodetects).
//
// Usage: node scripts/capture-screenshots.mjs [--fixtures=./fixtures] [--out=./docs/screenshots]

import fs from 'fs';
import path from 'path';
import net from 'net';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const argMap = Object.fromEntries(process.argv.slice(2).map(a => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? true];
}));
const FIXTURES = path.resolve(argMap.fixtures || path.join(ROOT, 'fixtures'));
const OUT = path.resolve(argMap.out || path.join(ROOT, 'docs/screenshots'));

function pickChrome() {
    if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const candidates = [
        // Linux
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        '/snap/bin/chromium',
        // macOS
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
        // Windows — program files variants
        'C:/Program Files/Google/Chrome/Application/chrome.exe',
        'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
        path.join(home, 'AppData/Local/Google/Chrome/Application/chrome.exe'),
        path.join(home, 'AppData/Local/Chromium/Application/chrome.exe'),
        // puppeteer-core bundled chromium (if installed via npm)
        ...(() => { try { return [require('puppeteer-core').executablePath()]; } catch { return []; } })(),
    ];
    for (const c of candidates) if (c && fs.existsSync(c)) return c;
    throw new Error('No chromium binary found. Set CHROME env var, install Google Chrome, or apt install chromium.');
}

async function findFreePort() {
    return await new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

async function waitForHealthy(url, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const r = await fetch(url);
            if (r.ok) return true;
        } catch {}
        await new Promise(r => setTimeout(r, 250));
    }
    throw new Error(`Server did not become healthy at ${url} within ${timeoutMs}ms`);
}

async function main() {
    fs.mkdirSync(OUT, { recursive: true });
    if (!fs.existsSync(FIXTURES)) {
        console.warn(`[capture] fixture dir does not exist: ${FIXTURES} — using empty data dir`);
        fs.mkdirSync(FIXTURES, { recursive: true });
    }

    const port = await findFreePort();
    const BASE = `http://localhost:${port}/gm`;

    console.log(`[capture] booting server on :${port} with data=${FIXTURES}`);
    const serverEnv = {
        ...process.env,
        PASSWORD: '',
        PORT: String(port),
        HOT_RELOAD: 'false',
        STARTUP_CWD: FIXTURES,
        PORTABLE_DATA_DIR: FIXTURES,
        BASE_URL: '/gm',
        AGENTGUI_SKIP_AUTO_IMPORT: '1',   // do not merge user's ~/.claude/projects into the fixture DB
    };
    const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
        env: serverEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: ROOT,
    });
    const srvLog = [];
    server.stdout.on('data', d => { srvLog.push(d); process.stdout.write(d); });
    server.stderr.on('data', d => { srvLog.push(d); process.stderr.write(d); });

    const cleanup = () => {
        try { server.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { server.kill('SIGKILL'); } catch {} }, 1500);
    };
    process.on('exit', cleanup);
    process.on('SIGINT', () => { cleanup(); process.exit(130); });

    let serverExitCode = null;
    server.on('exit', (code) => { serverExitCode = code ?? 0; });

    try {
        await waitForHealthy(`${BASE}/api/health`);
        if (serverExitCode !== null) throw new Error(`Server exited with code ${serverExitCode} before becoming healthy`);
        console.log('[capture] server healthy — launching browser');

        const { default: puppeteer } = await import('puppeteer-core');
        const browser = await puppeteer.launch({
            executablePath: pickChrome(),
            headless: 'new',
            args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--hide-scrollbars'],
            defaultViewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
        });

        const shots = [
            { name: 'home-light',          theme: 'light', url: `${BASE}/` },
            { name: 'home-dark',           theme: 'dark',  url: `${BASE}/` },
            { name: 'conversation-light',  theme: 'light', url: `${BASE}/`, firstConv: true },
            { name: 'conversation-dark',   theme: 'dark',  url: `${BASE}/`, firstConv: true },
            { name: 'tools-manager',       theme: 'light', url: `${BASE}/`, openTools: true },
        ];

        for (const s of shots) {
            const page = await browser.newPage();
            page.setDefaultNavigationTimeout(30000);
            await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
            await page.evaluateOnNewDocument((theme) => {
                try { localStorage.setItem('theme', theme); } catch {}
                if (theme === 'dark') {
                    document.documentElement.classList.add('dark');
                    document.documentElement.setAttribute('data-theme', 'dark');
                }
                // Determinism: disable transitions/animations so repeated shots match byte-for-byte
                const style = document.createElement('style');
                style.textContent = `*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}`;
                if (document.head) document.head.appendChild(style);
                else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
            }, s.theme);

            console.log(`[capture] -> ${s.name} (${s.theme})`);
            await page.goto(s.url, { waitUntil: 'domcontentloaded' });
            // Determinism: wait until the sidebar has transitioned out of "Loading..."
            // and rendered at least one conversation row.
            await page.waitForFunction(() => {
                const ul = document.querySelector('.sidebar-list');
                if (!ul) return false;
                const rows = ul.querySelectorAll('li:not(.sidebar-empty)');
                return rows.length > 0;
            }, { timeout: 8000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 600));

            if (s.firstConv) {
                const clicked = await page.evaluate(() => {
                    const row = document.querySelector('.sidebar-list li:not(.sidebar-empty), .conversation-item:not(.sidebar-empty)');
                    if (row) { row.click(); return true; }
                    return false;
                });
                if (clicked) {
                    await page.waitForFunction(() => {
                        const out = document.querySelector('#output');
                        return out && out.children.length > 0;
                    }, { timeout: 5000 }).catch(() => {});
                    await new Promise(r => setTimeout(r, 600));
                }
            }
            if (s.openTools) {
                const clicked = await page.evaluate(() => {
                    const btn = document.getElementById('toolsManagerBtn');
                    if (btn) { btn.click(); return true; }
                    return false;
                });
                if (clicked) await new Promise(r => setTimeout(r, 400));
            }

            const outPath = path.join(OUT, `${s.name}.png`);
            await page.screenshot({ path: outPath, type: 'png', fullPage: false });
            const sz = fs.statSync(outPath).size;
            console.log(`   wrote ${outPath} (${(sz/1024).toFixed(1)}KB)`);
            await page.close();
        }

        await browser.close();
    } finally {
        cleanup();
    }

    // Final summary
    const produced = fs.readdirSync(OUT).filter(f => f.endsWith('.png')).sort();
    console.log(`\n[capture] done. ${produced.length} png(s) in ${OUT}`);
    for (const f of produced) {
        const p = path.join(OUT, f);
        console.log(`   ${f}  ${(fs.statSync(p).size/1024).toFixed(1)}KB`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
