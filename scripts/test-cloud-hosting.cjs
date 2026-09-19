/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const http = require("http");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const dockerfile = fs.readFileSync(
  path.join(projectRoot, "server/Dockerfile"),
  "utf8",
);
const server = require(path.join(projectRoot, "server/src/index.js"));

assert.match(dockerfile, /COPY package.json package-lock.json/);
assert.match(dockerfile, /EXPOSE 80/);
assert.match(dockerfile, /CMD \["node", "src\/index\.js"\]/);
assert.equal(server.resolveEntryMode(undefined), "intro");
assert.equal(server.resolveEntryMode("practice"), "practice");
assert.equal(server.resolveEntryMode("other"), "intro");

const request = (app, url) =>
  new Promise((resolve, reject) => {
    const listener = http.createServer(app.callback()).listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      http
        .get({ hostname: "127.0.0.1", port, path: url }, (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () => {
            listener.close();
            resolve({
              status: response.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            });
          });
        })
        .on("error", (error) => {
          listener.close();
          reject(error);
        });
    });
  });

(async () => {
  const previous = process.env.APP_ENTRY_MODE;
  delete process.env.APP_ENTRY_MODE;
  const app = server.createApp();
  assert.deepEqual((await request(app, "/health")).body, { ok: true });
  assert.deepEqual((await request(app, "/api/app-entry")).body, {
    ok: true,
    mode: "intro",
  });
  process.env.APP_ENTRY_MODE = "practice";
  assert.deepEqual((await request(app, "/api/app-entry")).body, {
    ok: true,
    mode: "practice",
  });
  assert.equal((await request(app, "/missing")).status, 404);
  if (previous === undefined) delete process.env.APP_ENTRY_MODE;
  else process.env.APP_ENTRY_MODE = previous;
  console.log("云托管入口服务契约通过：Dockerfile 端口 80，APP_ENTRY_MODE 控制分流。");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
