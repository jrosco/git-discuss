import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MarkdownPreview } from '../src/web/markdown.js';

test('Markdown renders formatting while keeping raw HTML and unsafe links inert', () => {
  const html = renderToStaticMarkup(createElement(MarkdownPreview, {
    value: '**Bold** and `code`\n\n[Good](https://example.test) [Bad](javascript:alert(1))\n\n<script>alert(1)</script>\n\n| A | B |\n|---|---|\n| one | two |',
  }));
  assert.match(html, /<strong>Bold<\/strong>/);
  assert.match(html, /<code>code<\/code>/);
  assert.match(html, /<table>/);
  assert.match(html, /rel="noreferrer noopener"/);
  assert.doesNotMatch(html, /<script[\s>]/i);
  assert.doesNotMatch(html, /href="javascript:/i);
});
