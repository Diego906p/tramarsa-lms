/* ============================================================
   TRAMARSA LMS — Drivers de reproducción (patrón Strategy)
   El núcleo del reproductor (reproductor.js) nunca pregunta "¿qué
   tipo de módulo es esto?": itera esta lista, en orden, y usa el
   primer driver cuyo detectar() de positivo. Agregar un formato
   nuevo el día de mañana = escribir un driver nuevo y agregarlo a
   la lista — cero cambios en el núcleo ni en los otros drivers.

   Contrato de un driver:
     detectar(zip) -> boolean
     montar(contenedor, zip, rutaIndex, callbacks) -> destructor()
   callbacks = {
     onAvance(pasoActual, totalPasos),  // progreso parcial (Firestore)
     onFinalizado()                     // pasa a evaluación/certificado
   }
   Toda la lógica académica (evaluación, aprobación, certificado,
   Firestore) vive siempre en reproductor.js — el driver solo informa
   estos dos eventos, nunca toca DB ni sesión.
   ============================================================ */

import { construirDocumentoModulo } from './virtual-asset-resolver.js';

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

function alternarFullscreenReproductor() {
  const el = document.getElementById('viewReproductor');
  if (!document.fullscreenElement) el.requestFullscreen().catch(() => {});
  else document.exitFullscreen();
}
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('btnLaminaMax') || document.getElementById('btnContenidoMax');
  if (!btn) return;
  btn.innerHTML = `<i data-lucide="${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}" size="16"></i>`;
  lucide.createIcons();
});

// ---------------------------------------------------------------
// DriverLaminasLegacy — formato img/DiapositivaNN.png + audio/AudioNN.mp3
// Migrado sin cambios de comportamiento desde la versión anterior del
// reproductor (mismo módulo validado en producción: modulo_01).
// ---------------------------------------------------------------
export class DriverLaminasLegacy {
  constructor() {
    this.laminas = null;
    this.indiceLamina = 0;
    this.maximoAlcanzado = 0; // láminas ya "conquistadas": navegar libre hasta acá
    this.audioLamina = null;
    this.vimeoPlayerLamina = null;
    this.dwellRAF = null;
    this.callbacks = null;
    this.contenedor = null;
  }

  static IMG_RE = /(^|\/)img\/Diapositiva(\d+)\.(png|jpe?g|webp)$/i;
  static AUDIO_RE = /(^|\/)audio\/Audio(\d+)(?:-(\d+))?\.mp3$/i;
  static MANIFEST_RE = /(^|\/)manifest\.json$/i;

  detectar(zip) {
    return Object.keys(zip.files).some(p => !zip.files[p].dir && DriverLaminasLegacy.IMG_RE.test(p));
  }

