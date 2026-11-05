import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import usePullToRefresh from '../../hooks/usePullToRefresh';
import PullIndicator from '../../components/PullIndicator';
import { SkeletonPantalla } from '../../components/Skeleton';
import api from '../../api/axios';
import Layout from '../../components/Layout';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { Icon } from '../../components/Icon';
import toast from 'react-hot-toast';

const emptyMember = { name: '', apellido: '', celular: '', localidad: '', email: '', password: '', commission: 800 };

const PromoterDashboard = () => {
  const { user } = useAuth();
  const confirm = useConfirm();
  const [data,         setData]         = useState(null);
  const [loading,      setLoading]      = useState(true);
  const [team,         setTeam]         = useState([]);
  const [showTeamForm, setShowTeamForm] = useState(false);
  const [memberForm,   setMemberForm]   = useState(emptyMember);
  const [saving,       setSaving]       = useState(false);
  const [createdMember, setCreatedMember] = useState(null); // credenciales a compartir

  const loadTeam = () => {
    if (user?.role === 'jefe_publicas') {
      api.get('/users/my-team').then(r => setTeam(r.data)).catch(() => {});
    }
  };

  const cargar = () =>
    api.get('/users/my-sales')
      .then(res => setData(res.data))
      .catch(() => toast.error('Error al cargar datos'))
      .finally(() => setLoading(false));

  useEffect(() => {
    cargar();
    loadTeam();
  }, []);

  // Tirar para actualizar: el vendedor mira sus ventas del dia y quiere ver
  // si entro la ultima sin tener que salir y volver a la pantalla.
  const { pulling, progress, refreshing } = usePullToRefresh(
    () => Promise.all([cargar(), loadTeam()])
  );

  const handleAddMember = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/users/team', memberForm);
      toast.success('Vendedor creado');
      // guardar credenciales para mostrarlas
      setCreatedMember({
        name:     memberForm.name,
        apellido: memberForm.apellido,
        usuario:  memberForm.email,
        password: memberForm.password,
      });
      setShowTeamForm(false);
      setMemberForm(emptyMember);
      loadTeam();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al crear vendedor');
    } finally {
      setSaving(false);
    }
  };

  const removeMember = async (m) => {
    const nombre = `${m.name} ${m.apellido || ''}`.trim();
    const ok = await confirm({
      title: `Quitar a ${nombre} del equipo`,
      message: 'No va a poder loguearse más, pero sus ventas e historial se conservan.',
      confirmText: 'Quitar',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/users/team/${m.id}`);
      toast.success('Vendedor desactivado');
      loadTeam();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al quitar vendedor');
    }
  };

  const copyCredenciales = () => {
    if (!createdMember) return;
    const txt = `Prickets - Acceso de vendedor\n\nNombre: ${createdMember.name} ${createdMember.apellido || ''}\nUsuario: ${createdMember.usuario}\nContrasena: ${createdMember.password}\n\nIngresa en: ${window.location.origin}/login`;
    navigator.clipboard.writeText(txt).then(() => toast.success('Credenciales copiadas'));
  };

  const fmt = (n) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n || 0);

  return (
    <Layout>
      <PullIndicator pulling={pulling} progress={progress} refreshing={refreshing} />
      <div className="px-4 lg:px-8 py-6 max-w-4xl mx-auto">
        <h1 className="text-xl font-semibold tracking-tight mb-1">Mi Panel</h1>
        <p className="text-slate-400 text-sm mb-6">Hola, {user?.name}</p>

        <div className="card mb-6 border-brand/30 bg-brand/5">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div>
              <p className="text-xs text-slate-400 uppercase tracking-wider font-medium mb-2">Venta de entradas</p>
              <h2 className="text-xl font-bold text-white">Generar entrada</h2>
              <p className="text-sm text-slate-400 mt-1">
                Entrá al evento y generá desde adentro: así la entrada queda
                siempre atada al evento correcto.
              </p>
            </div>
            <Link to="/eventos" className="btn-primary text-center px-5 py-3 shrink-0">
              Ir a mis eventos
            </Link>
          </div>
        </div>

        {loading ? (
          <SkeletonPantalla stats={4} rows={3} />
        ) : !data ? (
          <p className="text-center text-slate-500 py-12">No hay datos disponibles</p>
        ) : (
          <>
            {/* Mi Zona (solo jefe) */}
            {data.summary?.es_jefe && (
              <div className="mb-6">
                <h3 className="font-semibold text-sm mb-3 text-slate-300">Mi Zona</h3>
                <div className="grid grid-cols-2 gap-3 mb-4">
                  <div className="card text-center py-4">
                    <p className="text-3xl font-black text-white">{data.summary.zona_vendidas ?? data.summary.equipo_vendidas}</p>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">Entradas de mi zona</p>
                  </div>
                  <div className="card text-center py-4 border-emerald-800/40">
                    <p className="stat-num font-black text-emerald-400">{fmt(data.summary.mi_comision_jefe)}</p>
                    <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">Mi ganancia por la zona</p>
                  </div>
                </div>

                <div className="card">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-semibold text-sm">Vendedores ({team.length})</h4>
                    <button onClick={() => { setShowTeamForm(!showTeamForm); setCreatedMember(null); }} className="btn-primary text-xs py-1.5 px-3">
                      {showTeamForm ? 'Cancelar' : '+ Agregar'}
                    </button>
                  </div>

                  {/* Credenciales del vendedor recien creado */}
                  {createdMember && (
                    <div className="mb-4 rounded-xl p-4 space-y-3"
                         style={{ background: 'rgba(201,151,77,0.08)', border: '1px solid rgba(201,151,77,0.3)' }}>
                      <div className="flex items-start gap-3">
                        <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                             style={{ background: 'rgba(52,211,153,0.15)' }}>
                          <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm">Vendedor creado</p>
                          <p className="text-xs" style={{ color: '#6B7280' }}>
                            Pasale estas credenciales a {createdMember.name} para que pueda entrar
                          </p>
                        </div>
                        <button onClick={() => setCreatedMember(null)}
                                className="text-gray-500 hover:text-white text-lg leading-none">×</button>
                      </div>

                      <div className="space-y-2 rounded-lg p-3" style={{ background: '#0D1117', border: '1px solid #1E2530' }}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Usuario</span>
                          <span className="font-mono text-sm" style={{ color: '#C9974D' }}>{createdMember.usuario}</span>
                        </div>
                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-800">
                          <span className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Contrasena</span>
                          <span className="font-mono text-sm" style={{ color: '#C9974D' }}>{createdMember.password}</span>
                        </div>
                      </div>

                      <button onClick={copyCredenciales} className="btn-primary w-full text-sm py-2">
                        Copiar credenciales para compartir
                      </button>
                      <p className="text-[10px] text-center" style={{ color: '#4B5563' }}>
                        Por seguridad, esta es la unica vez que vas a ver la contrasena
                      </p>
                    </div>
                  )}

                  {showTeamForm && (
                    <form onSubmit={handleAddMember} className="mb-4 p-4 bg-slate-800/50 rounded-xl space-y-3">
                      <p className="text-sm font-medium text-slate-300">Nuevo vendedor</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Nombre *</label>
                          <input className="input" required value={memberForm.name}
                            onChange={e => setMemberForm(f => ({ ...f, name: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Apellido</label>
                          <input className="input" value={memberForm.apellido}
                            onChange={e => setMemberForm(f => ({ ...f, apellido: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Celular</label>
                          <input className="input" placeholder="2645 123456" value={memberForm.celular}
                            onChange={e => setMemberForm(f => ({ ...f, celular: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Localidad</label>
                          <input className="input" placeholder="San Juan" value={memberForm.localidad}
                            onChange={e => setMemberForm(f => ({ ...f, localidad: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Usuario *</label>
                          <input type="text" className="input" required value={memberForm.email}
                            onChange={e => setMemberForm(f => ({ ...f, email: e.target.value }))} />
                        </div>
                        <div>
                          <label className="text-xs text-slate-400 block mb-1">Contrasena *</label>
                          <input type="password" className="input" required value={memberForm.password}
                            onChange={e => setMemberForm(f => ({ ...f, password: e.target.value }))} />
                        </div>
                        <div className="sm:col-span-2">
                          <label className="text-xs text-slate-400 block mb-1">Comision del vendedor ($ por entrada)</label>
                          <input type="number" inputMode="decimal" enterKeyHint="done" className="input" min="0" value={memberForm.commission}
                            onChange={e => setMemberForm(f => ({ ...f, commission: e.target.value }))} />
                        </div>
                      </div>
                      <button type="submit" disabled={saving} className="btn-primary w-full">
                        {saving ? 'Guardando...' : 'Crear vendedor'}
                      </button>
                    </form>
                  )}

                  {team.length === 0 ? (
                    <p className="text-center text-slate-500 text-sm py-4">Sin vendedores en el equipo</p>
                  ) : (
                    <div className="divide-y divide-slate-800">
                      {team.map(m => (
                        <div key={m.id} className="py-3 flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <p className="font-medium text-sm">{m.name} {m.apellido || ''}</p>
                            <p className="text-xs text-slate-500">{m.celular || m.email}</p>
                            {m.zona_name && (
                              <p className="text-[10px] mt-0.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded"
                                 style={{ background: 'rgba(201,151,77,0.10)', color: '#C9974D' }}>
                                <Icon name="pin" className="w-2.5 h-2.5" />
                                {m.zona_name}
                              </p>
                            )}
                          </div>
                          <div className="text-right shrink-0 flex items-center gap-3">
                            <div>
                              <p className="text-sm font-bold text-brand">{m.total_vendidas ?? 0} <span className="text-xs text-slate-400 font-normal">entradas</span></p>
                              <p className="text-xs text-slate-500">{fmt(m.total_recaudado)}</p>
                              {m.mi_ganancia > 0 && (
                                <p className="text-xs text-emerald-400 font-medium">Te gana: {fmt(m.mi_ganancia)}</p>
                              )}
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${m.is_active ? 'bg-emerald-950 text-emerald-400' : 'bg-slate-700 text-slate-400'}`}>
                                {m.is_active ? 'Activo' : 'Inactivo'}
                              </span>
                            </div>
                            {m.is_active && (
                              <button onClick={() => removeMember(m)}
                                      className="text-xs text-red-400 hover:text-red-300 font-medium px-2 py-1 rounded hover:bg-red-900/20">
                                Quitar
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Mis ventas */}
            <h3 className="font-semibold text-sm mb-3 text-slate-300">Mis Ventas</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
              <div className="card text-center py-4">
                <p className="text-3xl font-black text-brand">{data.summary?.total_vendidas || 0}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">Vendidas</p>
              </div>
              <div className="card text-center py-4">
                <p className="stat-num font-black text-slate-200">{fmt(data.summary?.total_recaudado)}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">Recaudado</p>
              </div>
              <div className="card text-center py-4 border-emerald-800/40">
                <p className="stat-num font-black text-emerald-400">{fmt(data.summary?.mi_comision)}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">Mi Ganancia</p>
              </div>
              <div className="card text-center py-4 border-red-900/40">
                <p className="stat-num font-black text-red-400">{fmt(data.summary?.debo_enviar)}</p>
                <p className="text-[10px] text-slate-400 uppercase tracking-wider mt-1">A rendir</p>
              </div>
            </div>

            {/* Desglose por evento */}
            {data.by_event?.length > 0 && (
              <div className="card mb-6">
                <h3 className="font-semibold text-sm mb-4">Desglose por Evento</h3>
                <div className="space-y-3">
                  {data.by_event.map((ev, i) => (
                    <div key={i} className="flex flex-col sm:flex-row sm:items-center justify-between p-3 bg-slate-800/50 rounded-lg">
                      <div className="mb-2 sm:mb-0">
                        <p className="font-medium text-white text-sm">{ev.evento}</p>
                        <p className="text-xs text-slate-500">
                          {new Date(ev.date + 'T12:00:00').toLocaleDateString('es-AR')} · {ev.vendidas} entradas
                        </p>
                      </div>
                      <div className="flex gap-4 text-right">
                        <div>
                          <p className="text-xs text-slate-500 uppercase">Recaudado</p>
                          <p className="text-sm font-semibold">{fmt(ev.recaudado)}</p>
                        </div>
                        <div>
                          <p className="text-xs text-slate-500 uppercase">A enviar</p>
                          <p className="text-sm font-bold text-red-400">{fmt(ev.a_enviar)}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ultimas ventas */}
            <div className="card overflow-x-auto">
              <h2 className="font-semibold mb-4 text-sm">Ultimas Ventas</h2>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-800">
                    <th className="text-left pb-2 font-medium">Comprador</th>
                    <th className="text-left pb-2 font-medium">Evento</th>
                    <th className="text-left pb-2 font-medium">Tipo</th>
                    <th className="text-right pb-2 font-medium">Monto</th>
                    <th className="text-left pb-2 font-medium pl-3">Estado</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800">
                  {data.recent?.map((t, i) => (
                    <tr key={i} className="hover:bg-slate-800/30">
                      <td className="py-3 pr-2">{t.buyer_name}</td>
                      <td className="py-3 pr-2 text-slate-400">{t.evento}</td>
                      <td className="py-3 pr-2 text-slate-400">{t.tipo_entrada}</td>
                      <td className="py-3 pr-2 text-right text-emerald-400">{fmt(t.amount_paid)}</td>
                      <td className="py-3 pl-3"><span className={`badge-${t.status}`}>{t.status}</span></td>
                    </tr>
                  ))}
                  {(!data.recent || data.recent.length === 0) && (
                    <tr><td colSpan={5} className="text-center py-6 text-slate-500">Sin ventas registradas</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
};

export default PromoterDashboard;
