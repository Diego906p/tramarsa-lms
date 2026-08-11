/* ============================================================
   TRAMARSA LMS — Reproductor de módulos
   El archivo .zip/.rar y la plantilla de certificado ya no salen de
   IndexedDB: se descargan desde su URL pública en GitHub
   (modulo.archivoUrl / modulo.certificadoUrl, subidas al guardar el
   módulo en el panel admin). El progreso (historial) vive en
   Firestore.
   ============================================================ */

import { getSesion, nombreCompleto, escaparHtml, renderDashboardTrabajador, mostrarCargando, ocultarCargando, toast } from './app.js';
import * as DB from './db-firestore.js';
import { archivoAJSZip } from './modulo-loader/package-adapters.js';
import { buscarIndexHtml } from './modulo-loader/virtual-asset-resolver.js';
import { seleccionarDriver, desbloquearAudioLaminas } from './modulo-loader/drivers.js';
import { descargarArchivoPrivado } from './github-storage.js';

const RP = {
  moduloId: null,
  modulo: null,
  zip: null,
  driver: null,           // instancia del driver ganador (ver modulo-loader/drivers.js)
  destructorDriver: null,
  modoRevision: false,    // módulo ya COMPLETADO: "Volver a ver" no re-evalúa ni reescribe el historial
  progresoFinalizado: false, // true en la pantalla de certificado/resultado aprobado: el progreso YA está guardado, salir no debe preguntar nada
  preguntas: [],
  indicePregunta: 0,
  respuestasCorrectas: 0,
  timerInterval: null,
  tiempoPorPregunta: 30, // segundos
  urlsTemporales: [], // para revocar blob URLs al salir
  alSalir: null // función a la que volver al cerrar (por defecto, Inicio)
};

