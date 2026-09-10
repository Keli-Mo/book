/* eslint-disable import/no-commonjs */
const assert = require("assert/strict");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
const compiled = new Map();
const load = (file, overrides = {}, cache = new Map()) => {
  if (cache.has(file)) return cache.get(file);
  if (!compiled.has(file)) {
    compiled.set(file, ts.transpileModule(read(file), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
    }).outputText);
  }
  const loaded = { exports: {} };
  cache.set(file, loaded.exports);
  new Function("module", "exports", "require", "wx", compiled.get(file))(
    loaded, loaded.exports, (request) => {
      if (Object.hasOwn(overrides, request)) return overrides[request];
      if (request.endsWith(".scss")) return {};
      if (request.startsWith("@/") || request.startsWith(".")) {
        const base = request.startsWith("@/") ? `src/${request.slice(2)}` : path.join(path.dirname(file), request);
        const target = [base, `${base}.ts`, `${base}.tsx`].find((candidate) => fs.existsSync(path.join(projectRoot, candidate)));
        assert.ok(target, `依赖必须存在：${request}`);
        return load(target, overrides, cache);
      }
      return require(request);
    }, overrides.wx,
  );
  return loaded.exports;
};
const { buildBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");

// 仅替换 React 调度和微信原生边界；路由、bundle、目录、音频控制器及点击回调都执行生产代码。
const createPage = (file, params, options = {}) => {
  let frame;
  let slot;
  const frames = new Map();
  const effects = [];
  const navigations = [];
  const audios = [];
  const recorderHandlers = {};
  const recorder = { stop() {}, start() {}, pause() {}, resume() {} };
  for (const event of ["Start", "Pause", "Resume", "Stop", "Error"]) {
    recorder[`on${event}`] = (callback) => { recorderHandlers[event] = callback; };
    recorder[`off${event}`] = () => { delete recorderHandlers[event]; };
  }
  const hook = (initial) => {
    const index = slot++;
    if (!frame.slots[index]) frame.slots[index] = initial();
    return frame.slots[index];
  };
  const changed = (before, after) => !before || !after || before.length !== after.length || after.some((item, i) => !Object.is(item, before[i]));
  const react = {
    useState(initial) {
      const state = hook(() => ({ value: typeof initial === "function" ? initial() : initial }));
      return [state.value, (value) => { state.value = typeof value === "function" ? value(state.value) : value; }];
    },
    useRef(initial) { return hook(() => ({ current: initial })); },
    useMemo(factory, deps) {
      const memo = hook(() => ({}));
      if (changed(memo.deps, deps)) { memo.value = factory(); memo.deps = deps; }
      return memo.value;
    },
    useEffect(callback, deps) {
      const effect = hook(() => ({}));
      if (changed(effect.deps, deps)) {
        effects.push(() => { effect.cleanup?.(); effect.cleanup = callback(); });
        effect.deps = deps;
      }
    },
  };
  const taro = {
    useRouter: () => ({ params }),
    useDidHide(callback) { frame.hide = callback; },
    useShareAppMessage() {},
    navigateTo: async ({ url }) => { navigations.push(url); },
    reLaunch: async ({ url }) => { navigations.push(url); },
    showToast() {}, showLoading() {}, hideLoading() {}, pageScrollTo() {},
    showModal: async () => ({ confirm: true }),
    authorize: async () => {},
    createInnerAudioContext() {
      const handlers = {};
      const audio = { src: "", events: [], currentTime: 0 };
      for (const event of ["Play", "Ended", "Stop", "Error", "TimeUpdate"]) audio[`on${event}`] = (callback) => { handlers[event] = callback; };
      audio.play = () => { audio.events.push("play"); handlers.Play?.(); };
      audio.stop = () => { audio.events.push("stop"); handlers.Stop?.(); };
      audio.destroy = () => { audio.events.push("destroy"); };
      audios.push(audio);
      return audio;
    },
  };
  const checkIns = [];
  const overrides = {
    react,
    "@tarojs/components": Object.fromEntries(["View", "Text", "Image", "Button", "ScrollView"].map((name) => [name, name])),
    "@tarojs/taro": { __esModule: true, default: taro, ...taro },
    "@/constant": { sharedImage: "share.png" },
    "@/services/cloudCheckIn": {
      getCheckInDetail: async () => options.detail,
      getReadableCloudError: (error) => error.message,
      uploadCheckInRecording: async () => "cloud://recording",
      createCheckIn: async (input) => { checkIns.push(input); return { id: "record&1", shareToken: "token&1" }; },
      removeUploadedRecording: async () => {},
    },
    wx: { getRecorderManager: () => recorder },
    ...options.overrides,
  };
  const Component = load(file, overrides).default;
  let tree;
  const renderNode = (node, location) => {
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${location}/${index}`));
    if (!node || typeof node !== "object") return node;
    if (typeof node.type === "function") {
      const id = `${location}/${node.type.name}:${node.key || ""}`;
      if (!frames.has(id)) frames.set(id, { slots: [] });
      frame = frames.get(id);
      frame.used = true;
      slot = 0;
      const result = node.type(node.props);
      return { ...node, props: { ...node.props, children: renderNode(result, id) } };
    }
    return { ...node, props: { ...node.props, children: renderNode(node.props?.children, location) } };
  };
  const render = () => {
    for (const current of frames.values()) current.used = false;
    tree = renderNode({ type: Component, props: {} }, "root");
    for (const [id, current] of frames) {
      if (!current.used) {
        for (const item of current.slots) item.cleanup?.();
        frames.delete(id);
      }
    }
    effects.splice(0).forEach((effect) => effect());
    return tree;
  };
  return {
    render, navigations, audios, recorderHandlers, checkIns,
    setRoute(next) { params = next; return render(); },
    hide() { for (const current of frames.values()) current.hide?.(); },
  };
};
const elements = (node) => Array.isArray(node) ? node.flatMap(elements) : node && typeof node === "object" ? [node, ...elements(node.props?.children)] : [];
const textOf = (node) => Array.isArray(node) ? node.map(textOf).join("") : node && typeof node === "object" ? textOf(node.props?.children) : node == null || typeof node === "boolean" ? "" : String(node);
const byClass = (tree, name) => elements(tree).find((node) => String(node.props?.className || "").split(" ").includes(name));
const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

async function testRoutes() {
  const practiceSource = read("src/pages/Practice/Practice.tsx");
  assert.doesNotMatch(practiceSource, /SAMPLE_BOOK_(?:ID|TITLE|COVER|PRACTICES)|book3Practice/, "Practice 必须移除固定 CASA 模型，改为实际 router 选择教材");
  assert.doesNotMatch(practiceSource, /DEFAULT_BOOK_ID/, "训练页不得自行猜默认教材");
  assert.equal(fs.existsSync(path.join(projectRoot, "src/features/listeningPractice/book3Practice.ts")), false, "固定 CASA 死文件应在替换引用后删除");
  for (const bookId of ["3", "22", "25"]) {
    const bundle = buildBookPracticeBundle(bookId);
    for (const index of [0, bundle.practices.length - 1]) {
      const page = createPage("src/pages/Practice/Practice.tsx", { bookId, practice: String(index) });
      let tree = page.render();
      const practice = bundle.practices[index];
      assert.equal(textOf(byClass(tree, "practice-header__course")), bundle.book.title);
      assert.equal(textOf(byClass(tree, "practice-header__progress")).trim(), `跟读训练 ${index + 1} / ${bundle.practices.length}`);
      assert.equal(byClass(tree, "practice-book-page__image").props.src, practice.imageUrl);
      assert.equal(textOf(byClass(tree, "practice-header__section")), practice.sectionTitle);
      const hotspots = elements(tree).filter((node) => String(node.props?.className || "").split(" ").includes("audio-hotspot"));
      assert.equal(hotspots.length, practice.tracks.length);
      assert.deepEqual(hotspots[0].props.style, { left: practice.tracks[0].left, top: practice.tracks[0].top });
      hotspots[0].props.onClick();
      assert.equal(page.audios.at(-1).src, practice.tracks[0].url);
      const directory = elements(tree).find((node) => node.type?.name === "PracticeDirectory");
      assert.deepEqual(directory.props.groups.flatMap((group) => group.items).map((item) => item.id), bundle.practices.map((item) => item.id));
      await directory.props.onSelect(bundle.practices.length);
      await directory.props.onSelect(-1);
      await directory.props.onSelect(0.5);
      assert.equal(textOf(byClass(page.render(), "practice-header__progress")).trim(), `跟读训练 ${index + 1} / ${bundle.practices.length}`, "目录越界不能破坏当前训练");
      const navigation = () => elements(page.render()).filter((node) => String(node.props?.className || "").split(" ").includes("practice-navigation__button"));
      const boundaryButton = index === 0 ? 0 : 1;
      assert.match(navigation()[boundaryButton].props.className, /practice-navigation__button--disabled/);
      await navigation()[boundaryButton].props.onClick();
      assert.equal(byClass(page.render(), "practice-book-page__image").props.src, practice.imageUrl, "首尾点击不能夹页或跨教材");
      await navigation()[1 - boundaryButton].props.onClick();
      const adjacent = index === 0 ? 1 : index - 1;
      assert.equal(byClass(page.render(), "practice-book-page__image").props.src, bundle.practices[adjacent].imageUrl, "上下页应在当前 bundle 内切换");
      await navigation()[boundaryButton].props.onClick();
      page.recorderHandlers.Stop({ tempFilePath: "/tmp/recording.mp3", duration: 1200 });
      tree = page.render();
      await byClass(tree, "check-in-button").props.onClick();
      assert.deepEqual(page.checkIns[0], {
        recordingFileId: "cloud://recording", durationMs: 1200,
        bookId, bookTitle: bundle.book.title, practiceId: practice.id,
        practiceIndex: index, pageNumber: practice.pageNumber,
        sectionTitle: practice.sectionTitle, imageUrl: practice.imageUrl,
      });
      assert.equal(page.navigations.at(-1), "/pages/CheckInDetail/CheckInDetail?id=record%261&token=token%261");
    }
  }
  const invalidRoutes = [{}, { practice: "0" }, { bookId: "3" }, { bookId: "unknown", practice: "0" }];
  for (const bookId of ["3", "22", "25"]) {
    for (const practice of ["", " ", "-1", "1.5", "NaN", "Infinity", "1e1", "0x1", "01", "9007199254740992", String(buildBookPracticeBundle(bookId).practices.length)]) invalidRoutes.push({ bookId, practice });
  }
  for (const params of invalidRoutes) {
    const page = createPage("src/pages/Practice/Practice.tsx", params);
    const tree = page.render();
    assert.equal(byClass(tree, "practice-page"), undefined, `非法路由不能夹到首尾：${JSON.stringify(params)}`);
    const button = elements(tree).find((node) => node.type === "Button" && textOf(node) === "选择教材");
    assert.ok(button, "非法路由应有可恢复的书库入口");
    button.props.onClick();
    assert.equal(page.navigations.at(-1), "/pages/BookLibrary/BookLibrary");
    assert.equal(page.audios.length, 0, "非法路由不能初始化录音会话");
  }
  const broken = createPage("src/pages/Practice/Practice.tsx", { bookId: "22", practice: "0" }, {
    overrides: { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle() { throw new Error("教材 22 第 2 页：缺少图片"); } } },
  });
  assert.match(textOf(broken.render()), /教材 22 第 2 页：缺少图片/);

  for (const bookId of ["3", "22", "25"]) {
    const bundle = buildBookPracticeBundle(bookId);
    for (const practiceIndex of [0, bundle.practices.length - 1, undefined, -1, 0.5, "0", bundle.practices.length]) {
      await testHistory({ bookId, practiceIndex }, Number.isInteger(practiceIndex) && practiceIndex >= 0 && practiceIndex < bundle.practices.length);
    }
  }
  await testHistory({}, false);
  await testHistory({ bookId: "unknown", practiceIndex: 0 }, false);
  await testHistory({ bookId: "book &1", practiceIndex: 0 }, true, { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle: () => buildBookPracticeBundle("22") } });
  await testHistory({ bookId: "22", practiceIndex: 0 }, false, { "@/features/listeningPractice/bookPractice": { buildBookPracticeBundle() { throw new Error("损坏教材"); } } });
  const { BOOKS, resolveBookAction } = load("src/features/bookLibrary/bookCatalog.ts");
  for (const book of BOOKS) assert.equal(resolveBookAction(book).url, `/pages/Practice/Practice?bookId=${encodeURIComponent(book.id)}&practice=0`);
  assert.equal(resolveBookAction({ ...BOOKS[0], id: "book &1" }).url, "/pages/Practice/Practice?bookId=book%20%261&practice=0");
  console.log("教材路由测试通过：真实路由、首尾边界、恢复页、教材内容、打卡与历史回跳正确。");
}

async function testHistory(fields, valid, overrides = {}) {
  const detail = { id: "record", bookTitle: "历史书名", sectionTitle: "历史章节", imageUrl: "history.png", durationMs: 1000, createdAt: 0, recordingUrl: "record.mp3", shareToken: "token", isOwner: true, ...fields };
  const page = createPage("src/pages/CheckInDetail/CheckInDetail.tsx", { id: "record" }, { detail, overrides });
  page.render();
  await settle();
  const tree = page.render();
  const button = byClass(tree, "check-in-actions__practice");
  assert.equal(textOf(button), valid ? "我也来跟读" : "选择教材", JSON.stringify(fields));
  button.props.onClick();
  assert.equal(page.navigations.at(-1), valid ? `/pages/Practice/Practice?bookId=${encodeURIComponent(fields.bookId)}&practice=${fields.practiceIndex}` : "/pages/BookLibrary/BookLibrary");
}

module.exports = { createPage, elements, textOf, byClass, buildBookPracticeBundle };
if (require.main === module) testRoutes().catch((error) => { console.error(error); process.exitCode = 1; });
