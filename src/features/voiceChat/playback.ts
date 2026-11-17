const fileManager = () => wx.getFileSystemManager();

export const readVoiceRecordingBase64 = (filePath: string): Promise<string> => new Promise((resolve, reject) => {
  fileManager().readFile({
    filePath,
    encoding: "base64",
    success: (result) => typeof result.data === "string" ? resolve(result.data) : reject(new Error("录音文件读取失败")),
    fail: () => reject(new Error("录音文件读取失败")),
  });
});

export const saveVoiceAudioBase64 = (requestId: string, audioBase64: string): Promise<string> => new Promise((resolve, reject) => {
  if (!/^[a-f0-9]{32}$/.test(requestId) || !/^[A-Za-z0-9+/]+={0,2}$/.test(audioBase64)) {
    reject(new Error("语音数据格式不正确"));
    return;
  }
  const filePath = `${wx.env.USER_DATA_PATH}/voice-chat-${requestId}.mp3`;
  fileManager().writeFile({
    filePath,
    data: audioBase64,
    encoding: "base64",
    success: () => resolve(filePath),
    fail: () => reject(new Error("语音文件保存失败")),
  });
});

export const removeVoiceFile = (filePath: string): Promise<void> => new Promise((resolve) => {
  if (!filePath || !filePath.startsWith(wx.env.USER_DATA_PATH + "/voice-chat-")) { resolve(); return; }
  fileManager().unlink({ filePath, success: () => resolve(), fail: () => resolve() });
});

export const removeRecordedTempFile = (filePath: string): Promise<void> => new Promise((resolve) => {
  if (!filePath) { resolve(); return; }
  fileManager().unlink({ filePath, success: () => resolve(), fail: () => resolve() });
});

/** 清理上次异常退出后遗留的合成音频，不删除当前页面正在使用的文件。 */
export const sweepVoiceAudioFiles = (retain: () => Set<string>): Promise<void> => new Promise((resolve) => {
  const directory = wx.env.USER_DATA_PATH;
  fileManager().readdir({
    dirPath: directory,
    success: ({ files }) => {
      const stale = files.filter((name) => /^voice-chat-[a-f0-9]{32}\.mp3$/.test(name))
        .map((name) => `${directory}/${name}`)
        .filter((filePath) => !retain().has(filePath));
      void Promise.all(stale.map(removeVoiceFile)).then(() => resolve(), () => resolve());
    },
    fail: () => resolve(),
  });
});
