import { conversationUrl } from './transport.js';
await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
const { config } = await chrome.storage.local.get('config');
document.querySelector('#conversation').value = config?.conversation ?? '';
document.querySelector('#setup').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const conversation = conversationUrl(document.querySelector('#conversation').value);
    const file = document.querySelector('#credential').files[0];
    const secret = file ? JSON.parse(await file.text()).secret : config?.secret;
    if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error();
    await chrome.storage.local.set({ config: { conversation, secret } });
    document.querySelector('#credential').value = '';
    document.querySelector('#status').textContent = 'Enabled. Keep the local service running.';
  } catch { document.querySelector('#status').textContent = 'Check the conversation URL and local credential file.'; }
});
document.querySelector('#disable').addEventListener('click', async () => {
  await chrome.storage.local.remove('config');
  location.reload();
});
