/* ============================================================
   TRAMARSA LMS — Resolutor virtual de assets
   Toma un JSZip (ya normalizado por package-adapters.js) y produce
   un documento HTML autocontenido en un Blob URL, listo para montar
   en un <iframe>. El módulo puede referenciar css/js/img/audio/video/
   fonts/json/lo-que-sea con rutas relativas normales: el LMS nunca
   inspecciona ni asume esa estructura.

   Estrategia en 2 pasadas (necesarias ambas, no una u otra):
   1) Estática: reemplaza en el texto de cada archivo html/css/js/json
      cualquier ocurrencia literal de una ruta relativa conocida por su
      Blob URL — cubre <link>, <script src>, <img src>, url() de CSS,
      manifest.json, etc. declarados directamente en el código fuente.
   2) Runtime: un shim inyectado como primer <script> del documento
      intercepta fetch/XHR y los setters de .src de imagen/audio/video/
      script — cubre rutas armadas dinámicamente en JS (ej. un módulo
      que hace `'img/Diapositiva' + n + '.png'` en tiempo de ejecución,
      donde la pasada estática no tiene un literal completo que buscar).
   ============================================================ */

const EXT_TEXTO = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg']);

function extension(ruta) {
  return ruta.split('.').pop().toLowerCase();
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
export async function construirDocumentoModulo(zip, rutaIndex) {
  const base = carpetaDe(rutaIndex);
  const rutas = Object.keys(zip.files).filter(p => !zip.files[p].dir && p.startsWith(base));

  const urlsTemporales = [];
  const mapaBlobUrls = new Map(); // ruta relativa a la carpeta del módulo -> blob URL
  const mapaPlano = {};

  for (const ruta of rutas) {
    const relativa = ruta.slice(base.length);
    const blob = await zip.files[ruta].async('blob');
    const url = URL.createObjectURL(blob);
    urlsTemporales.push(url);
    mapaBlobUrls.set(relativa, url);
    mapaPlano[relativa] = url;
  }

  // Pasada estática: reescribe referencias literales dentro de cada
  // archivo de texto (html/css/js/json/svg), no solo el index.html.
  for (const ruta of rutas) {
    const relativa = ruta.slice(base.length);
    if (!EXT_TEXTO.has(extension(relativa))) continue;
    let texto = await zip.files[ruta].async('text');
    texto = sustituirRutasLiterales(texto, mapaBlobUrls, relativa);
    const blobTexto = new Blob([texto], { type: relativa.endsWith('.css') ? 'text/css' : relativa.match(/\.m?js$/) ? 'text/javascript' : 'text/plain' });
    const urlTexto = URL.createObjectURL(blobTexto);
    urlsTemporales.push(urlTexto);
    mapaBlobUrls.set(relativa, urlTexto);
    mapaPlano[relativa] = urlTexto;
  }

  const rutaIndexRelativa = rutaIndex.slice(base.length);
  let htmlIndex = await zip.files[rutaIndex].async('text');
  htmlIndex = sustituirRutasLiterales(htmlIndex, mapaBlobUrls, rutaIndexRelativa);
  htmlIndex = inyectarBootstrap(htmlIndex, shimRuntime(mapaPlano));

  const blobFinal = new Blob([htmlIndex], { type: 'text/html' });
  const urlFinal = URL.createObjectURL(blobFinal);
  urlsTemporales.push(urlFinal);

  return { url: urlFinal, urlsTemporales };
}
