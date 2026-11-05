// Handler de Web Push que el SW de Workbox importa (importScripts en
// vite.config). Cuando llega un push, el browser entrega el payload aca
// y mostramos una notificacion nativa. Si la app esta abierta, el handler
// 'notificationclick' la enfoca y navega al url del payload.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: 'Prickets', body: event.data?.text() || '' }; }
  const title = data.title || 'Prickets';
  const options = {
    body:  data.body || '',
    icon:  '/favicon.svg',
    badge: '/favicon.svg',
    data:  { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil((async () => {
    const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Si ya hay una ventana de la app, la enfocamos y navegamos.
    for (const c of all) {
      if (c.url.includes(self.location.origin)) {
        await c.focus();
        if ('navigate' in c) try { await c.navigate(url); } catch {}
        return;
      }
    }
    // Si no hay ventana, la abrimos.
    if (clients.openWindow) await clients.openWindow(url);
  })());
});
