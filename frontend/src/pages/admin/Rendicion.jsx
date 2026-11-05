import { useEffect, useState } from 'react';
import api from '../../api/axios';
import { SkeletonList } from '../../components/Skeleton';
import Layout from '../../components/Layout';
import { useConfirm } from '../../context/ConfirmContext';
import toast from 'react-hot-toast';

const fmt = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n || 0);

const ROLE_LABELS = {
  jefe_publicas: 'Jefe de Públicas',
  vendedor:      'Vendedor',
};

const Rendicion = () => {
  const confirm = useConfirm();
  const [list,      setList]      = useState([]);
  const [search,    setSearch]    = useState('');
  const [loading,   setLoading]   = useState(true);
  const [selected,  setSelected]  = useState(null);   // { promotor_id } seleccionado
  const [detail,    setDetail]    = useState(null);
  const [loadingD,  setLoadingD]  = useState(false);
  const [showPago,  setShowPago]  = useState(false);
  const [pagoForm,  setPagoForm]  = useState({ amount: '', note: '', event_id: '' });
  const [saving,    setSaving]    = useState(false);

  const load = (s = '') => {
    setLoading(true);
    api.get(`/rendiciones${s ? `?search=${encodeURIComponent(s)}` : ''}`)
      .then(r => setList(r.data))
      .catch(() => toast.error('Error al cargar publicas'))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  const loadDetail = (promotorId) => {
    setSelected(promotorId);
    setLoadingD(true);
    api.get(`/rendiciones/${promotorId}`)
      .then(r => setDetail(r.data))
      .catch(() => toast.error('Error al cargar detalle'))
      .finally(() => setLoadingD(false));
  };

  const handleSearch = (e) => {
    e.preventDefault();
    load(search);
  };

  const handleRegistrarPago = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/rendiciones', {
        promotor_id: selected,
        amount: parseFloat(pagoForm.amount),
        note: pagoForm.note,
        event_id: pagoForm.event_id || null,
      });
      toast.success('Pago registrado');
      setShowPago(false);
      setPagoForm({ amount: '', note: '', event_id: '' });
      loadDetail(selected);
      load(search);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al registrar pago');
    } finally {
      setSaving(false);
    }
  };

  const marcarPagoTotal = async (publica, e) => {
    e.stopPropagation();
    if (publica.saldo_pendiente <= 0) return;
    const nombre = `${publica.name} ${publica.apellido || ''}`.trim();
    const ok = await confirm({
      title: `Marcar a ${nombre} como pagó todo`,
      message: `Se registra un pago por ${fmt(publica.saldo_pendiente)} y su saldo queda en cero.`,
      confirmText: 'Marcar pagado',
    });
    if (!ok) return;
    try {
      await api.post('/rendiciones', {
        promotor_id: publica.promotor_id,
        amount: publica.saldo_pendiente,
        note: 'Marcado como pagado total desde rendicion',
      });
      toast.success('Pago registrado, saldo en cero');
      load(search);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al registrar');
    }
  };

  const marcarPagoEvento = async (ev) => {
    const pendiente = (ev.a_enviar || 0) - (ev.pagado_evento || 0);
    if (pendiente <= 0) return;
    const ok = await confirm({
      title: `Marcar evento "${ev.evento}" como pagado`,
      message: `Se registra un pago por ${fmt(pendiente)} asociado al evento.`,
      confirmText: 'Marcar pagado',
    });
    if (!ok) return;
    try {
      await api.post('/rendiciones', {
        promotor_id: selected,
        amount: pendiente,
        event_id: ev.event_id,
        note: `Pago marcado por evento: ${ev.evento}`,
      });
      toast.success('Evento marcado como pagado');
      loadDetail(selected);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al registrar');
    }
  };

  const handleEliminarPago = async (pagoId) => {
    const ok = await confirm({
      title: 'Eliminar pago',
      message: 'Se borra el registro del pago.',
      confirmText: 'Eliminar',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/rendiciones/${pagoId}`);
      toast.success('Pago eliminado');
      loadDetail(selected);
      load(search);
    } catch {
      toast.error('Error al eliminar');
    }
  };

  // === Vista detalle ===
  if (selected) return (
    <Layout>
      <div className="px-4 lg:px-8 py-6 max-w-4xl mx-auto">
        <button
          onClick={() => { setSelected(null); setDetail(null); }}
          className="text-sm text-gray-400 hover:text-white mb-4 inline-flex items-center gap-1"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
          Volver al listado
        </button>

        {loadingD || !detail ? (
          <SkeletonList rows={4} />
        ) : (
          <>
            {/* Perfil */}
            <div className="card mb-6">
              <div className="flex items-start gap-4">
                <div className="w-14 h-14 rounded-full flex items-center justify-center text-xl font-bold shrink-0"
                     style={{ background: 'rgba(201,151,77,0.15)', color: '#C9974D' }}>
                  {detail.perfil.name?.charAt(0)?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <h1 className="text-xl font-bold">{detail.perfil.name} {detail.perfil.apellido || ''}</h1>
                  <p className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                    {ROLE_LABELS[detail.perfil.role] || detail.perfil.role}
                    {detail.perfil.leader_name && ` · Jefe: ${detail.perfil.leader_name}`}
                  </p>
                  <p className="text-xs font-mono mt-1" style={{ color: '#C9974D' }}>{detail.perfil.promo_code}</p>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
                <div>
                  <p className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Celular</p>
                  <p>{detail.perfil.celular || '—'}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Localidad</p>
                  <p>{detail.perfil.localidad || '—'}</p>
                </div>
                <div className="col-span-2">
                  <p className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Usuario</p>
                  <p className="font-mono text-xs">{detail.perfil.email}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Comisión por entrada</p>
                  <p>{fmt(detail.perfil.commission)}</p>
                </div>
                <div>
                  <p className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Alta</p>
                  <p className="text-xs">{new Date(detail.perfil.created_at).toLocaleDateString('es-AR')}</p>
                </div>
              </div>
            </div>

            {/* Resumen financiero */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
              <div className="card text-center py-4">
                <p className="text-2xl font-black">{detail.totals.total_vendidas}</p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: '#6B7280' }}>Vendidas</p>
              </div>
              <div className="card text-center py-4">
                <p className="stat-num-sm font-black">{fmt(detail.totals.total_recaudado)}</p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: '#6B7280' }}>Recaudado</p>
              </div>
              <div className="card text-center py-4" style={{ borderColor: 'rgba(52,211,153,0.3)' }}>
                <p className="stat-num-sm font-black text-emerald-400">{fmt(detail.totals.ya_rindio)}</p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: '#6B7280' }}>Ya rindió</p>
              </div>
              <div className="card text-center py-4" style={{ borderColor: 'rgba(239,68,68,0.3)' }}>
                <p className={`text-2xl font-black ${detail.totals.saldo_pendiente > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                  {fmt(detail.totals.saldo_pendiente)}
                </p>
                <p className="text-[10px] uppercase tracking-wider mt-1" style={{ color: '#6B7280' }}>
                  {detail.totals.saldo_pendiente > 0 ? 'Nos debe' : 'Al día'}
                </p>
              </div>
            </div>

            {/* Acciones */}
            <div className="mb-6">
              <button
                onClick={() => setShowPago(!showPago)}
                className="btn-primary"
              >
                {showPago ? 'Cancelar' : 'Registrar pago'}
              </button>
            </div>

            {showPago && (
              <form onSubmit={handleRegistrarPago} className="card mb-6 space-y-4">
                <h3 className="font-semibold text-sm">Nuevo pago</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs block mb-1" style={{ color: '#6B7280' }}>Monto *</label>
                    <input
                      type="number" inputMode="decimal" enterKeyHint="done" step="0.01" min="0" required
                      className="input"
                      placeholder="0"
                      value={pagoForm.amount}
                      onChange={e => setPagoForm(f => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                  <div>
                    <label className="text-xs block mb-1" style={{ color: '#6B7280' }}>Evento (opcional)</label>
                    <select className="input" value={pagoForm.event_id}
                            onChange={e => setPagoForm(f => ({ ...f, event_id: e.target.value }))}>
                      <option value="">Sin evento específico</option>
                      {detail.by_event.map(ev => (
                        <option key={ev.event_id} value={ev.event_id}>{ev.evento}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="text-xs block mb-1" style={{ color: '#6B7280' }}>Nota</label>
                  <input className="input" placeholder="ej: efectivo en mano, transferencia..."
                         value={pagoForm.note}
                         onChange={e => setPagoForm(f => ({ ...f, note: e.target.value }))} />
                </div>
                <button type="submit" disabled={saving} className="btn-primary">
                  {saving ? 'Guardando...' : 'Guardar pago'}
                </button>
              </form>
            )}

            {/* Historial de pagos */}
            <div className="card mb-6">
              <h3 className="font-semibold text-sm mb-4">Historial de pagos ({detail.pagos.length})</h3>
              {detail.pagos.length === 0 ? (
                <p className="text-center text-sm py-4" style={{ color: '#4B5563' }}>Sin pagos registrados</p>
              ) : (
                <div className="space-y-2">
                  {detail.pagos.map(p => (
                    <div key={p.id} className="flex items-center justify-between gap-3 py-2 border-b border-gray-800 last:border-0">
                      <div className="min-w-0">
                        <p className="font-semibold text-emerald-400">{fmt(p.amount)}</p>
                        <p className="text-xs" style={{ color: '#6B7280' }}>
                          {new Date(p.created_at).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' })}
                          {p.evento && ` · ${p.evento}`}
                          {p.created_by_name && ` · por ${p.created_by_name}`}
                        </p>
                        {p.note && <p className="text-xs mt-0.5">{p.note}</p>}
                      </div>
                      <button onClick={() => handleEliminarPago(p.id)}
                              className="text-xs text-red-400 hover:text-red-300 shrink-0">
                        Eliminar
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Desglose por evento */}
            {detail.by_event.length > 0 && (
              <div className="card mb-6">
                <h3 className="font-semibold text-sm mb-4">Por evento</h3>
                <div className="space-y-2">
                  {detail.by_event.map(ev => {
                    const pendiente = (ev.a_enviar || 0) - (ev.pagado_evento || 0);
                    const estaPagado = pendiente <= 0;
                    return (
                      <div key={ev.event_id} className="flex items-center justify-between gap-3 py-2 border-b border-gray-800 last:border-0">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium">{ev.evento}</p>
                          <p className="text-xs" style={{ color: '#6B7280' }}>
                            {new Date(ev.date + 'T12:00:00').toLocaleDateString('es-AR')} · {ev.vendidas} vendidas
                          </p>
                          {(ev.pagado_evento || 0) > 0 && (
                            <p className="text-xs mt-0.5 text-emerald-400">
                              Ya pagó: {fmt(ev.pagado_evento)}
                            </p>
                          )}
                        </div>
                        <div className="text-right shrink-0 flex items-center gap-3">
                          <div>
                            <p className="text-sm">{fmt(ev.recaudado)}</p>
                            <p className={`text-xs ${estaPagado ? 'text-emerald-400' : 'text-red-400'}`}>
                              {estaPagado ? 'Al día' : `A rendir: ${fmt(pendiente)}`}
                            </p>
                          </div>
                          {estaPagado ? (
                            <span className="text-[10px] px-2 py-1 rounded font-semibold"
                                  style={{ background: 'rgba(52,211,153,0.15)', color: '#34D399', border: '1px solid rgba(52,211,153,0.3)' }}>
                              PAGÓ
                            </span>
                          ) : (
                            <button onClick={() => marcarPagoEvento(ev)}
                                    className="text-xs px-3 py-1.5 rounded font-medium"
                                    style={{ background: '#1E2530', color: '#C9974D', border: '1px solid rgba(201,151,77,0.3)' }}>
                              Marcar pagado
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Últimas ventas */}
            <div className="card">
              <h3 className="font-semibold text-sm mb-4">Últimas ventas</h3>
              {detail.recent.length === 0 ? (
                <p className="text-center text-sm py-4" style={{ color: '#4B5563' }}>Sin ventas registradas</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-left border-b border-gray-800" style={{ color: '#6B7280' }}>
                        <th className="pb-2 font-medium">Comprador</th>
                        <th className="pb-2 font-medium">Evento</th>
                        <th className="pb-2 font-medium">Tipo</th>
                        <th className="pb-2 font-medium text-right">Monto</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-800">
                      {detail.recent.map(t => (
                        <tr key={t.id}>
                          <td className="py-2 pr-2">{t.buyer_name} {t.buyer_apellido || ''}</td>
                          <td className="py-2 pr-2" style={{ color: '#9CA3AF' }}>{t.evento}</td>
                          <td className="py-2 pr-2" style={{ color: '#9CA3AF' }}>{t.tipo_entrada}</td>
                          <td className="py-2 text-right text-emerald-400">{fmt(t.amount_paid)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </Layout>
  );

  // === Vista listado ===
  return (
    <Layout>
      <div className="px-4 lg:px-8 py-6 max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold tracking-tight mb-1">Rendición de entradas</h1>
        <p className="text-sm mb-6" style={{ color: '#6B7280' }}>
          Busca una pública para ver su perfil, lo que debe y registrar pagos.
        </p>

        <form onSubmit={handleSearch} className="mb-4 flex gap-2">
          <input
            type="search"
            enterKeyHint="search"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck="false"
            className="input flex-1"
            placeholder="Buscar por nombre, apellido o código..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          <button type="submit" className="btn-primary px-6">Buscar</button>
        </form>

        {loading ? (
          <SkeletonList rows={5} />
        ) : list.length === 0 ? (
          <p className="text-center py-12 text-sm" style={{ color: '#4B5563' }}>Sin resultados</p>
        ) : (
          <div className="space-y-2">
            {list.map(p => p.es_caja ? (
              /* La caja no es una publica: esa plata ya esta en la casa, nadie
                 la rinde. Va sin saldo, sin boton de pago y sin detalle. */
              <div key="caja" className="card w-full text-left flex items-center gap-4">
                <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold shrink-0"
                     style={{ background: 'rgba(52,211,153,0.12)', color: '#34D399' }}>
                  $
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">Caja</p>
                  <p className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                    Dueño y administración
                    {p.cortesias > 0 && ` · ${p.cortesias} cortesía${p.cortesias === 1 ? '' : 's'}`}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold">{p.total_vendidas} <span className="text-xs font-normal" style={{ color: '#6B7280' }}>vend.</span></p>
                  <p className="text-sm font-semibold text-emerald-400">{fmt(p.total_recaudado)}</p>
                  <p className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: '#6B7280' }}>
                    En la casa
                  </p>
                </div>
              </div>
            ) : (
              <div
                key={p.promotor_id}
                role="button"
                tabIndex={0}
                onClick={() => loadDetail(p.promotor_id)}
                onKeyDown={(e) => { if (e.key === 'Enter') loadDetail(p.promotor_id); }}
                className="card w-full text-left hover:border-gray-700 transition-colors flex items-center gap-4 cursor-pointer"
              >
                <div className="w-12 h-12 rounded-full flex items-center justify-center font-bold shrink-0"
                     style={{ background: 'rgba(201,151,77,0.15)', color: '#C9974D' }}>
                  {p.name?.charAt(0)?.toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="font-semibold">{p.name} {p.apellido || ''}</p>
                  <p className="text-xs mt-0.5" style={{ color: '#6B7280' }}>
                    {ROLE_LABELS[p.role] || p.role}
                    {p.leader_name && ` · Jefe: ${p.leader_name}`}
                    {' · '}<span className="font-mono" style={{ color: '#C9974D' }}>{p.promo_code}</span>
                  </p>
                </div>
                <div className="text-right shrink-0 flex items-center gap-3">
                  <div>
                    <p className="text-sm font-bold">{p.total_vendidas} <span className="text-xs font-normal" style={{ color: '#6B7280' }}>vend.</span></p>
                    <p className={`text-sm font-semibold ${p.saldo_pendiente > 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                      {fmt(p.saldo_pendiente)}
                    </p>
                    <p className="text-[10px] uppercase tracking-wider mt-0.5" style={{ color: '#6B7280' }}>
                      {p.saldo_pendiente > 0 ? 'Nos debe' : 'Al día'}
                    </p>
                  </div>
                  {p.saldo_pendiente > 0 ? (
                    <button onClick={(e) => marcarPagoTotal(p, e)}
                            className="text-xs px-3 py-1.5 rounded font-semibold"
                            style={{ background: 'rgba(201,151,77,0.15)', color: '#C9974D', border: '1px solid rgba(201,151,77,0.4)' }}>
                      Pagó todo
                    </button>
                  ) : (
                    <span className="text-[10px] px-2 py-1 rounded font-semibold"
                          style={{ background: 'rgba(52,211,153,0.15)', color: '#34D399', border: '1px solid rgba(52,211,153,0.3)' }}>
                      PAGÓ
                    </span>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  );
};

export default Rendicion;
