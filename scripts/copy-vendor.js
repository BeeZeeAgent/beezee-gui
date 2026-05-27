#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const copies = [
  ['node_modules/xstate/dist/xstate.umd.min.js', 'static/lib/xstate.umd.min.js'],
];

for (const [src, dest] of copies) {
  const srcPath = path.join(root, src);
  const destPath = path.join(root, dest);
  if (!fs.existsSync(srcPath)) { console.warn('[copy-vendor] not found:', src); continue; }
  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  fs.copyFileSync(srcPath, destPath);
  console.log('[copy-vendor] copied', src, '->', dest);
}

// Build webjsx IIFE bundle from ESM dist files
const webjsxDist = path.join(root, 'node_modules/webjsx/dist');
if (fs.existsSync(webjsxDist)) {
  const ORDER = ['constants', 'elementTags', 'utils', 'renderSuspension', 'attributes', 'createDOMElement', 'createElement', 'applyDiff', 'types'];

  function stripModule(src) {
    return src
      .replace(/^import\s+.*?from\s+['"][^'"]+['"];?\s*$/gm, '')
      .replace(/^export\s+(const|function|class|async\s+function)\s+/gm, '$1 ')
      .replace(/^export\s+\{[^}]*\}(\s+from\s+['"][^'"]+['"])?\s*;?\s*$/gm, '')
      .replace(/^export\s+\*\s+from\s+['"][^'"]+['"];?\s*$/gm, '')
      .replace(/^\/\/#\s+sourceMappingURL=.*$/gm, '')
      .trim();
  }

  const stripped = ORDER.map(name => {
    const src = fs.readFileSync(path.join(webjsxDist, `${name}.js`), 'utf8');
    return `// === ${name}.js ===\n${stripModule(src)}`;
  });

  const iife = `(function(window) {\n"use strict";\n\n${stripped.join('\n\n')}\n\nwindow.webjsx = { createElement, applyDiff, createDOMElement, Fragment };\n})(typeof window !== 'undefined' ? window : globalThis);\n`;

  const dest = path.join(root, 'static/lib/webjsx.js');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, iife);
  console.log('[copy-vendor] built webjsx IIFE ->', 'static/lib/webjsx.js', `(${iife.split('\n').length} lines)`);
} else {
  console.warn('[copy-vendor] webjsx not found in node_modules — run npm install');
}
