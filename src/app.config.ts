export default defineAppConfig({
  resizable: true,
  pages: [
    "pages/Home/Home",
    "pages/BookLibrary/BookLibrary",
    "pages/Practice/Practice",
    "pages/CheckInDetail/CheckInDetail",
    "pages/MyCheckIns/MyCheckIns",
  ],
  window: {
    backgroundTextStyle: "light",
    navigationBarBackgroundColor: "#fff",
    navigationBarTitleText: "海沙牛娃英语跟读",
    navigationBarTextStyle: "black",
  },
  permission: {
    "scope.record": {
      desc: "用于录制并回听你的英语跟读，确认打卡后才会上传云端",
    },
  },
  entryPagePath: "pages/Home/Home",
});
