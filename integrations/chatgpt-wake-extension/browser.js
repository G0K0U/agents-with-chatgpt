// Injected in the isolated world. Reads only the composer to avoid overwriting a draft,
// and the send control's enabled state. Never reads surrounding DOM or responses.
export async function submitComposer(expectedUrl, message) {
  const pause = () => new Promise(resolve => setTimeout(resolve, 200));
  for (let i = 0; i < 50; i++) {
    if (location.href !== expectedUrl) throw new Error('Conversation changed');
    const composer = document.querySelector('#prompt-textarea');
    if (!composer) { await pause(); continue; }
    if ((composer.value ?? composer.innerText ?? '').trim()) throw new Error('Composer has a draft');
    composer.focus();
    if (composer instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(composer, message);
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (composer.isContentEditable) {
      if (!document.execCommand('insertText', false, message)) throw new Error('Composer insertion failed');
    } else throw new Error('Unsupported composer');
    for (let j = 0; j < 25; j++) {
      if (location.href !== expectedUrl) throw new Error('Conversation changed');
      if ((composer.value ?? composer.innerText ?? '').trim() !== message) throw new Error('Composer changed');
      const send = document.querySelector('button[data-testid="send-button"]');
      if (send && !send.disabled && send.getAttribute('aria-disabled') !== 'true') {
        send.click();
        return 'wake_submitted'; // click dispatched, not delivery confirmation or audit evidence
      }
      await pause();
    }
    throw new Error('Send unavailable');
  }
  throw new Error('Composer unavailable');
}
export function chromeAdapter(api) {
  return {
    findTabs: url => api.tabs.query({ url }),
    openTab: url => api.tabs.create({ url, active: true }),
    focusTab: async tab => { await api.tabs.update(tab.id, { active: true }); await api.windows.update(tab.windowId, { focused: true }); },
    submit: async (tabId, url, message) => {
      // A newly opened tab can still be loading. Only URL/status metadata is inspected.
      for (let i = 0; i < 50; i++) {
        const tab = await api.tabs.get(tabId);
        if (tab.url && tab.url !== url) throw new Error('Conversation changed');
        if (tab.status === 'complete') {
          const results = await api.scripting.executeScript({ target: { tabId }, func: submitComposer, args: [url, message] });
          if (results.length !== 1 || results[0].error || results[0].result !== 'wake_submitted') throw new Error('Submission failed');
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error('Tab unavailable');
    }
  };
}
