const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createUiPage } = require('./helpers/native-ui-fixtures.cjs');
const { byClass, elements, textOf } = require('./test-practice-book-route.cjs');

for (const version of ['develop', 'trial', 'release', '', 'unknown']) {
  test(`Home ${version || 'missing environment'} keeps voice access in the correct navigation scope`, async () => {
    const page = createUiPage('Home', {
      overrides: { wx: { getAccountInfoSync: () => ({ miniProgram: { envVersion: version } }) } },
    });
    try {
      const tree = page.render();
      const tabs = byClass(tree, 'home-tabs');
      const items = elements(tabs).filter(node => node.props?.className?.split(' ').includes('home-tabs__item'));
      const preview = ['develop', 'trial'].includes(version);
      assert.deepEqual(items.map(textOf), preview ? ['学习', '英语伙伴', '我的'] : ['学习', '我的']);
      assert.equal(byClass(tree, 'voice-chat-entry'), undefined, 'old promotional banner is removed');
      if (preview) {
        const chat = items[1];
        assert.equal(chat.props.ariaRole, 'button');
        assert.equal(chat.props.ariaLabel, '英语伙伴');
        assert.ok(byClass(chat, 'home-tabs__voice-icon'), 'chat entry has a visible microphone icon');
        await chat.props.onClick();
        assert.equal(page.navigations.at(-1), '/pages/VoiceChat/VoiceChat');
        assert.equal(page.navigationMethods.at(-1), 'navigateTo', 'native back returns to the learning page');
      } else {
        assert.equal(byClass(tree, 'home-tabs__voice'), undefined);
      }
      await items.at(-1).props.onClick();
      assert.equal(page.navigations.at(-1), '/pages/MyCheckIns/MyCheckIns');
      await byClass(tree, 'continue-card__button').props.onClick();
      assert.equal(page.navigations.at(-1), '/pages/BookLibrary/BookLibrary?series=all');
    } finally { page.dispose(); }
  });
}
