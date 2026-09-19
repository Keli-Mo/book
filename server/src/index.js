const Koa = require("koa");

const DEFAULT_PORT = 80;

const resolveEntryMode = (value) =>
  value === "practice" ? "practice" : "intro";

const createApp = () => {
  const app = new Koa();

  app.use(async (ctx) => {
    if (ctx.method === "GET" && (ctx.path === "/" || ctx.path === "/health")) {
      ctx.body = { ok: true };
      return;
    }

    if (ctx.method === "GET" && ctx.path === "/api/app-entry") {
      ctx.body = {
        ok: true,
        mode: resolveEntryMode(process.env.APP_ENTRY_MODE),
      };
      return;
    }

    ctx.status = 404;
    ctx.body = { ok: false, error: "NOT_FOUND" };
  });

  return app;
};

const start = () => {
  const port = Number.parseInt(process.env.PORT || String(DEFAULT_PORT), 10);
  const listenPort = Number.isInteger(port) && port > 0 ? port : DEFAULT_PORT;
  createApp().listen(listenPort, "0.0.0.0", () => {
    process.stdout.write(`haisha cloud hosting listening on ${listenPort}\n`);
  });
};

if (require.main === module) {
  start();
}

module.exports = {
  createApp,
  resolveEntryMode,
};
