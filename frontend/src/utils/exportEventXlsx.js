// Genera un archivo Excel multi-hoja con todos los datos relevantes de un
// evento. Pensado para descargar antes de "reciclar" (clonar) el evento,
// asi queda un snapshot offline para el dueño.
//
// Hojas:
//   1. "Resumen"      — datos del evento + totales (vendidas, recaudado, etc.)
//   2. "Entradas"     — listado completo con datos del comprador y QR
//   3. "Demografía"   — edad/localidad/email del público (si hay datos)
//   4. "Vendedores"   — ventas y comisiones por promotor
//
// Lazy-load: exceljs pesa ~400KB minified. Lo importamos dinamicamente
// solo cuando se aprieta el boton, no en el chunk inicial.

import api from '../api/axios';

const fmtMoney = (n) => {
  const v = parseFloat(n || 0);
  return isNaN(v) ? 0 : v;
};
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(String(s).includes('T') ? s : s.replace(' ', 'T') + 'Z');
  return isNaN(d.getTime()) ? '' : d.toLocaleString('es-AR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
};
const fmtEventDate = (s) => {
  if (!s) return '';
  // events.date es "YYYY-MM-DD" sin hora
  const d = new Date(s + 'T12:00:00');
  return isNaN(d.getTime()) ? s : d.toLocaleDateString('es-AR', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });
};

const STATUS_LABEL = {
  pagado:    'Pagado',
  pendiente: 'Pendiente',
  usado:     'Usado',
  cancelado: 'Cancelado',
};
const METHOD_LABEL = {
  efectivo:      'Efectivo',
  transferencia: 'Transferencia',
  cortesia:      'Cortesía',
};

