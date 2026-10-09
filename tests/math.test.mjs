import test from 'node:test';
import assert from 'node:assert/strict';
import { formulaSVG } from '../core/math.mjs';
const fixtures = {
  'inline physics': String.raw`E=mc^2`,
  'fractions and sums': String.raw`\mathcal{L}(\theta)=-\sum_{i=1}^{N}\log p_\theta(x_i\mid x_{<i})`,
  matrix: String.raw`A=\begin{pmatrix}a&b\\c&d\end{pmatrix}`,
  'aligned multiline': String.raw`\begin{aligned}f(x)&=(x+1)^2\\&=x^2+2x+1\end{aligned}`,
  'piecewise cases': String.raw`f(x)=\begin{cases}x^2&x\ge0\\-x&x<0\end{cases}`,
  'explicit equation number': String.raw`\int_0^1x^2\,dx=\frac13\tag{1}`,
  'local macro': String.raw`\newcommand{\R}{\mathbb{R}}\quad x\in\R`,
  chemistry: String.raw`\ce{CO2 + C -> 2 CO}`,
  'extended symbols': String.raw`\cancel{x}+\braket{\psi|H|\psi}`,
};
for (const [name, tex] of Object.entries(fixtures))
  test('MathJax SVG: ' + name, async () => {
    const svg = await formulaSVG(tex);
    assert.match(svg, /^<svg/);
    assert.match(svg, /<path/);
    assert.doesNotMatch(svg, /<merror|data-mjx-error|<script|https?:\/\/[^" ]+\.woff/);
    assert.doesNotMatch(
      svg,
      /<use /,
      'SVG must contain its glyph paths, not depend on a global font cache',
    );
  });
test('invalid TeX reports an error instead of pretending to render', async () => {
  await assert.rejects(formulaSVG(String.raw`\thisMacroDoesNotExist{x}`));
});
