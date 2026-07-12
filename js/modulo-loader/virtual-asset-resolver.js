/* ============================================================
   TRAMARSA LMS — Resolutor virtual de assets
   Toma un JSZip (ya normalizado por package-adapters.js) y produce
   un documento HTML autocontenido en un Blob URL, listo para montar
   en un <iframe>. El módulo puede referenciar css/js/img/audio/video/
   fonts/json/lo-que-sea con rutas relativas normales: el LMS nunca
   inspecciona ni asume esa estructura.

   Estrategia en 3 pasadas (las 3 necesarias, no una u otra):
   1) Inlineo de <script src="local.js"> / <link rel="stylesheet"
      href="local.css">: el contenido real se inyecta directo en el
      HTML en vez de referenciarlo por Blob URL. Motivo (limitación
      real del navegador, no una elección de diseño): el iframe corre
      con origen opaco (sandbox sin allow-same-origin, aislamiento a
      propósito) y un <script src="blob:...">/<link href="blob:...">
      NO carga si el blob fue creado desde otro origen — a diferencia
      de <img>/<audio>/<video> con blob:, que sí funcionan cross-origin
      sin problema. Por eso un módulo de una sola pieza (todo inline,
      sin carpetas css/js separadas) funcionaba y uno con css/js como
      archivos aparte no — no era un bug del módulo, era esto.
   2) Estática: reemplaza en el texto de cada archivo html/css/js/json
      cualquier ocurrencia literal de una ruta relativa conocida por su
      Blob URL — cubre <img src>, url() de CSS, manifest.json, etc.
      (todo lo que no sea el <script src>/<link> ya inlineado en el
      paso 1, que para esos casos sí es seguro usar Blob URL).
   3) Runtime: un shim inyectado como primer <script> del documento
      intercepta fetch/XHR y los setters de .src de imagen/audio/video/
      script — cubre rutas armadas dinámicamente en JS (ej. un módulo
      que hace `'img/Diapositiva' + n + '.png'` en tiempo de ejecución,
      donde la pasada estática no tiene un literal completo que buscar).
   ============================================================ */

const EXT_TEXTO = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg']);

function extension(ruta) {
  return ruta.split('.').pop().toLowerCase();
}

// blob.type NO es confiable como fuente de MIME: JSZip deja Blob.type en
// '' (string vacío) al leer un archivo agregado vía zip.file(ruta, archivo)
// sin pasar {mimeType} explícito — y package-adapters.js (carpeta arrastrada
// y .rar) nunca lo pasa. Confirmado con bytes idénticos, blob.type='' desde
// JSZip vs 'audio/mpeg' desde fetch() directo del mismo archivo, incluso
// pasando un File ya tipado. Con blob.type='' caía a 'application/octet-stream'
// — <img> lo tolera (sniffea bytes), <audio>/<video> no: nunca se vuelven
// reproducibles y no disparan error (silencio total). Por eso se determina
// el MIME por extensión, nunca por blob.type.
const MIME_POR_EXTENSION = {
  html: 'text/html', htm: 'text/html', css: 'text/css',
  js: 'text/javascript', mjs: 'text/javascript', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  mp4: 'video/mp4', webm: 'video/webm',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf'
};
function mimePorRuta(ruta) {
  return MIME_POR_EXTENSION[extension(ruta)] || 'application/octet-stream';
}

// Convierte un Blob a data: URI (base64). Los assets del módulo (img/audio/
// video/css/js referenciados por ruta relativa) se entregan así en vez de
// blob: — ver nota "Partición de blob: URLs" más abajo, en construirDocumentoModulo,
// para el motivo. En trozos de 32 KB para no pisar el límite de argumentos
// de String.fromCharCode.apply en archivos grandes (mismo patrón que
// github-storage.js).
async function blobADataUri(blob, ruta) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000;
  let binario = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binario += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:' + mimePorRuta(ruta) + ';base64,' + btoa(binario);
}

/**
 * Busca el punto de entrada (index.html) dentro del JSZip. Tolera que
 * el paquete venga envuelto en una única carpeta contenedora (patrón
 * típico al comprimir "la carpeta" en vez de "el contenido de la
 * carpeta") — en ese caso ancla el punto de entrada ahí, no en la raíz.
 * @param {JSZip} zip
 * @returns {string|null} ruta del index.html dentro del zip
 */
