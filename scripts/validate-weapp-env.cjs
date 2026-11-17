/* eslint-disable import/no-commonjs */
const fs = require("node:fs");
const path = require("node:path");

const dist = path.resolve(__dirname, "../dist");
const visit = (directory) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (entry.name.endsWith(".js") && /\bprocess\.env\b/.test(fs.readFileSync(file, "utf8"))) {
      throw new Error(`小程序产物仍含 process.env，运行时会报 process is not defined：${file}`);
    }
  }
};

visit(dist);
console.log("Compiled WeChat bundle has no runtime process.env references.");