  async detectarVideoAutomatico(zip, rutas) {
    const candidatos = rutas.filter(p => /\.(js|html)$/i.test(p));
    let vimeoId = null;
    let laminaConVideo = null;
    for (const ruta of candidatos) {
      let texto;
      try { texto = await zip.files[ruta].async('text'); } catch (e) { continue; }
      if (!vimeoId) {
        const m = texto.match(/player\.vimeo\.com\/video\/(\d+)/) || texto.match(/vimeo\.com\/(\d+)/);
        if (m) vimeoId = m[1];
      }
      if (laminaConVideo === null) {
        const m2 = texto.match(/Diapositiva0*(\d+)[^}]{0,120}?video\s*:\s*true/i);
        if (m2) laminaConVideo = parseInt(m2[1], 10);
      }
      if (vimeoId && laminaConVideo !== null) break;
    }
    return (vimeoId && laminaConVideo !== null) ? [{ lamina: laminaConVideo, vimeoId }] : [];
  }

  async construirLaminas(zip, urlsTemporales) {
    const rutas = Object.keys(zip.files).filter(p => !zip.files[p].dir);
    const imagenes = new Map();
    rutas.forEach(p => {
      const m = p.match(DriverLaminasLegacy.IMG_RE);
      if (m) imagenes.set(parseInt(m[2], 10), p);
    });
    if (imagenes.size === 0) return null;

    const audios = [];
    rutas.forEach(p => {
      const m = p.match(DriverLaminasLegacy.AUDIO_RE);
      if (m) audios.push({ desde: parseInt(m[2], 10), hasta: m[3] ? parseInt(m[3], 10) : null, ruta: p });
    });

    let videoConfig = [];
    const manifestPath = rutas.find(p => DriverLaminasLegacy.MANIFEST_RE.test(p));
    if (manifestPath) {
      try {
        const texto = await zip.files[manifestPath].async('text');
        const manifest = JSON.parse(texto);
        if (Array.isArray(manifest.video)) videoConfig = manifest.video;
        else if (manifest.video) videoConfig = [manifest.video];
      } catch (e) { /* manifest inválido: se ignora */ }
    }
    if (videoConfig.length === 0) videoConfig = await this.detectarVideoAutomatico(zip, rutas);

    const numeros = [...imagenes.keys()].sort((a, b) => a - b);
    const laminas = [];
    for (const n of numeros) {
      const blobImg = await zip.files[imagenes.get(n)].async('blob');
      const urlImg = URL.createObjectURL(blobImg);
      urlsTemporales.push(urlImg);
      const video = videoConfig.find(v => v.lamina === n) || null;
      laminas.push({ numero: n, imgUrl: urlImg, imgUrlDividida: null, audioUrl: null, video });
    }

    for (const a of audios) {
      const lamina = laminas.find(l => l.numero === a.desde);
      if (!lamina) continue;
      const blobAudio = await zip.files[a.ruta].async('blob');
      const urlAudio = URL.createObjectURL(blobAudio);
      urlsTemporales.push(urlAudio);
      lamina.audioUrl = urlAudio;
      if (a.hasta) lamina.cubreLaminaNumero = a.hasta;
    }

    for (const lamina of laminas.slice()) {
      if (!lamina.cubreLaminaNumero) continue;
      const cubierta = laminas.find(l => l.numero === lamina.cubreLaminaNumero);
      if (!cubierta) continue;
      lamina.imgUrlDividida = cubierta.imgUrl;
      const idx = laminas.indexOf(cubierta);
      if (idx >= 0) laminas.splice(idx, 1);
    }
    return laminas;
  }

  async montar(contenedor, zip, rutaIndex, callbacks, urlsTemporales, pasoInicial = 0) {
    this.contenedor = contenedor;
    this.callbacks = callbacks;
    this.laminas = await this.construirLaminas(zip, urlsTemporales);
    this.indiceLamina = Math.max(0, Math.min(pasoInicial, this.laminas.length - 1));
    this.maximoAlcanzado = this.indiceLamina;
    this.renderPaso();
    return () => this.destruir();
  }

  detenerLoopProgreso() {
    if (this.dwellRAF) cancelAnimationFrame(this.dwellRAF);
    this.dwellRAF = null;
  }

  detenerReproduccion() {
    this.detenerLoopProgreso();
    if (this.audioLamina) { this.audioLamina.pause(); this.audioLamina.onended = null; }
    if (this.vimeoPlayerLamina) { this.vimeoPlayerLamina.pause().catch(() => {}); this.vimeoPlayerLamina.off('ended'); this.vimeoPlayerLamina = null; }
  }

  renderPaso() {
    this.detenerReproduccion();
    const total = this.laminas.length;
    const lamina = this.laminas[this.indiceLamina];
    document.getElementById('reproductorPaso').textContent = `Diapositiva ${this.indiceLamina + 1} de ${total}`;
    this.callbacks.onAvance(this.indiceLamina + 1, total + 1);

    this.contenedor.innerHTML = `
      <div class="rp-full" id="rpLaminaCard">
        <div class="rp-media-full" id="rpMedia" oncontextmenu="return false;"><img src="${lamina.imgUrl}" alt="Diapositiva ${lamina.numero}" id="rpLaminaImg" oncontextmenu="return false;"></div>
        <div id="rpControlsBar">
          <div class="rp-controls">
            <button class="icon-btn" id="btnLaminaPrev" style="flex:0;min-width:44px;" ${this.indiceLamina === 0 ? 'disabled' : ''}><i data-lucide="chevron-left" size="16"></i></button>
            <button class="icon-btn" id="btnLaminaPlayPause" style="flex:0;min-width:44px;"><i data-lucide="pause" size="16"></i></button>
            <div class="rp-dwell-bar"><div class="rp-dwell-fill" id="dwellFillLamina"></div></div>
            <button class="btn-save" id="btnLaminaNext" disabled style="opacity:.5;white-space:nowrap;">
              ${this.indiceLamina < total - 1 ? 'Siguiente' : 'Continuar'} <i data-lucide="arrow-right" size="14"></i>
            </button>
            <button class="icon-btn" id="btnLaminaMax" style="flex:0;min-width:44px;" title="Pantalla completa"><i data-lucide="${document.fullscreenElement ? 'minimize-2' : 'maximize-2'}" size="16"></i></button>
          </div>
          <p style="font-size:.74rem;color:var(--gray-500);margin-top:10px;text-align:center;">Puedes retroceder o pausar, pero no adelantar: "Siguiente" se habilita al terminar el audio de esta diapositiva.</p>
        </div>
      </div>
    `;
    lucide.createIcons();

    document.getElementById('btnLaminaPrev').addEventListener('click', () => {
      if (this.indiceLamina > 0) { this.indiceLamina--; this.renderPaso(); }
    });
    document.getElementById('btnLaminaNext').addEventListener('click', () => {
      if (this.indiceLamina < total - 1) { this.indiceLamina++; this.renderPaso(); }
      else this.callbacks.onFinalizado();
    });
    document.getElementById('btnLaminaMax').addEventListener('click', alternarFullscreenReproductor);
    document.getElementById('btnLaminaPlayPause').addEventListener('click', () => this.togglePlayPause());

    this.iniciarReproduccion(lamina);

    // Ya se llegó antes hasta acá (o más adelante): puede avanzar de
    // inmediato sin esperar el audio otra vez. El audio igual se
    // reproduce para quien quiera repasarlo, solo que no bloquea.
    if (this.indiceLamina < this.maximoAlcanzado) this.habilitarSiguiente();
  }

  habilitarSiguiente() {
    const barra = document.getElementById('rpControlsBar');
    if (barra) barra.style.display = '';
    const btn = document.getElementById('btnLaminaNext');
    if (btn) { btn.disabled = false; btn.style.opacity = '1'; }
  }

  actualizarIconoPlayPause(reproduciendo) {
    const btn = document.getElementById('btnLaminaPlayPause');
    if (!btn) return;
    btn.innerHTML = `<i data-lucide="${reproduciendo ? 'pause' : 'play'}" size="16"></i>`;
    lucide.createIcons();
  }

  iniciarReproduccion(lamina) {
    const fill = document.getElementById('dwellFillLamina');

    if (!lamina.audioUrl && !lamina.video) {
      const segundosMinimos = 4;
      const inicio = performance.now();
      const tick = () => {
        const transcurrido = (performance.now() - inicio) / 1000;
        if (fill) fill.style.width = `${Math.min(100, (transcurrido / segundosMinimos) * 100)}%`;
        if (transcurrido >= segundosMinimos) {
          this.maximoAlcanzado = Math.max(this.maximoAlcanzado, this.indiceLamina);
          this.habilitarSiguiente();
          return;
        }
        this.dwellRAF = requestAnimationFrame(tick);
      };
      this.dwellRAF = requestAnimationFrame(tick);
      return;
    }

    if (lamina.audioUrl) {
      if (!this.audioLamina) this.audioLamina = new Audio();
      const audio = this.audioLamina;
      audio.src = lamina.audioUrl;
      audio.currentTime = 0;
      let dividida = false;
      const tick = () => {
        if (fill && audio.duration) fill.style.width = `${(audio.currentTime / audio.duration) * 100}%`;
        if (lamina.imgUrlDividida && !dividida && audio.duration && audio.currentTime >= audio.duration / 2) {
          dividida = true;
          const img = document.getElementById('rpLaminaImg');
          if (img) img.src = lamina.imgUrlDividida;
        }
        this.dwellRAF = requestAnimationFrame(tick);
      };
      this.dwellRAF = requestAnimationFrame(tick);
      audio.onended = () => {
        this.detenerLoopProgreso();
        this.maximoAlcanzado = Math.max(this.maximoAlcanzado, this.indiceLamina);
        if (lamina.video) this.mostrarVideo(lamina);
        else this.habilitarSiguiente();
      };
      const p = audio.play();
      if (p && p.catch) p.catch(() => {});
      this.actualizarIconoPlayPause(true);
    } else if (lamina.video) {
      this.mostrarVideo(lamina);
    }
  }

  async mostrarVideo(lamina) {
    const media = document.getElementById('rpMedia');
    if (!media || !lamina.video || !lamina.video.vimeoId) { this.habilitarSiguiente(); return; }

    const barra = document.getElementById('rpControlsBar');
    if (barra) barra.style.display = 'none';

    media.innerHTML = `<iframe src="https://player.vimeo.com/video/${lamina.video.vimeoId}?badge=0&autopause=0&autoplay=1&muted=1" allow="autoplay; fullscreen; picture-in-picture" title="Video de la diapositiva"></iframe>`;
    try {
      await cargarVimeoSdk();
      this.vimeoPlayerLamina = new window.Vimeo.Player(media.querySelector('iframe'));
      this.vimeoPlayerLamina.on('ended', () => {
        this.maximoAlcanzado = Math.max(this.maximoAlcanzado, this.indiceLamina);
        this.habilitarSiguiente();
      });
      this.actualizarIconoPlayPause(true);
      try {
        await this.vimeoPlayerLamina.play();
        await this.vimeoPlayerLamina.setMuted(false);
      } catch (e) { /* si el navegador bloquea el autoplay, queda muteado y el usuario le da play */ }
    } catch (e) {
      if (barra) barra.style.display = '';
      this.habilitarSiguiente();
    }
  }

  togglePlayPause() {
    const enVideo = this.vimeoPlayerLamina && document.getElementById('rpMedia').querySelector('iframe');
    if (enVideo) {
      this.vimeoPlayerLamina.getPaused().then(pausado => {
        if (pausado) { this.vimeoPlayerLamina.play(); this.actualizarIconoPlayPause(true); }
        else { this.vimeoPlayerLamina.pause(); this.actualizarIconoPlayPause(false); }
      }).catch(() => {});
      return;
    }
    if (this.audioLamina && this.audioLamina.src) {
      if (this.audioLamina.paused) { this.audioLamina.play(); this.actualizarIconoPlayPause(true); }
      else { this.audioLamina.pause(); this.actualizarIconoPlayPause(false); }
    }
  }

  destruir() {
    this.detenerReproduccion();
  }
}

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
// Si es contenido de terceros que no conoce este contrato, degrada con
// elegancia: tras un tiempo de gracia sin 'modulo:iniciado', se muestra
// el iframe como caja negra + un botón manual para continuar.
// ---------------------------------------------------------------
const GRACIA_SIN_SDK_MS = 6000;

