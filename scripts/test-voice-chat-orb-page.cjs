const assert = require("node:assert/strict");
const { createPage, elements, textOf, byClass } = require("./test-practice-book-route.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const microphone = page => {
  const node = byClass(page.render(), "voice-chat__mic");
  assert.equal(node?.type, "Button", "语音气泡应保留原生按钮交互");
  return node;
};
const button = (page, label) => {
  const node = elements(page.render()).find(item => item.type === "Button" && textOf(item) === label);
  assert.ok(node, `应存在操作：${label}`);
  return node;
};
const reply = request => ({
  requestId: request.requestId, transcript: "I like dogs.",
  replyEn: "Dogs are fun. What is your dog's name?", replyZh: "狗很有趣。你的狗叫什么名字？",
  audioBase64: "QUJD",
});

function createVoicePage(options = {}) {
  const calls = { starts: 0, stops: 0, requests: [] };
  let recording;
  const page = createPage("src/pages/VoiceChat/VoiceChat.tsx", {}, {
    deferAudioPlay: true,
    taroOverrides: {
      getStorageSync: () => true, setStorageSync: () => {},
      ...options.taroOverrides,
    },
    overrides: {
      "@/features/voiceChat/recording": {
        createVoiceRecorder: () => ({
          start(onStop, onError) {
            calls.starts++;
            recording = { onStop, onError };
          },
          stop() {
            assert.ok(recording, "只有真实开始的录音才能结束");
            calls.stops++;
            const current = recording;
            recording = undefined;
            current.onStop(`/record-${calls.starts}.mp3`, 1200);
          },
          cancel() { recording = undefined; },
          isActive() { return Boolean(recording); },
        }),
      },
      "@/features/voiceChat/playback": {
        sweepVoiceAudioFiles: async () => {}, removeRecordedTempFile: async () => {}, removeVoiceFile: async () => {},
        readVoiceRecordingBase64: async () => "QUJD", saveVoiceAudioBase64: async () => "/reply.mp3",
      },
      "@/services/voiceChat": {
        isVoiceChatPreview: () => true, getVoiceChatQuota: async () => ({ kind: "unlimited" }),
        callVoiceChat: async request => {
          calls.requests.push(request);
          return options.callVoiceChat ? options.callVoiceChat(request) : reply(request);
        },
      },
    },
  });
  return { page, calls, isRecording: () => Boolean(recording) };
}

async function withPage(options, check) {
  const context = createVoicePage(options);
  const { page } = context;
  try {
    page.render(); page.show(); await settle();
    await check(context);
  } finally {
    page.unload(); page.dispose();
  }
}

async function recordTurn(page) {
  microphone(page).props.onClick(); await settle();
  microphone(page).props.onClick(); await settle();
}

