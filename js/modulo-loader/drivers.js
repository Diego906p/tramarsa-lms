/* ============================================================
   TRAMARSA LMS — Driver de reproducción (patrón Strategy)
   Un único driver, un único contrato: el LMS localiza index.html y lo
   ejecuta siempre — nunca inspecciona la estructura interna del
   paquete (ni nombres de archivo, ni si hay PNG o no). Cualquier
   módulo que respete el contrato SDK (ver virtual-asset-resolver.js)
   funciona sin adaptaciones específicas.

   Contrato de un driver:
     detectar(zip) -> boolean
     montar(contenedor, zip, rutaIndex, callbacks, urlsTemporales, pasoInicial, navegacionLibre, opciones) -> destructor()
   callbacks = {
     onAvance(pasoActual, totalPasos),  // progreso parcial (Firestore)
     onFinalizado()                     // pasa a evaluación/certificado
   }
   opciones = { color, moduloId }  // color de acento del módulo (Firestore,
   ya lo tiene el llamador antes de montar — nunca se le pide al módulo) y
   su id (clave de la preferencia Automático/Manual persistida en
   localStorage, por módulo, hasta que el usuario la cambie).
   Toda la lógica académica (evaluación, aprobación, certificado,
   Firestore) vive siempre en reproductor.js — el driver solo informa
   estos dos eventos, nunca toca DB ni sesión.

   La lista de drivers se mantiene como patrón extensible (agregar un
   formato futuro genuinamente distinto = agregar una clase más acá,
   cero cambios en el núcleo), aunque hoy solo tenga un integrante.
   ============================================================ */

import { construirDocumentoModulo } from './virtual-asset-resolver.js';

// ---------------------------------------------------------------
// DriverIndexHtml — contrato universal: el único requisito es que
// exista index.html. Se monta en un <iframe sandbox> aislado (sin
// allow-same-origin: origen opaco, sin acceso a Firestore/Auth/window
// del LMS) y se comunica exclusivamente por postMessage.
//
// Si el módulo integra el SDK (window.TramarsaLMS, inyectado por el
// virtual-asset-resolver) reporta 'modulo:iniciado' — a partir de ahí
// el LMS toma el control de la navegación exactamente igual que en el
// driver de láminas: dibuja su propia barra prev/next fuera del iframe,
// el módulo pierde sus controles propios (los oculta él mismo al
// integrarse) y solo avanza cuando el LMS le manda 'lms:siguiente'
// después de recibir 'modulo:audioFinalizado' de la diapositiva actual
// (o si esa diapositiva ya había sido alcanzada antes: mismo criterio
// de "no adelantar, sí retroceder y volver" que el otro driver).
//
// Si es contenido de terceros que no conoce este contrato, NO hay
// atajo: tras el tiempo de gracia sin 'modulo:iniciado' se muestra un
// aviso de incompatibilidad — nunca un botón para saltar a la
// evaluación sin haber recorrido el contenido (regla anti-trampa).
// ---------------------------------------------------------------
const GRACIA_SIN_SDK_MS = 8000;

export class DriverIndexHtml {
  constructor() {
    this.iframe = null;
    this.urlsTemporales = [];
    this.callbacks = null;
    this.timeoutGracia = null;
    this.handlerMensaje = null;
    this.modoControlado = false;
    this.pasoInicial = 0;
    this.navegacionLibre = false;
    this.indiceActual = 0;
    this.totalDiapositivas = 0;
    this.maximoAlcanzado = 0;
    this.audioListoIndiceActual = false;
    this.pausado = false;
    this.pctAvanceReal = 0;
    this.colorAcento = 'var(--blue-600)';
    this.moduloId = null;
    this.clavePreferenciaAutoplay = null;
    this.autoplayActivo = true;
    this.handlerFullscreenChange = null;
    this.timeoutAvisoFullscreen = null;
  }

  detectar(zip) {
    // Requisito único del contrato: que exista un index.html.
    return Object.keys(zip.files).some(p => !zip.files[p].dir && /(^|\/)index\.html?$/i.test(p));
  }