export class DriverIndexHtml {
  constructor() {
    this.iframe = null;
    this.urlsTemporales = [];
    this.callbacks = null;
    this.timeoutGracia = null;
    this.handlerMensaje = null;
    this.modoControlado = false;
    this.pasoInicial = 0;
    this.indiceActual = 0;
    this.totalDiapositivas = 0;
    this.maximoAlcanzado = 0;
    this.audioListoIndiceActual = false;
  }

  detectar(zip) {
    // Requisito único del contrato: que exista un index.html.
    return Object.keys(zip.files).some(p => !zip.files[p].dir && /(^|\/)index\.html?$/i.test(p));
  }

  async montar(contenedor, zip, rutaIndex, callbacks, urlsTemporalesCompartidas, pasoInicial = 0) {
    this.callbacks = callbacks;
    this.pasoInicial = pasoInicial;
    this.maximoAlcanzado = pasoInicial;
    const { url, urlsTemporales } = await construirDocumentoModulo(zip, rutaIndex);
    this.urlsTemporales = urlsTemporales;
    urlsTemporalesCompartidas.push(...urlsTemporales);

    document.getElementById('reproductorPaso').textContent = 'Contenido del módulo';

    contenedor.innerHTML = `
      <div class="rp-full" id="rpIndexHtmlCard">
        <div class="rp-media-full" id="rpMediaIndexHtml" style="height:100%;">
          <iframe id="rpIframeModulo" sandbox="allow-scripts allow-forms allow-popups" allow="autoplay; fullscreen"
            style="width:100%;height:100%;border:0;background:#fff;"></iframe>
        </div>
        <div id="rpControlsBarIndexHtml"></div>
        <div id="rpAvanceManual" class="rp-controls" style="display:none;margin-top:10px;">
          <button class="btn-save" id="btnMarcarVisto">Marcar contenido como visto <i data-lucide="arrow-right" size="14"></i></button>
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
          this.enviarComando('lms:reanudar', { paso: this.pasoInicial });
          break;
        case 'modulo:diapositiva':
          if (Number.isFinite(datos.total) && Number.isFinite(datos.indice)) {
            this.indiceActual = datos.indice;
            this.totalDiapositivas = datos.total;
            this.audioListoIndiceActual = this.indiceActual < this.maximoAlcanzado;
            this.renderControles();
            this.callbacks.onAvance(datos.indice + 1, datos.total + 1);
          }
          break;
        case 'modulo:audioFinalizado':
          this.maximoAlcanzado = Math.max(this.maximoAlcanzado, this.indiceActual);
          this.audioListoIndiceActual = true;
          this.renderControles();
          break;
        case 'modulo:avance':
          if (Number.isFinite(datos.pct)) this.callbacks.onAvance(datos.pct, 100);
          break;
        case 'modulo:finalizado':
          this.callbacks.onFinalizado();
          break;
      }
    };
    window.addEventListener('message', this.handlerMensaje);

    // Módulos sin integración del SDK (contenido de terceros) nunca
    // van a mandar 'modulo:iniciado'; en ese caso, tras un tiempo de
    // gracia, se ofrece el botón de avance manual (caja negra).
    this.timeoutGracia = setTimeout(() => {
      if (this.modoControlado) return;
      const bloque = document.getElementById('rpAvanceManual');
      if (bloque) bloque.style.display = 'flex';
    }, GRACIA_SIN_SDK_MS);

    const btnManual = document.getElementById('btnMarcarVisto');
    if (btnManual) btnManual.addEventListener('click', () => this.callbacks.onFinalizado());

    return () => this.destruir();
  }

  enviarComando(tipo, datos) {
    if (this.iframe && this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ tipo, ...datos }, '*');
    }
  }

  renderControles() {
    const barra = document.getElementById('rpControlsBarIndexHtml');
    if (!barra) return;
    const esUltima = this.indiceActual >= this.totalDiapositivas - 1;
    const puedeAvanzar = this.audioListoIndiceActual;
    barra.innerHTML = `
      <div class="rp-controls">
        <button class="icon-btn" id="btnIndexHtmlPrev" style="flex:0;min-width:44px;" ${this.indiceActual === 0 ? 'disabled' : ''}><i data-lucide="chevron-left" size="16"></i></button>
        <div class="rp-dwell-bar"><div class="rp-dwell-fill" style="width:${puedeAvanzar ? 100 : 0}%;"></div></div>
        <button class="btn-save" id="btnIndexHtmlNext" ${puedeAvanzar ? '' : 'disabled'} style="${puedeAvanzar ? '' : 'opacity:.5;'}white-space:nowrap;">
          ${esUltima ? 'Continuar' : 'Siguiente'} <i data-lucide="arrow-right" size="14"></i>
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
  }

  destruir() {
    clearTimeout(this.timeoutGracia);
    if (this.handlerMensaje) window.removeEventListener('message', this.handlerMensaje);
  }
}

/**
 * Selecciona el primer driver que reconozca el paquete, en orden de
 * prioridad. Sin condicionales de formato en el núcleo: solo esto.
 * @param {JSZip} zip
 */
export function seleccionarDriver(zip) {
  const drivers = [new DriverLaminasLegacy(), new DriverIndexHtml()];
  return drivers.find(d => d.detectar(zip)) || null;
}
