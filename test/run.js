'use strict';

/*
 * Test runner. Loads every `test-*.js` file in this folder, then prints a
 * summary. No frameworks, no dependencies.
 *
 * Run with:  node test/run.js
 */

const fs = require('fs');
const path = require('path');
const { runAll } = require('./_helpers');

const here = __dirname;
const testFiles = fs
  .readdirSync(here)
  .filter((f) => f.startsWith('test-') && f.endsWith('.js'))
  .sort();

console.log(`Đang chạy ${testFiles.length} file test:`);
for (const f of testFiles) {
  console.log('\n— ' + f);
  require(path.join(here, f));
}

console.log('');
runAll().then(({ failed }) => {
  process.exit(failed > 0 ? 1 : 0);
});
