import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const pass = 'Browser-Test-Only-Password-2026!';
const nav = (page, label) =>
  page
    .getByRole('navigation', { name: '主要导航' })
    .getByRole('button', { name: label, exact: true })
    .click();
const state = async (context) => (await context.request.get('/api/state')).json();

test('两位真实浏览器用户：建站、邀请、同步共读、隐私、奖励、服务和移动端', async ({
  browser,
  page,
  context,
}) => {
  const errors = [];
  const watch = (p) => p.on('pageerror', (e) => errors.push(e.message));
  watch(page);
  mkdirSync('screenshots', { recursive: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '从一次共读开始' })).toBeVisible();
  await page.getByLabel('一次性建站码').fill('browser-test-only-code');
  await page.getByLabel('你希望被怎样称呼').fill('庭主');
  await page.getByLabel('邮箱', { exact: true }).fill('owner@browser.test');
  await page.getByLabel('设置密码（至少 12 个字符）').fill(pass);
  await page.getByRole('checkbox').nth(0).check();
  await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button', { name: '建立庭院', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你好，庭主。' })).toBeVisible();
  await page.screenshot({ path: 'screenshots/01-共读庭院-桌面.png', fullPage: true });
  await nav(page, '善友与邀请');
  await page.getByLabel('伙伴的邮箱').fill('friend@browser.test');
  await page.getByRole('checkbox', { name: '我确认这是我直接认识的成年伙伴' }).check();
  await page.getByRole('button', { name: '生成专属邀请' }).click();
  const link = await page.getByLabel('请私下发送这条邀请').inputValue();
  expect(link).toContain('#invite=');
  const friendContext = await browser.newContext({
    baseURL: 'http://127.0.0.1:4321',
    viewport: { width: 1280, height: 900 },
  });
  const friend = await friendContext.newPage();
  watch(friend);
  try {
    await friend.goto(link);
    await expect(friend.getByLabel('邮箱', { exact: true })).toHaveValue('friend@browser.test');
    await friend.getByLabel('你希望被怎样称呼').fill('知秋');
    await friend.getByLabel('设置密码（至少 12 个字符）').fill(pass);
    await friend.getByRole('checkbox').nth(0).check();
    await friend.getByRole('checkbox').nth(1).check();
    await friend.getByRole('button', { name: '接受邀请并加入' }).click();
    await expect(friend.getByRole('heading', { name: '你好，知秋。' })).toBeVisible();
    await page.getByRole('button', { name: '确认常住' }).click();
    await expect(friend.locator('.top-balance')).toHaveText('20 GC');
    await nav(page, '共读室');
    await nav(friend, '共读室');
    await page.getByRole('button', { name: '第 4 段', exact: true }).click();
    await page.getByRole('button', { name: '带大家读这一段' }).click();
    await expect(friend.locator('.passage-number')).toHaveText('04');
    await friend.getByLabel('我的笔记', { exact: true }).fill('私人想法：我还没有准备好分享。');
    await friend.getByRole('button', { name: '保存这张卡片' }).click();
    await expect(friend.getByText('私人想法：我还没有准备好分享。', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: '共同讨论', exact: true }).click();
    await expect(page.getByText('私人想法：我还没有准备好分享。', { exact: true })).toHaveCount(0);
    expect((await state(context)).notes).toHaveLength(0);
    await friend.getByLabel('我的笔记', { exact: true }).fill('公开问题：原文与个人解释如何区分？');
    await friend.getByRole('checkbox', { name: '主动分享到本庭院（默认仅自己可见）' }).check();
    await friend.getByRole('button', { name: '保存这张卡片' }).click();
    await expect(
      page.getByText('公开问题：原文与个人解释如何区分？', { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel('主要理解、仍存的分歧、下次的问题')
      .fill(
        '本场理解：回到原文寻找依据。\n仍存分歧：经验可以说明多少？\n下次的问题：如何提出反例？',
      );
    await page.getByRole('button', { name: '发布共同成果' }).click();
    await expect(friend.getByText(/本场理解：回到原文寻找依据。/)).toBeVisible();
    await friend.screenshot({ path: 'screenshots/02-同步共读与私有笔记.png', fullPage: true });
    await nav(page, '愿力集市');
    await page.locator('summary').filter({ hasText: '发布贡献悬赏' }).click();
    await page.getByLabel('任务名称').fill('整理本场理解');
    await page.getByLabel('明确的交付与验收标准').fill('三条理解，一条分歧，一个后续问题。');
    await page.getByLabel('奖励（GC）').fill('30');
    await page.getByRole('button', { name: '锁定预算并发布' }).click();
    await nav(friend, '愿力集市');
    await friend.getByRole('button', { name: '领取贡献任务' }).click();
    await friend.getByLabel('我的交付说明').fill('已整理三条理解、一条分歧和一个后续问题。');
    await friend.getByRole('button', { name: '提交验收', exact: true }).click();
    await page.getByRole('button', { name: '验收并发放 30 GC' }).click();
    await expect(friend.locator('.top-balance')).toHaveText('50 GC');
    await friend.getByRole('button', { name: '善友服务', exact: true }).click();
    await friend.locator('summary').filter({ hasText: '发布我的服务' }).click();
    await friend.getByLabel('服务名称').fill('整理一次读书笔记');
    await friend.getByLabel('范围、交付方式和时间约定').fill('整理一份 300 字的笔记，当天交付。');
    await friend.getByLabel('价格（GC）').fill('5');
    await friend.getByRole('button', { name: '发布服务约定' }).click();
    await page.getByRole('button', { name: '善友服务', exact: true }).click();
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: '确认约定并托管' }).click();
    await expect(page.locator('.top-balance')).toHaveText('15 GC');
    await friend.getByRole('button', { name: '服务订单', exact: true }).click();
    await friend.getByLabel('服务完成说明').fill('已交付整理后的笔记，请确认。');
    await friend.getByRole('button', { name: '提交服务交付' }).click();
    await page.getByRole('button', { name: '服务订单', exact: true }).click();
    await page.getByRole('button', { name: '确认收到并结算' }).click();
    await expect(friend.locator('.top-balance')).toHaveText('55 GC');
    await nav(friend, '功德账簿');
    await expect(friend.getByText('整理本场理解', { exact: true })).toBeVisible();
    await expect(friend.getByText('完成委托服务', { exact: true })).toBeVisible();
    expect((await (await context.request.get('/api/audit')).json()).ok).toBe(true);
    await friend.screenshot({ path: 'screenshots/03-功德账簿与贡献履历.png', fullPage: true });
    await friend.setViewportSize({ width: 390, height: 844 });
    await nav(friend, '共读庭院');
    await expect(friend.getByRole('heading', { name: '你好，知秋。' })).toBeVisible();
    expect(
      await friend.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await friend.screenshot({ path: 'screenshots/04-庭院-手机.png', fullPage: true });
    await nav(friend, '共读室');
    expect(
      await friend.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
    await friend.screenshot({ path: 'screenshots/05-共读室-手机.png', fullPage: true });
    const exported = await (await friendContext.request.get('/api/export')).json();
    expect(exported.notes).toHaveLength(2);
    expect(exported.contributions).toHaveLength(2);
    expect(errors).toEqual([]);
    await friend.reload();
    await expect(friend.locator('.top-balance')).toHaveText('55 GC');
  } finally {
    await friendContext.close();
  }
});

test('主动加入的本机双人语音可以连接，离开后停止麦克风', async ({ browser, page, context }) => {
  await context.grantPermissions(['microphone']);
  await page.addInitScript(() => {
    window.__testMediaTracks = [];
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await original(constraints);
      window.__testMediaTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill('owner@browser.test');
  await page.getByLabel('密码', { exact: true }).fill(pass);
  await page.getByRole('button', { name: '进入庭院' }).click();
  await nav(page, '共读室');
  const secondContext = await browser.newContext({
    baseURL: 'http://127.0.0.1:4321',
    permissions: ['microphone'],
  });
  const other = await secondContext.newPage();
  try {
    await other.goto('/');
    await other.getByLabel('邮箱', { exact: true }).fill('friend@browser.test');
    await other.getByLabel('密码', { exact: true }).fill(pass);
    await other.getByRole('button', { name: '进入庭院' }).click();
    await nav(other, '共读室');
    await page.getByRole('button', { name: '自愿加入语音' }).click();
    await other.getByRole('button', { name: '自愿加入语音' }).click();
    await expect(page.getByText('麦克风已静音 · 已连接 1 位伙伴')).toBeVisible({ timeout: 20000 });
    await expect(other.getByText('麦克风已静音 · 已连接 1 位伙伴')).toBeVisible({ timeout: 20000 });
    await page.getByRole('button', { name: '开启麦克风', exact: true }).click();
    await expect(page.getByText('麦克风已开启 · 已连接 1 位伙伴')).toBeVisible();
    await page.getByRole('button', { name: '离开语音', exact: true }).click();
    await expect(page.getByRole('button', { name: '自愿加入语音' })).toBeVisible();
    expect((await state(context)).participants.find((p) => p.name === '庭主').voice).toBe(false);
    expect(
      await page.evaluate(
        () =>
          window.__testMediaTracks.length > 0 &&
          window.__testMediaTracks.every((track) => track.readyState === 'ended'),
      ),
    ).toBe(true);
    await expect(other.getByText('麦克风已静音 · 已连接 0 位伙伴')).toBeVisible();
  } finally {
    await secondContext.close();
  }
});
