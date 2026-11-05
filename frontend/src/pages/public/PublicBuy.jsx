import { useEffect, useState } from 'react';
import { useCerrarConAtras } from '../../hooks/useCerrarConAtras';
import { useParams, useSearchParams } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { downloadTicketsPdf } from '../../utils/downloadTicketsPdf';
import LocalidadInput from '../../components/LocalidadInput';
import useWakeLock from '../../hooks/useWakeLock';
import { porcentaje, anchoBarra } from '../../lib/percent';
import { BACKEND_URL as BACKEND } from '../../api/config';

const emptyForm = () => ({
  buyer_name: '', buyer_apellido: '', buyer_dni: '',
  buyer_edad: '', buyer_localidad: '', buyer_email: '',
  // Consentimientos, separados a proposito: uno es para poder comprar y el
  // otro es para recibir novedades. Mezclarlos invalida el segundo.
  acepta_terminos: false, acepta_descuentos: false,
});

const PublicBuy = () => {
  const { code }       = useParams();
  const [searchParams] = useSearchParams();

  const [zoomQr, setZoomQr] = useState(null);
  // El comprador levanta el QR a pantalla completa en la puerta: si toca
  // atras tiene que volver a su entrada, no irse de la pagina.
  useCerrarConAtras(!!zoomQr, () => setZoomQr(null));

  // Modo "reservado": link generado desde /caja con entradas ya vendidas
  // (?tickets=ID1,ID2). El comprador solo carga nombre/apellido.
  const presetTickets  = searchParams.get('tickets') || '';
  const isReserved     = !!presetTickets;
  // Lista de IDs inicial del URL — la usamos como fallback. Una vez que el
  // backend responde con tickets-info, reemplazamos por la lista de
  // PENDIENTES (filtra los que ya quedaron cargados). Esto evita que un
  // refresh / volver al link tras cargar 1 de N rompa el flow con
  // "Link parcialmente utilizado".
  const urlReservedIds = presetTickets ? presetTickets.split(',').filter(Boolean) : [];
  const [reservedIds,    setReservedIds]    = useState(urlReservedIds);
  const [completedCount, setCompletedCount] = useState(0); // ya cargados antes
  const [totalCount,     setTotalCount]     = useState(urlReservedIds.length);

  const presetEventId  = searchParams.get('event') || '';
  const presetTypeId   = searchParams.get('type')  || '';
  const presetQtyParam = Math.min(Math.max(parseInt(searchParams.get('qty') || '1', 10) || 1, 1), 10);
  const presetQty      = isReserved ? reservedIds.length : presetQtyParam;
  const presetPay      = searchParams.get('pay') || 'efectivo';
  const isCortesiaParam = searchParams.get('cortesia') === '1';
  // En modo reservado el flag de cortesia lo decide el server (lo seteamos
  // luego con setReservedInfo). Por defecto, el del query string.
  const [reservedInfo, setReservedInfo] = useState(null);
  const isCortesia      = isReserved ? !!reservedInfo?.cortesia : isCortesiaParam;

  const [promotor,    setPromotor]    = useState(null);
  const [events,      setEvents]      = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState(null);
  const [eventSel,    setEventSel]    = useState(presetEventId);
  const [ticketTypes, setTicketTypes] = useState([]);
  const [typeSel,     setTypeSel]     = useState(presetTypeId);

  // Flujo de a uno
  const [step,         setStep]         = useState(0);            // 0..presetQty-1
  const [mode,         setMode]         = useState('form');       // 'form' | 'qr' | 'done'
  const [form,         setForm]         = useState(emptyForm());
  const [createdAll,   setCreatedAll]   = useState([]);           // todos los QRs generados
  const [currentTicket, setCurrentTicket] = useState(null);       // el que se muestra ahora
  const [saving,       setSaving]       = useState(false);
  const [formError,    setFormError]    = useState(null);

  // Recuperar QRs perdidos
  const [recoverOpen,    setRecoverOpen]    = useState(false);

  // Mantiene la pantalla encendida (Screen Wake Lock) sin apagarse ni atenuarse al mostrar la entrada
  useWakeLock(mode === 'qr' || mode === 'done' || recoverOpen || !!zoomQr);
  const [recoverForm,    setRecoverForm]    = useState({ nombre: '', apellido: '', email: '' });
  const [recovering,     setRecovering]     = useState(false);
  const [recoveredList,  setRecoveredList]  = useState(null);
  const [recoverError,   setRecoverError]   = useState(null);

  useEffect(() => {
    if (isReserved) {
      // Modo reservado: traemos la info de los tickets ya emitidos.
      Promise.all([
        fetch(`${BACKEND}/public/tickets-info?ids=${encodeURIComponent(presetTickets)}`).then(async r => ({ status: r.status, body: await r.json() })),
        fetch(`${BACKEND}/public/events`).then(r => r.json()),
      ])
        .then(([info, evs]) => {
          if (info.body?.status === 'completed' && Array.isArray(info.body.tickets)) {
            setCreatedAll(info.body.tickets);
            setMode('done');
            return;
          }
          if (info.body?.error) {
            setError(info.body.error || 'Link invalido o ya utilizado.');
            return;
          }
          const i = info.body;
          setReservedInfo(i);
          // Backend ahora devuelve i.ticket_ids = SOLO pendientes (si hay
          // mixto, filtra los completados). Usamos eso como la lista de
          // trabajo. Si por compatibilidad no viene, caemos al URL.
          if (Array.isArray(i.ticket_ids) && i.ticket_ids.length > 0) {
            setReservedIds(i.ticket_ids);
          }
          if (typeof i.completed_count === 'number') setCompletedCount(i.completed_count);
          if (typeof i.total_count === 'number')     setTotalCount(i.total_count);
          const list = Array.isArray(evs) ? evs : [];
          setEvents(list);
          setEventSel(i.event_id);
          setTypeSel(i.ticket_type_id);
          const target = list.find(e => e.id === i.event_id);
          setTicketTypes(target?.ticket_types || []);
        })
        .catch(() => setError('No se pudo cargar la pagina.'))
        .finally(() => setLoading(false));
      return;
    }

    Promise.all([
      fetch(`${BACKEND}/public/promotor/${code}`).then(r => r.json()),
      fetch(`${BACKEND}/public/events`).then(r => r.json()),
    ])
      .then(([promo, evs]) => {
        if (promo.error) { setError('Link no valido o expirado.'); return; }
        setPromotor(promo);
        const list = Array.isArray(evs) ? evs : [];
        setEvents(list);
        const target = presetEventId
          ? list.find(e => e.id === presetEventId)
          : list.length === 1 ? list[0] : null;
        if (target) {
          setEventSel(target.id);
          const types = target.ticket_types || [];
          setTicketTypes(types);
          if (presetTypeId && types.find(t => t.id === presetTypeId)) setTypeSel(presetTypeId);
          else if (types.length === 1) setTypeSel(types[0].id);
        }
      })
      .catch(() => setError('No se pudo cargar la pagina.'))
      .finally(() => setLoading(false));
  }, [code]);

  const handleEventChange = (id) => {
    setEventSel(id);
    setTypeSel('');
    const ev = events.find(e => e.id === id);
    setTicketTypes(ev?.ticket_types || []);
  };

  const submitOne = async (e) => {
    e.preventDefault();
    setFormError(null);
    if (!eventSel || !typeSel) { setFormError('Selecciona el evento y tipo de entrada'); return; }
    if (!form.buyer_name || !form.buyer_apellido || !form.buyer_dni) {
      setFormError('Nombre, apellido y DNI obligatorios');
      return;
    }
    if (!form.acepta_terminos) {
      setFormError('Tenés que aceptar los términos y condiciones');
      return;
    }

    setSaving(true);
    try {
      let data;
      if (isReserved) {
        // Modo reservado: completamos UN ticket reservado por vez (el del step actual).
        const tid = reservedIds[step];
        const r = await fetch(`${BACKEND}/public/tickets-complete/${code}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ticket_ids: [tid], attendees: [form] }),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Error al registrar');
      } else {
        const r = await fetch(`${BACKEND}/public/tickets/${code}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event_id: eventSel,
            ticket_type_id: typeSel,
            payment_method: isCortesia ? 'cortesia' : presetPay,
            cortesia: isCortesia,
            attendees: [form],
          }),
        });
        data = await r.json();
        if (!r.ok) throw new Error(data.error || 'Error al registrar');
      }
      const t = data.tickets[0];
      setCurrentTicket(t);
      setCreatedAll(prev => [...prev, t]);
      setMode('qr');
    } catch (err) {
      setFormError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const nextPerson = () => {
    if (step + 1 >= presetQty) {
      setMode('done');
    } else {
      setStep(step + 1);
      setForm(emptyForm());
      setCurrentTicket(null);
      setMode('form');
    }
  };

  const restart = () => {
    setStep(0);
    setMode('form');
    setForm(emptyForm());
    setCreatedAll([]);
    setCurrentTicket(null);
  };

  const doRecover = async (e) => {
    e.preventDefault();
    setRecoverError(null);
    setRecovering(true);
    try {
      const r = await fetch(`${BACKEND}/public/recover/${code}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(recoverForm),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Error');
      if (!data.tickets || data.tickets.length === 0) {
        setRecoverError('No encontramos entradas con esos datos. Revisá nombre y apellido.');
        setRecoveredList(null);
      } else {
        setRecoveredList(data.tickets);
      }
    } catch (err) {
      setRecoverError(err.message);
    } finally {
      setRecovering(false);
    }
  };

  const closeRecover = () => {
    setRecoverOpen(false);
    setRecoverForm({ nombre: '', apellido: '', email: '' });
    setRecoveredList(null);
    setRecoverError(null);
  };

  const selectedType  = ticketTypes.find(t => t.id === typeSel);
  const selectedEvent = events.find(e => e.id === eventSel);
  const eventLocked   = (isReserved || !!presetEventId) && !!selectedEvent;
  const typeLocked    = (isReserved || !!presetTypeId)  && !!selectedType;

  if (loading) return (
    <div className="min-h-dvh flex items-center justify-center" style={{ background: '#111312' }}>
      <div className="animate-spin rounded-full h-8 w-8 border-t-2" style={{ borderColor: '#788C79' }} />
    </div>
  );

  if (error) return (
    <div className="min-h-dvh flex items-center justify-center px-4" style={{ background: '#111312' }}>
      <div className="text-center space-y-4 max-w-sm">
        <p className="text-3xl font-bold font-heading text-white select-none">Pri<span style={{ color: '#788C79' }}>ckets</span></p>
        <p className="text-red-400 text-sm">{error}</p>
        <button
          onClick={() => { setError(null); setRecoverOpen(true); }}
          className="btn-primary px-6 py-2.5 text-sm font-semibold"
        >
          🔍 Buscar / Recuperar mi QR
        </button>
      </div>
    </div>
  );

  const personNum = step + 1;
  const isLast    = personNum >= presetQty;

  return (
    <div className="min-h-dvh py-8 px-4" style={{ background: '#111312' }}>
      <div className="max-w-md mx-auto">

        <div className="text-center mb-6">
          <p className="text-3xl font-bold font-heading text-white select-none">Pri<span style={{ color: '#788C79' }}>ckets</span></p>
          <p className="text-xs mt-1" style={{ color: '#8C948D' }}>Registro y emisión de entrada</p>
        </div>

        {/* Aviso cuando se retoma a mitad de camino: el link traia N entradas
            pero algunas ya quedaron cargadas (cierre de tab, volver al dia
            siguiente, etc). Hoy seguimos desde la pendiente. */}
        {isReserved && completedCount > 0 && mode !== 'done' && (
          <div className="card mb-4 py-3"
               style={{ background: 'rgba(201,151,77,0.06)', borderColor: 'rgba(201,151,77,0.3)' }}>
            <p className="text-sm font-medium" style={{ color: '#C9974D' }}>
              Continuando desde la entrada {completedCount + personNum} de {totalCount}
            </p>
            <p className="text-xs mt-1" style={{ color: '#9AA3B2' }}>
              {completedCount === 1 ? 'Ya cargaste 1 entrada antes' : `Ya cargaste ${completedCount} entradas antes`}. Te quedan {presetQty - createdAll.length}.
            </p>
          </div>
        )}

        {/* Indicador de progreso si hay mas de 1 */}
        {presetQty > 1 && mode !== 'done' && (
          <div className="card mb-4 py-3">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#6B7280' }}>
                Entrada {personNum} de {presetQty}
              </p>
              <p className="text-xs font-mono" style={{ color: '#C9974D' }}>
                {createdAll.length} / {presetQty} generadas
              </p>
            </div>
            <div className="h-1.5 rounded-full overflow-hidden" style={{ background: '#1E2530' }}>
              <div className="h-full rounded-full transition-all duration-500"
                   style={{ width: anchoBarra(porcentaje(createdAll.length, presetQty)), background: '#C9974D' }} />
            </div>
          </div>
        )}

        {/* MODO FORM */}
        {mode === 'form' && (
          <form onSubmit={submitOne} className="card space-y-5">

            {!eventLocked && events.length > 1 && (
              <div>
                <label className="text-sm text-gray-400 block mb-1">Evento *</label>
                <select className="input" required value={eventSel} onChange={e => handleEventChange(e.target.value)}>
                  <option value="">Seleccionar evento</option>
                  {events.map(ev => (
                    <option key={ev.id} value={ev.id}>
                      {ev.name} — {new Date(ev.date + 'T12:00:00').toLocaleDateString('es-AR')}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {selectedEvent && (
              <div className="rounded-lg p-3" style={{ background: '#161B24', border: '1px solid #1E2530' }}>
                <p className="font-semibold text-sm">{selectedEvent.name}</p>
                <p className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                  {new Date(selectedEvent.date + 'T12:00:00').toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' })}
                </p>
                {typeLocked && selectedType && (
                  <p className="text-xs mt-1 font-medium" style={{ color: '#C9974D' }}>
                    {selectedType.name} — {isCortesia ? 'CORTESÍA' : `$${parseFloat(selectedType.price).toLocaleString('es-AR')}`}
                  </p>
                )}
              </div>
            )}

            {!typeLocked && ticketTypes.length > 0 && (
              <div>
                <label className="text-sm text-gray-400 block mb-1">Tipo de entrada *</label>
                <select className="input" required value={typeSel} onChange={e => setTypeSel(e.target.value)}>
                  <option value="">Seleccionar tipo</option>
                  {ticketTypes.map(tt => (
                    <option key={tt.id} value={tt.id} disabled={tt.available <= 0}>
                      {tt.name} — ${parseFloat(tt.price).toLocaleString('es-AR')} ({tt.available} disp.)
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="space-y-3 pt-1" style={{ borderTop: '1px solid #1E2530', paddingTop: '1rem' }}>
              <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#4B5563' }}>
                {presetQty > 1 ? `Datos de la persona ${personNum}` : 'Tus datos'}
              </p>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Nombre *</label>
                  <input className="input" required placeholder="Juan" value={form.buyer_name}
                    autoComplete="given-name" autoCapitalize="words" enterKeyHint="next"
                    onChange={e => setForm(f => ({ ...f, buyer_name: e.target.value }))} />
                </div>
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Apellido *</label>
                  <input className="input" required placeholder="Garcia" value={form.buyer_apellido}
                    autoComplete="family-name" autoCapitalize="words" enterKeyHint="next"
                    onChange={e => setForm(f => ({ ...f, buyer_apellido: e.target.value }))} />
                </div>
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">DNI / Documento *</label>
                <input className="input" required placeholder="12345678" value={form.buyer_dni}
                  inputMode="numeric" pattern="[0-9]*" enterKeyHint="next"
                  onChange={e => setForm(f => ({ ...f, buyer_dni: e.target.value }))} />
                <p className="text-[11px] mt-1" style={{ color: '#8C948D' }}>
                  El DNI es tu clave de seguridad privada para poder consultar y recuperar tus QRs.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Edad</label>
                  <input className="input" inputMode="numeric" enterKeyHint="done" pattern="[0-9]*" maxLength={3}
                    placeholder="25" value={form.buyer_edad}
                    onChange={e => setForm(f => ({ ...f, buyer_edad: e.target.value }))} />
                </div>
                <div>
                  <label className="text-sm text-gray-400 block mb-1">Localidad</label>
                  <LocalidadInput
                    backend={BACKEND}
                    value={form.buyer_localidad}
                    onChange={(v) => setForm(f => ({ ...f, buyer_localidad: v }))}
                    placeholder="San Juan"
                  />
                </div>
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">
                  Email <span style={{ color: '#4B5563' }}>(opcional)</span>
                </label>
                <input type="email" className="input" placeholder="tu@email.com" value={form.buyer_email}
                  autoComplete="email" inputMode="email" autoCapitalize="off" spellCheck="false"
                  enterKeyHint="done"
                  onChange={e => setForm(f => ({ ...f, buyer_email: e.target.value }))} />
              </div>
            </div>

            {/* Las dos casillas van SEPARADAS y a la vista. Meter el permiso
                de novedades adentro de los terminos no es consentimiento
                valido, y ademas dispara quejas de spam en el mismo dominio
                con el que mandamos los QR: si eso se ensucia, las entradas
                empiezan a caer en no deseados. */}
            <div className="space-y-3 rounded-lg p-3"
                 style={{ background: '#161B24', border: '1px solid #1E2530' }}>
              {/* Descuentos: solo tiene sentido si dejo su email */}
              {form.buyer_email.trim() !== '' && (
                <label className="flex items-start gap-2.5 cursor-pointer select-none">
                  <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#C9974D] shrink-0"
                    checked={form.acepta_descuentos}
                    onChange={e => setForm(f => ({ ...f, acepta_descuentos: e.target.checked }))} />
                  <span>
                    <span className="block text-sm" style={{ color: '#E1E5E2' }}>
                      Quiero recibir descuentos y preventas
                    </span>
                    <span className="block text-[11px] leading-snug mt-0.5" style={{ color: '#6B7280' }}>
                      Te avisamos antes que al resto cuando salen las entradas
                      con descuento. Podés darte de baja cuando quieras.
                    </span>
                  </span>
                </label>
              )}

              <label className="flex items-start gap-2.5 cursor-pointer select-none">
                <input type="checkbox" className="w-4 h-4 mt-0.5 accent-[#C9974D] shrink-0"
                  checked={form.acepta_terminos}
                  onChange={e => setForm(f => ({ ...f, acepta_terminos: e.target.checked }))} />
                <span className="text-sm" style={{ color: '#E1E5E2' }}>
                  Acepto los términos y condiciones
                  <span style={{ color: '#D47779' }}> *</span>
                </span>
              </label>
            </div>

            {formError && (
              <p className="text-sm text-red-400 text-center">{formError}</p>
            )}

            <button type="submit" disabled={saving || !typeSel || !eventSel}
                    className="btn-primary w-full py-3 text-base font-semibold">
              {saving ? 'Generando...' : 'Generar mi QR'}
            </button>
          </form>
        )}

        {/* MODO QR */}
        {mode === 'qr' && currentTicket && (
          <div className="card text-center space-y-4">
            <div>
              <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#C9974D' }}>
                QR N° {personNum}{presetQty > 1 ? ` de ${presetQty}` : ''}
              </p>
              <h2 className="text-lg font-bold mt-1">{currentTicket.buyer_name} {currentTicket.buyer_apellido}</h2>
              <p className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                {currentTicket.tipo_entrada} · {parseFloat(currentTicket.amount_paid) === 0
                  ? 'CORTESÍA'
                  : `$${parseFloat(currentTicket.amount_paid).toLocaleString('es-AR')}`}
              </p>
            </div>

            <div className="flex justify-center p-4 bg-white rounded-xl cursor-pointer" onClick={() => setZoomQr(currentTicket)}>
              <QRCodeSVG
                value={JSON.stringify({ code: currentTicket.qr_code, ticket_id: currentTicket.id })}
                size={220} bgColor="#ffffff" fgColor="#000000"
              />
            </div>

            <p className="font-mono text-xs" style={{ color: '#4B5563' }}>{currentTicket.qr_code}</p>

            <button
              type="button"
              onClick={() => setZoomQr(currentTicket)}
              className="w-full py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
              style={{ background: 'rgba(201,151,77,0.15)', color: '#C9974D', border: '1px solid rgba(201,151,77,0.4)' }}
            >
              ☀️ Agrandar QR (Brillo Máximo)
            </button>

            <div className="rounded-lg p-3" style={{ background: 'rgba(201,151,77,0.08)', border: '1px solid rgba(201,151,77,0.3)' }}>
              <p className="text-sm font-semibold" style={{ color: '#C9974D' }}>
                Capturá este QR
              </p>
              <p className="text-xs mt-1" style={{ color: '#9CA3AF' }}>
                Sacale una captura de pantalla. Lo vas a necesitar en la entrada del evento.
              </p>
            </div>

            {isLast ? (
              <button onClick={() => setMode('done')} className="btn-primary w-full py-3 text-base">
                Listo, terminé
              </button>
            ) : (
              <button onClick={nextPerson} className="btn-primary w-full py-3 text-base">
                Capturé el QR — Generar siguiente
              </button>
            )}
          </div>
        )}

        {/* MODO DONE — resumen */}
        {mode === 'done' && (
          <div className="space-y-4">
            <div className="card text-center space-y-3">
              <div className="w-14 h-14 rounded-full flex items-center justify-center mx-auto"
                   style={{ background: 'rgba(52,211,153,0.1)', border: '1px solid rgba(52,211,153,0.3)' }}>
                <svg className="w-7 h-7 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <h2 className="text-xl font-bold">
                {createdAll.length === 1 ? 'Entrada registrada' : `${createdAll.length} entradas registradas`}
              </h2>
              <p className="text-xs" style={{ color: '#6B7280' }}>
                Asegurate de tener capturada cada una de las entradas
              </p>
            </div>

            {createdAll.map((t, i) => (
              <div key={t.id} className="card text-center space-y-2 py-4">
                <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#C9974D' }}>
                  QR N° {i + 1}
                </p>
                <p className="font-semibold text-sm">{t.buyer_name} {t.buyer_apellido}</p>
                <div id={`qr-pdf-${t.id}`} className="flex justify-center p-2 bg-white rounded-lg cursor-pointer" onClick={() => setZoomQr(t)}>
                  <QRCodeSVG
                    value={JSON.stringify({ code: t.qr_code, ticket_id: t.id })}
                    size={150} bgColor="#ffffff" fgColor="#000000"
                  />
                </div>
                <p className="font-mono text-xs" style={{ color: '#4B5563' }}>{t.qr_code}</p>

                <button
                  type="button"
                  onClick={() => setZoomQr(t)}
                  className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-all"
                  style={{ background: 'rgba(201,151,77,0.15)', color: '#C9974D', border: '1px solid rgba(201,151,77,0.4)' }}
                >
                  ☀️ Agrandar QR (Brillo Máximo)
                </button>
              </div>
            ))}

            <button
              onClick={() => downloadTicketsPdf({
                tickets: createdAll,
                eventName: events.find(e => e.id === eventSel)?.name,
                promoterName: promotor ? `${promotor.name || ''} ${promotor.apellido || ''}`.trim() : '',
              })}
              className="btn-primary w-full py-3"
            >
              📄 Descargar PDF
            </button>
            <button onClick={() => window.print()} className="btn-secondary w-full py-3">
              <span className="inline-flex items-center justify-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Imprimir
              </span>
            </button>
          </div>
        )}

        {/* Recuperar QRs perdidos */}
        {mode === 'form' && !recoverOpen && (
          <p className="text-center text-xs mt-4">
            <button onClick={() => setRecoverOpen(true)}
                    className="underline" style={{ color: '#6B7280' }}>
              ¿Ya compraste y perdiste tu QR? Recuperalo
            </button>
          </p>
        )}

        {recoverOpen && (
          <div className="card mt-4 space-y-4">
            <div className="flex items-center justify-between">
              <p className="font-semibold text-sm">Recuperar mis QRs</p>
              <button onClick={closeRecover} className="text-gray-500 hover:text-white text-lg leading-none">×</button>
            </div>

            {!recoveredList ? (
              <form onSubmit={doRecover} className="space-y-3">
                <p className="text-xs" style={{ color: '#8C948D' }}>
                  Por seguridad, cargá tu Nombre, Apellido y DNI exactos para recuperar tus entradas:
                </p>
                <input className="input" required placeholder="Nombre *"
                       autoComplete="given-name" autoCapitalize="words" enterKeyHint="next"
                       value={recoverForm.nombre}
                       onChange={e => setRecoverForm(f => ({ ...f, nombre: e.target.value }))} />
                <input className="input" required placeholder="Apellido *"
                       autoComplete="family-name" autoCapitalize="words" enterKeyHint="next"
                       value={recoverForm.apellido}
                       onChange={e => setRecoverForm(f => ({ ...f, apellido: e.target.value }))} />
                <input className="input" required placeholder="DNI / Documento *"
                       inputMode="numeric" pattern="[0-9]*" enterKeyHint="search"
                       value={recoverForm.dni || ''}
                       onChange={e => setRecoverForm(f => ({ ...f, dni: e.target.value }))} />
                {recoverError && <p className="text-sm text-red-400">{recoverError}</p>}
                <button type="submit" disabled={recovering} className="btn-primary w-full py-3 font-semibold">
                  {recovering ? 'Verificando DNI...' : '🔒 Recuperar mis QRs'}
                </button>
              </form>
            ) : (
              <div className="space-y-3">
                <p className="text-xs" style={{ color: '#9CA3AF' }}>
                  Encontramos {recoveredList.length} entrada{recoveredList.length === 1 ? '' : 's'}
                </p>
                {recoveredList.map((t, i) => (
                  <div key={t.id} className="rounded-lg p-3 space-y-2 text-center"
                       style={{ background: '#161B24', border: '1px solid #1E2530' }}>
                    <p className="text-xs uppercase tracking-widest font-semibold" style={{ color: '#C9974D' }}>
                      QR N° {i + 1} {t.status === 'usado' && '· YA INGRESÓ'}
                    </p>
                    <p className="text-sm font-semibold">{t.buyer_name} {t.buyer_apellido}</p>
                    <p className="text-xs" style={{ color: '#6B7280' }}>
                      {t.evento} · {t.tipo_entrada}
                    </p>
                    <div id={`qr-pdf-${t.id}`} className="flex justify-center p-2 bg-white rounded-lg">
                      <QRCodeSVG
                        value={JSON.stringify({ code: t.qr_code, ticket_id: t.id })}
                        size={160} bgColor="#ffffff" fgColor="#000000"
                      />
                    </div>
                    <p className="font-mono text-xs" style={{ color: '#4B5563' }}>{t.qr_code}</p>
                  </div>
                ))}
                <button
                  onClick={() => downloadTicketsPdf({
                    tickets: recoveredList,
                    eventName: recoveredList[0]?.evento || 'Entradas',
                    promoterName: '',
                  })}
                  className="btn-primary w-full"
                >
                  📄 Descargar PDF
                </button>
                <button onClick={() => window.print()} className="btn-secondary w-full">
                  <span className="inline-flex items-center justify-center gap-1.5">
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
                </svg>
                Imprimir
              </span>
                </button>
                <button onClick={closeRecover} className="text-xs underline w-full" style={{ color: '#6B7280' }}>
                  Cerrar
                </button>
              </div>
            )}
          </div>
        )}

        {/* Modal Fullscreen de Brillo Máximo */}
        {zoomQr && (
          <div className="fixed inset-0 z-50 bg-white text-black flex flex-col items-center justify-center p-6 text-center select-none">
            <p className="text-xs uppercase tracking-widest font-bold text-amber-700 mb-2">☀️ MÁXIMO BRILLO DE PANTALLA</p>
            <h2 className="text-2xl font-black mb-1">{zoomQr.buyer_name} {zoomQr.buyer_apellido || ''}</h2>
            <p className="text-xs text-gray-600 mb-6">{zoomQr.tipo_entrada || 'ENTRADA'}</p>

            <div className="p-4 bg-white rounded-2xl shadow-2xl border-4 border-black">
              <QRCodeSVG
                value={JSON.stringify({ code: zoomQr.qr_code, ticket_id: zoomQr.id })}
                size={290} bgColor="#ffffff" fgColor="#000000"
              />
            </div>

            <p className="font-mono text-sm font-bold mt-4 tracking-widest">{zoomQr.qr_code}</p>
            <p className="text-xs text-gray-500 mt-2 max-w-xs">
              Mantené la pantalla orientada hacia la cámara del escáner para una lectura instantánea.
            </p>

            <button
              onClick={() => setZoomQr(null)}
              className="mt-8 px-8 py-3 rounded-full bg-black text-white font-bold text-sm hover:opacity-90 transition-all shadow-lg"
            >
              ✖️ Cerrar vista de brillo
            </button>
          </div>
        )}

        <p className="text-center text-xs mt-6" style={{ color: '#1E2530' }}>Prickets — Sistema de Entradas</p>
      </div>
    </div>
  );
};

export default PublicBuy;
