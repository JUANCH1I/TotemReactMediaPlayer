import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../components/Carousel.js', import.meta.url), 'utf8');

assert.match(source, /useWindowDimensions\(\)/);
assert.doesNotMatch(source, /Dimensions\.get|\bDimensions\b/);
assert.doesNotMatch(source, /\boff\b/);
assert.doesNotMatch(source, /\[\.\.\.playlist,\s*\.\.\.playlist\]/);
assert.doesNotMatch(source, /\[deviceId,\s*setDeviceId\]/);

assert.match(source, /unsubscribe\s*=\s*onValue\(/);
assert.match(source, /unsubscribe\?\.\(\)/);
assert.match(source, /Image\.prefetch\(nextUri\)/);
assert.match(source, /animationGenerationRef\.current \+= 1/);
assert.match(source, /activeAnimationRef\.current\?\.stop\(\)/);
assert.match(source, /items\.length <= 1/);
assert.match(source, /useReducer\(carouselReducer/);
assert.doesNotMatch(source, /requestAnimationFrame|setCurrentIndex|setPlaylist/);
assert.match(source, /width: resolvedWidth/);
assert.match(source, /height: resolvedHeight/);

const imageNodeCount = (source.match(/<Image\b/g) ?? []).length;
assert.ok(imageNodeCount <= 2, `Carousel must declare at most 2 Image nodes; found ${imageNodeCount}.`);

console.log('Carousel static regression checks passed.');