// Nombre del PDF/PNG descargado: aaaa-mm-dd_nombres_apellidos_m{numero}.
// La fecha es siempre la de emisión (primera aprobación), nunca la del
// día en que se vuelve a descargar.
const RANGO_DIACRITICOS = new RegExp('[' + String.fromCharCode(0x0300) + '-' + String.fromCharCode(0x036f) + ']', 'g');
function limpiarParaArchivo(texto) {
  return (texto || '')
    .normalize('NFD').replace(RANGO_DIACRITICOS, '') // quita tildes
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function nombreArchivoCertificado(usuario, modulo, fechaEmisionISO) {
  const fecha = new Date(fechaEmisionISO || Date.now());
  const aaaa = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  const nombres = limpiarParaArchivo([usuario.primerNombre, usuario.segundoNombre].filter(Boolean).join(' '));
  const apellidos = limpiarParaArchivo([usuario.apellidoPaterno, usuario.apellidoMaterno].filter(Boolean).join(' '));
  const numero = (modulo && modulo.numeroModulo) || (modulo && modulo.id);
  return `${aaaa}-${mm}-${dd}_${nombres}_${apellidos}_m${numero}`;
}

// Progreso parcial (avancePct) del intento EN_PROGRESO actual, para que
// "Mis módulos"/"Mi progreso" puedan mostrar cuánto llevaba el trabajador
// aunque haya salido antes de terminar.
async function guardarAvanceHistorial(pasoActual, totalPasos) {
  if (!totalPasos) return;
  const usuario = getSesion();
  const hist = await DB.obtenerHistorialRegistro(usuario.dni, RP.moduloId);
  if (!hist || hist.estado !== 'EN_PROGRESO') return;
  const pct = Math.max(hist.avancePct || 0, Math.min(99, Math.round((pasoActual / totalPasos) * 100)));
  // pasoMaximoAlcanzado (0-based) es lo que permite reanudar exactamente
  // donde quedó y navegar libre hasta ahí sin volver a exigir el audio
  // completo (ver drivers.js). Nunca decrece: retroceder no lo pisa.
  const pasoMaximoAlcanzado = Math.max(hist.pasoMaximoAlcanzado || 0, pasoActual - 1);
  const cambios = {};
  if (pct !== hist.avancePct) cambios.avancePct = pct;
  if (pasoMaximoAlcanzado !== (hist.pasoMaximoAlcanzado || 0)) cambios.pasoMaximoAlcanzado = pasoMaximoAlcanzado;
  if (Object.keys(cambios).length) await DB.actualizarHistorial(usuario.dni, RP.moduloId, cambios);
}

let vimeoSdkPromise = null;
function cargarVimeoSdk() {
  if (window.Vimeo && window.Vimeo.Player) return Promise.resolve();
  if (vimeoSdkPromise) return vimeoSdkPromise;
  vimeoSdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://player.vimeo.com/api/player.js';
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return vimeoSdkPromise;
}

// Los registros nuevos guardan una ruta privada; las URLs antiguas se leen
// solo como compatibilidad durante la migración de datos.
async function descargarArchivoDesdeUrl(ruta, nombre, tipo = 'archivo') {
  const usuario = getSesion();
  return descargarArchivoPrivado(ruta, nombre, {
    moduloId: RP.moduloId,
    usuarioId: usuario && usuario.dni,
    tipo
  });
}

async function abrirReproductor(moduloId) {
  // PRIMERA línea, antes de cualquier await: desbloquea el elemento Audio
  // compartido mientras el click del usuario sigue vigente. La descarga
  // del zip puede tardar varios segundos y el navegador ya no aceptaría
  // audio.play() con el gesto expirado — con el elemento desbloqueado,
  // la primera lámina arranca sonando sin pantalla "Iniciar módulo".
  desbloquearAudioLaminas();
  RP.moduloId = moduloId;
  RP.modulo = await DB.obtenerModulo(moduloId);
  if (!RP.modulo) return;

  document.getElementById('viewReproductor').classList.remove('hidden');
  document.getElementById('reproductorTitulo').textContent = RP.modulo.nombre;
  document.getElementById('reproductorPaso').textContent = 'Cargando módulo...';
  mostrarCargandoReproductor();

  try {
    // Marca el inicio en el historial (si no existe ningún registro todavía).
    // Si el módulo ya está COMPLETADO, no se crea un intento nuevo: el modo
    // "Revisar" solo permite ver el contenido, no reabre la evaluación como
    // pendiente ni pisa el registro de aprobación ya guardado.
    const usuario = getSesion();
    if (!usuario || !usuario.dni) throw new Error('La sesión no contiene un DNI válido. Vuelve a iniciar sesión.');
    await DB.crearHistorialSiNoExiste(usuario.dni, moduloId, {
      estado: 'EN_PROGRESO', puntaje: null, avancePct: 0, fechaInicio: new Date().toISOString(), fechaFin: null
    });

    if (!RP.modulo.archivoUrl) {
      renderReproductorError('Este módulo no tiene un archivo .zip o .rar cargado todavía. Contacta al administrador.');
      return;
    }

    const archivo = await descargarArchivoDesdeUrl(RP.modulo.archivoUrl, RP.modulo.archivoNombre);
    RP.zip = await archivoAJSZip(archivo);
    await montarDriverDelModulo();
  } catch (e) {
    console.error('No se pudo iniciar el módulo:', e);
    const mensaje = e instanceof Error && e.message ? e.message : 'Error desconocido al iniciar el módulo.';
    renderReproductorError(`No se pudo cargar el módulo: ${mensaje}`);
  }
}

// El núcleo nunca pregunta "¿qué tipo de módulo es esto?": selecciona el
// primer driver de modulo-loader/drivers.js que reconozca el paquete y le
// delega todo lo visual. El único contrato que el driver le devuelve al
// núcleo son dos eventos (avance parcial / finalizado) — el resto de la
// lógica académica (Firestore, evaluación, certificado) sigue aquí mismo.
async function montarDriverDelModulo() {
  const driver = seleccionarDriver(RP.zip);
  if (!driver) {
    // Ningún driver reconoce el paquete (ni siquiera contiene index.html):
    // no hay contenido reproducible, pasa directo a evaluación/cierre.
    await prepararEvaluacionOFinalizar();
    return;
  }
  RP.driver = driver;
  const rutaIndex = buscarIndexHtml(RP.zip);
  const contenedor = document.getElementById('reproductorBody');
  contenedor.innerHTML = '';

  // Reanudar exactamente donde quedó: el driver arranca en pasoInicial y
  // permite navegar libre hasta ahí sin volver a exigir el audio completo.
  // Si el módulo ya está COMPLETADO (modo "Volver a ver"), la navegación
  // es totalmente libre y al terminar NO se re-evalúa ni se toca el
  // historial: se vuelve a mostrar el resultado/certificado ya obtenido.
  const usuario = getSesion();
  const hist = await DB.obtenerHistorialRegistro(usuario.dni, RP.moduloId);
  RP.modoRevision = !!(hist && hist.estado === 'COMPLETADO');
  const pasoInicial = RP.modoRevision ? 0 : ((hist && hist.pasoMaximoAlcanzado) || 0);

  RP.destructorDriver = await driver.montar(contenedor, RP.zip, rutaIndex, {
    onAvance: (paso, total) => guardarAvanceHistorial(paso, total),
    onFinalizado: () => prepararEvaluacionOFinalizar()
  }, RP.urlsTemporales, pasoInicial, RP.modoRevision, { color: RP.modulo.color, moduloId: RP.moduloId });
}

function mostrarCargandoReproductor() {
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card" style="text-align:center;">
      <i data-lucide="loader-circle" size="32" class="spin"></i>
      <p style="margin-top:12px;color:var(--gray-500);">Cargando módulo...</p>
    </div>`;
  lucide.createIcons();
}

function renderReproductorError(mensaje) {
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card" style="text-align:center;">
      <i data-lucide="alert-triangle" size="32" style="color:var(--orange-500);"></i>
      <p style="margin-top:12px;color:var(--gray-700);">${escaparHtml(mensaje)}</p>
      <button class="btn-save" style="margin-top:16px;" onclick="cerrarReproductor()">Cerrar</button>
    </div>`;
  lucide.createIcons();
}

async function leerJsonDelZip(ruta) {
  const entry = RP.zip.file(ruta);
  if (!entry) return null;
  try {
    const texto = await entry.async('text');
    return JSON.parse(texto);
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------
// Todo lo visual (láminas img+audio, iframe con index.html propio del
// módulo, etc.) vive en modulo-loader/drivers.js — ver montarDriverDelModulo()
// más arriba. Lo que sigue es exclusivamente lógica académica: evaluación,
// aprobación y certificado.
// ---------------------------------------------------------------
// Evaluación: banco de preguntas aleatorio, secuencial, sin retroceder
// ---------------------------------------------------------------
async function prepararEvaluacionOFinalizar() {
  // Modo "Volver a ver": el módulo ya está aprobado — es solo repaso de
  // contenido, no una evaluación real. Al llegar al final no se vuelve a
  // generar el cuestionario ni se re-muestra la pantalla de resultado o
  // certificado (ya se vieron/descargaron desde Certificados si hacía
  // falta) — pero cerrar de inmediato sin aviso se sentía abrupto, así
  // que se muestra una pantalla corta de agradecimiento antes de volver.
  if (RP.modoRevision) {
    renderAgradecimientoRevision();
    return;
  }

  const banco = (RP.modulo.preguntas && RP.modulo.preguntas.length) ? RP.modulo.preguntas : await leerJsonDelZip('questions.json');

  if (!banco || !Array.isArray(banco) || banco.length === 0) {
    await finalizarModulo(null);
    return;
  }

  const CANTIDAD_PREGUNTAS = Math.min(5, banco.length);
  const seleccionadas = mezclarArray([...banco]).slice(0, CANTIDAD_PREGUNTAS);

  RP.preguntas = seleccionadas.map(p => ({
    enunciado: p.enunciado,
    alternativas: mezclarArray([...p.alternativas])
  }));
  RP.indicePregunta = 0;
  RP.respuestasCorrectas = 0;

  renderPasoPregunta();
}

// Pantalla corta al llegar al final de una sesión "Volver a ver" — no hay
// evaluación ni certificado que mostrar de nuevo, pero cerrar en seco se
// sentía abrupto para el usuario.
function renderAgradecimientoRevision() {
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado" style="text-align:center;">
      <i data-lucide="check-circle-2" size="40" style="color:var(--green-500);margin-bottom:10px;"></i>
      <h2 style="font-size:1.2rem;font-weight:800;color:var(--navy-900);margin-bottom:6px;">Gracias por volver a ver el módulo.</h2>
      <button class="btn-save" style="margin-top:10px;" onclick="cerrarReproductor()">Salir</button>
    </div>
  `;
  lucide.createIcons();
}

function mezclarArray(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function renderPasoPregunta() {
  clearInterval(RP.timerInterval);
  const total = RP.preguntas.length;
  const pregunta = RP.preguntas[RP.indicePregunta];
  document.getElementById('reproductorPaso').textContent = `Evaluación — Pregunta ${RP.indicePregunta + 1} de ${total}`;

  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <span class="rp-pregunta-num">Pregunta ${RP.indicePregunta + 1} de ${total}</span>
        <span class="rp-timer"><i data-lucide="clock" size="14"></i> <span id="tiempoRestante">${RP.tiempoPorPregunta}</span>s</span>
      </div>
      <div class="rp-pregunta-texto">${escaparHtml(pregunta.enunciado)}</div>
      <div id="listaAlternativas">
        ${pregunta.alternativas.map((a, i) => `
          <div class="rp-alternativa" data-index="${i}" onclick="seleccionarAlternativa(${i})">
            ${escaparHtml(a.texto)}
          </div>
        `).join('')}
      </div>
    </div>
  `;
  lucide.createIcons();

  let tiempo = RP.tiempoPorPregunta;
  RP.timerInterval = setInterval(() => {
    tiempo--;
    const span = document.getElementById('tiempoRestante');
    if (span) span.textContent = tiempo;
    if (tiempo <= 0) {
      clearInterval(RP.timerInterval);
      seleccionarAlternativa(-1);
    }
  }, 1000);
}

function seleccionarAlternativa(indice) {
  clearInterval(RP.timerInterval);
  const pregunta = RP.preguntas[RP.indicePregunta];
  const elementos = document.querySelectorAll('.rp-alternativa');
  elementos.forEach(el => el.style.pointerEvents = 'none');

  const indiceCorrecta = pregunta.alternativas.findIndex(a => a.esCorrecta);
  if (indice === indiceCorrecta) RP.respuestasCorrectas++;

  if (elementos[indiceCorrecta]) elementos[indiceCorrecta].classList.add('correcta');
  if (indice >= 0 && indice !== indiceCorrecta && elementos[indice]) elementos[indice].classList.add('incorrecta');

  setTimeout(() => {
    if (RP.indicePregunta < RP.preguntas.length - 1) {
      RP.indicePregunta++;
      renderPasoPregunta();
    } else {
      const puntaje = Math.round((RP.respuestasCorrectas / RP.preguntas.length) * 100);
      finalizarModulo(puntaje);
    }
  }, 1200);
}

// ---------------------------------------------------------------
// Resultado + certificado
// ---------------------------------------------------------------
const UMBRAL_APROBACION = 70;

async function finalizarModulo(puntaje) {
  const usuario = getSesion();
  const aprobado = puntaje === null || puntaje >= UMBRAL_APROBACION;

  // Defensa extra: en modo revisión jamás se reescribe el historial (la
  // fecha de emisión del certificado es la de la PRIMERA aprobación).
  if (RP.modoRevision) { await renderResultadoAprobado(puntaje); return; }

  if (aprobado) {
    await DB.actualizarHistorial(usuario.dni, RP.moduloId, {
      estado: 'COMPLETADO', puntaje, avancePct: 100, fechaFin: new Date().toISOString()
    });
    await renderResultadoAprobado(puntaje);
  } else {
    // el intento fallido queda registrado, pero sigue EN_PROGRESO para reintentar
    renderResultadoDesaprobado(puntaje);
  }
}

async function renderResultadoAprobado(puntaje) {
  document.getElementById('reproductorPaso').textContent = '';
  // A partir de acá el progreso YA está guardado en Firestore (COMPLETADO):
  // salir con la X de arriba no debe preguntar "¿tu avance no se guardará?"
  // — eso ya no aplica, es mentira en esta pantalla.
  RP.progresoFinalizado = true;
  const usuario = getSesion();

  // Presentación tipo diploma: solo el mensaje arriba, el certificado
  // grande y centrado como protagonista, y 2 botones abajo (Descargar /
  // Volver al inicio) — sin visor PDF ni barras de herramientas.
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado rp-resultado-cert">
      <h2 style="font-size:1.3rem;font-weight:800;color:var(--navy-900);margin-bottom:4px;">¡Módulo completado!${puntaje !== null ? ` Obtuviste ${puntaje}% en la evaluación.` : ''}</h2>
      <div id="certContainer"></div>
      <div id="certAcciones" style="display:flex;gap:12px;justify-content:center;margin-top:14px;">
        <button class="btn-save" onclick="cerrarReproductor()">Volver al inicio</button>
      </div>
    </div>
  `;
  lucide.createIcons();

  // La fecha de emisión del certificado es la de la primera aprobación
  // (hist.fechaFin), no la fecha en la que se vuelve a ver/descargar.
  const hist = await DB.obtenerHistorialRegistro(usuario.dni, RP.moduloId);
  await intentarGenerarCertificado(usuario, hist ? hist.fechaFin : new Date().toISOString());
}

function renderResultadoDesaprobado(puntaje) {
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado">
      <div class="icon-grande" style="background:var(--red-100);color:var(--red-500);"><i data-lucide="x" size="34"></i></div>
      <h2 style="font-size:1.3rem;font-weight:800;color:var(--navy-900);margin-bottom:6px;">No alcanzaste el puntaje mínimo</h2>
      <p style="color:var(--gray-500);font-size:.9rem;">Obtuviste ${puntaje}%. Necesitas al menos ${UMBRAL_APROBACION}% para aprobar. Vuelve a intentarlo con nuevas preguntas.</p>
      <div style="display:flex;gap:10px;justify-content:center;margin-top:18px;">
        <button class="btn-cancel" onclick="cerrarReproductor()">Salir</button>
        <button class="btn-save" onclick="prepararEvaluacionOFinalizar()">Reintentar evaluación</button>
      </div>
    </div>
  `;
  lucide.createIcons();
}

// Ubica en el PDF (vía pdf.js) la posición exacta de cada texto placeholder,
// para poder cubrirlo y redibujar el valor real encima sin mover nada más.
async function localizarTextosEnPdf(bytes, textosBuscados) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
  const pagina = await pdf.getPage(1);
  const contenido = await pagina.getTextContent();
  const encontrados = {};
  for (const item of contenido.items) {
    const texto = item.str.trim();
    if (!texto) continue;
    for (const buscado of textosBuscados) {
      if (texto === buscado) {
        const [a, b, , , e, f] = item.transform;
        if (!encontrados[buscado]) encontrados[buscado] = [];
        encontrados[buscado].push({ x: e, y: f, width: item.width, height: item.height || Math.hypot(a, b) || 14 });
      }
    }
  }
  return encontrados;
}

// Renderiza la primera página de un PDF (bytes) como imagen PNG, para
// mostrar el certificado como un diploma limpio en vez del visor PDF.
async function renderizarPdfComoImagen(bytes) {
  try {
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    // copia: pdf.js transfiere (y vacía) el buffer que recibe
    const pdf = await pdfjsLib.getDocument({ data: bytes.slice() }).promise;
    const pagina = await pdf.getPage(1);
    const base = pagina.getViewport({ scale: 1 });
    const escala = Math.min(3, 1600 / base.width); // nítido sin exagerar memoria
    const viewport = pagina.getViewport({ scale: escala });
    const canvas = document.createElement('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await pagina.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
    return canvas.toDataURL('image/png');
  } catch (e) {
    console.error('No se pudo renderizar el certificado como imagen:', e);
    return null;
  }
}

// Genera los bytes del PDF final con los campos dinámicos reemplazados
// (negrita, centrados sobre su misma posición). Pura: no toca RP ni el
// DOM — la usan tanto el reproductor (con su propia UI de resultado)
// como la descarga directa que dispara el admin desde Usuarios.
// Devuelve null si la plantilla no contiene ninguno de los placeholders.
async function generarBytesPdfCertificado(usuario, modulo, fechaEmisionISO) {
  const nombreUsuario = nombreCompleto(usuario).toUpperCase();
  const nombreModulo = (modulo.nombre || '').toUpperCase();
  const fechaTexto = new Date(fechaEmisionISO || Date.now()).toLocaleDateString('es-PE', { day: '2-digit', month: 'long', year: 'numeric' });

  const reemplazos = {
    'NOMBRES APELLIDOS': nombreUsuario,
    'MÓDULO': nombreModulo,
    'MODULO': nombreModulo,
    'FECHA': fechaTexto,
    'DD de MM del AAAAA': fechaTexto
  };

  const certArchivo = await descargarArchivoDesdeUrl(modulo.certificadoUrl, modulo.certificadoNombre, 'certificado');
  const bytes = new Uint8Array(await certArchivo.arrayBuffer());
  // pdf.js toma posesión (transferable) del ArrayBuffer que recibe y lo deja
  // vacío; se le pasa una copia para no perder los bytes que pdf-lib
  // necesita justo después.
  const posiciones = await localizarTextosEnPdf(bytes.slice(), Object.keys(reemplazos));

  const pdfDoc = await PDFLib.PDFDocument.load(bytes);
  const pagina = pdfDoc.getPages()[0];
  // Arial no es una fuente base embebible en el navegador sin licenciar el
  // archivo TTF; Helvetica es el sustituto estándar métricamente compatible.
  // Los campos dinámicos van en negrita para destacar sobre la plantilla.
  const fuente = await pdfDoc.embedFont(PDFLib.StandardFonts.HelveticaBold);

  let algunReemplazo = false;
  for (const [placeholder, valor] of Object.entries(reemplazos)) {
    const ocurrencias = posiciones[placeholder];
    if (!ocurrencias || !ocurrencias.length) continue;
    for (const pos of ocurrencias) {
      algunReemplazo = true;
      const tamanoFuente = Math.max(8, (pos.height || 14) * 0.82);
      pagina.drawRectangle({ x: pos.x - 3, y: pos.y - 3, width: pos.width + 6, height: (pos.height || 14) + 6, color: PDFLib.rgb(1, 1, 1) });
      const anchoTexto = fuente.widthOfTextAtSize(valor, tamanoFuente);
      const centroX = pos.x + pos.width / 2;
      pagina.drawText(valor, { x: centroX - anchoTexto / 2, y: pos.y, size: tamanoFuente, font: fuente, color: PDFLib.rgb(0.024, 0.149, 0.314) });
    }
  }

  if (!algunReemplazo) return null;
  return pdfDoc.save();
}

// Certificado en PDF editable: cubre los placeholders "NOMBRES APELLIDOS",
// "MÓDULO" y la fecha con un rectángulo blanco y dibuja el valor real
// centrado en su misma posición, sin alterar el resto del diseño.
async function intentarGenerarCertificado(usuario, fechaEmisionISO) {
  mostrarCargando('Generando certificado...');
  if (!RP.modulo.certificadoUrl) {
    await intentarGenerarCertificadoLegacyPNG(usuario, fechaEmisionISO);
    ocultarCargando();
    return;
  }

  try {
    const bytesFinal = await generarBytesPdfCertificado(usuario, RP.modulo, fechaEmisionISO);
    if (!bytesFinal) {
      ocultarCargando();
      document.getElementById('certContainer').innerHTML = `<p style="font-size:.8rem;color:var(--orange-500);margin-top:14px;">La plantilla de certificado no contiene los textos "NOMBRES APELLIDOS" / "MÓDULO" / fecha, no se pudo personalizar.</p>`;
      return;
    }

    const blobFinal = new Blob([bytesFinal], { type: 'application/pdf' });
    const url = URL.createObjectURL(blobFinal);
    RP.urlsTemporales.push(url);

    // Presentación tipo diploma: se renderiza la página del PDF final a
    // una imagen (pdf.js → canvas) en vez de incrustar el visor PDF del
    // navegador (fondo negro, toolbar de zoom/impresión, panel lateral).
    const imgDiploma = await renderizarPdfComoImagen(bytesFinal);
    document.getElementById('certContainer').innerHTML = imgDiploma
      ? `<img src="${imgDiploma}" class="cert-diploma" alt="Certificado">`
      : `<p style="font-size:.8rem;color:var(--gray-500);margin-top:14px;">Certificado generado. Usa el botón para descargarlo.</p>`;

    const botonDescargar = `
      <a href="${url}" download="${nombreArchivoCertificado(usuario, RP.modulo, fechaEmisionISO)}.pdf" class="btn-save" style="text-decoration:none;display:inline-flex;align-items:center;gap:7px;">
        <i data-lucide="download" size="15"></i> Descargar certificado
      </a>`;
    const acciones = document.getElementById('certAcciones');
    if (acciones) acciones.insertAdjacentHTML('afterbegin', botonDescargar);
    else document.getElementById('certContainer').insertAdjacentHTML('beforeend', `<div style="display:flex;justify-content:center;margin-top:12px;">${botonDescargar}</div>`);
    lucide.createIcons();
    ocultarCargando();
    toast('exito', 'Certificado generado correctamente.');
  } catch (e) {
    console.error('No se pudo generar el certificado PDF:', e);
    ocultarCargando();
    toast('error', 'No se pudo generar el certificado en PDF.');
    document.getElementById('certContainer').innerHTML = `<p style="font-size:.8rem;color:var(--red-500);margin-top:14px;">No se pudo generar el certificado en PDF.</p>`;
  }
}

// Descarga directa del certificado, usada por el admin desde Usuarios
// (no abre el reproductor ni el panel de resultado: solo genera el PDF
// con la fecha de emisión ya registrada en el historial y lo descarga).
export async function descargarCertificadoAdmin(usuario, modulo, fechaEmisionISO) {
  if (!modulo.certificadoUrl) throw new Error('Este módulo no tiene una plantilla de certificado cargada.');
  const bytesFinal = await generarBytesPdfCertificado(usuario, modulo, fechaEmisionISO);
  if (!bytesFinal) throw new Error('La plantilla de certificado no contiene los campos esperados.');
  const blob = new Blob([bytesFinal], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${nombreArchivoCertificado(usuario, modulo, fechaEmisionISO)}.pdf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// Compatibilidad: módulos antiguos que traían certificate/template.png +
// layout.json dentro del propio .zip.
async function intentarGenerarCertificadoLegacyPNG(usuario, fechaEmisionISO) {
  const templateEntry = RP.zip && (RP.zip.file('certificate/template.png') || RP.zip.file('certificate/template.jpg'));

  if (!templateEntry) {
    document.getElementById('certContainer').innerHTML = `<p style="font-size:.8rem;color:var(--gray-500);margin-top:14px;">Este módulo no incluye plantilla de certificado.</p>`;
    return;
  }
  const layoutJson = await leerJsonDelZip('certificate/layout.json');

  const layout = layoutJson || { x: 500, y: 350, fontSize: 42, color: '#061E4E', fontFamily: 'Inter, sans-serif' };
  const blob = await templateEntry.async('blob');
  const url = URL.createObjectURL(blob);
  RP.urlsTemporales.push(url);

  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    ctx.font = `${layout.fontSize || 42}px ${layout.fontFamily || 'Inter, sans-serif'}`;
    ctx.fillStyle = layout.color || '#061E4E';
    ctx.textAlign = layout.align || 'center';
    ctx.fillText(nombreCompleto(usuario), layout.x || canvas.width/2, layout.y || canvas.height/2);

    if (layout.fechaX !== undefined) {
      ctx.font = `${layout.fechaFontSize || 18}px ${layout.fontFamily || 'Inter, sans-serif'}`;
      ctx.fillText(new Date(fechaEmisionISO || Date.now()).toLocaleDateString('es-PE'), layout.fechaX, layout.fechaY || (layout.y + 40));
    }

    const dataUrl = canvas.toDataURL('image/png');
    document.getElementById('certContainer').innerHTML = `
      <img src="${dataUrl}" class="rp-cert-preview" alt="Certificado">
      <a href="${dataUrl}" download="${nombreArchivoCertificado(usuario, RP.modulo, fechaEmisionISO)}.png" class="btn-outline" style="text-decoration:none;justify-content:center;display:flex;">
        <i data-lucide="download" size="15"></i>&nbsp; Descargar certificado
      </a>
    `;
    lucide.createIcons();
  };
  img.src = url;
}

// ---------------------------------------------------------------
// Certificado fuera del flujo del reproductor (desde "Mis módulos" o
// "Certificados").
// ---------------------------------------------------------------
async function verCertificadoStandalone(moduloId, alVolver) {
  const usuario = getSesion();
  const [modulo, hist] = await Promise.all([DB.obtenerModulo(moduloId), DB.obtenerHistorialRegistro(usuario.dni, moduloId)]);
  if (!modulo || !hist || hist.estado !== 'COMPLETADO') return;

  RP.modulo = modulo;
  RP.moduloId = moduloId;
  RP.zip = null;
  RP.urlsTemporales = RP.urlsTemporales || [];
  RP.alSalir = alVolver || null;
  RP.progresoFinalizado = true; // ver un certificado ya emitido: nada que perder al salir

  document.getElementById('viewReproductor').classList.remove('hidden');
  document.getElementById('reproductorTitulo').textContent = modulo.nombre;
  document.getElementById('reproductorPaso').textContent = '';
  document.getElementById('reproductorBody').innerHTML = `
    <div class="rp-card rp-resultado rp-resultado-cert">
      <h2 style="font-size:1.3rem;font-weight:800;color:var(--navy-900);margin-bottom:4px;">${modulo.nombre}</h2>
      <div id="certContainer"></div>
      <div id="certAcciones" style="display:flex;gap:12px;justify-content:center;margin-top:14px;">
        <button class="btn-cancel" onclick="cerrarReproductor()">Cerrar</button>
      </div>
    </div>`;
  lucide.createIcons();
  await intentarGenerarCertificado(usuario, hist.fechaFin);
}

function cerrarReproductor() {
  if (document.fullscreenElement) document.exitFullscreen();
  clearInterval(RP.timerInterval);
  if (RP.destructorDriver) RP.destructorDriver();
  RP.destructorDriver = null;
  RP.driver = null;
  RP.urlsTemporales.forEach(u => URL.revokeObjectURL(u));
  RP.urlsTemporales = [];
  RP.zip = null; RP.preguntas = []; RP.modoRevision = false; RP.progresoFinalizado = false;
  document.getElementById('viewReproductor').classList.add('hidden');
  (RP.alSalir || renderDashboardTrabajador)();
  RP.alSalir = null;
  lucide.createIcons();
}
document.getElementById('btnSalirReproductor').addEventListener('click', () => {
  // Sin alerta: en "Volver a ver" no hay nada que perder (solo repaso), y
  // en la pantalla de certificado/resultado el progreso ya quedó guardado
  // — la advertencia de "no se guardará" sería directamente falsa ahí.
  // Solo se pregunta si hay una evaluación real en curso todavía sin cerrar.
  if (RP.modoRevision || RP.progresoFinalizado || confirm('¿Salir del módulo? Tu avance en la evaluación actual no se guardará.')) {
    cerrarReproductor();
  }
});

Object.assign(window, {
  abrirReproductor, cerrarReproductor, verCertificadoStandalone,
  seleccionarAlternativa, prepararEvaluacionOFinalizar
});
