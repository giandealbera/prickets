/**
 * Genera un PDF con los QRs de los tickets, uno por página.
 * Cada página: nombre del evento, nombre del comprador, QR grande, código.
 *
 * Uso:
 *   await downloadTicketsPdf({ tickets, eventName });
 *
 * tickets: [{ id, qr_code, buyer_name, buyer_apellido, tipo_entrada?, amount_paid? }]
 */
import { jsPDF } from 'jspdf';

/** Convierte un SVG (string) a dataURL PNG usando canvas. */
function svgToPngDataUrl(svgString, size = 600) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

/** Toma un nodo DOM de tipo <svg> y genera el string XML serializable. */
function svgNodeToString(svgNode) {
  return new XMLSerializer().serializeToString(svgNode);
}

/** Genera el SVG de un QR usando la misma logica que QRCodeSVG (sin React).
 *  Lo hacemos via canvas: dibujamos el QR string a un SVG inline temporal.
 *  Para no duplicar logica, asumimos que el caller ya tiene los SVGs renderizados
 *  en el DOM (con id="qr-pdf-{ticketId}") y los buscamos por ese selector.
 */
async function getQrPng(ticketId) {
  const node = document.getElementById(`qr-pdf-${ticketId}`);
  if (!node) throw new Error(`SVG del ticket ${ticketId} no encontrado en el DOM`);
  const svg = node.querySelector('svg') || node;
  return svgToPngDataUrl(svgNodeToString(svg), 600);
}

export async function downloadTicketsPdf({ tickets, eventName, promoterName }) {
  if (!tickets || tickets.length === 0) return;

  const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = pdf.internal.pageSize.getWidth();   // 210mm
  const pageH = pdf.internal.pageSize.getHeight();  // 297mm

  for (let i = 0; i < tickets.length; i++) {
    const t = tickets[i];
    if (i > 0) pdf.addPage();

    // Header: marca
    pdf.setFontSize(24);
    pdf.setTextColor(201, 151, 77);  // brand gold
    pdf.text('Prickets', pageW / 2, 25, { align: 'center' });

    // Evento
    pdf.setFontSize(16);
    pdf.setTextColor(0, 0, 0);
    pdf.text(eventName || 'Evento', pageW / 2, 40, { align: 'center' });

    // QR Code grande (centrado)
    try {
      const qrDataUrl = await getQrPng(t.id);
      const qrSize = 100;
      pdf.addImage(qrDataUrl, 'PNG', (pageW - qrSize) / 2, 55, qrSize, qrSize);
    } catch (err) {
      console.error('Error renderizando QR:', err);
      pdf.setFontSize(12);
      pdf.setTextColor(200, 0, 0);
      pdf.text('Error: no se pudo renderizar el QR', pageW / 2, 100, { align: 'center' });
    }

    // Codigo del QR
    pdf.setFontSize(11);
    pdf.setTextColor(80, 80, 80);
    pdf.text(t.qr_code, pageW / 2, 168, { align: 'center' });

    // Asistente
    pdf.setFontSize(14);
    pdf.setTextColor(0, 0, 0);
    const fullName = `${t.buyer_name || ''} ${t.buyer_apellido || ''}`.trim();
    pdf.text(fullName, pageW / 2, 185, { align: 'center' });

    if (t.tipo_entrada) {
      pdf.setFontSize(11);
      pdf.setTextColor(120, 120, 120);
      pdf.text(`Tipo: ${t.tipo_entrada}`, pageW / 2, 195, { align: 'center' });
    }

    // Footer
    pdf.setFontSize(9);
    pdf.setTextColor(150, 150, 150);
    pdf.text(`Entrada ${i + 1} de ${tickets.length}`, pageW / 2, pageH - 20, { align: 'center' });
    if (promoterName) {
      pdf.text(`Vendido por: ${promoterName}`, pageW / 2, pageH - 14, { align: 'center' });
    }
    pdf.text('Conservá este QR — lo necesitás para ingresar', pageW / 2, pageH - 8, { align: 'center' });
  }

  const filename = `prickets-${(eventName || 'entradas').toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}.pdf`;
  pdf.save(filename);
}
