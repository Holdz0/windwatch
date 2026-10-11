async function list() { return (await chrome.storage.local.get('origins')).origins || ['http://localhost:5173', 'http://localhost:5178']; }
async function render() {
  const root = document.getElementById('origins'); root.replaceChildren();
  for (const origin of await list()) { const item = document.createElement('li'); item.textContent = origin; const remove = document.createElement('button'); remove.textContent = 'İzni kaldır'; remove.onclick = async () => { await chrome.storage.local.set({ origins: (await list()).filter(value => value !== origin) }); await render(); }; item.append(remove); root.append(item); }
}
async function add(value) {
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); await chrome.storage.local.set({ origins: [...new Set([...(await list()), url.origin])] }); document.getElementById('result').textContent = 'İzin verildi. WindWatch sayfasını yenileyin.'; await render(); }
  catch { document.getElementById('result').textContent = 'Geçerli bir WindWatch adresi girin.'; }
}
document.getElementById('add').onclick = () => add(document.getElementById('origin').value);
document.getElementById('allow').onclick = async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await add(tab?.url); };
void render();