export async function exportEventXlsx(eventId, opts = {}) {
  // Cargamos exceljs solo ahora (lazy). Compatible con SSR + tree shaking.
  const ExcelJS = (await import('exceljs')).default;

  // Endpoint dedicado: una sola request que devuelve TODO. El backend
  // valida en el guard que sea owner del evento (role=owner +
  // event_owners.user_id = req.user.id), asi un admin con DevTools no
  // puede dispararlo aunque tenga acceso al evento por scope.
  const r = await api.get(`/events/${eventId}/export-data`);
  const event     = r.data.event;
  const tickets   = r.data.tickets || [];
  const stats     = r.data.buyer_stats;
  const promoters = r.data.promoter_sales || [];

  const wb = new ExcelJS.Workbook();
  wb.creator       = 'Prickets';
  wb.created       = new Date();
  wb.lastModifiedBy = 'Prickets';

  // ---------- Hoja 1: Resumen ----------
  const resumen = wb.addWorksheet('Resumen');
  resumen.columns = [
    { width: 28 },
    { width: 40 },
  ];

  const tBoldGold = { font: { bold: true, color: { argb: 'FFC9974D' } } };

  const addKV = (label, value) => {
    const row = resumen.addRow([label, value]);
    row.getCell(1).font = { bold: true, color: { argb: 'FF6B7280' } };
  };

  // Encabezado
  const title = resumen.addRow(['Prickets — Resumen del evento', '']);
  title.height = 26;
  title.getCell(1).font = { size: 16, bold: true, color: { argb: 'FFC9974D' } };
  resumen.mergeCells(`A${title.number}:B${title.number}`);
  resumen.addRow([]);

  addKV('Evento',          event.name || '');
  addKV('Fecha',           fmtEventDate(event.date));
  if (event.start_time) addKV('Hora',            event.start_time);
  addKV('Estado',          event.is_active ? 'Activo' : 'Inactivo');
  resumen.addRow([]);

  // Totales (calculados acá; coinciden con LiveControl/SoldTickets)
  let vendidas = 0, usadas = 0, pendientes = 0, canceladas = 0, cortesias = 0;
  let recaudado = 0, totalEfectivo = 0, totalTransferencia = 0;
  for (const t of tickets) {
    const valid = t.status === 'pagado' || t.status === 'usado';
    if (t.status === 'usado') usadas++;
    if (t.status === 'pendiente') pendientes++;
    if (t.status === 'cancelado') canceladas++;
    if (t.payment_method === 'cortesia') cortesias++;
    else if (valid) vendidas++;
    if (valid) {
      const amt = fmtMoney(t.amount_paid);
      recaudado += amt;
      if (t.payment_method === 'efectivo')      totalEfectivo += amt;
      if (t.payment_method === 'transferencia') totalTransferencia += amt;
    }
  }

  const totalRow = resumen.addRow(['Totales', '']);
  totalRow.getCell(1).font = tBoldGold.font;
  resumen.mergeCells(`A${totalRow.number}:B${totalRow.number}`);
  addKV('Vendidas (no cortesía)',  vendidas);
  addKV('Usadas (escaneadas)',     usadas);
  addKV('Cortesías',               cortesias);
  addKV('Pendientes',              pendientes);
  addKV('Canceladas',              canceladas);
  addKV('Recaudado total',         recaudado);
  addKV('Recaudado efectivo',      totalEfectivo);
  addKV('Recaudado transferencia', totalTransferencia);

  // Tipos de entrada
  if (event.ticket_types?.length > 0) {
    resumen.addRow([]);
    const tt = resumen.addRow(['Tipos de entrada', '']);
    tt.getCell(1).font = tBoldGold.font;
    resumen.mergeCells(`A${tt.number}:B${tt.number}`);
    event.ticket_types.forEach(t => {
      addKV(t.name, `$${fmtMoney(t.price).toLocaleString('es-AR')} · ${t.sold_count}/${t.total_quota}`);
    });
  }

  resumen.addRow([]);
  const exportedRow = resumen.addRow(['Exportado', new Date().toLocaleString('es-AR')]);
  exportedRow.getCell(1).font = { italic: true, color: { argb: 'FF6B7280' } };
  exportedRow.getCell(2).font = { italic: true, color: { argb: 'FF6B7280' } };

  // ---------- Hoja 2: Entradas ----------
  const ent = wb.addWorksheet('Entradas');
  ent.columns = [
    { header: 'QR',          key: 'qr',       width: 16 },
    { header: 'Nombre',      key: 'name',     width: 16 },
    { header: 'Apellido',    key: 'apellido', width: 16 },
    { header: 'Email',       key: 'email',    width: 28 },
    { header: 'Edad',        key: 'edad',     width: 8  },
    { header: 'Localidad',   key: 'localidad',width: 16 },
    { header: 'Tipo',        key: 'tipo',     width: 16 },
    { header: 'Monto',       key: 'monto',    width: 12, style: { numFmt: '"$"#,##0.00' } },
    { header: 'Método',      key: 'metodo',   width: 14 },
    { header: 'Estado',      key: 'estado',   width: 12 },
    { header: 'Vendedor',    key: 'vendedor', width: 22 },
    { header: 'Creado',      key: 'creado',   width: 18 },
    { header: 'Escaneado',   key: 'usado',    width: 18 },
  ];
  ent.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ent.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2530' }
  };
  ent.views = [{ state: 'frozen', ySplit: 1 }]; // header pegado al scrollear

  for (const t of tickets) {
    ent.addRow({
      qr:        t.qr_code,
      name:      t.buyer_name,
      apellido:  t.buyer_apellido,
      email:     t.buyer_email,
      edad:      t.buyer_edad,
      localidad: t.buyer_localidad,
      tipo:      t.tipo_entrada,
      monto:     fmtMoney(t.amount_paid),
      metodo:    METHOD_LABEL[t.payment_method] || t.payment_method,
      estado:    STATUS_LABEL[t.status] || t.status,
      vendedor:  t.vendedor_nombre || (t.vendedor_code ? `(${t.vendedor_code})` : ''),
      creado:    fmtDate(t.created_at),
      usado:     fmtDate(t.scanned_at),
    });
  }

  // ---------- Hoja 3: Demografía (opcional) ----------
  if (stats && stats.muestra > 0) {
    const dem = wb.addWorksheet('Demografía');
    dem.columns = [{ width: 24 }, { width: 16 }, { width: 16 }];

    const t1 = dem.addRow(['Edad del público', '', '']);
    t1.getCell(1).font = tBoldGold.font;
    dem.mergeCells(`A${t1.number}:C${t1.number}`);
    dem.addRow(['Muestra (cargaron edad)', stats.muestra, '']);
    dem.addRow(['Cobertura', `${stats.cobertura_pct}%`, '']);
    if (stats.edad) {
      dem.addRow(['Promedio', stats.edad.avg ? Number(stats.edad.avg).toFixed(1) : '', '']);
      dem.addRow(['Mínimo',   stats.edad.min, '']);
      dem.addRow(['Máximo',   stats.edad.max, '']);
    }
    dem.addRow([]);

    const t2 = dem.addRow(['Rango', 'Cantidad', '%']);
    t2.font = { bold: true };
    (stats.edad?.buckets || []).forEach(b => {
      dem.addRow([b.rango, b.count, `${b.pct}%`]);
    });

    if (stats.por_localidad?.length > 0) {
      dem.addRow([]);
      const t3 = dem.addRow(['Top localidades', 'Cantidad', '']);
      t3.getCell(1).font = tBoldGold.font;
      stats.por_localidad.slice(0, 10).forEach(l => {
        dem.addRow([l.localidad || '(sin dato)', l.count, '']);
      });
    }
  }

  // ---------- Hoja 4: Vendedores ----------
  if (promoters.length > 0) {
    const ven = wb.addWorksheet('Vendedores');
    ven.columns = [
      { header: 'Vendedor',  key: 'name',      width: 22 },
      { header: 'Apellido',  key: 'apellido',  width: 16 },
      { header: 'Código',    key: 'promo',     width: 12 },
      { header: 'Vendidas',  key: 'vendidas',  width: 10 },
      { header: 'Recaudado', key: 'recaudado', width: 14, style: { numFmt: '"$"#,##0.00' } },
      { header: 'Comisión',  key: 'comision',  width: 14, style: { numFmt: '"$"#,##0.00' } },
      { header: 'Debe enviar', key: 'debe',    width: 14, style: { numFmt: '"$"#,##0.00' } },
    ];
    ven.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ven.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E2530' } };
    ven.views = [{ state: 'frozen', ySplit: 1 }];
    for (const p of promoters) {
      ven.addRow({
        name:      p.name,
        apellido:  p.apellido,
        promo:     p.promo_code,
        vendidas:  parseInt(p.total_vendidas || 0, 10),
        recaudado: fmtMoney(p.total_recaudado),
        comision:  fmtMoney(p.comision_promotor),
        debe:      fmtMoney(p.debe_enviar),
      });
    }
  }

  // ---------- Descargar ----------
  const buffer = await wb.xlsx.writeBuffer();
  const blob   = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const safeName = (event.name || 'evento').replace(/[^a-zA-Z0-9-_]/g, '_').slice(0, 40);
  const fname  = `${safeName}_${event.date || 'sin-fecha'}.xlsx`;

  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url;
  a.download = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { fname, tickets: tickets.length };
}
