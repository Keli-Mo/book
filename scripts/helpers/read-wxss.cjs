/* eslint-disable import/no-commonjs */
const fs = require('node:fs');
const path = require('node:path');

function readWxssWithImports(filename, readSource = file => fs.readFileSync(file, 'utf8')) {
  const active = new Set();
  const expand = file => {
    const resolved = path.resolve(file);
    if (active.has(resolved)) throw new Error(`WXSS 循环引用: ${resolved}`);
    active.add(resolved);
    try {
      // Taro emits local quoted @import statements when extracting shared WXSS.
      return readSource(resolved).replace(/@import\s+["']([^"']+)["']\s*;/g,
        (_, relative) => expand(path.resolve(path.dirname(resolved), relative)));
    } finally {
      active.delete(resolved);
    }
  };
  return expand(filename);
}

module.exports = { readWxssWithImports };
