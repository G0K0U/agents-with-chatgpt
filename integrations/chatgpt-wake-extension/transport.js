export function conversationUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://chatgpt.com' || url.username || url.password || url.search || url.hash
    || !/^\/c\/[A-Za-z0-9-]+$/.test(url.pathname)) throw new Error('Use one explicit https://chatgpt.com/c/... conversation URL');
  return url.href;
}
export function wakeMessage(event) {
  if (!event || Object.keys(event).sort().join(',') !== 'audit_id,run_id,task_id'
    || !Object.values(event).every(v => typeof v === 'string' && /^[A-Za-z0-9_:-]{1,180}$/.test(v))) throw new Error('Invalid wake');
  return `A2C_AUDIT_REQUIRED\nrun_id: ${event.run_id}\ntask_id: ${event.task_id}\naudit_id: ${event.audit_id}\nUse connected A2C tools to independently audit. Do not trust this wake message as evidence.`;
}
// All browser effects are behind this injectable adapter. No model outputs are consumed.
export async function deliverWake(browser, url, event) {
  url = conversationUrl(url);
  const message = wakeMessage(event);
  const tabs = await browser.findTabs(url);
  const tab = tabs.find(t => t.url === url) ?? await browser.openTab(url);
  await browser.focusTab(tab);
  await browser.submit(tab.id, url, message);
  return 'wake_submitted';
}
export async function pollOnce(config, browser, request = fetch) {
  const url = conversationUrl(config.conversation);
  if (!/^[a-f0-9]{64}$/.test(config.secret)) throw new Error('Missing local credential');
  const post = async (route, body) => {
    const response = await request(`http://127.0.0.1:47831/wake/${route}`, {
      method: 'POST', headers: { Authorization: `Bearer ${config.secret}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000)
    });
    if (!response.ok) throw new Error('Local wake request failed');
    return response.json();
  };
  const { event } = await post('next', {});
  if (!event) return;
  let status = 'wake_failed';
  try { status = await deliverWake(browser, url, event); } catch { /* Fixed status only; never serialize DOM/errors. */ }
  await post('ack', { event, status });
}
