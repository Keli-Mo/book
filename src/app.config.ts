export default defineAppConfig({
  resizable: true,
  lazyCodeLoading: "requiredComponents",
  // Taro 的虚拟 comp 在按需注入时路径会变成 wx://not-found，闸门页白屏。
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
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#fff",
    navigationBarTitleText: "海沙牛娃英语跟读",
    navigationBarTextStyle: "black",
  },
  permission: {
    "scope.record": {
      desc: "用于录制并回听你的英语跟读，点击分享后才会上传云端",
    },
  },
  entryPagePath: "pages/Launch/Launch",
});
