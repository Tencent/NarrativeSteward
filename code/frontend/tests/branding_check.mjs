import assert from 'node:assert/strict'
import { FORMAL_PRODUCT_NAME, productNameForMode } from '../src/branding.js'
assert.equal(FORMAL_PRODUCT_NAME, 'NarrativeSteward')
assert.equal(productNameForMode(), 'NarrativeSteward')
console.log('branding_check: pass')
