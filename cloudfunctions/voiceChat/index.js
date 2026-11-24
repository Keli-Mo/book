const cloud = require("wx-server-sdk");
const { createHandler } = require("./handler");
const { createProviders } = require("./providers");
const { createQuotaStore } = require("./quota");

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const parseIds = (list = "") => new Set(list.split(",").map((value) => value.trim()).filter(Boolean));
// SCF_FUNCTIONNAME is supplied by the cloud runtime, not the request body.
// Never open the production function if the test switch is copied by mistake.
const openTrial = process.env.VOICE_CHAT_OPEN_TRIAL === "true" && process.env.SCF_FUNCTIONNAME === "voiceChatDiagnostics";
const quotaEnabled = !openTrial && process.env.VOICE_CHAT_QUOTA_ENABLED === "true";

exports.main = createHandler({
  enabled: process.env.VOICE_CHAT_ENABLED === "true",
  openTrial,
  allowedOpenIds: parseIds(process.env.VOICE_CHAT_ALLOWED_OPENIDS),
  unlimitedOpenIds: parseIds(process.env.VOICE_CHAT_UNLIMITED_OPENIDS),
  debugOpenIds: parseIds(process.env.VOICE_CHAT_DEBUG_OPENIDS),
  quotaEnabled,
  quota: quotaEnabled ? createQuotaStore(cloud.database({ throwOnNotFound: false })) : null,
  getOpenId: () => {
    const context = cloud.getWXContext();
    // WeChat manages who can open the experience build. This check authenticates
    // same-app callers; it does not independently verify experience membership.
    if (openTrial && context.APPID !== "wxdb6824b2da985a21") return undefined;
    return context.OPENID;
  },
  logDiagnostic: (event) => console.warn(JSON.stringify(event)),
  ...createProviders(),
});
