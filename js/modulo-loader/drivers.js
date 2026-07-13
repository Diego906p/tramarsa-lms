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
// DriverLaminas — formato declarativo v2 (manifest.json), el formato
// oficial de los módulos nuevos: el paquete es SOLO contenido
// (imágenes + audios + manifest), sin index.html, sin JS propio, sin
// controles propios. El LMS reproduce directamente en su propio
// documento: sin iframe, sin sandbox, sin postMessage, sin resolver.
// Eso elimina de raíz toda la familia de problemas del formato
// anterior (origen opaco, blob/data URIs, MIME vacío, gesto de
// autoplay dentro del iframe, gate anti-trampa duplicado).
//
// manifest.json:
//   {
//     "version": 2,
//     "css": "estilos.css",              // opcional: CSS global de las láminas html
//     "lienzo": { "ancho": 1920, "alto": 1080 },  // opcional (default 1920x1080)
//     "laminas": [
//       { "imagen": "img/...png", "audio": "audio/...mp3" },      // lámina imagen
//       { "html": "laminas/...html", "audio": "audio/...mp3" }    // lámina html
//     ]
//   }
//
// Lámina "html": fragmento HTML puramente VISUAL (contenido de la
// diapositiva + CSS compartido + JS decorativo opcional), renderizado
// en un iframe sandbox por srcdoc. A diferencia del formato viejo, el
// iframe es un póster, no una app: el LMS nunca le habla ni espera
// nada de él — audio, navegación, gate y progreso son 100% del LMS,
// idénticos a la lámina imagen. Los assets que el fragmento/CSS
// referencien se sustituyen a data: URI (blob: no resuelve dentro de
// un iframe de origen opaco — misma partición de Chrome ya documentada
// en virtual-asset-resolver.js).
//
// La lógica académica (evaluación/certificado/Firestore) sigue en
// reproductor.js vía los mismos callbacks onAvance/onFinalizado.
// ---------------------------------------------------------------

// JSZip deja blob.type='' — <audio> no tolera eso (falla en silencio,
// bug ya documentado en virtual-asset-resolver.js). MIME siempre por
// extensión.
const MIME_LAMINAS = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', svg: 'image/svg+xml',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4'
};
function mimeLamina(ruta) {
  return MIME_LAMINAS[ruta.split('.').pop().toLowerCase()] || 'application/octet-stream';
}

/** Busca manifest.json al menor nivel de profundidad (tolera carpeta contenedora). */
export function buscarManifest(zip) {
  const candidatos = Object.keys(zip.files)
    .filter(p => !zip.files[p].dir && /(^|\/)manifest\.json$/i.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length);
  return candidatos[0] || null;
}

// El navegador bloquea audio.play() si el gesto del usuario ya "expiró"
// (la descarga del zip puede tardar varios segundos). Truco estándar:
// durante el click original (abrirReproductor, antes de cualquier await)
// se reproduce un WAV silencioso en un elemento Audio compartido — ese
// elemento queda desbloqueado para toda la sesión de página y es el
// mismo que usa DriverLaminas después. Así la primera lámina arranca
// sonando sin pantalla "Iniciar módulo".
const WAV_SILENCIO = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
let audioCompartido = null;
export function desbloquearAudioLaminas() {
  if (!audioCompartido) audioCompartido = new Audio();
  try {
    audioCompartido.src = WAV_SILENCIO;
    audioCompartido.play().catch(() => {});
  } catch (e) { /* si falla, el driver degrada a botón Play manual */ }
  return audioCompartido;
}

export class DriverLaminas {
  constructor() {
    this.callbacks = null;
    this.laminas = [];          // [{urlImagen, urlAudio}]
    this.indiceActual = 0;
    this.maximoAlcanzado = 0;
    this.audioListoIndiceActual = false;
    this.pausado = false;
    this.navegacionLibre = false;
    this.autoplayActivo = true;
    this.colorAcento = 'var(--blue-600)';
    this.moduloId = null;
    this.clavePreferenciaAutoplay = null;
    this.audio = null;
    this.timeoutAutoAvance = null;
    this.onPlayingBound = null;
    this.onEndedBound = null;
    this.handlerFullscreenChange = null;
    this.timeoutAvisoFullscreen = null;
  }

