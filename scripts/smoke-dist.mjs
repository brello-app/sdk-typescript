import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Brello as ESMBrello } from '../dist/index.mjs';

const require = createRequire(import.meta.url);
const { Brello: CommonJSBrello } = require('../dist/index.cjs');

assert.equal(typeof ESMBrello, 'function');
assert.equal(typeof CommonJSBrello, 'function');
