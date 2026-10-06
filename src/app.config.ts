type AppConfigWithLegacyPlaceholder = Parameters<typeof defineAppConfig>[0] & {
  componentPlaceholder: { comp: "view" };
};

const appConfig = {
  // 保留 iPad 横竖屏支持；手机方向由 window.pageOrientation 控制。
  resizable: true,
  lazyCodeLoading: "requiredComponents",
  // 历史启动页白屏兼容配置；Taro 4.0.12 的 AppConfig 未收录，保留现有输出。
  componentPlaceholder: {
    comp: "view",
  },
  pages: [
    "pages/Launch/Launch",
    "pages/Home/Home",
    "pages/BookLibrary/BookLibrary",
    "pages/ThinkBookReader/ThinkBookReader",
    "pages/Practice/Practice",
    "pages/CheckInDetail/CheckInDetail",
    "pages/MyCheckIns/MyCheckIns",
    "pages/Intro/Intro",
  ],
  window: {
    pageOrientation: "portrait",
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#fff",
    navigationBarTitleText: "海沙牛娃英语跟读",
    navigationBarTextStyle: "black",
  },
  entryPagePath: "pages/Launch/Launch",
} satisfies AppConfigWithLegacyPlaceholder;

export default defineAppConfig(appConfig);
