import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

assert.match(source, /getApps\(\)\.length\s*>\s*0\s*\?\s*getApp\(\)\s*:\s*initializeApp\(/);
assert.match(source, /Platform\.isTV/);
assert.doesNotMatch(source, /location:\s*null/);
// A totem never receives a key, so the screen has to be held awake by the app
// from the very first render, before any content plays.
assert.match(source, /import \{ useKeepAwake \} from 'expo-keep-awake';/);
assert.match(source, /useKeepAwake\(\);/);
// The service target is the only focusable element, so it is always focused:
// its ring must depend on an armed press count, never on focus, or it shows
// permanently on the totem.
assert.match(source, /opacity: servicePressArmed \? 0\.9 : 0 \}/);
assert.doesNotMatch(source, /\(\{ focused \}\)/);
assert.doesNotMatch(source, /focused \? 0\.9/);
// The boot, error and empty states share components/StatusScreen.js, so the
// announcement and the retry control are asserted where they now live.
const statusScreen = readFileSync(
  new URL('../components/StatusScreen.js', import.meta.url),
  'utf8',
);

assert.match(source, /tone=\{StatusTone\.WAITING\}/);
assert.match(source, /tone=\{StatusTone\.ERROR\}/);
assert.match(source, /actionLabel="[^"]+"/);
assert.match(source, /onAction=\{retryNow\}/);
assert.match(statusScreen, /accessibilityRole=\{tone === StatusTone\.ERROR \? 'alert' : 'summary'\}/);
assert.match(statusScreen, /accessibilityRole='button'/);

const readyIndex = source.indexOf("setInitializationState('ready')");
const registrationIndex = source.indexOf('registerDeviceInBackground();');
const baseRegistrationIndex = source.indexOf('await update(ref(database, `devices/${deviceId}`)');
const tvGuardIndex = source.indexOf('if (Platform.isTV)');
const locationUpdateIndex = source.indexOf('await updateDeviceLocation(database, deviceId);');

assert.notEqual(readyIndex, -1, 'The navigator must be enabled after local Firebase initialization.');
assert.notEqual(registrationIndex, -1, 'Device registration must run in the background.');
assert.ok(
  readyIndex < registrationIndex,
  'The navigator must be enabled before background device registration starts.',
);
assert.ok(
  baseRegistrationIndex < tvGuardIndex && tvGuardIndex < locationUpdateIndex,
  'Base registration must precede the TV guard, and TV detection must precede location work.',
);

console.log('App bootstrap static regression checks passed.');