  // Automático/Manual es preferencia del usuario para ESE módulo, no del
  // módulo en sí — vive en localStorage del navegador, nunca en Firestore
  // ni en el propio paquete. Persiste hasta que el usuario la cambie.
  leerPreferenciaAutoplay() {
    if (!this.clavePreferenciaAutoplay) return true;
    const guardado = localStorage.getItem(this.clavePreferenciaAutoplay);
    return guardado === null ? true : guardado === '1';
  }
  guardarPreferenciaAutoplay(activo) {
    if (this.clavePreferenciaAutoplay) localStorage.setItem(this.clavePreferenciaAutoplay, activo ? '1' : '0');
  }

  async montar(contenedor, zip, rutaIndex, callbacks, urlsTemporalesCompartidas, pasoInicial = 0, navegacionLibre = false, opciones = {}) {
    this.callbacks = callbacks;
    this.pasoInicial = pasoInicial;
    this.navegacionLibre = navegacionLibre;
    this.maximoAlcanzado = pasoInicial;
    this.colorAcento = opciones.color || 'var(--blue-600)';
    this.moduloId = opciones.moduloId || null;
    this.clavePreferenciaAutoplay = this.moduloId ? `tramarsa_autoplay_${this.moduloId}` : null;
    this.autoplayActivo = this.leerPreferenciaAutoplay();
    const { url, urlsTemporales } = await construirDocumentoModulo(zip, rutaIndex);
    this.urlsTemporales = urlsTemporales;
    urlsTemporalesCompartidas.push(...urlsTemporales);

    document.getElementById('reproductorPaso').textContent = 'Contenido del módulo';

    contenedor.innerHTML = `
      <div class="rp-full" id="rpIndexHtmlCard">
        <div class="rp-media-full" id="rpMediaIndexHtml" style="height:100%;position:relative;">
          <iframe id="rpIframeModulo" sandbox="allow-scripts allow-forms allow-popups" allow="autoplay; fullscreen"
            style="width:100%;height:100%;border:0;background:#fff;"></iframe>
          <div id="rpAvisoFullscreen"></div>
        </div>
        <div id="rpControlsBarIndexHtml"></div>
        <div id="rpAvisoIncompatible" style="display:none;margin-top:10px;text-align:center;font-size:.8rem;color:var(--orange-500);">
          <i data-lucide="alert-triangle" size="14"></i>
          Este módulo no es compatible con el reproductor del LMS (no integra la API de comunicación).
          No es posible completarlo hasta que el administrador lo actualice.
        </div>
      </div>
    `;
    lucide.createIcons();

    this.iframe = document.getElementById('rpIframeModulo');
    this.iframe.src = url;

    this.handlerMensaje = (evento) => {
      if (evento.source !== this.iframe.contentWindow) return; // solo mensajes del propio módulo montado
      const datos = evento.data || {};
      switch (datos.tipo) {
        case 'modulo:iniciado':
          clearTimeout(this.timeoutGracia);
          this.modoControlado = true;
          // Si el aviso de incompatibilidad ya se había mostrado (red lenta,
          // pestaña en segundo plano throttleada, etc.) y 'modulo:iniciado'
          // igual llega después, hay que ocultarlo — antes quedaba pegado
          // en pantalla para siempre aunque el módulo sí se integrara bien
          // (mensaje falso, no bloqueaba nada pero confundía).
          { const aviso = document.getElementById('rpAvisoIncompatible'); if (aviso) aviso.style.display = 'none'; }
          // Orden importa: primero la preferencia (para que el autoavance
          // interno del módulo ya quede correcto), después el reanudar.
          // reproducir sigue la preferencia guardada: automático retoma
          // reproduciendo desde el inicio de esa lámina, manual queda
          // detenido esperando al usuario. No se intenta recordar el
          // segundo exacto del audio, solo la lámina.
          this.enviarComando('lms:alternarAutoplay', { activo: this.autoplayActivo });
          // navegacionLibre (true en "Volver a ver"): el gate anti-trampa
          // vive DENTRO del módulo (maxAlcanzado propio) — el driver puede
          // tener su propio botón "Siguiente" habilitado, pero si el módulo
          // no sabe que está en revisión libre, su Motor.puedeAvanzar()
          // sigue bloqueando el avance real. Bug reportado: "Siguiente se
          // ve habilitado pero no adelanta la lámina".
          this.enviarComando('lms:reanudar', { paso: this.pasoInicial, reproducir: this.autoplayActivo, navegacionLibre: this.navegacionLibre });
          // El botón de play/pausa debe reflejar si de verdad quedó sonando
          // algo tras el reanudar. En el primer montaje (pasoInicial=0) el
          // propio módulo ya arrancó su lámina 1 con el click de "Iniciar
          // módulo" del usuario, sin importar la preferencia — sí está
          // sonando. Al retomar en progreso (pasoInicial>0) el estado real
          // es exactamente "reproducir": si la preferencia es Manual, no
          // arranca nada y el botón debe partir en "Reproducir", no "Pausar".
          this.pausado = this.pasoInicial > 0 && !this.autoplayActivo;
          break;
        case 'modulo:diapositiva':
          if (Number.isFinite(datos.total) && Number.isFinite(datos.indice)) {
            this.indiceActual = datos.indice;
            this.totalDiapositivas = datos.total;
            this.audioListoIndiceActual = this.navegacionLibre || this.indiceActual < this.maximoAlcanzado;
            this.renderControles();
            // Denominador = datos.total (cantidad real de diapositivas), NO
            // datos.total+1: ese +1 de más hacía que el cálculo de avancePct
            // nunca alcanzara el 100% real (siempre un tramo corto), aun en
            // la última diapositiva. Bug real, reportado como "el progreso
            // nunca completa el segmento".
            this.callbacks.onAvance(datos.indice + 1, datos.total);
          }
          break;
        case 'modulo:audioFinalizado':
          this.maximoAlcanzado = Math.max(this.maximoAlcanzado, this.indiceActual);
          this.audioListoIndiceActual = true;
          this.renderControles();
          break;
        case 'modulo:avance':
          // Evento confirmado (cambio de lámina, Reiniciar, etc.) — SIEMPRE
          // un salto instantáneo, nunca una animación: transition:none antes
          // de fijar el ancho, si no el navegador interpolaría un reinicio
          // (100%→0%) como si fuera parte del progreso normal.
          if (Number.isFinite(datos.pct)) {
            this.pctAvanceReal = datos.pct;
            const fill = document.getElementById('rpProgresoRealFill');
            if (fill) { fill.style.transition = 'none'; fill.style.width = datos.pct + '%'; }
            this.callbacks.onAvance(datos.pct, 100);
            this.renderControles();
          }
          break;
        case 'modulo:segmentoAudio':
          // Barra realmente fluida: UN mensaje al empezar cada lámina (no
          // un tick por frame) con {pctDestino, duracionMs} = tiempo real
          // restante del audio. Se arma una transición CSS de esa duración
          // exacta y se fija el destino — el navegador interpola solo a
          // 60fps, sin overhead de postMessage ni de recálculo por JS.
          // Puramente visual: a propósito no toca Firestore (eso solo pasa
          // por 'modulo:avance'/'modulo:audioFinalizado', que si confirman
          // progreso real) — evita romper el anti-trampa con progreso
          // "en vivo" aún no terminado de escuchar.
          if (Number.isFinite(datos.pctDestino) && Number.isFinite(datos.duracionMs)) {
            const fill = document.getElementById('rpProgresoRealFill');
            if (fill) {
              // Punto de partida: el ancho REAL actual (getComputedStyle),
              // no this.pctAvanceReal — ese puede estar desactualizado
              // (nunca se toca durante una animación en curso ni durante
              // una pausa), y usarlo como partida causaba un salto/congelo
              // real al reanudar en medio de una lámina. getComputedStyle
              // siempre refleja dónde está el fill de verdad, esté animando,
              // recién congelado por una pausa, o en reposo.
              const anchoActual = getComputedStyle(fill).width;
              fill.style.transition = 'none';
              fill.style.width = anchoActual;
              void fill.offsetWidth; // fuerza reflow: sin esto el navegador podría fusionar los dos cambios de estilo y saltar directo al destino
              fill.style.transition = `width ${datos.duracionMs}ms linear`;
              fill.style.width = datos.pctDestino + '%';
              this.pctAvanceReal = datos.pctDestino; // mantenido al día por si renderControles() reconstruye la barra después
            }
          }
          break;
        case 'modulo:pausado':
          this.pausado = true;
          // Congela la animación exactamente donde iba (no en el destino
          // final ni en el valor viejo) — sin rebuild completo del panel,
          // que recrearía el nodo y perdería la posición actual.
          { const fill = document.getElementById('rpProgresoRealFill');
            if (fill) { const anchoActual = getComputedStyle(fill).width; fill.style.transition = 'none'; fill.style.width = anchoActual; } }
          this.actualizarIconoPlayPausa();
          break;
        case 'modulo:reanudado':
          this.pausado = false;
          this.actualizarIconoPlayPausa();
          break;
        case 'modulo:finalizado':
          this.callbacks.onFinalizado();
          break;
      }
    };
    window.addEventListener('message', this.handlerMensaje);

    // Módulos sin integración del SDK (contenido de terceros) nunca
    // van a mandar 'modulo:iniciado'. En ese caso NO se ofrece ningún
    // atajo (antes existía "Marcar contenido como visto", eliminado por
    // permitir saltarse el contenido): solo se avisa la incompatibilidad.
    this.timeoutGracia = setTimeout(() => {
      if (this.modoControlado) return;
      const aviso = document.getElementById('rpAvisoIncompatible');
      if (aviso) { aviso.style.display = 'block'; lucide.createIcons(); }
    }, GRACIA_SIN_SDK_MS);

    return () => this.destruir();
  }