export function buscarIndexHtml(zip) {
  const candidatos = Object.keys(zip.files)
    .filter(p => !zip.files[p].dir && /(^|\/)index\.html?$/i.test(p))
    .sort((a, b) => a.split('/').length - b.split('/').length); // menor profundidad primero
  return candidatos[0] || null;
}

function carpetaDe(ruta) {
  const i = ruta.lastIndexOf('/');
  return i === -1 ? '' : ruta.slice(0, i + 1);
}

// Sustituye toda ocurrencia literal de una ruta relativa conocida por
// su Blob URL. Se ordenan de más larga a más corta para que una ruta
// como "img/DiapositivaLogo.png" no quede parcialmente pisada por un
// prefijo más corto tipo "img/Diapositiva".
function sustituirRutasLiterales(texto, mapaBlobUrls, propiaRuta) {
  const rutas = [...mapaBlobUrls.keys()]
    .filter(r => r !== propiaRuta)
    .sort((a, b) => b.length - a.length);
  for (const ruta of rutas) {
    if (!texto.includes(ruta)) continue;
    texto = texto.split(ruta).join(mapaBlobUrls.get(ruta));
  }
  return texto;
}

function shimRuntime(mapaPlano) {
  return `(function(){
    var MAPA = ${JSON.stringify(mapaPlano)};
    function limpiar(ruta){ return String(ruta).replace(/^\\.\\//, ''); }
    function resolver(ruta){
      if (!ruta || typeof ruta !== 'string') return ruta;
      if (/^([a-z]+:)?\\/\\//i.test(ruta) || /^(data|blob):/i.test(ruta)) return ruta;
      var limpio = limpiar(ruta);
      return Object.prototype.hasOwnProperty.call(MAPA, limpio) ? MAPA[limpio] : ruta;
    }
    // API oficial LMS <-> módulo (contrato documentado, ver drivers.js).
    // Se define ANTES de tocar prototipos nativos: si el parcheo de abajo
    // llegara a fallar en algún navegador, el módulo igual puede reportar
    // su estado al LMS (window.TramarsaLMS nunca queda indefinido).
    // notificar*: el módulo informa su estado al LMS.
    // onComando: el LMS le ordena navegar (lms:siguiente/lms:anterior/
    // lms:reanudar) — el módulo integrado debe ceder su navegación propia
    // a esto y ocultar sus botones/atajos de teclado originales.
    window.TramarsaLMS = {
      notificarIniciado: function(){ parent.postMessage({ tipo:'modulo:iniciado' }, '*'); },
      notificarDiapositiva: function(indice,total){ parent.postMessage({ tipo:'modulo:diapositiva', indice:indice, total:total }, '*'); },
      notificarAudioFinalizado: function(){ parent.postMessage({ tipo:'modulo:audioFinalizado' }, '*'); },
      notificarAvance: function(pct){ parent.postMessage({ tipo:'modulo:avance', pct:pct }, '*'); },
      // Señal puramente visual — barra realmente fluida: se manda UNA vez
      // al empezar cada lámina (no un tick por frame), con el destino y la
      // duración real restante del audio. El LMS arma una transición CSS de
      // esa duración exacta y deja que el navegador interpole solo, sin
      // overhead de postMessage por frame. Separada a propósito de
      // notificarAvance: esa SÍ escribe en Firestore (pasoMaximoAlcanzado) y
      // mezclar el progreso "en vivo, aún no confirmado" con el progreso
      // persistido rompería el anti-trampa (avanzar sin terminar el audio).
      notificarSegmentoAudio: function(pctDestino, duracionMs){ parent.postMessage({ tipo:'modulo:segmentoAudio', pctDestino:pctDestino, duracionMs:duracionMs }, '*'); },
      notificarPausado: function(){ parent.postMessage({ tipo:'modulo:pausado' }, '*'); },
      notificarReanudado: function(){ parent.postMessage({ tipo:'modulo:reanudado' }, '*'); },
      notificarFinalizado: function(){ parent.postMessage({ tipo:'modulo:finalizado' }, '*'); },
      onComando: function(fn){
        window.addEventListener('message', function(e){
          var d = e.data || {};
          if (typeof d.tipo === 'string' && d.tipo.indexOf('lms:') === 0) fn(d);
        });
      }
    };

    // Parcheo de rutas relativas construidas en runtime (además de la
    // sustitución estática ya aplicada al texto). Envuelto en try/catch:
    // si algún navegador no permite redefinir estas propiedades, el resto
    // del módulo (y el contrato TramarsaLMS de arriba) sigue funcionando.
    try {
      [
        [HTMLImageElement, 'src'], [HTMLScriptElement, 'src'],
        [HTMLMediaElement, 'src'], [HTMLSourceElement, 'src'],
        [HTMLLinkElement, 'href']
      ].forEach(function(par){
        var Clase = par[0], prop = par[1];
        var d = Object.getOwnPropertyDescriptor(Clase.prototype, prop);
        if (!d || !d.set) return;
        Object.defineProperty(Clase.prototype, prop, {
          configurable: true, enumerable: d.enumerable, get: d.get,
          set: function(v){ d.set.call(this, resolver(v)); }
        });
      });
      var origFetch = window.fetch;
      if (origFetch) window.fetch = function(input, init){
        if (typeof input === 'string') input = resolver(input);
        return origFetch.call(this, input, init);
      };
      var origOpen = XMLHttpRequest.prototype.open;
      XMLHttpRequest.prototype.open = function(metodo, url){
        var args = Array.prototype.slice.call(arguments);
        args[1] = resolver(url);
        return origOpen.apply(this, args);
      };
    } catch (e) { /* ver comentario arriba: TramarsaLMS ya quedó disponible igual */ }
  })();`;
}

