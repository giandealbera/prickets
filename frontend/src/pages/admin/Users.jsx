import { useEffect, useState } from 'react';
import api from '../../api/axios';
import Layout from '../../components/Layout';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import { useConfirm } from '../../context/ConfirmContext';
import { Icon } from '../../components/Icon';

const ROLES_ADMIN = ['jefe_publicas', 'vendedor', 'admin', 'owner'];
const ROLES_OWNER = ['jefe_publicas', 'vendedor'];
const ROLE_LABELS = {
  admin:         'Administrador',
  jefe_publicas: 'Jefe de Públicas',
  vendedor:      'Vendedor',
  owner:         'Dueño del evento',
};
const PUBLICAS_ROLES = ['jefe_publicas', 'vendedor'];
const emptyFormFor = (isOwner) => ({
  name: '', apellido: '', celular: '', localidad: '', email: '', password: '',
  role: isOwner ? 'jefe_publicas' : 'owner',
  promo_code: '', commission: 800, leader_id: '', leader_commission: 400, zona_id: '',
});

const Users = () => {
  const { user: me } = useAuth();
  const confirm = useConfirm();
  const isOwner = me?.role === 'owner';
  const ROLES = isOwner ? ROLES_OWNER : ROLES_ADMIN;
  const [users,       setUsers]       = useState([]);
  const [zonas,       setZonas]       = useState([]);
  const [showForm,    setShowForm]    = useState(false);
  const [form,        setForm]        = useState(emptyFormFor(me?.role === "owner"));
  const [saving,      setSaving]      = useState(false);
  const [editCommId,  setEditCommId]  = useState(null);
  const [commForm,    setCommForm]    = useState({ commission: 800, leader_commission: 400 });
  const [editRoleId,  setEditRoleId]  = useState(null); // id del usuario cambiando rol
  const [createdUser, setCreatedUser] = useState(null);
  // Magic link recien generado para mostrar en modal (link + expiracion).
  const [magicResult, setMagicResult] = useState(null);
  const [magicLoading, setMagicLoading] = useState(null);

  const jefes = users.filter(u => u.role === 'jefe_publicas' && u.is_active);

  const load = () => api.get('/users').then(r => setUsers(r.data)).catch(() => toast.error('Error al cargar usuarios'));
  const loadZonas = () => api.get('/zonas').then(r => setZonas(r.data)).catch(() => {});
  useEffect(() => { load(); loadZonas(); }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      await api.post('/users', form);
      toast.success('Usuario creado');
      setCreatedUser({
        name:     form.name,
        apellido: form.apellido,
        role:     form.role,
        usuario:  form.email,
        password: form.password,
      });
      setShowForm(false);
      setForm(emptyFormFor(me?.role === "owner"));
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al crear usuario');
    } finally {
      setSaving(false);
    }
  };

  const copyCreds = () => {
    if (!createdUser) return;
    const txt = `Prickets - Acceso\n\nNombre: ${createdUser.name} ${createdUser.apellido || ''}\nRol: ${ROLE_LABELS[createdUser.role] || createdUser.role}\nUsuario: ${createdUser.usuario}\nContrasena: ${createdUser.password}\n\nIngresa en: ${window.location.origin}/login`;
    navigator.clipboard.writeText(txt).then(() => toast.success('Credenciales copiadas'));
  };

  const reactivate = async (u) => {
    try {
      await api.put(`/users/${u.id}`, { ...u, is_active: true });
      toast.success('Usuario activado');
      load();
    } catch {
      toast.error('Error al activar usuario');
    }
  };

  // Hard delete: borra la fila de la DB. Doble confirm para evitar accidentes,
  // porque NO se puede deshacer. Solo el admin tiene el boton (el backend
  // tambien lo restringe en la route /:id/hard).
  const hardDelete = async (u) => {
    const nombre = `${u.name} ${u.apellido || ''}`.trim();
    const tipo   = ROLE_LABELS[u.role] || u.role;
    const ok = await confirm({
      title: `Eliminar definitivamente a ${nombre} (${tipo})`,
      message: 'Esto borra al usuario de la base de datos. NO se puede deshacer.\n• Sus sesiones y códigos de 2FA se borran.\n• Sus eventos creados quedan sin dueño asignado.\n• Sus tickets vendidos/escaneados quedan en la base pero sin referencia.\n• Su staff (jefes/vendedores) queda huérfano.\n\nSi tenés dudas, usá "Desactivar" mejor.',
      confirmText: 'Eliminar definitivamente',
      dangerous: true,
    });
    if (!ok) return;
    // Segundo confirm pidiendo escribir el nombre — ultimo seguro contra
    // "Enter por inercia" en el confirm anterior.
    const typed = window.prompt(`Escribí "${nombre}" exactamente para confirmar:`);
    if (typed !== nombre) {
      if (typed !== null) toast.error('Nombre no coincide. Cancelado.');
      return;
    }
    try {
      await api.delete(`/users/${u.id}/hard`);
      toast.success(`${nombre} eliminado`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al eliminar usuario');
    }
  };

  // Genera un magic link de 48h. Util cuando un dueño olvido la clave —
  // el admin NO puede ver la password (es bcrypt), pero si puede generarle
  // un acceso temporal de un solo uso. El dueño entra, setea su nueva
  // password al primer login (must_change_password) y listo.
  const generateMagic = async (u) => {
    const nombre = `${u.name} ${u.apellido || ''}`.trim();
    const ok = await confirm({
      title: `Generar acceso de 48h para ${nombre}`,
      message: 'Vas a ver un link que tenés que mandarle por WhatsApp/email. Es de un solo uso: cuando lo abren, se invalida.',
      confirmText: 'Generar link',
    });
    if (!ok) return;
    setMagicLoading(u.id);
    try {
      const r = await api.post(`/users/${u.id}/magic-link`);
      const url = `${window.location.origin}/acceso/${r.data.magic_token}`;
      setMagicResult({ url, target: r.data.target, expires_at: r.data.expires_at });
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error al generar magic link');
    } finally {
      setMagicLoading(null);
    }
  };

  const copyMagicLink = () => {
    if (!magicResult) return;
    navigator.clipboard.writeText(magicResult.url)
      .then(() => toast.success('Link copiado'))
      .catch(() => toast.error('No se pudo copiar'));
  };

  const softDeactivate = async (u) => {
    const ok = await confirm({
      title: `Desactivar a ${u.name}`,
      message: 'Va a perder acceso pero queda el historial.',
      confirmText: 'Desactivar',
      dangerous: true,
    });
    if (!ok) return;
    try {
      await api.delete(`/users/${u.id}`);
      toast.success('Usuario desactivado');
      load();
    } catch {
      toast.error('Error al desactivar usuario');
    }
  };

  const changeRole = async (u, newRole) => {
    try {
      await api.put(`/users/${u.id}`, { ...u, role: newRole });
      toast.success(`Rol cambiado a ${ROLE_LABELS[newRole] || newRole}`);
      setEditRoleId(null);
      load();
    } catch {
      toast.error('Error al cambiar rol');
    }
  };

  const openEditComm = (u) => {
    setEditCommId(u.id);
    setCommForm({ commission: u.commission ?? 800, leader_commission: u.leader_commission ?? 400 });
  };

  const saveCommission = async (userId) => {
    try {
      await api.patch(`/users/${userId}/commission`, commForm);
      toast.success('Comisión actualizada');
      setEditCommId(null);
      load();
    } catch {
      toast.error('Error al actualizar comisión');
    }
  };

  const isPublicas = PUBLICAS_ROLES.includes(form.role);

  return (
    <Layout>
      <div className="px-4 lg:px-8 py-6 max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-semibold tracking-tight">{isOwner ? 'Mi Personal' : 'Dueños'}</h1>
          <button onClick={() => { setShowForm(!showForm); setCreatedUser(null); }} className="btn-primary">
            {showForm ? 'Cancelar' : (isOwner ? '+ Nuevo miembro' : '+ Nuevo dueño')}
          </button>
        </div>

        {/* Credenciales del usuario recien creado */}
        {createdUser && (
          <div className="mb-6 rounded-xl p-4 space-y-3"
               style={{ background: 'rgba(201,151,77,0.08)', border: '1px solid rgba(201,151,77,0.3)' }}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                   style={{ background: 'rgba(52,211,153,0.15)' }}>
                <svg className="w-5 h-5 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">{ROLE_LABELS[createdUser.role] || createdUser.role} creado</p>
                <p className="text-xs" style={{ color: '#6B7280' }}>
                  Pasale estas credenciales a {createdUser.name} para que pueda entrar al sistema
                </p>
              </div>
              <button onClick={() => setCreatedUser(null)}
                      className="text-gray-500 hover:text-white text-lg leading-none">×</button>
            </div>

            <div className="space-y-2 rounded-lg p-3" style={{ background: '#0D1117', border: '1px solid #1E2530' }}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Usuario</span>
                <span className="font-mono text-sm" style={{ color: '#C9974D' }}>{createdUser.usuario}</span>
              </div>
              <div className="flex items-center justify-between gap-2 pt-2 border-t border-gray-800">
                <span className="text-xs uppercase tracking-wider" style={{ color: '#6B7280' }}>Contrasena</span>
                <span className="font-mono text-sm" style={{ color: '#C9974D' }}>{createdUser.password}</span>
              </div>
            </div>

            <button onClick={copyCreds} className="btn-primary w-full text-sm py-2">
              Copiar credenciales para compartir
            </button>
            <p className="text-[10px] text-center" style={{ color: '#4B5563' }}>
              Por seguridad, esta es la unica vez que vas a ver la contrasena
            </p>
          </div>
        )}

        {/* Magic link generado: link de 48h para mandarle al usuario */}
        {magicResult && (
          <div className="mb-6 rounded-xl p-4 space-y-3"
               style={{ background: 'rgba(96,165,250,0.08)', border: '1px solid rgba(96,165,250,0.35)' }}>
            <div className="flex items-start gap-3">
              <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
                   style={{ background: 'rgba(96,165,250,0.15)', color: '#60A5FA' }}>
                <Icon name="link" className="w-5 h-5" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm">Acceso temporal generado</p>
                <p className="text-xs" style={{ color: '#9CA3AF' }}>
                  Para {magicResult.target.name} · {ROLE_LABELS[magicResult.target.role] || magicResult.target.role}
                </p>
              </div>
              <button onClick={() => setMagicResult(null)}
                      className="text-gray-500 hover:text-white text-lg leading-none">×</button>
            </div>

            <p className="text-xs" style={{ color: '#9CA3AF' }}>
              Mandale este link por WhatsApp/email. Es de <b>un solo uso</b> y expira en 48hs.
              Cuando lo abra, va a entrar al sistema y tener que setear su nueva contraseña.
            </p>

            <div className="rounded-lg p-3 break-all font-mono text-[11px] selectable"
                 style={{ background: '#0D1117', border: '1px solid #1E2530', color: '#60A5FA' }}>
              {magicResult.url}
            </div>

            <button onClick={copyMagicLink} className="btn-primary w-full text-sm py-2 inline-flex items-center justify-center gap-2">
              <Icon name="copy" className="w-4 h-4" />
              Copiar link
            </button>
            <p className="text-[10px] text-center" style={{ color: '#4B5563' }}>
              Si lo regenerás, el link anterior queda invalidado automáticamente.
            </p>
          </div>
        )}

        {showForm && (
          <form onSubmit={handleSubmit} className="card mb-8 space-y-4">
            <h2 className="font-semibold">{isOwner ? 'Nuevo miembro de tu equipo' : 'Nuevo dueño'}</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-sm text-gray-400 block mb-1">Nombre *</label>
                <input className="input" required value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Apellido</label>
                <input className="input" value={form.apellido}
                  onChange={e => setForm(f => ({ ...f, apellido: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Email (para iniciar sesión) *</label>
                <input type="email" className="input" required value={form.email}
                  placeholder="ej: juan@email.com"
                  onChange={e => setForm(f => ({ ...f, email: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Contraseña *</label>
                <input type="password" className="input" required minLength={8} value={form.password}
                  placeholder="mín. 8 caracteres"
                  onChange={e => setForm(f => ({ ...f, password: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Celular</label>
                <input className="input" placeholder="ej: 2645 123456" value={form.celular}
                  onChange={e => setForm(f => ({ ...f, celular: e.target.value }))} />
              </div>
              <div>
                <label className="text-sm text-gray-400 block mb-1">Localidad</label>
                <input className="input" placeholder="ej: San Juan" value={form.localidad}
                  onChange={e => setForm(f => ({ ...f, localidad: e.target.value }))} />
              </div>
              <div className="sm:col-span-2">
                <label className="text-sm text-gray-400 block mb-1">Rol *</label>
                <select className="input" value={form.role}
                  onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                </select>
              </div>

              {isPublicas && (
                <>
                  <div>
                    <label className="text-sm text-gray-400 block mb-1">Código de pública</label>
                    <input className="input" placeholder="Ej: PROMO2024" value={form.promo_code}
                      onChange={e => setForm(f => ({ ...f, promo_code: e.target.value }))} />
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 block mb-1">Zona</label>
                    <select className="input" value={form.zona_id}
                      onChange={e => setForm(f => ({ ...f, zona_id: e.target.value }))}>
                      <option value="">Sin zona</option>
                      {zonas.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
                    </select>
                    {zonas.length === 0 && (
                      <p className="text-xs text-gray-500 mt-1">Aún no hay zonas creadas. Andá a "Zonas" para crear.</p>
                    )}
                  </div>
                  <div>
                    <label className="text-sm text-gray-400 block mb-1">Comisión propia ($ por entrada)</label>
                    <input type="number" inputMode="decimal" enterKeyHint="done" className="input" min="0" value={form.commission}
                      onChange={e => setForm(f => ({ ...f, commission: e.target.value }))} />
                  </div>
                  {form.role === 'vendedor' && (
                    <>
                      <div>
                        <label className="text-sm text-gray-400 block mb-1">Jefe de Públicas</label>
                        <select className="input" value={form.leader_id}
                          onChange={e => setForm(f => ({ ...f, leader_id: e.target.value }))}>
                          <option value="">Sin jefe asignado</option>
                          {jefes.map(p => <option key={p.id} value={p.id}>{p.name} {p.apellido || ''}</option>)}
                        </select>
                      </div>
                      {form.leader_id && (
                        <div>
                          <label className="text-sm text-gray-400 block mb-1">Comisión del jefe ($ por entrada)</label>
                          <input type="number" inputMode="decimal" enterKeyHint="done" className="input" min="0" value={form.leader_commission}
                            onChange={e => setForm(f => ({ ...f, leader_commission: e.target.value }))} />
                        </div>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
            <button type="submit" disabled={saving} className="btn-primary">
              {saving ? 'Guardando...' : 'Crear usuario'}
            </button>
          </form>
        )}

        <div className="space-y-3">
          {users.map(u => (
            <div key={u.id} className="card">
              <div className="flex items-start justify-between gap-3">
                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="font-semibold">{u.name} {u.apellido || ''}</p>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium ${
                      u.is_active ? 'bg-emerald-900/40 text-emerald-400' : 'bg-gray-700 text-gray-400'
                    }`}>
                      {u.is_active ? 'Activo' : 'Inactivo'}
                    </span>
                  </div>
                  <p className="text-sm text-gray-400 mt-0.5">{u.email}{u.celular ? ` · ${u.celular}` : ''}</p>
                  {u.localidad && <p className="text-xs text-gray-500">{u.localidad}</p>}
                  {u.promo_code && (
                    <p className="text-xs text-gray-500 mt-1">
                      Código: <span className="font-mono text-gray-300">{u.promo_code}</span>
                      {u.leader_name && <span> · Jefe: {u.leader_name}</span>}
                    </p>
                  )}
                </div>

                {/* Rol + acciones */}
                <div className="shrink-0 text-right">
                  {/* Rol editable */}
                  {editRoleId === u.id ? (
                    <div className="flex items-center gap-2 mb-2">
                      <select
                        defaultValue={u.role}
                        onChange={e => changeRole(u, e.target.value)}
                        className="input text-xs py-1 w-40"
                      >
                        {ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                      </select>
                      <button onClick={() => setEditRoleId(null)} className="text-xs text-gray-500 hover:text-white">✕</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditRoleId(u.id); setEditCommId(null); }}
                      className="text-xs bg-gray-800 hover:bg-gray-700 px-2 py-1 rounded-lg mb-2 transition-colors"
                      title="Cambiar rol"
                    >
                      {ROLE_LABELS[u.role] || u.role} ✎
                    </button>
                  )}

                  {/* Acciones */}
                  <div className="flex items-center justify-end gap-2 flex-wrap">
                    {PUBLICAS_ROLES.includes(u.role) && (
                      <button onClick={() => editCommId === u.id ? setEditCommId(null) : openEditComm(u)}
                        className="text-xs text-blue-400 hover:text-blue-200 transition-colors">
                        {editCommId === u.id ? 'Cancelar' : '$ Comisión'}
                      </button>
                    )}
                    {/* Magic link: solo para usuarios activos, no para el propio admin,
                        y NO para admins ajenos (el backend lo bloquea igual). */}
                    {u.is_active && u.role !== 'admin' && u.id !== me?.id && (
                      <button onClick={() => generateMagic(u)}
                        disabled={magicLoading === u.id}
                        className="text-xs text-blue-400 hover:text-blue-200 transition-colors disabled:opacity-40 inline-flex items-center gap-1"
                        title="Generar acceso temporal de 48h (si olvidó la contraseña)">
                        <Icon name="link" className="w-3 h-3" />
                        {magicLoading === u.id ? '…' : 'Acceso'}
                      </button>
                    )}
                    {/* Activo: admin tiene "Eliminar" (hard delete); owner sigue
                        con "Desactivar" (soft) porque NO debe poder borrar de la DB.
                        Inactivo: cualquiera con permisos ve "Activar". */}
                    {!u.is_active ? (
                      <button onClick={() => reactivate(u)}
                        className="text-xs text-gray-400 hover:text-white transition-colors">
                        Activar
                      </button>
                    ) : me?.role === 'admin' ? (
                      <>
                        <button onClick={() => softDeactivate(u)}
                          className="text-xs text-gray-400 hover:text-white transition-colors"
                          title="Soft delete: mantiene historial, pierde acceso">
                          Desactivar
                        </button>
                        <button onClick={() => hardDelete(u)}
                          className="text-xs hover:text-red-300 transition-colors"
                          style={{ color: '#FCA5A5' }}
                          title="Hard delete: borra de la base de datos">
                          Eliminar
                        </button>
                      </>
                    ) : (
                      <button onClick={() => softDeactivate(u)}
                        className="text-xs text-gray-400 hover:text-white transition-colors">
                        Desactivar
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Editor de comisión */}
              {editCommId === u.id && (
                <div className="mt-3 pt-3 border-t border-gray-800 grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase block mb-1">Comisión propia ($ x entrada)</label>
                    <input type="number" inputMode="decimal" enterKeyHint="done" className="input text-sm py-1" min="0"
                      value={commForm.commission}
                      onChange={e => setCommForm(f => ({ ...f, commission: parseFloat(e.target.value) }))} />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase block mb-1">Comisión jefe ($ x entrada)</label>
                    <input type="number" inputMode="decimal" enterKeyHint="done" className="input text-sm py-1" min="0"
                      value={commForm.leader_commission}
                      onChange={e => setCommForm(f => ({ ...f, leader_commission: parseFloat(e.target.value) }))} />
                  </div>
                  <div className="col-span-2">
                    <button onClick={() => saveCommission(u.id)} className="btn-primary text-xs py-1.5 w-full">
                      Guardar comisión
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </Layout>
  );
};

export default Users;