  detectar(zip) {
    return !!buscarManifest(zip);
  }

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
    this.navegacionLibre = navegacionLibre;
    this.colorAcento = opciones.color || 'var(--blue-600)';
    this.moduloId = opciones.moduloId || null;
    this.clavePreferenciaAutoplay = this.moduloId ? `tramarsa_autoplay_${this.moduloId}` : null;
    this.autoplayActivo = this.leerPreferenciaAutoplay();

    const rutaManifest = buscarManifest(zip);
    const base = rutaManifest.slice(0, rutaManifest.lastIndexOf('/') + 1);
    let manifest;
    try {
      manifest = JSON.parse(await zip.files[rutaManifest].async('text'));
    } catch (e) {
      throw new Error('El manifest.json del módulo no es un JSON válido.');
    }
    if (!Array.isArray(manifest.laminas) || !manifest.laminas.length) {
      throw new Error('El manifest.json del módulo no declara ninguna lámina.');
    }

    // CSS global y tamaño de lienzo de las láminas html (opcionales).
    let cssModulo = '';
    if (manifest.css && zip.files[base + manifest.css]) {
      cssModulo = await zip.files[base + manifest.css].async('text');
    }
    const lienzoAncho = (manifest.lienzo && manifest.lienzo.ancho) || 1920;
    const lienzoAlto = (manifest.lienzo && manifest.lienzo.alto) || 1080;

    // Imágenes del paquete referenciadas por fragmentos html o por el CSS:
    // se sustituyen a data: URI (dentro del iframe sandbox de origen opaco,
    // blob: del padre no resuelve). Solo se convierte lo realmente citado.
    const rutasImagenes = Object.keys(zip.files)
      .filter(p => !zip.files[p].dir && p.startsWith(base) && /\.(png|jpe?g|webp|gif|svg)$/i.test(p))
      .map(p => p.slice(base.length))
      .sort((a, b) => b.length - a.length); // más larga primero: sin pisadas parciales
    const sustituirAssets = async (texto) => {
      for (const ruta of rutasImagenes) {
        if (!texto.includes(ruta)) continue;
        const bytes = await zip.files[base + ruta].async('arraybuffer');
        const b64 = btoa(Array.from(new Uint8Array(bytes), c => String.fromCharCode(c)).join(''));
        texto = texto.split(ruta).join(`data:${mimeLamina(ruta)};base64,${b64}`);
      }
      return texto;
    };
    if (cssModulo) cssModulo = await sustituirAssets(cssModulo);

