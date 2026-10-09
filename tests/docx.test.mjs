import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { formulaSVG } from '../core/math.mjs';
const require = createRequire(import.meta.url),
  { exportDocx } = require('../core/docx.cjs'),
  run = promisify(execFile);
const binary = '/opt/homebrew/bin/pandoc';
test(
  'Word preserves normal equations and substitutes vector graphics for unsupported TeX',
  { skip: !require('node:fs').existsSync(binary) },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-docx-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = String.raw`\ce{CO2 + C -> 2 CO}`,
      target = path.join(dir, 'output.docx');
    const result = await exportDocx({
      binary,
      content: '# Test\n\n$E=mc^2$\n\n$$\n' + source + '\n$$\n',
      resourceDir: dir,
      target,
      tempDir: dir,
      maths: [{ source, svg: await formulaSVG(source) }],
    });
    assert.equal(result.fallbackCount, 1);
    const { stdout: xml } = await run('/usr/bin/unzip', ['-p', target, 'word/document.xml']);
    const { stdout: files } = await run('/usr/bin/unzip', ['-Z1', target]);
    assert.match(xml, /<m:oMath>/);
    assert.match(files, /word\/media\/.*\.svg/);
    const visible = [...xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g)].map((m) => m[1]).join('');
    assert.doesNotMatch(visible, /\\ce/);
  },
);
test(
  'Word recognizes inline and display single-backslash LaTeX delimiters',
  { skip: !require('node:fs').existsSync(binary) },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-docx-brackets-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const target = path.join(dir, 'brackets.docx');
    const result = await exportDocx({
      binary,
      content: '# Generated document\n\nOptimizer error \\(\\eta\\).\n\n\\[\nE = mc^2\n\\]\n',
      resourceDir: dir,
      target,
      tempDir: dir,
    });
    assert.equal(result.fallbackCount, 0);
    const { stdout: xml } = await run('/usr/bin/unzip', ['-p', target, 'word/document.xml']);
    assert.equal([...xml.matchAll(/<m:oMath>/g)].length, 2);
    const visible = [...xml.matchAll(/<w:t(?:\s[^>]*)?>(.*?)<\/w:t>/g)]
      .map((match) => match[1])
      .join('');
    assert.doesNotMatch(visible, /\\\(|\\\)|\\\[|\\\]|\\eta/);
  },
);
test(
  'Word uses the generated SVG for unsupported bracket-delimited math',
  { skip: !require('node:fs').existsSync(binary) },
  async (t) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'folio-docx-bracket-svg-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const source = String.raw`\ce{CO2 + C -> 2 CO}`;
    const target = path.join(dir, 'formula.docx');
    const result = await exportDocx({
      binary,
      content: '\\[\n' + source + '\n\\]\n',
      resourceDir: dir,
      target,
      tempDir: dir,
      maths: [{ source, svg: await formulaSVG(source) }],
    });
    assert.equal(result.fallbackCount, 1);
    const { stdout: files } = await run('/usr/bin/unzip', ['-Z1', target]);
    assert.match(files, /word\/media\/.*\.svg/);
  },
);
