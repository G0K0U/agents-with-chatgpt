import { chromeAdapter } from './browser.js';
import { pollOnce } from './transport.js';
let busy = false;
async function poll() {
  if (busy) return;
  busy = true;
  try {
    await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
    const { config } = await chrome.storage.local.get('config');
    if (config) await pollOnce(config, chromeAdapter(chrome));
  } catch { /* No credentials, DOM or raw errors in logs. */ }
  finally { busy = false; }
}
const schedule = () => chrome.alarms.create('a2c-wake', { periodInMinutes: 0.5 });
chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);
chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'a2c-wake') void poll(); });
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
void schedule();
