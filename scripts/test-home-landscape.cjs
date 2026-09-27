/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const sass = require("sass");
const postcss = require("postcss");
const { createUiPage } = require("./helpers/native-ui-fixtures.cjs");
const { byClass, elements, textOf, load } = require("./test-practice-book-route.cjs");

const css = postcss.parse(sass.compile(path.resolve(__dirname, "../src/pages/Home/Home.scss")).css);
const scope = ".library-home.device-layout--phone.device-layout--landscape";
const { buildFullBookPracticeBundle } = load("src/features/listeningPractice/bookPractice.ts");
const { BOOK_SERIES } = load("src/features/bookLibrary/bookCatalog.ts");
const profile = {
  windowWidth: 844, windowHeight: 390, isPad: false, isSplit: false,
  orientation: "landscape", statusBarHeight: 20, safeAreaBottom: 21,
};

function declaration(suffix, property, supports = false) {
  let result;
  const selector = suffix ? `${scope} ${suffix}` : scope;
  css.walkRules(rule => {
    if (!rule.selectors.includes(selector)) return;
    if ((rule.parent.type === "atrule") !== supports) return;
    rule.walkDecls(property, item => { result = item.value; });
  });
  return result;
}
function pixels(suffix, property) {
  const value = declaration(suffix, property);
  assert.match(value || "", /^\d+(?:\.\d+)?PX$/i, `${suffix} ${property} uses fixed CSS pixels`);
  return Number.parseFloat(value);
}

test("phone landscape keeps the continue card readable and its action at least 44px", () => {
  const brand = pixels(".library-home__brand", "font-size");
  assert.ok(brand >= 18 && brand <= 20);
  const card = pixels(".continue-card", "min-height");
  const coverHeight = pixels(".continue-card__cover", "height");
  const coverWidth = pixels(".continue-card__cover", "width");
  assert.ok(card >= 140 && card <= 156);
  assert.ok(coverHeight >= 112 && coverHeight <= 120);
  assert.ok(coverWidth >= 80 && coverWidth <= 84);
  assert.equal(pixels(".continue-card__title", "font-size"), 16);
  assert.equal(pixels(".continue-card__progress", "font-size"), 12);
  const action = pixels(".continue-card__button", "height");
  assert.ok(action >= 44);
  const bodyBudget = 2 * pixels(".continue-card__title", "line-height")
    + pixels(".continue-card__progress", "margin-top")
    + pixels(".continue-card__progress", "line-height") + action;
  assert.ok(bodyBudget <= coverHeight, "two title lines, progress and action fit beside the cover");
  assert.equal(declaration(".continue-card__button", "flex"), "none", "the action cannot shrink");
  assert.ok(pixels(".series-row__cover", "height") <= 56);
  assert.ok(pixels(".series-row__title", "font-size") <= 16);
});

test("phone landscape reserves the compact bottom bar and its safe area", () => {
  const footer = pixels(".home-tabs", "height");
  assert.ok(footer >= 56 && footer <= 64);
  assert.ok(pixels("", "padding-bottom") >= footer + 8, "last series row can scroll clear of the fixed bar");
  assert.match(declaration("", "padding-bottom", true), /env\(safe-area-inset-bottom\)/);
  assert.match(declaration(".home-tabs", "height", true), /env\(safe-area-inset-bottom\)/);
  for (const side of ["left", "right"]) {
    assert.match(declaration(".home-tabs", `padding-${side}`, true), new RegExp(`env\\(safe-area-inset-${side}\\)`));
  }
});

test("actual landscape Home keeps full book titles and resumes the original page", async () => {
  for (const bookId of ["7", "28"]) {
    const bundle = buildFullBookPracticeBundle(bookId);
    const practice = bundle.practices[5];
    const page = createUiPage("Home", {
      profile,
      history: { version: 2, bookId, imageIndex: practice.imageIndex },
    });
    try {
      const tree = page.render();
      assert.match(byClass(tree, "library-home").props.className, /device-layout--single/);
      assert.equal(textOf(byClass(tree, "continue-card__title")), bundle.book.title);
      assert.equal(byClass(tree, "continue-card__cover").props.src, bundle.book.cover);
      assert.equal(textOf(byClass(tree, "continue-card__progress")), `${practice.sectionTitle} · ${practice.pageLabel || `教材第 ${practice.pageNumber} 页`}`);
      await byClass(tree, "continue-card__button").props.onClick();
      const route = bundle.book.seriesId === "think" ? "ThinkBookReader" : "Practice";
      assert.equal(page.navigations.at(-1), `/pages/${route}/${route}?bookId=${bookId}&page=${practice.imageIndex}`);
    } finally { page.dispose(); }
  }
});

test("actual empty landscape Home keeps book, series, search and recording-library entries", async () => {
  const page = createUiPage("Home", { profile });
  try {
    const tree = page.render();
    assert.equal(textOf(byClass(tree, "continue-card__button")), "选择教材");
    for (const name of ["continue-card__button", "library-home__search", "series-section__all"]) {
      await byClass(tree, name).props.onClick();
      assert.equal(page.navigations.at(-1), "/pages/BookLibrary/BookLibrary?series=all");
    }
    const rows = elements(tree).filter(node => node.props?.className === "series-row");
    assert.equal(rows.length, BOOK_SERIES.length);
    for (const [index, row] of rows.entries()) {
      await row.props.onClick();
      assert.equal(page.navigations.at(-1), `/pages/BookLibrary/BookLibrary?series=${BOOK_SERIES[index].id}`);
    }
    const mine = elements(tree).find(node => node.props?.className?.includes("home-tabs__item") && textOf(node) === "我的");
    await mine.props.onClick();
    assert.equal(page.navigations.at(-1), "/pages/MyCheckIns/MyCheckIns");
  } finally { page.dispose(); }
});
