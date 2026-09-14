// Wrap dist/index.html in a password gate, Burger Wars style: the real page is AES-GCM encrypted
// with a key derived (PBKDF2) from the access code, and decrypted in the browser.
// Usage: GATE_PASSWORD=word node tools/gate.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

const password = process.env.GATE_PASSWORD;
if (!password) {
  console.error('GATE_PASSWORD is not set; leaving dist/index.html open.');
  process.exit(0);
}
const file = new URL('../dist/index.html', import.meta.url);
const html = readFileSync(file, 'utf8');
if (html.includes('id="gate"')) {
  console.error('dist/index.html is already gated.');
  process.exit(0);
}

const subtle = webcrypto.subtle;
const salt = webcrypto.getRandomValues(new Uint8Array(16));
const iv = webcrypto.getRandomValues(new Uint8Array(12));
const ITER = 300000;
const base = await subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
const key = await subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
const cipher = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(html)));
const b64 = (u8) => Buffer.from(u8).toString('base64');

const gate = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="robots" content="noindex" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="Ragdoll God" />
<meta name="theme-color" content="#1a1c2c" />
<link rel="icon" href="data:," />
<title>Ragdoll God</title>
<style>
  @font-face { font-family: 'Pixelify Sans'; src: url('./fonts/PixelifySans.woff2') format('woff2'); font-weight: 400 700; font-display: swap; }
  html, body { margin: 0; height: 100%; background: #1a1c2c; color: #f4f4f4; font-family: 'Pixelify Sans', 'Segoe UI', system-ui, sans-serif; }
  .wrap { min-height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box; }
  .card { width: 100%; max-width: 420px; background: #262b44; border: 3px solid #f4f4f4; box-shadow: 8px 8px 0 #0f1020; padding: 28px 24px; text-align: center; }
  h1 { font-size: 34px; margin: 0 0 6px; color: #ffd23f; }
  h1 span { color: #7fd1ff; }
  p { font-size: 18px; line-height: 1.5; color: #c9cfe6; margin: 0 0 20px; }
  input { width: 100%; box-sizing: border-box; font: inherit; font-size: 24px; padding: 12px; border: 3px solid #f4f4f4; background: #1a1c2c; color: #fff; text-align: center; letter-spacing: 3px; }
  input:focus { outline: none; border-color: #ffd23f; }
  button { margin-top: 14px; width: 100%; font: inherit; font-weight: 700; font-size: 22px; padding: 14px; border: 3px solid #f4f4f4; background: #4cd964; color: #10321a; cursor: pointer; box-shadow: 4px 4px 0 #0f1020; }
  button:active { transform: translate(3px, 3px); box-shadow: 1px 1px 0 #0f1020; }
  label { display: block; margin-top: 14px; font-size: 16px; color: #c9cfe6; }
  .err { color: #ff6b6b; font-size: 18px; margin-top: 12px; min-height: 22px; font-weight: 700; }
  .busy { opacity: .6; pointer-events: none; }
</style>
</head>
<body>
<div class="wrap"><form class="card" id="gate">
  <h1>RAGDOLL <span>GOD</span></h1>
  <p>Enter the secret word to open the world.</p>
  <input id="pw" type="password" autocomplete="current-password" autofocus placeholder="secret word" />
  <button type="submit">OPEN</button>
  <label><input type="checkbox" id="remember" checked style="width:auto;margin-right:8px;vertical-align:middle;transform:scale(1.4)"> remember on this device</label>
  <div class="err" id="err"></div>
</form></div>
<script>
const SALT = "${b64(salt)}", IV = "${b64(iv)}", ITER = ${ITER};
const PAYLOAD = "${b64(cipher)}";
const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
async function unlock(pw) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt: b64(SALT), iterations: ITER, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(IV) }, key, b64(PAYLOAD));
  return new TextDecoder().decode(plain);
}
async function go(pw, remember) {
  const form = document.getElementById('gate'); form.classList.add('busy');
  try {
    const html = await unlock(pw.trim().toLowerCase());
    if (remember) localStorage.setItem('rg.code', pw); else localStorage.removeItem('rg.code');
    document.open(); document.write(html); document.close();
  } catch (e) {
    form.classList.remove('busy');
    document.getElementById('err').textContent = 'NOPE, TRY AGAIN';
    localStorage.removeItem('rg.code');
  }
}
document.getElementById('gate').addEventListener('submit', (e) => { e.preventDefault(); go(document.getElementById('pw').value, document.getElementById('remember').checked); });
const saved = localStorage.getItem('rg.code'); if (saved) go(saved, true);
</script>
</body>
</html>
`;
writeFileSync(file, gate);
console.log(`Gated dist/index.html (${(cipher.length / 1024).toFixed(1)} KB payload).`);
