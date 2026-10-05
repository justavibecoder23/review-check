import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');

test('YouTube frame and iframe share rounded clipping without exposed dark edges', () => {
  assert.match(css, /\.how-video-frame \{[^}]*position: relative;[^}]*aspect-ratio: 16 \/ 9;[^}]*overflow: hidden;[^}]*clip-path: inset\(0 round 18px\);[^}]*isolation: isolate;[^}]*background: #fff;/);
  assert.match(css, /\.how-video-frame iframe \{[^}]*position: absolute;[^}]*inset: 0;[^}]*box-sizing: border-box;[^}]*border: 0;[^}]*border-radius: inherit;[^}]*clip-path: inset\(0 round 18px\);/);
});