(async () => {
  await withPage({}, async ({ page }) => {
    const mic = microphone(page);
    assert.equal(mic.props["data-state"], "idle");
    assert.ok(mic.props.ariaLabel?.trim(), "无文字按钮必须有可朗读的动作名称");
    assert.equal(textOf(mic), "", "气泡按钮用图标表达，不显示按钮文案");
    const composer = byClass(page.render(), "voice-chat__composer");
    const nodes = elements(composer);
    const index = nodes.findIndex(node => node.type === "Button" && String(node.props.className).split(" ").includes("voice-chat__mic"));
    assert.ok(index >= 0);
    assert.equal(nodes.slice(index + 1).filter(node => node.type === "Text" && textOf(node).trim()).length, 0, "气泡及其下方不显示文字提示");
  });

  await withPage({}, async ({ page, calls, isRecording }) => {
    await recordTurn(page);
    const audio = page.audios.at(-1);
    assert.ok(audio, "回复生成后应创建英文播放器");
    assert.equal(microphone(page).props["data-state"], "loading", "原生播放尚未开始时不能假装正在发声");
    audio.trigger("Play");
    assert.equal(microphone(page).props["data-state"], "speaking");
    assert.match(microphone(page).props.ariaLabel, /停止/);
    microphone(page).props.onClick(); await settle();
    assert.ok(audio.events.includes("stop"));
    assert.ok(audio.events.includes("destroy"));
    assert.equal(calls.starts, 1, "播放中首点只停播，不能同时开始录音");
    assert.equal(calls.requests.length, 1, "停止播放不发起新对话");
    assert.equal(isRecording(), false);
    assert.equal(microphone(page).props["data-state"], "idle");
    audio.trigger("Play");
    assert.equal(microphone(page).props["data-state"], "idle", "已停止播放器的迟到事件不能复活播放状态");
    microphone(page).props.onClick(); await settle();
    assert.equal(calls.starts, 2, "停播后的下一次点击才开始录音");
    assert.equal(isRecording(), true);
    assert.equal(calls.requests.length, 1);
  });

  await withPage({}, async ({ page, calls, isRecording }) => {
    await recordTurn(page);
    page.audios.at(-1).trigger("Play"); page.audios.at(-1).trigger("Ended");
    button(page, "跟读").props.onClick(); await settle();
    assert.equal(isRecording(), true);
    assert.equal(microphone(page).props.disabled, false, "跟读期间气泡可用于结束本地录音");
    assert.match(microphone(page).props.ariaLabel, /跟读/);
    microphone(page).props.onClick(); await settle();
    assert.equal(isRecording(), false);
    assert.equal(calls.requests.length, 1, "结束跟读只能保存本地录音，不能发送给 AI");
    button(page, "回听自己").props.onClick(); await settle();
    assert.equal(page.audios.at(-1).src, "/record-2.mp3");
    page.audios.at(-1).trigger("Play");
    assert.equal(microphone(page).props["data-state"], "speaking", "本地回听也由真实播放事件驱动气泡");
  });

  const pendingReply = deferred();
  await withPage({ callVoiceChat: () => pendingReply.promise }, async ({ page, calls }) => {
    const firstClick = microphone(page).props.onClick;
    firstClick(); firstClick(); await settle();
    assert.equal(calls.starts, 1, "启动授权和录音期间快速重复点击不能重复占用麦克风");
    microphone(page).props.onClick(); await settle();
    const processingButton = microphone(page);
    assert.equal(processingButton.props.disabled, true);
    processingButton.props.onClick(); processingButton.props.onClick(); await settle();
    assert.equal(calls.requests.length, 1, "处理中即使迟到点击回调到达也不能重复发送");
    assert.equal(calls.starts, 1);
    pendingReply.resolve(reply(calls.requests[0])); await settle();
  });

  const authorization = deferred();
  let authorizationCalls = 0;
  await withPage({ taroOverrides: {
    getStorageSync: () => false,
    showModal: () => { throw Error("不应再显示额外的录音说明确认框"); },
    getSetting: async () => ({ authSetting: {} }),
    authorize: async ({ scope }) => {
      assert.equal(scope, "scope.record");
      authorizationCalls++;
      await authorization.promise;
      throw { errMsg: "authorize:fail auth deny" };
    },
  } }, async ({ page, calls }) => {
    microphone(page).props.onClick(); await settle();
    assert.equal(microphone(page).props["data-state"], "loading");
    assert.equal(microphone(page).props.disabled, true);
    microphone(page).props.onClick(); await settle();
    assert.equal(authorizationCalls, 1, "只请求微信麦克风授权，不能重复弹出业务确认");
    authorization.resolve(); await settle();
    assert.equal(microphone(page).props["data-state"], "error", "拒绝麦克风授权后退出等待并说明原因");
    assert.equal(microphone(page).props.disabled, false);
    assert.match(textOf(page.render()), /麦克风权限未开启/);
    assert.equal(calls.starts, 0);
    assert.equal(calls.requests.length, 0);
  });

  let shouldFail = true;
  await withPage({ callVoiceChat: request => {
    if (shouldFail) throw { code: "ASR_TIMEOUT" };
    return reply(request);
  } }, async ({ page, calls }) => {
    await recordTurn(page);
    assert.equal(microphone(page).props["data-state"], "error");
    assert.equal(microphone(page).props.disabled, false);
    const tree = page.render();
    const error = byClass(tree, "voice-chat__error");
    assert.match(textOf(error), /语音识别超时/);
    const nodes = elements(tree);
    const micIndex = nodes.findIndex(node => node.type === "Button" && String(node.props.className).split(" ").includes("voice-chat__mic"));
    assert.ok(nodes.indexOf(error) < micIndex, "具体错误显示在气泡上方，不能被纯图标吞掉");
    shouldFail = false;
    await recordTurn(page);
    assert.equal(calls.requests.length, 2, "发生具体错误后仍可重新录音发起下一轮");
    assert.equal(byClass(page.render(), "voice-chat__error"), undefined);
  });

  console.log("voice chat orb page checks passed: playback, local repeat, concurrency, microphone authorization, recovery and accessibility");
})().catch(error => { console.error(error); process.exitCode = 1; });
