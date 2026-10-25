import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApplication } from '../server/index.mjs';

const directory = mkdtempSync(join(tmpdir(), 'cloud-reading-browser-'));
const app = createApplication({
  filename: join(directory, 'test.sqlite'),
  bootstrapCode: 'browser-test-only-code',
});
app.server.listen(4321, '127.0.0.1', () =>
  console.log('浏览器测试庭院：http://127.0.0.1:4321，仅使用临时数据库。'),
);
const stop = async () => {
  await app.close();
  rmSync(directory, { recursive: true, force: true });
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