function inyectarBootstrap(html, scriptTexto) {
  const tagScript = `<script>${scriptTexto}<\/script>`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + tagScript);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, m => m + '<head>' + tagScript + '</head>');
  return tagScript + html;
}

/**
 * Construye el documento final del módulo listo para <iframe src="...">.
 * @param {JSZip} zip
 * @param {string} rutaIndex ruta del index.html dentro del zip (buscarIndexHtml)
 * @returns {Promise<{url:string, urlsTemporales:string[]}>}
 */
// Inlinea <script src="local.js"> y <link rel="stylesheet" href="local.css">
// con el contenido real del archivo (ya reescrito por la pasada estática).
// Debe correr ANTES de sustituirRutasLiterales sobre el HTML: opera sobre
// las rutas originales ("js/app.js"), no sobre Blob URLs.
function inlinearScriptsYEstilos(html, contenidoTextoPorRuta) {
  html = html.replace(/<script\s+([^>]*)>\s*<\/script>/gi, (match, atributos) => {
    const m = atributos.match(/src\s*=\s*["']([^"']+)["']/i);
    if (!m) return match; // script inline sin src: no toca nada
    const limpio = m[1].replace(/^\.?\//, '');
    if (!contenidoTextoPorRuta.has(limpio)) return match; // externo (http…) u otro: se deja igual
    return `<script>${contenidoTextoPorRuta.get(limpio)}</script>`;
  });
  html = html.replace(/<link\s+([^>]*)>/gi, (match, atributos) => {
    if (!/rel\s*=\s*["']stylesheet["']/i.test(atributos)) return match;
    const m = atributos.match(/href\s*=\s*["']([^"']+)["']/i);
    if (!m) return match;
    const limpio = m[1].replace(/^\.?\//, '');
    if (!contenidoTextoPorRuta.has(limpio)) return match;
    return `<style>${contenidoTextoPorRuta.get(limpio)}</style>`;
  });
  return html;
}

export async function construirDocumentoModulo(zip, rutaIndex) {
  const base = carpetaDe(rutaIndex);
  const rutas = Object.keys(zip.files).filter(p => !zip.files[p].dir && p.startsWith(base));

  const urlsTemporales = [];
  const mapaBlobUrls = new Map(); // ruta relativa a la carpeta del módulo -> data: URI
  const mapaPlano = {};
  const contenidoTextoPorRuta = new Map(); // solo archivos de texto, ya reescritos

  // Partición de blob: URLs (Chrome, política de aislamiento por partición
  // de almacenamiento): un iframe sandbox sin allow-same-origin (origen
  // opaco, aislamiento a propósito — ver drivers.js) ya no puede resolver
  // un blob: URL creado por el documento padre. Esto rompió img/audio/video
  // de todos los módulos (nuevos y ya validados) sin que el código de los
  // módulos ni el driver cambiaran — regresión de plataforma, no de este
  // proyecto. El documento final del módulo (abajo, iframe.src) sigue en
  // blob: porque esa es una NAVEGACIÓN de nivel superior del iframe, no un
  // sub-recurso pedido desde dentro de un documento ya opaco — eso sí sigue
  // funcionando y no hace falta tocarlo. Los assets referenciados DESDE
  // DENTRO del documento (img/audio/css/js) sí necesitan data: URI.
  // Descompresión + codificación en PARALELO (Promise.all), no una a la
  // vez: cada archivo es independiente (map key propia, sin estado
  // compartido) y JSZip/FileReader no se bloquean entre sí. Con un
  // for-of + await secuencial, un módulo con muchas imágenes/audios podía
  // tardar varios segundos extra solo en esta etapa.
  //
  // Bug real de rendimiento corregido: esta pasada codificaba a data: URI
  // TAMBIÉN los archivos de texto (html/css/js/json/svg) usando el Blob
  // binario tal cual venía en el zip — pero la pasada de texto (abajo)
  // los vuelve a codificar igual, esta vez con el contenido YA reescrito
  // (rutas sustituidas), y ese es el que de verdad se usa. El resultado
  // de esta primera pasada para archivos de texto SIEMPRE se pisaba —
  // era una codificación base64 completa por archivo, al pedo. Con
  // módulos de muchos KB de JS/CSS esto duplicaba el trabajo de encoding
  // sin ningún efecto en el resultado final. Ahora esta pasada solo
  // codifica binarios (imágenes/audio/video/fuentes); el texto se
  // codifica una sola vez, en la pasada de abajo.
  await Promise.all(rutas.map(async (ruta) => {
    const relativa = ruta.slice(base.length);
    if (EXT_TEXTO.has(extension(relativa))) return; // lo codifica la pasada de texto, con el contenido correcto
    const blob = await zip.files[ruta].async('blob');
    const url = await blobADataUri(blob, relativa);
    mapaBlobUrls.set(relativa, url);
    mapaPlano[relativa] = url;
  }));

  // Pasada estática: reescribe referencias literales dentro de cada
  // archivo de texto (html/css/js/json/svg), no solo el index.html, y
  // codifica el resultado ya reescrito — única codificación real para
  // estos archivos. También en paralelo, mismo motivo.
  await Promise.all(rutas.map(async (ruta) => {
    const relativa = ruta.slice(base.length);
    if (!EXT_TEXTO.has(extension(relativa))) return;
    let texto = await zip.files[ruta].async('text');
    texto = sustituirRutasLiterales(texto, mapaBlobUrls, relativa);
    contenidoTextoPorRuta.set(relativa, texto);
    // También como data: URI, por si algo más lo referencia dinámicamente
    // (poco común, pero no cuesta nada dejarlo disponible). blob: no sirve
    // aquí por el mismo motivo de partición explicado arriba.
    const blobTexto = new Blob([texto]);
    const urlTexto = await blobADataUri(blobTexto, relativa);
    mapaBlobUrls.set(relativa, urlTexto);
    mapaPlano[relativa] = urlTexto;
  }));

  const rutaIndexRelativa = rutaIndex.slice(base.length);
  let htmlIndex = await zip.files[rutaIndex].async('text');
  htmlIndex = inlinearScriptsYEstilos(htmlIndex, contenidoTextoPorRuta);
  htmlIndex = sustituirRutasLiterales(htmlIndex, mapaBlobUrls, rutaIndexRelativa);
  htmlIndex = inyectarBootstrap(htmlIndex, shimRuntime(mapaPlano));

  const blobFinal = new Blob([htmlIndex], { type: 'text/html' });
  const urlFinal = URL.createObjectURL(blobFinal);
  urlsTemporales.push(urlFinal);

  return { url: urlFinal, urlsTemporales };
}
