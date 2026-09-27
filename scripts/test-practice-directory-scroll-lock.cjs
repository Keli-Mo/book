/* eslint-disable import/no-commonjs */
const assert = require("node:assert/strict");
const test = require("node:test");
const { createPage, byClass, elements } = require("./test-practice-book-route.cjs");

const routes = [
  { name: "普通训练", file: "src/pages/Practice/Practice.tsx", params: { bookId: "22", practice: "0" } },
  { name: "Think", file: "src/pages/ThinkBookReader/ThinkBookReader.tsx", params: { bookId: "28", page: "12" } },
];
const render = (page) => { page.render(); page.render(); return page.render(); };
const pageStyle = (tree) => {
  const metadata = elements(tree).filter((node) => node.type === "PageMeta");
  assert.equal(metadata.length, 1, "每页只应有一个控制背景滚动的 PageMeta");
  return metadata[0].props.pageStyle;
};

for (const route of routes) {
  test(`${route.name}：目录锁住背景、保留内部滚动，关闭或选页后解锁`, async () => {
    const page = createPage(route.file, route.params);
    try {
      assert.equal(pageStyle(render(page)), "");
      byClass(page.render(), "practice-header__directory").props.onClick();
      let tree = render(page);
      assert.equal(pageStyle(tree), "overflow: hidden;");
      const mask = byClass(tree, "practice-directory-mask");
      assert.equal(mask.props.catchMove, true, "遮罩必须使用原生 catchtouchmove 阻止滚动穿透");
      assert.equal(byClass(tree, "practice-directory-scroll").props.scrollY, true,
        "锁住背景时目录内部仍须允许竖向滚动");
      mask.props.onClick();
      tree = render(page);
      assert.equal(pageStyle(tree), "");
      assert.match(byClass(tree, "practice-directory-mask").props.className, /practice-directory-mask--hidden/);

      byClass(tree, "practice-header__directory").props.onClick();
      tree = render(page);
      byClass(tree, "practice-directory-group__header").props.onClick();
      tree = render(page);
      const next = elements(tree).find((node) =>
        String(node.props?.className || "").split(" ").includes("practice-directory-item") &&
        !String(node.props.className).includes("practice-directory-item--active"));
      assert.ok(next);
      await next.props.onClick();
      assert.equal(pageStyle(render(page)), "", "成功选择练习后应解除背景滚动锁");
    } finally {
      page.unload();
      page.dispose();
    }
  });
}
