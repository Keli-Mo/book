const assert = require("node:assert/strict");
const { createPage, createFakeTimers, elements, textOf, byClass } = require("./test-practice-book-route.cjs");

const settle = () => new Promise(resolve => setImmediate(resolve));
const free = (freeRemaining) => ({ kind: "metered", freeRemaining, packRemaining: 0, packExpiresAt: null });
const button = (page, label) => elements(page.render()).find(node => node.type === "Button" && textOf(node) === label);
const microphone = page => byClass(page.render(), "voice-chat__mic");

(async () => {
  const timers = createFakeTimers();
  const confirmations = [];
  let quota = free(1), chatCalls = 0, recording;
  const page = createPage("src/pages/VoiceChat/VoiceChat.tsx", {}, {
    setTimeout: timers.setTimeout, clearTimeout: timers.clearTimeout, deferAudioPlay: true,
    taroOverrides: {
      getStorageSync: () => false,
      setStorageSync: () => {},
      showModal: async options => {
        assert.ok([...options.confirmText].length <= 4, "微信说明弹窗确认按钮最多四个汉字");
        return { confirm: true, cancel: false };
      },
    },
    overrides: {
      "@/features/voiceChat/recording": {
        createVoiceRecorder: () => ({
          start(onStop) { recording = onStop; },
          stop() { const onStop = recording; recording = undefined; onStop("/record.mp3", 1200); },
          cancel() { recording = undefined; }, isActive() { return Boolean(recording); },
        }),
      },
      "@/features/voiceChat/playback": {
        sweepVoiceAudioFiles: async () => {}, removeRecordedTempFile: async () => {}, removeVoiceFile: async () => {},
        readVoiceRecordingBase64: async () => "QUJD", saveVoiceAudioBase64: async () => "/reply.mp3",
      },
      "@/services/voiceChat": {
        isVoiceChatPreview: () => true, getVoiceChatQuota: async () => quota,
        callVoiceChat: async ({ requestId }) => {
          chatCalls++;
          quota = { ...free(0), pendingUntil: Date.now() + 120000 };
          return { requestId, transcript: "Hello", replyEn: "Hi!", replyZh: "你好！", audioBase64: "QUJD", receipt: { requestId, token: "c".repeat(32) } };
        },
        confirmVoiceChatTurn: async receipt => {
          confirmations.push(receipt);
          quota = free(0);
          if (confirmations.length === 1) throw Error("response lost after commit");
          return quota;
        },
      },
    },
  });
  try {
    page.render(); page.show(); await settle();
    assert.match(textOf(page.render()), /免费剩余 1 轮/);
    microphone(page).props.onClick(); await settle();
    microphone(page).props.onClick(); await settle();
    assert.equal(confirmations.length, 0, "仅收到语音、写入文件、调用 play 均不能扣轮");
    assert.match(textOf(page.render()), /上一轮正在处理/);
    page.audios.at(-1).trigger("Error"); await settle();
    assert.match(textOf(page.render()), /本轮还没有扣除/);
    assert.equal(confirmations.length, 0);
    button(page, "重听").props.onClick(); await settle();
    page.audios.at(-1).trigger("Play"); await settle();
    assert.equal(confirmations.length, 1);
    assert.equal(microphone(page).props.disabled, false, "轮数用完仍可通过气泡停止正在播放的回复");
    timers.advance(800); await settle();
    assert.deepEqual(confirmations[1], confirmations[0], "网络应答丢失后重试同一份收据");
    page.audios.at(-1).trigger("Ended");
    assert.match(textOf(page.render()), /5 轮免费体验已用完/);
    assert.equal(microphone(page).props.disabled, true);
    assert.equal(button(page, "重听").props.disabled, false);
    button(page, "重听").props.onClick(); await settle();
    page.audios.at(-1).trigger("Play"); page.audios.at(-1).trigger("Ended");
    button(page, "跟读").props.onClick(); await settle(); button(page, "结束跟读").props.onClick(); await settle();
    button(page, "回听自己").props.onClick(); await settle();
    page.audios.at(-1).trigger("Play");
    page.audios.at(-1).trigger("Ended");
    assert.equal(confirmations.length, 2);
    assert.equal(chatCalls, 1, "免费额度耗尽后重听和跟读不能发起新对话");
    quota = { ...free(0), packRemaining: 10, packExpiresAt: Date.now() + 86400000 };
    page.show(); await settle(); assert.match(textOf(page.render()), /体验包剩余 10 轮，.+到期/);
    quota = { ...free(0), packRemaining: 10, packExpiresAt: Date.now() - 1000 };
    page.show(); await settle(); assert.match(textOf(page.render()), /体验包已到期/);
    quota = { kind: "unlimited" }; page.show(); await settle();
    assert.equal(textOf(byClass(page.render(), "voice-chat__quota")), "内部测试");
    assert.equal(microphone(page).props.disabled, false, "不限轮用户可继续录音");
    assert.ok(!textOf(page.render()).includes("首次播放计 1 轮"), "不限轮用户不显示计轮提示");
  } finally {
    page.unload(); page.dispose();
  }
  console.log("voice chat page quota and playback checks passed");
})().catch(error => { console.error(error); process.exitCode = 1; });
