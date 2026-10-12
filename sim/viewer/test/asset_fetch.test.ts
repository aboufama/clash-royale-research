// Deploy version on asset URLs (viewer/src/sc/asset_fetch.ts).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { versionedUrl } from '../src/sc/asset_fetch.ts';

test('asset URLs carry the bundle version only when it has one', () => {
  assert.equal(versionedUrl('assets/manifest.json', null), 'assets/manifest.json');
  assert.equal(versionedUrl('assets/manifest.json', 'abc123'), 'assets/manifest.json?v=abc123');
  assert.equal(versionedUrl('assets/a.json?x=1', 'abc123'), 'assets/a.json?x=1&v=abc123');
  // a local run (no ?v= on the module URL) leaves URLs alone
  assert.equal(versionedUrl('assets/manifest.json'), 'assets/manifest.json');
});