    const esqueletoSrcdoc = (fragmento) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#111827}
#lienzo{position:absolute;top:0;left:0;width:${lienzoAncho}px;height:${lienzoAlto}px;transform-origin:0 0;overflow:hidden;background:#fff}
${cssModulo}
</style></head><body><div id="lienzo">${fragmento}</div><script>
(function(){function a(){var l=document.getElementById('lienzo');var e=Math.min(innerWidth/${lienzoAncho},innerHeight/${lienzoAlto});l.style.transform='translate('+((innerWidth-${lienzoAncho}*e)/2)+'px,'+((innerHeight-${lienzoAlto}*e)/2)+'px) scale('+e+')';}addEventListener('resize',a);a();})();
<\/script></body></html>`;

    // Formato de archivo único: "contenido" = UN solo HTML con todas las
    // láminas como <section class="slide"> en orden + su <style>. Pensado
    // para plantillas que un tercero o una IA regenera tocando un único
    // archivo (contenido y diseño visual interno libres, estructura de
    // secciones intocable): el driver extrae secciones y estilos él mismo.
    let seccionesContenido = null;
    if (manifest.contenido) {
      const entradaCont = zip.files[base + manifest.contenido];
      if (!entradaCont) throw new Error(`El manifest declara "${manifest.contenido}" pero el archivo no existe en el paquete.`);
      const textoCont = await sustituirAssets(await entradaCont.async('text'));
      const docCont = new DOMParser().parseFromString(textoCont, 'text/html');
      docCont.querySelectorAll('style').forEach(s => { cssModulo += '\n' + s.textContent; });
      seccionesContenido = Array.from(docCont.querySelectorAll('section.slide'));
      if (seccionesContenido.length < manifest.laminas.length) {
        throw new Error(`El contenido tiene ${seccionesContenido.length} láminas pero el manifest declara ${manifest.laminas.length}.`);
      }
    }

    // Audio siempre por blob: URL (elemento del documento del LMS, sin
    // restricción de origen). Visual: imagen (blob:), html (srcdoc) o
    // sección extraída del contenido único.
    this.laminas = [];
    for (const lam of manifest.laminas) {
      const entradaAud = lam.audio ? zip.files[base + lam.audio] : null;
      if (lam.audio && !entradaAud) throw new Error(`El manifest declara "${lam.audio}" pero el archivo no existe en el paquete.`);
      let urlAudio = null;
      if (entradaAud) {
        const blobAud = new Blob([await entradaAud.async('arraybuffer')], { type: mimeLamina(lam.audio) });
        urlAudio = URL.createObjectURL(blobAud);
        urlsTemporalesCompartidas.push(urlAudio);
      }

      if (lam.imagen) {
        const entradaImg = zip.files[base + lam.imagen];
        if (!entradaImg) throw new Error(`El manifest declara "${lam.imagen}" pero el archivo no existe en el paquete.`);
        const blobImg = new Blob([await entradaImg.async('arraybuffer')], { type: mimeLamina(lam.imagen) });
        const urlImagen = URL.createObjectURL(blobImg);
        urlsTemporalesCompartidas.push(urlImagen);
        this.laminas.push({ tipo: 'imagen', urlImagen, urlAudio });
      } else if (lam.html) {
        const entradaHtml = zip.files[base + lam.html];
        if (!entradaHtml) throw new Error(`El manifest declara "${lam.html}" pero el archivo no existe en el paquete.`);
        const fragmento = await sustituirAssets(await entradaHtml.async('text'));
        this.laminas.push({ tipo: 'html', srcdoc: esqueletoSrcdoc(fragmento), urlAudio });
      } else if (seccionesContenido) {
        const seccion = seccionesContenido[this.laminas.length];
        seccion.classList.add('activa');
        this.laminas.push({ tipo: 'html', srcdoc: esqueletoSrcdoc(seccion.outerHTML), urlAudio });
      } else {
        throw new Error('Cada lámina del manifest debe declarar "imagen" o "html" (o el manifest debe declarar "contenido").');
      }
    }

    const total = this.laminas.length;
    this.indiceActual = Math.min(pasoInicial, total - 1);
    this.maximoAlcanzado = this.indiceActual;

    document.getElementById('reproductorPaso').textContent = 'Contenido del módulo';
    contenedor.innerHTML = `
      <div class="rp-full" id="rpLaminasCard">
        <div class="rp-media-full" id="rpLaminaMedia" style="height:100%;display:flex;align-items:center;justify-content:center;background:#fff;overflow:hidden;"></div>
        <div id="rpAvisoFullscreen"></div>
        <div id="rpControlsBarLaminas"></div>
      </div>
    `;

    // Elemento Audio compartido ya desbloqueado por el click original
    // (ver desbloquearAudioLaminas) — si no existe (flujo inesperado),
    // se crea uno normal y el autoplay degradará a Play manual.
    this.audio = audioCompartido || new Audio();
    this.onPlayingBound = () => this.alEmpezarAudio();
    this.onEndedBound = () => this.alTerminarAudio();
    this.audio.addEventListener('playing', this.onPlayingBound);
    this.audio.addEventListener('ended', this.onEndedBound);

    this.mostrarLamina(this.indiceActual, this.autoplayActivo);
    return () => this.destruir();
  }

  // Posición exacta de la barra calculada SIEMPRE desde el audio local
  // (ground truth), nunca desde getComputedStyle ni variables cacheadas:
  // pct = (láminas completas + fracción del audio actual) / total.
  pctBarraActual() {
    const total = this.laminas.length;
    const frac = (this.audio && this.audio.duration && !isNaN(this.audio.duration))
      ? Math.min(1, this.audio.currentTime / this.audio.duration) : 0;
    return ((this.indiceActual + frac) / total) * 100;
  }
  fijarBarra(pct) {
    const fill = document.getElementById('rpProgresoLamFill');
    if (fill) { fill.style.transition = 'none'; fill.style.width = pct + '%'; }
  }
  animarBarraHaciaFinDeLamina() {
    const fill = document.getElementById('rpProgresoLamFill');
    if (!fill || !this.audio.duration || isNaN(this.audio.duration)) return;
    const restanteMs = Math.max(0, (this.audio.duration - this.audio.currentTime) * 1000);
    const destino = ((this.indiceActual + 1) / this.laminas.length) * 100;
    fill.style.transition = 'none';
    fill.style.width = this.pctBarraActual() + '%';
    void fill.offsetWidth; // reflow: sin esto el navegador fusiona ambos cambios
    fill.style.transition = `width ${restanteMs}ms linear`;
    fill.style.width = destino + '%';
  }

  mostrarLamina(i, reproducir) {
    clearTimeout(this.timeoutAutoAvance);
    const total = this.laminas.length;
    this.indiceActual = i;
    const lam = this.laminas[i];
    this.audioListoIndiceActual = this.navegacionLibre || i < this.maximoAlcanzado || !lam.urlAudio;

    const media = document.getElementById('rpLaminaMedia');
    if (media) {
      if (lam.tipo === 'imagen') {
        media.innerHTML = '<img alt="" style="width:100%;height:100%;object-fit:contain;display:block;">';
        media.firstChild.src = lam.urlImagen;
      } else {
        // Iframe "póster": solo pinta el fragmento. Sin canal de
        // comunicación — el LMS nunca espera nada de él. allow-scripts
        // solo para el ajuste de escala del esqueleto y JS decorativo.
        media.innerHTML = '<iframe sandbox="allow-scripts" style="width:100%;height:100%;border:0;display:block;background:#fff;"></iframe>';
        media.firstChild.srcdoc = lam.srcdoc;
      }
    }

    this.audio.pause();
    if (this.laminas[i].urlAudio) {
      this.audio.src = this.laminas[i].urlAudio;
      this.audio.currentTime = 0;
      if (reproducir) this.reproducir();
      else this.pausado = true;
    } else {
      // Lámina sin audio: avance habilitado de inmediato.
      this.pausado = true;
    }
    this.renderControles();
    this.fijarBarra((i / total) * 100);
    this.callbacks.onAvance(i + 1, total + 1);
  }

  reproducir() {
    if (this.audio.ended) this.audio.currentTime = 0;
    this.audio.play().then(() => {
      this.pausado = false;
      this.actualizarIconoPlayPausa();
    }).catch(() => {
      // Autoplay bloqueado (gesto expirado): degrada a Play manual.
      this.pausado = true;
      this.actualizarIconoPlayPausa();
    });
  }

  pausar() {
    this.audio.pause();
    this.pausado = true;
    this.fijarBarra(this.pctBarraActual()); // congela exactamente donde va
    this.actualizarIconoPlayPausa();
  }

  alEmpezarAudio() {
    this.pausado = false;
    this.actualizarIconoPlayPausa();
    this.animarBarraHaciaFinDeLamina();
  }

  alTerminarAudio() {
    const total = this.laminas.length;
    this.maximoAlcanzado = Math.max(this.maximoAlcanzado, this.indiceActual);
    this.audioListoIndiceActual = true;
    this.fijarBarra(((this.indiceActual + 1) / total) * 100); // fin exacto
    const esUltima = this.indiceActual >= total - 1;
    if (this.autoplayActivo && !esUltima) {
      this.timeoutAutoAvance = setTimeout(() => this.mostrarLamina(this.indiceActual + 1, true), 600);
    } else {
      this.pausado = true;
    }
    // Última lámina terminada en modo inmersivo táctil: ahí no hay botón
    // "Continuar" visible — se sale de fullscreen automáticamente para que
    // el usuario vea los controles y pueda pasar a la evaluación.
    if (esUltima && document.fullscreenElement && window.matchMedia('(pointer: coarse)').matches) {
      document.exitFullscreen().catch(() => {});
    }
    this.renderControles();
  }

  actualizarIconoPlayPausa() {
    const btn = document.getElementById('btnLamPlayPausa');
    if (!btn) return;
    btn.title = this.pausado ? 'Reproducir' : 'Pausar';
    btn.innerHTML = `<i data-lucide="${this.pausado ? 'play' : 'pause'}" size="16"></i>`;
    lucide.createIcons();
  }

  actualizarBotonAuto() {
    const btn = document.getElementById('btnLamAuto');
    if (!btn) return;
    btn.title = this.autoplayActivo ? 'Automático (clic para Manual)' : 'Manual (clic para Automático)';
    btn.style.color = this.autoplayActivo ? this.colorAcento : '';
    btn.innerHTML = `<i data-lucide="${this.autoplayActivo ? 'zap' : 'hand'}" size="16"></i>`;
    lucide.createIcons();
  }

  renderControles() {
    const barra = document.getElementById('rpControlsBarLaminas');
    if (!barra) return;
    const total = this.laminas.length;
    const esUltima = this.indiceActual >= total - 1;
    const puedeAvanzar = this.audioListoIndiceActual;
    const enFullscreen = !!document.fullscreenElement;
    // Pantalla completa: mismo criterio que DriverIndexHtml — solo tiene
    // sentido con Automático (en Manual hay que interactuar seguido); con
    // Automático + fullscreen los controles secundarios se ocultan y queda
    // solo barra + botón de salir (modo compacto).
    const fullscreenDisponible = this.autoplayActivo || enFullscreen;
    const compacto = enFullscreen && this.autoplayActivo;
    // INMERSIVO (táctil, celular/tablet): en fullscreen no se muestra NADA
    // salvo la presentación — ni barra de progreso ni controles. Solo una X
    // flotante que SALE de pantalla completa (no cierra el módulo ni toca
    // el progreso; el CSS @media pointer:coarse oculta además el header).
    if (enFullscreen && window.matchMedia('(pointer: coarse)').matches) {
      barra.innerHTML = `
        <button id="btnLamSalirFs" title="Salir de pantalla completa"
          style="position:fixed;top:calc(10px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));width:42px;height:42px;border-radius:50%;border:none;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;z-index:60;cursor:pointer;">
          <i data-lucide="x" size="20"></i>
        </button>`;
      lucide.createIcons();
      document.getElementById('btnLamSalirFs').addEventListener('click', () => {
        document.exitFullscreen().catch(() => {});
      });
      return;
    }
    barra.innerHTML = `
      <div class="rp-controls">
        ${compacto ? '' : `<button class="icon-btn" id="btnLamPrev" style="flex:0;min-width:44px;" ${this.indiceActual === 0 ? 'disabled' : ''} title="Anterior"><i data-lucide="chevron-left" size="16"></i></button>
        <button class="icon-btn" id="btnLamPlayPausa" style="flex:0;min-width:44px;" title="${this.pausado ? 'Reproducir' : 'Pausar'}"><i data-lucide="${this.pausado ? 'play' : 'pause'}" size="16"></i></button>`}
        <div class="rp-dwell-bar" style="flex:1;height:6px;border-radius:999px;overflow:hidden;background:var(--gray-200);">
          <div id="rpProgresoLamFill" style="height:100%;width:${this.pctBarraActual()}%;background:${this.colorAcento};"></div>
        </div>
        ${compacto ? '' : `<button class="btn-save" id="btnLamNext" ${puedeAvanzar ? '' : 'disabled'} style="${puedeAvanzar ? '' : 'opacity:.5;'}white-space:nowrap;">
          ${esUltima ? 'Continuar' : 'Siguiente'} <i data-lucide="arrow-right" size="14"></i>
        </button>
        <button class="icon-btn" id="btnLamAuto" style="flex:0;min-width:44px;${this.autoplayActivo ? 'color:' + this.colorAcento + ';' : ''}" title="${this.autoplayActivo ? 'Automático (clic para Manual)' : 'Manual (clic para Automático)'}">
          <i data-lucide="${this.autoplayActivo ? 'zap' : 'hand'}" size="16"></i>
        </button>`}
        <button class="icon-btn" id="btnLamFullscreen" style="flex:0;min-width:44px;${fullscreenDisponible ? '' : 'opacity:.4;'}" ${fullscreenDisponible ? '' : 'disabled'}
          title="${enFullscreen ? 'Salir de pantalla completa' : (fullscreenDisponible ? 'Pantalla completa' : 'Disponible solo con avance Automático')}">
          <i data-lucide="${enFullscreen ? 'minimize' : 'maximize'}" size="16"></i>
        </button>
      </div>
      ${compacto ? '' : `<p style="font-size:.74rem;color:var(--gray-500);margin-top:10px;text-align:center;">Puedes retroceder o pausar, pero no adelantar: "Siguiente" se habilita al terminar el audio de esta diapositiva.</p>`}
    `;
    lucide.createIcons();
    // Rebuild recrea el nodo del fill: si el audio sigue sonando hay que
    // relanzar la animación desde la posición real actual.
    if (!this.audio.paused && !this.audio.ended) this.animarBarraHaciaFinDeLamina();
    if (!compacto) {
      document.getElementById('btnLamPrev').addEventListener('click', () => {
        if (this.indiceActual > 0) this.mostrarLamina(this.indiceActual - 1, this.autoplayActivo);
      });
      document.getElementById('btnLamNext').addEventListener('click', () => {
        if (esUltima) this.callbacks.onFinalizado();
        else this.mostrarLamina(this.indiceActual + 1, this.autoplayActivo);
      });
      document.getElementById('btnLamPlayPausa').addEventListener('click', () => {
        if (this.pausado) this.reproducir();
        else this.pausar();
      });
      document.getElementById('btnLamAuto').addEventListener('click', () => {
        this.autoplayActivo = !this.autoplayActivo;
        this.guardarPreferenciaAutoplay(this.autoplayActivo);
        // Si se apaga Automático en fullscreen, salir (mismo criterio que
        // DriverIndexHtml: fullscreen solo tiene sentido con Automático).
        if (!this.autoplayActivo && document.fullscreenElement) document.exitFullscreen().catch(() => {});
        this.renderControles();
        // Si acaba de activar Automático con el audio ya terminado, avanza
        // solo (si no, queda esperando un click extra que Manual sí pide).
        if (this.autoplayActivo && this.audio.ended && this.indiceActual < this.laminas.length - 1 && this.audioListoIndiceActual) {
          this.timeoutAutoAvance = setTimeout(() => this.mostrarLamina(this.indiceActual + 1, true), 400);
        }
      });
    }
    // Fullscreen real sobre toda la vista (#viewReproductor) — el botón de
    // salir del LMS sigue visible en pantalla completa.
    const btnFs = document.getElementById('btnLamFullscreen');
    if (fullscreenDisponible) {
      btnFs.addEventListener('click', () => {
        const vista = document.getElementById('viewReproductor');
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          vista.requestFullscreen().catch(() => {}).then(() => {
            if (screen.orientation && screen.orientation.lock) {
              screen.orientation.lock('landscape').catch(() => {});
            }
          });
        }
      });
    }
    if (!this.handlerFullscreenChange) {
      this.handlerFullscreenChange = () => {
        this.renderControles();
        if (document.fullscreenElement) this.mostrarAvisoFullscreen();
        else if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
      };
      document.addEventListener('fullscreenchange', this.handlerFullscreenChange);
    }
  }

  mostrarAvisoFullscreen() {
    const aviso = document.getElementById('rpAvisoFullscreen');
    if (!aviso) return;
    aviso.textContent = 'Para salir: presiona de nuevo el botón de pantalla completa o usa Atrás';
    aviso.classList.add('show');
    clearTimeout(this.timeoutAvisoFullscreen);
    this.timeoutAvisoFullscreen = setTimeout(() => aviso.classList.remove('show'), 3500);
  }

  destruir() {
    clearTimeout(this.timeoutAutoAvance);
    clearTimeout(this.timeoutAvisoFullscreen);
    if (this.handlerFullscreenChange) {
      document.removeEventListener('fullscreenchange', this.handlerFullscreenChange);
      this.handlerFullscreenChange = null;
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (this.audio) {
      this.audio.pause();
      if (this.onPlayingBound) this.audio.removeEventListener('playing', this.onPlayingBound);
      if (this.onEndedBound) this.audio.removeEventListener('ended', this.onEndedBound);
      // El elemento es compartido (queda desbloqueado para el próximo
      // módulo): solo se limpia la fuente, no se destruye.
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = null;
    }
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
// Si es contenido de terceros que no conoce este contrato, NO hay
// atajo: tras el tiempo de gracia sin 'modulo:iniciado' se muestra un
// aviso de incompatibilidad — nunca un botón para saltar a la
// evaluación sin haber recorrido el contenido (regla anti-trampa).
// ---------------------------------------------------------------
// 8000ms era demasiado corto: en redes/dispositivos lentos, la
// descompresión+arranque real de un módulo con muchos archivos podía
// tomar más que eso, y el aviso de "incompatible" llegaba a mostrarse
// brevemente ANTES de que 'modulo:iniciado' llegara de verdad — un falso
// positivo visual, no un problema real de compatibilidad. Ver también el
// spinner de carga (#rpCargandoModulo) que cubre esta espera con un
// mensaje neutral en vez de dejarlo en blanco.
const GRACIA_SIN_SDK_MS = 18000;

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
        <div id="rpCargandoModulo" style="position:absolute;inset:0;background:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;">
          <i data-lucide="loader-circle" size="28" class="spin" style="color:var(--blue-600);"></i>
          <span style="font-size:.82rem;color:var(--gray-500);font-weight:600;">Cargando módulo...</span>
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
          // Spinner de carga: se muestra desde el montaje hasta este punto,
          // cubriendo la espera real (descompresión + arranque del módulo)
          // con un mensaje neutral en vez de una pantalla en blanco — reduce
          // el riesgo de que el usuario vea el aviso de incompatibilidad de
          // pasada mientras el módulo todavía está arrancando.
          { const cargando = document.getElementById('rpCargandoModulo'); if (cargando) cargando.remove(); }
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
      const cargando = document.getElementById('rpCargandoModulo');
      if (cargando) cargando.remove();
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
    const enFullscreen = !!document.fullscreenElement;
    // Pantalla completa: solo tiene sentido con Automático activo (el
    // usuario no necesita tocar la pantalla para avanzar) — en Manual el
    // propio flujo exige interactuar seguido, y hacerlo en fullscreen es
    // más incómodo, no menos. Con Automático + fullscreen se ocultan los
    // controles secundarios (Prev/Play/Auto) y solo queda la barra de
    // progreso — casi toda la superficie para el contenido del módulo.
    const fullscreenDisponible = this.autoplayActivo || enFullscreen;
    const compacto = enFullscreen && this.autoplayActivo;
    // INMERSIVO táctil: igual que en DriverLaminas — solo la presentación
    // y una X flotante que sale de fullscreen (no cierra el módulo).
    if (enFullscreen && window.matchMedia('(pointer: coarse)').matches) {
      barra.innerHTML = `
        <button id="btnIndexHtmlSalirFs" title="Salir de pantalla completa"
          style="position:fixed;top:calc(10px + env(safe-area-inset-top));right:calc(10px + env(safe-area-inset-right));width:42px;height:42px;border-radius:50%;border:none;background:rgba(0,0,0,.45);color:#fff;display:flex;align-items:center;justify-content:center;z-index:60;cursor:pointer;">
          <i data-lucide="x" size="20"></i>
        </button>`;
      lucide.createIcons();
      document.getElementById('btnIndexHtmlSalirFs').addEventListener('click', () => {
        document.exitFullscreen().catch(() => {});
      });
      if (!this.handlerFullscreenChange) {
        this.handlerFullscreenChange = () => {
          this.renderControles();
          if (document.fullscreenElement) this.mostrarAvisoFullscreen();
          else if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
        };
        document.addEventListener('fullscreenchange', this.handlerFullscreenChange);
      }
      return;
    }
    barra.innerHTML = `
      <div class="rp-controls">
        ${compacto ? '' : `<button class="icon-btn" id="btnIndexHtmlPrev" style="flex:0;min-width:44px;" ${this.indiceActual === 0 ? 'disabled' : ''} title="Anterior"><i data-lucide="chevron-left" size="16"></i></button>
        <button class="icon-btn" id="btnIndexHtmlPlayPausa" style="flex:0;min-width:44px;" title="${this.pausado ? 'Reanudar' : 'Pausar'}"><i data-lucide="${iconoPlayPausa}" size="16"></i></button>`}
        <div class="rp-dwell-bar" style="flex:1;height:6px;border-radius:999px;overflow:hidden;background:var(--gray-200);">
          <div id="rpProgresoRealFill" style="height:100%;width:${this.pctAvanceReal}%;background:${this.colorAcento};transition:width .12s linear;"></div>
        </div>
        ${compacto ? '' : `<button class="btn-save" id="btnIndexHtmlNext" ${puedeAvanzar ? '' : 'disabled'} style="${puedeAvanzar ? '' : 'opacity:.5;'}white-space:nowrap;">
          ${esUltima ? 'Continuar' : 'Siguiente'} <i data-lucide="arrow-right" size="14"></i>
        </button>
        <button class="icon-btn" id="btnIndexHtmlAuto" style="flex:0;min-width:44px;${this.autoplayActivo ? 'color:' + this.colorAcento + ';' : ''}" title="${this.autoplayActivo ? 'Automático (clic para Manual)' : 'Manual (clic para Automático)'}">
          <i data-lucide="${this.autoplayActivo ? 'zap' : 'hand'}" size="16"></i>
        </button>`}
        <button class="icon-btn" id="btnIndexHtmlFullscreen" style="flex:0;min-width:44px;${fullscreenDisponible ? '' : 'opacity:.4;'}" ${fullscreenDisponible ? '' : 'disabled'}
          title="${enFullscreen ? 'Salir de pantalla completa' : (fullscreenDisponible ? 'Pantalla completa' : 'Disponible solo con avance Automático')}">
          <i data-lucide="${enFullscreen ? 'minimize' : 'maximize'}" size="16"></i>
        </button>
      </div>
      ${compacto ? '' : `<p style="font-size:.74rem;color:var(--gray-500);margin-top:10px;text-align:center;">Puedes retroceder o pausar, pero no adelantar: "Siguiente" se habilita al terminar el audio de esta diapositiva.</p>`}
    `;
    lucide.createIcons();
    if (!compacto) {
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
        // Si se apaga Automático mientras se está en fullscreen, salir —
        // fullscreen solo tiene sentido con Automático (ver comentario arriba).
        if (!this.autoplayActivo && document.fullscreenElement) document.exitFullscreen().catch(() => {});
        this.renderControles();
      });
    }
    // Opcional: Fullscreen API real sobre toda la vista del reproductor
    // (#viewReproductor), no solo el iframe — así el botón de salir del
    // LMS sigue visible en pantalla completa. No cambia nada del
    // comportamiento normal para quien no lo use.
    const btnFs = document.getElementById('btnIndexHtmlFullscreen');
    if (fullscreenDisponible) {
      btnFs.addEventListener('click', () => {
        const vista = document.getElementById('viewReproductor');
        if (document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
        } else {
          vista.requestFullscreen().catch(() => {}).then(() => {
            // Orientación horizontal: solo algunos navegadores/SO la
            // soportan (Chrome Android sí, iOS Safari no expone esta
            // API) — se intenta, y si falla se sigue igual en el
            // formato que ya tenga el dispositivo, sin bloquear nada.
            if (screen.orientation && screen.orientation.lock) {
              screen.orientation.lock('landscape').catch(() => {});
            }
          });
        }
      });
    }
    if (!this.handlerFullscreenChange) {
      this.handlerFullscreenChange = () => {
        this.renderControles();
        if (document.fullscreenElement) this.mostrarAvisoFullscreen();
        else if (screen.orientation && screen.orientation.unlock) screen.orientation.unlock();
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
  // DriverLaminas (manifest.json, formato oficial v2) tiene prioridad;
  // DriverIndexHtml queda como fallback para paquetes del formato anterior.
  const drivers = [new DriverLaminas(), new DriverIndexHtml()];
  return drivers.find(d => d.detectar(zip)) || null;
}
