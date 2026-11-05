// "Evento activo": el ultimo evento en el que el usuario entro (su home,
// /evento/:id). Lo guardamos en localStorage para que, cuando se vaya a
// Vender / Escanear / Reportes, tenga un acceso directo de un toque para
// volver al home de ESE evento — sin pasar por la lista de eventos.
//
// Se setea al cargar EventDashboard. El FAB EventQuickReturn lo lee.

const KEY = 'prickets:activeEvent';

export function setActiveEvent(id, name) {
  if (!id) return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ id: String(id), name: name || 'Evento' }));
    // Aviso sincronico para que el FAB se actualice sin esperar a un
    // cambio de ruta (por ej. si recargas parado en el home del evento).
    window.dispatchEvent(new Event('active-event-changed'));
  } catch { /* localStorage no disponible (modo privado) */ }
}

export function getActiveEvent() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.id ? parsed : null;
  } catch {
    return null;
  }
}

export function clearActiveEvent() {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new Event('active-event-changed'));
  } catch { /* no-op */ }
}
