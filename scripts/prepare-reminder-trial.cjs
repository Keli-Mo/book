// 微信开发者工具为每个云函数独立打包。两个入口使用同一实现，package.json 固定通道。
const { copyFileSync } = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "../cloudfunctions");
copyFileSync(path.join(root, "dailyReminder/index.js"), path.join(root, "dailyReminderTrial/index.js"));
