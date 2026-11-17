const cloud = require("wx-server-sdk");
const { createHandler } = require("./handler");
const { createProviders } = require("./providers");
const { createQuotaStore } = require("./quota");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const parseIds = (list = "") => new Set(list.split(",").map((value) => value.trim()).filter(Boolean));
const quotaEnabled = process.env.VOICE_CHAT_QUOTA_ENABLED === "true";

exports.main = createHandler({
  enabled: process.env.VOICE_CHAT_ENABLED === "true",
  allowedOpenIds: parseIds(process.env.VOICE_CHAT_ALLOWED_OPENIDS),
  unlimitedOpenIds: parseIds(process.env.VOICE_CHAT_UNLIMITED_OPENIDS),
  quotaEnabled,
  quota: quotaEnabled ? createQuotaStore(cloud.database({ throwOnNotFound: false })) : null,
  getOpenId: () => cloud.getWXContext().OPENID,
  logDiagnostic: (event) => console.warn(JSON.stringify(event)),
  ...createProviders(),
});
