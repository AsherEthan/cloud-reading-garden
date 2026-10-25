import { test, expect } from '@playwright/test';

const password = 'Browser-Test-Only-Password-2026!';
async function login(page, email) {
  await page.goto('/');
  await page.getByLabel('邮箱', { exact: true }).fill(email);
  await page.getByLabel('密码', { exact: true }).fill(password);
  await page.getByRole('button', { name: '进入庭院' }).click();
  await expect(page.getByRole('application')).toBeVisible();
}

test('Three.js 庭院：立体渲染、射线拾取、移动、同步与触屏', async ({ page, context, browser }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'owner@browser.test');
  const canvas = page.getByRole('application');
  await expect(canvas).toHaveAttribute('data-renderer', 'three-webgl');
  await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
  expect(Number(await canvas.getAttribute('data-triangles'))).toBeGreaterThan(1000);
  await page.screenshot({ path: 'screenshots/08-Three.js庭院-桌面.png' });
  const position = page.getByTestId('world-position');
  await expect(page.getByText('庭院已连接', { exact: false })).toHaveCount(0);
  await expect
    .poll(async () => (await (await context.request.get('/api/state')).json()).world.length)
    .toBeGreaterThan(0);
  const initialX = Number(await position.getAttribute('data-x'));
  const initialY = Number(await position.getAttribute('data-y'));
  await canvas.focus();
  await page.keyboard.press('ArrowRight');
  await expect(position).toHaveAttribute('data-x', String(initialX + 1));
  const friendContext = await browser.newContext({ baseURL: 'http://127.0.0.1:4321' });
  const friend = await friendContext.newPage();
  try {
    await login(friend, 'friend@browser.test');
    await friend.evaluate(() => {
      window.__worldEvents = [];
      window.addEventListener('cloud-world', (e) => {
        window.__worldEvents = e.detail;
      });
    });
    await canvas.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(position).toHaveAttribute('data-x', String(initialX));
    await expect
      .poll(() => friend.evaluate(() => window.__worldEvents.find((p) => p.name === '庭主')?.x))
      .toBe(initialX);
    await page.getByRole('button', { name: '向善友挥手', exact: true }).click();
    await expect
      .poll(() => friend.evaluate(() => window.__worldEvents.find((p) => p.name === '庭主')?.emote))
      .toBe('wave');
    const collision = await context.request.post('/api/world/move', {
      headers: { Origin: 'http://127.0.0.1:4321' },
      data: { x: 40, y: 30 },
    });
    expect(collision.status()).toBe(400);
    const teleport = await context.request.post('/api/world/move', {
      headers: { Origin: 'http://127.0.0.1:4321' },
      data: { x: 30, y: 22 },
    });
    expect(teleport.status()).toBe(409);
    // 固定桌面视口下直接点击书屋屋顶，验证相机投影后的射线拾取，而非菜单跳转。
    await canvas.click({ position: { x: 800, y: 230 } });
    await expect(page.getByRole('dialog', { name: '云间书屋互动', exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(position).toHaveAttribute('data-x', '21');
    await expect(position).toHaveAttribute('data-y', '15');
    await page.screenshot({ path: 'screenshots/06-像素庭院-建筑互动.png' });
    await page.getByRole('button', { name: '进入书屋', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: '云间书屋 · 一起读一会儿', exact: true }),
    ).toBeVisible();
    await page.getByLabel('我的笔记', { exact: true }).fill('WASD 在输入框里是文字，不应移动角色');
    await page.getByLabel('我的笔记', { exact: true }).press('w');
    await expect(position).toHaveAttribute('data-y', '15');
    await page.getByRole('button', { name: '回到庭院', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: '打开庭院地图', exact: true }).click();
    await page.getByRole('button', { name: '走到愿力公告板', exact: true }).click();
    await expect(page.getByRole('dialog', { name: '愿力公告板互动', exact: true })).toBeVisible({
      timeout: 15000,
    });
    await page.getByRole('button', { name: '查看贡献悬赏', exact: true }).click();
    await expect(page.getByRole('button', { name: '贡献悬赏', exact: true })).toHaveClass('active');
    await page.getByRole('button', { name: '回到庭院', exact: true }).click();
    await page.getByRole('button', { name: '打开共读手记', exact: true }).click();
    await expect(page.getByRole('heading', { name: '共同成果', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '角色装扮与设置', exact: true }).click();
    await page.getByRole('button', { name: '选择第 3 套装扮', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '选择第 3 套装扮', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileX = Number(await position.getAttribute('data-x'));
    await page.getByRole('button', { name: '向左移动', exact: true }).click();
    await expect(position).toHaveAttribute('data-x', String(mobileX - 1));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'screenshots/07-像素庭院-触屏控制.png' });
    await page.screenshot({ path: 'screenshots/09-Three.js庭院-手机.png' });
    const me = (await (await context.request.get('/api/state')).json()).world.find(
      (p) => p.name === '庭主',
    );
    expect(me.skin).toBe(2);
    expect(errors).toEqual([]);
  } finally {
    await friendContext.close();
  }
});

test('Three.js 图形上下文丢失后可恢复，不改变账户与共读功能', async ({ page, context }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await login(page, 'owner@browser.test');
  const canvas = page.getByRole('application');
  await expect(canvas).toHaveAttribute('data-scene-ready', 'true');
  const before = (await (await context.request.get('/api/state')).json()).wallet.balance;
  const frames = Number(await canvas.getAttribute('data-rendered-frames'));
  const available = await canvas.evaluate((element) => {
    const gl = element.getContext('webgl2');
    const extension = gl.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    window.__gardenRestoreContext = () => extension.restoreContext();
    extension.loseContext();
    return true;
  });
  expect(available).toBe(true);
  await expect(page.getByRole('alert')).toContainText('3D 显示连接已中断');
  await page.getByRole('button', { name: '共读室', exact: true }).click();
  await expect(page.getByLabel('我的笔记', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回到庭院', exact: true }).click();
  await page.evaluate(() => window.__gardenRestoreContext());
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect
    .poll(async () => Number(await canvas.getAttribute('data-rendered-frames')))
    .toBeGreaterThan(frames);
  await page.screenshot({ path: 'screenshots/10-Three.js庭院-恢复.png' });
  const after = (await (await context.request.get('/api/state')).json()).wallet.balance;
  expect(after).toBe(before);
  expect(errors).toEqual([]);
});

test('不支持 WebGL 时明确提示，并仍能打开共读与账簿', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (kind, ...args) {
      if (['webgl', 'webgl2', 'experimental-webgl'].includes(kind)) return null;
      return original.call(this, kind, ...args);
    };
  });
  await login(page, 'owner@browser.test');
  await expect(page.getByRole('alert')).toContainText('未能启动 3D 场景');
  await page.getByRole('button', { name: '共读室', exact: true }).click();
  await expect(page.getByLabel('我的笔记', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '回到庭院', exact: true }).click();
  await page.getByRole('button', { name: '功德账簿', exact: true }).click();
  await expect(
    page.getByRole('dialog', { name: '功德账房 · 我的收支与贡献', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
