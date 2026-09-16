import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

assert.match(source, /getApps\(\)\.length\s*>\s*0\s*\?\s*getApp\(\)\s*:\s*initializeApp\(/);
assert.match(source, /Platform\.isTV/);
assert.doesNotMatch(source, /location:\s*null/);
assert.match(source, /accessibilityRole="alert"/);
assert.match(source, /accessibilityRole="button"/);

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
