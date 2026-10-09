import { spawn } from 'node:child_process';
const vite = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { stdio: 'inherit' });
let desktop;
for (let i = 0; i < 100; i++) {
  try {
    if ((await fetch('http://127.0.0.1:5173')).ok) break;
  } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
desktop = spawn('node_modules/.bin/electron', ['.'], {
  stdio: 'inherit',
  env: { ...process.env, FOLIO_DEV_URL: 'http://127.0.0.1:5173' },
});
const stop = () => {
  desktop?.kill();
  vite.kill();
};
desktop.on('exit', () => {
  vite.kill();
  process.exit();
});
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
