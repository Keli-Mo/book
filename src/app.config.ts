export default defineAppConfig({
  resizable: true,
  lazyCodeLoading: "requiredComponents",
  pages: [
    "pages/Launch/Launch",
    "pages/Home/Home",
    "pages/BookLibrary/BookLibrary",
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
