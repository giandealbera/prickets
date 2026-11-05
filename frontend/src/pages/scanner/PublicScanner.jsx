import { useEffect, useRef, useState, useCallback } from 'react';
import EntradaYaUsada from '../../components/EntradaYaUsada';
import { useParams } from 'react-router-dom';
import { startQrCamera, destroyQrScanner, pauseScanner, resumeScanner } from '../../lib/qrCamera';
import useWakeLock from '../../hooks/useWakeLock';
import { BACKEND_URL as BACKEND } from '../../api/config';

// Cuanto ignoramos el MISMO QR despues de procesarlo. Evita que la camara
// vuelva a leer el celular del cliente que todavia esta en el cuadro.
const REPEAT_LOCK_MS = 8000;

// Con una entrada VALIDA seguimos escaneando solos: el portero no tiene que
// tocar nada entre persona y persona. Es lo que mas acelera la fila real.
// Las invalidas NO se auto-despachan: quedan fijas hasta que las resuelva.
const AUTO_NEXT_MS = 1400;

// Patron de vibracion: corto = ok, doble largo = error. Sirve en la boca de
// un boliche ruidoso donde el portero no escucha bien el toast.
const VIBRATE_OK  = [40];
const VIBRATE_BAD = [60, 60, 120];
const buzz = (pattern) => {
  if (typeof navigator !== 'undefined' && navigator.vibrate) {
    try { navigator.vibrate(pattern); } catch { /* iOS Safari no soporta vibrate */ }
  }
};

