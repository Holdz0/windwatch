// This bridge never reads media or browsing history. Only explicitly trusted
// app origins can ask the background worker to inspect a chosen source tab.
(() => {
  chrome.runtime.onMessage.addListener(message => {
    if (message?.type === 'windwatch:update') window.postMessage({ channel: 'windwatch-helper:reply', event: 'update', update: message.update }, location.origin);
  });
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.channel !== 'windwatch-helper:request' || typeof data.id !== 'string') return;
    chrome.runtime.sendMessage({ ...data, type: 'windwatch:app' }).then(result => {
      window.postMessage({ channel: 'windwatch-helper:reply', id: data.id, result }, location.origin);
    }).catch(() => window.postMessage({ channel: 'windwatch-helper:reply', id: data.id, result: { ok: false, error: 'Video yardımcısı yeniden yüklendi. WindWatch sayfasını yenileyin.' } }, location.origin));
  });
})();