  enviarComando(tipo, datos) {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ tipo, ...datos }, '*');
    }
  }

  // Solo el ícono/título del botón play-pausa, sin recrear el resto de la
  // barra — usado por pausado/reanudado para no perder el estado de la
  // animación CSS de la barra de progreso (un rebuild completo recrea el
  // nodo del fill y lo reinicia).
  actualizarIconoPlayPausa() {
    const btn = document.getElementById('btnIndexHtmlPlayPausa');
    if (!btn) return;
    btn.title = this.pausado ? 'Reanudar' : 'Pausar';
    btn.innerHTML = `<i data-lucide="${this.pausado ? 'play' : 'pause'}" size="16"></i>`;
    lucide.createIcons();
  }

  renderControles() {
    const barra = document.getElementById('rpControlsBarIndexHtml');
    if (!barra) return;
    const esUltima = this.indiceActual >= this.totalDiapositivas - 1;
    const puedeAvanzar = this.audioListoIndiceActual;
    const iconoPlayPausa = this.pausado ? 'play' : 'pause';
    barra.innerHTML = `
      <div class="rp-controls">
        <button class="icon-btn" id="btnIndexHtmlPrev" style="flex:0;min-width:44px;" ${this.indiceActual === 0 ? 'disabled' : ''} title="Anterior"><i data-lucide="chevron-left" size="16"></i></button>
        <button class="icon-btn" id="btnIndexHtmlPlayPausa" style="flex:0;min-width:44px;" title="${this.pausado ? 'Reanudar' : 'Pausar'}"><i data-lucide="${iconoPlayPausa}" size="16"></i></button>
        <div class="rp-dwell-bar" style="flex:1;height:6px;border-radius:999px;overflow:hidden;background:var(--gray-200);">
          <div id="rpProgresoRealFill" style="height:100%;width:${this.pctAvanceReal}%;background:${this.colorAcento};transition:width .12s linear;"></div>
        </div>
        <button class="btn-save" id="btnIndexHtmlNext" ${puedeAvanzar ? '' : 'disabled'} style="${puedeAvanzar ? '' : 'opacity:.5;'}white-space:nowrap;">
          ${esUltima ? 'Continuar' : 'Siguiente'} <i data-lucide="arrow-right" size="14"></i>
        </button>
        <button class="icon-btn" id="btnIndexHtmlAuto" style="flex:0;min-width:44px;${this.autoplayActivo ? 'color:' + this.colorAcento + ';' : ''}" title="${this.autoplayActivo ? 'Automático (clic para Manual)' : 'Manual (clic para Automático)'}">
          <i data-lucide="${this.autoplayActivo ? 'zap' : 'hand'}" size="16"></i>
        </button>
        <button class="icon-btn" id="btnIndexHtmlFullscreen" style="flex:0;min-width:44px;" title="${document.fullscreenElement ? 'Salir de pantalla completa' : 'Pantalla completa'}">
          <i data-lucide="${document.fullscreenElement ? 'minimize' : 'maximize'}" size="16"></i>
        </button>
      </div>
      <p style="font-size:.74rem;color:var(--gray-500);margin-top:10px;text-align:center;">Puedes retroceder o pausar, pero no adelantar: "Siguiente" se habilita al terminar el audio de esta diapositiva.</p>
    `;
    lucide.createIcons();
    document.getElementById('btnIndexHtmlPrev').addEventListener('click', () => this.enviarComando('lms:anterior', {}));
    document.getElementById('btnIndexHtmlNext').addEventListener('click', () => {
      if (esUltima) this.callbacks.onFinalizado();
      else this.enviarComando('lms:siguiente', {});
    });
    document.getElementById('btnIndexHtmlPlayPausa').addEventListener('click', () => {
      if (this.pausado) this.enviarComando('lms:continuar', {});
      else this.enviarComando('lms:pausar', {});
    });
    document.getElementById('btnIndexHtmlAuto').addEventListener('click', () => {
      this.autoplayActivo = !this.autoplayActivo;
      this.guardarPreferenciaAutoplay(this.autoplayActivo);
      this.enviarComando('lms:alternarAutoplay', { activo: this.autoplayActivo });
      this.renderControles();
    });
    // Opcional: Fullscreen API real sobre toda la vista del reproductor
    // (#viewReproductor), no solo el iframe — así los controles propios del
    // LMS (Prev/Play/barra/Auto) siguen visibles en pantalla completa. No
    // cambia nada del comportamiento normal para quien no lo use.
    document.getElementById('btnIndexHtmlFullscreen').addEventListener('click', () => {
      const vista = document.getElementById('viewReproductor');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else vista.requestFullscreen().catch(() => {});
    });
    if (!this.handlerFullscreenChange) {
      this.handlerFullscreenChange = () => {
        this.renderControles();
        if (document.fullscreenElement) this.mostrarAvisoFullscreen();
      };
      document.addEventListener('fullscreenchange', this.handlerFullscreenChange);
    }
  }

  // Aviso propio del LMS al entrar en fullscreen — breve y se autooculta.
  // NO reemplaza el aviso nativo del navegador ("Presiona Esc para salir" /
  // su equivalente táctil en móvil): eso es una medida de seguridad del
  // propio estándar Fullscreen API (evita que una página suplante al
  // sistema operativo) y ningún sitio puede suprimirlo ni personalizarlo,
  // en ningún navegador. Este aviso es un complemento, no un reemplazo.
  mostrarAvisoFullscreen() {
    const aviso = document.getElementById('rpAvisoFullscreen');
    if (!aviso) return;
    aviso.textContent = 'Para salir: presiona de nuevo el botón de pantalla completa o usa Atrás';
    aviso.classList.add('show');
    clearTimeout(this.timeoutAvisoFullscreen);
    this.timeoutAvisoFullscreen = setTimeout(() => aviso.classList.remove('show'), 3500);
  }

  destruir() {
    clearTimeout(this.timeoutGracia);
    clearTimeout(this.timeoutAvisoFullscreen);
    if (this.handlerMensaje) window.removeEventListener('message', this.handlerMensaje);
    if (this.handlerFullscreenChange) document.removeEventListener('fullscreenchange', this.handlerFullscreenChange);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    // Bug real: ocultar #viewReproductor con CSS (display:none) NO detiene
    // el iframe — sigue vivo, el audio sigue sonando y el Motor del módulo
    // sigue autoavanzando en segundo plano aunque nadie lo vea, corrompiendo
    // el progreso guardado la próxima vez que llegue un modulo:diapositiva/
    // avance real. Sacar el iframe del DOM es la única forma garantizada de
    // detener de verdad todo lo que corre adentro (audio, timers, el propio
    // Motor) — por spec, un iframe removido termina su browsing context al
    // instante. src='about:blank' primero por si algún navegador demora el
    // remove() un tick.
    if (this.iframe) {
      this.iframe.src = 'about:blank';
      this.iframe.remove();
      this.iframe = null;
    }
  }
}

/**
 * Selecciona el primer driver que reconozca el paquete, en orden de
 * prioridad. Sin condicionales de formato en el núcleo: solo esto.
 * @param {JSZip} zip
 */
export function seleccionarDriver(zip) {
  const drivers = [new DriverIndexHtml()];
  return drivers.find(d => d.detectar(zip)) || null;
}