const PublicScanner = () => {
  const { token } = useParams();
  // Mantiene la pantalla del portero prendida mientras el componente esta
  // montado. Sin esto se bloquea el celu cada 30s y se pierde el flow.
  useWakeLock(true);
  const [info,     setInfo]     = useState(null);
  const [error,    setError]    = useState(null);
  const [result,   setResult]   = useState(null);
  const [scanning, setScanning] = useState(false);
  const [camError, setCamError] = useState(null);
  const [needsTap, setNeedsTap] = useState(false);
  const scannerRef = useRef(null);
  // Guarda de reentrada: a 30 FPS la camara dispara el callback muchas veces
  // mientras el servidor todavia esta respondiendo.
  const busyRef = useRef(false);

  // Cargar info del escáner (evento y tipo de entrada)
  useEffect(() => {
    fetch(`${BACKEND}/scan/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) setError(data.error);
        else setInfo(data);
      })
      .catch(() => setError('No se pudo conectar al servidor'));
  }, [token]);

  const lastScannedCode = useRef('');
  const lastScannedTime = useRef(0);

  // Qué hacer cuando se lee un QR. Estable (solo depende del token).
  const handleDecoded = useCallback(async (decodedText) => {
    // Sin esta guarda salian varios POST en paralelo por la misma persona y
    // el resultado de uno pisaba al del otro.
    if (busyRef.current) return;

    let qr_code = decodedText;
    try {
      const parsed = JSON.parse(decodedText);
      qr_code = parsed.code || decodedText;
    } catch { /* plain text */ }

    const cleanCode = String(qr_code || '').toUpperCase().trim();
    if (!cleanCode) return;
    const now = Date.now();

    // Mismo QR recien procesado: ignorar en silencio.
    if (cleanCode === lastScannedCode.current && (now - lastScannedTime.current < REPEAT_LOCK_MS)) {
      return;
    }

    busyRef.current = true;
    lastScannedCode.current = cleanCode;
    lastScannedTime.current = now;
    // Dejamos de decodificar mientras verificamos contra el servidor: no
    // tiene sentido gastar CPU a 30 FPS con el cartel de resultado en pantalla.
    pauseScanner(scannerRef.current);

    setScanning(true);
    try {
      const res = await fetch(`${BACKEND}/scan/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qr_code }),
      });
      const data = await res.json();
      const ok = res.ok && data.valid;
      buzz(ok ? VIBRATE_OK : VIBRATE_BAD);
      setResult({ ok, data });
    } catch {
      // Cayo la RED, no el QR. Liberamos el bloqueo del codigo para que el
      // portero pueda reintentar la misma entrada en el acto; antes quedaba
      // mudo varios segundos y parecia que el escaner se habia colgado.
      lastScannedCode.current = '';
      buzz(VIBRATE_BAD);
      setResult({ ok: false, data: { error: 'Error de conexión. Reintentá.' } });
    } finally {
      setScanning(false);
      busyRef.current = false;
    }
  }, [token]);

  // Auto-continuar tras una entrada valida: limpiamos el cartel solo y la
  // fila sigue. Si es invalida queda en pantalla hasta que el portero la
  // despache a mano (necesita atencion).
  useEffect(() => {
    if (!result?.ok) return;
    const t = setTimeout(() => setResult(null), AUTO_NEXT_MS);
    return () => clearTimeout(t);
  }, [result]);

  // Sin cartel en pantalla, volvemos a decodificar.
  useEffect(() => {
    if (result) return;
    resumeScanner(scannerRef.current);
  }, [result]);

  // Arranca la cámara trasera con la API de bajo nivel Html5Qrcode (no el
  // widget): sin botón "Request Camera Permission" en inglés ni selector.
  // Si el navegador exige un toque del usuario para abrir la cámara, dejamos
  // needsTap=true y mostramos un botón EN ESPAÑOL para reintentar.
  // Marca si el componente sigue montado. Sin esto, un arranque que termina
  // DESPUES de desmontar (React monta y desmonta dos veces en desarrollo)
  // deja una camara prendida sin dueño.
  const montadoRef = useRef(true);
  // Candado de arranque: evita dos aperturas de camara simultaneas.
  const arrancandoRef = useRef(false);

  const startCamera = useCallback(async () => {
    // Candado: si ya hay un arranque en curso, no largamos otro. Sin esto, el
    // arranque automatico y un toque en "Activar camara" corrian a la vez,
    // creaban DOS instancias y quedaban dos camaras prendidas con dos
    // previews apilados.
    if (arrancandoRef.current) return;
    arrancandoRef.current = true;
    setCamError(null);
    try {
      // Descartamos la instancia previa antes de reintentar: una instancia con
      // un start() fallido queda trabada y contagia el error a todo lo demas.
      const previa = scannerRef.current;
      scannerRef.current = null;
      await destroyQrScanner(previa);

      const { ok, error, scanner } = await startQrCamera({
        elementId: 'qr-reader',
        onDecoded: handleDecoded,
      });

      if (!montadoRef.current) { await destroyQrScanner(scanner); return; }
      scannerRef.current = scanner || null;
      setNeedsTap(!ok);
      setCamError(ok ? null : error);
    } finally {
      arrancandoRef.current = false;
    }
  }, [handleDecoded]);

  // Montar/desmontar el escáner cuando ya tenemos la info del evento.
  useEffect(() => {
    if (!info) return;
    montadoRef.current = true;
    startCamera();
    return () => {
      montadoRef.current = false;
      const s = scannerRef.current;
      scannerRef.current = null;
      destroyQrScanner(s);
    };
  }, [info, startCamera]);

  // Soltamos la camara cuando la pantalla pasa a segundo plano y la
  // reabrimos al volver. Sin esto, si el escaner queda abierto en dos lados
  // a la vez (una pestaña del navegador y la app instalada, o dos pestañas),
  // los dos retienen la camara: el celular queda con dos capturas activas y
  // el preview se ve raro o duplicado. Ademas deja de gastar bateria cuando
  // el portero cambia de app.
  useEffect(() => {
    if (!info) return;
    const alCambiarVisibilidad = () => {
      if (document.hidden) {
        const s = scannerRef.current;
        scannerRef.current = null;
        destroyQrScanner(s);
      } else if (montadoRef.current && !scannerRef.current) {
        startCamera();
      }
    };
    document.addEventListener('visibilitychange', alCambiarVisibilidad);
    return () => document.removeEventListener('visibilitychange', alCambiarVisibilidad);
  }, [info, startCamera]);

  const fmt = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('es-AR', { day: 'numeric', month: 'long' }) : '';
  const ticket = result?.data?.ticket;

  if (error) return (
    <div className="min-h-dvh bg-gray-950 flex items-center justify-center p-6">
      <div className="text-center">
        <div className="inline-flex items-center justify-center w-14 h-14 rounded-full mb-4"
             style={{ background: 'rgba(185,28,28,0.10)', border: '1px solid rgba(185,28,28,0.35)', color: '#FCA5A5' }}>
          <svg className="w-7 h-7" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
          </svg>
        </div>
        <p className="text-red-400 text-base font-semibold">{error}</p>
        <p className="text-gray-500 mt-1.5 text-sm">Este link es inválido o fue desactivado</p>
      </div>
    </div>
  );

  if (!info) return (
    <div className="min-h-dvh bg-gray-950 flex items-center justify-center">
      <div className="animate-spin rounded-full h-10 w-10 border-t-2 border-brand" />
    </div>
  );

  return (
    <div className="min-h-dvh bg-gray-950 text-white">
      {/* Header */}
      <div className="bg-gray-900 border-b border-gray-800 px-4 py-4 text-center">
        <p className="text-xl font-black tracking-tight mb-2" style={{ color: '#C9974D' }}>Prickets</p>
        <p className="text-xs text-gray-400 uppercase tracking-widest mb-0.5">{info.event_name}</p>
        <h1 className="text-xl font-bold text-brand">
          {info.label || info.ticket_type_name}
        </h1>
        {info.event_date && (
          <p className="text-xs text-gray-500 mt-0.5">{fmt(info.event_date)}</p>
        )}
      </div>

      <div className="px-4 py-6 max-w-md mx-auto">
        {/* Resultado del escaneo */}
        {result && (
          <div className={`rounded-2xl border-2 p-6 mb-6 text-center transition-all ${
            result.ok ? 'border-green-500 bg-green-900/20' : 'border-red-500 bg-red-900/20'
          }`}>
            <div className={`w-16 h-16 rounded-full mx-auto flex items-center justify-center mb-3 ${result.ok ? 'bg-green-900/30 border border-green-700/50' : 'bg-red-900/30 border border-red-700/50'}`}>
              <svg className={`w-9 h-9 ${result.ok ? 'text-green-400' : 'text-red-400'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                {result.ok
                  ? <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                  : <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />}
              </svg>
            </div>
            {result.ok ? (
              <div className="my-2">
                <h2 className="text-3xl font-black text-green-400 mb-2 tracking-tight">VÁLIDA</h2>
                {ticket && (
                  <p className="text-xl font-bold text-white">
                    {ticket.buyer_name} {ticket.buyer_apellido || ''}
                  </p>
                )}
              </div>
            ) : (
              <div>
                <h2 className="text-2xl font-black text-red-400 mb-2">ENTRADA INVÁLIDA</h2>
                {result.data?.error && (
                  <p className="text-red-300 text-base font-medium mb-2">{result.data.error}</p>
                )}
                {ticket && ticket.status === 'usado' && (
                  <EntradaYaUsada ticket={ticket} miPuerta={info?.label} />
                )}
              </div>
            )}
            <button onClick={() => { lastScannedCode.current = ''; setResult(null); }}
              className="mt-4 w-full py-3 rounded-xl bg-brand text-black font-semibold text-sm hover:opacity-90 transition-opacity">
              ➡️ Escanear siguiente entrada
            </button>
          </div>
        )}

        {/* Cámara: SIEMPRE montada (aunque haya un resultado encima) para no
            cortar el stream — si se desmonta, html5-qrcode pierde el video y
            re-pide permiso. La ocultamos con display mientras se ve el cartel. */}
        <div className="card mb-4" style={{ display: result ? 'none' : 'block' }}>
          <p className="text-sm text-gray-400 text-center mb-4">Apuntá la cámara al QR de la entrada</p>
          <div id="qr-reader" className="rounded-xl overflow-hidden" />
          {needsTap && (
            <button onClick={startCamera}
              className="mt-4 w-full py-3 rounded-xl bg-brand text-black font-semibold text-sm inline-flex items-center justify-center gap-2">
              {/* SVG inline para no agregar import a este chunk publico. */}
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9zM12 17a4 4 0 100-8 4 4 0 000 8z" />
              </svg>
              Activar cámara
            </button>
          )}
          {camError && (
            <p className="text-center text-red-400 text-sm mt-3">{camError}</p>
          )}
          {scanning && (
            <p className="text-center text-brand text-sm mt-3 animate-pulse">Verificando...</p>
          )}
        </div>

        <p className="text-center text-xs text-gray-600">
          Solo para <strong className="text-gray-500">{info.ticket_type_name}</strong> · {info.event_name}
        </p>
      </div>
    </div>
  );
};

export default PublicScanner;
