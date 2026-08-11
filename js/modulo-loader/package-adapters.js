/* ============================================================
   TRAMARSA LMS — Adaptadores de paquete de módulo
   Normaliza los 3 caminos de carga (.zip, .rar, carpeta arrastrada)
   a UN MISMO resultado: una instancia de JSZip en memoria. Todo el
   resto de la plataforma (admin al subir, reproductor al reproducir)
   trabaja siempre sobre ese JSZip — nunca sabe de dónde vino.
   ============================================================ */

// ---------------------------------------------------------------
// Soporte .rar: libarchive.js (WASM), autohospedado (ver reproductor.js
// histórico: el Worker de tipo módulo que usa la librería no puede
// crearse desde un origen CORS distinto, por eso no está en CDN).
// ---------------------------------------------------------------
let libarchiveListo = null;
function cargarLibarchive() {
  if (!libarchiveListo) {
    libarchiveListo = import('../vendor/libarchive/libarchive.js').then(mod => {
      mod.Archive.init({ workerUrl: 'js/vendor/libarchive/worker-bundle.js' });
      return mod.Archive;
    });
  }
  return libarchiveListo;
}

async function rarAJSZip(archivo) {
  if (location.protocol === 'file:') {
    throw new Error('Los archivos .rar no se pueden abrir ejecutando la plataforma con doble clic (file://). Funciona normal al subir a GitHub Pages o abrir desde cualquier servidor. Mientras tanto, sube el módulo como .zip.');
  }
  const Archive = await cargarLibarchive();
  const archive = await Archive.open(archivo);
  const arbol = await archive.extractFiles();

  const zip = new JSZip();
  (function agregar(nodo, prefijo) {
    for (const [nombre, valor] of Object.entries(nodo)) {
      if (valor instanceof File) zip.file(prefijo + nombre, valor);
      else agregar(valor, prefijo + nombre + '/');
    }
  })(arbol, '');
  return zip;
}

/**
 * Normaliza un archivo (.zip o .rar) a JSZip.
 * @param {File} archivo
 */
export async function archivoAJSZip(archivo) {
  const ext = archivo.name.split('.').pop().toLowerCase();
  if (ext === 'rar') return rarAJSZip(archivo);
  return JSZip.loadAsync(archivo);
}

// ---------------------------------------------------------------
// Soporte carpeta arrastrada/seleccionada: recorre el árbol de
// FileSystemEntry (drag&drop) o la FileList plana con rutas
// webkitRelativePath (<input type="file" webkitdirectory>), y arma
// el mismo JSZip que producirían un .zip o un .rar.
// ---------------------------------------------------------------
function leerEntryArchivo(entry) {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}
function leerEntryDirectorio(entry) {
  const reader = entry.createReader();
  const todos = [];
  return new Promise((resolve, reject) => {
    (function leerLote() {
      reader.readEntries(entradas => {
        if (!entradas.length) { resolve(todos); return; }
        todos.push(...entradas);
        leerLote();
      }, reject);
    })();
  });
}

async function agregarEntryAlZip(zip, entry, rutaBase) {
  if (entry.isFile) {
    const archivo = await leerEntryArchivo(entry);
    zip.file(rutaBase + entry.name, archivo);
  } else if (entry.isDirectory) {
    const hijos = await leerEntryDirectorio(entry);
    for (const hijo of hijos) await agregarEntryAlZip(zip, hijo, rutaBase + entry.name + '/');
  }
}

/**
 * Normaliza una carpeta arrastrada (DataTransferItemList del evento
 * 'drop') a JSZip. Cada item de nivel raíz aporta su propio subárbol.
 * @param {DataTransferItemList} items
 */
export async function carpetaArrastradaAJSZip(items) {
  const zip = new JSZip();
  const entries = Array.from(items)
    .map(item => item.webkitGetAsEntry && item.webkitGetAsEntry())
    .filter(Boolean);
  if (!entries.length) throw new Error('El navegador no permite leer carpetas arrastradas. Usa el selector de carpeta o sube un .zip/.rar.');
  for (const entry of entries) await agregarEntryAlZip(zip, entry, '');
  return zip;
}

/**
 * Normaliza una carpeta elegida vía <input type="file" webkitdirectory>
 * (FileList con .webkitRelativePath) a JSZip.
 * @param {FileList} fileList
 */
export function carpetaSeleccionadaAJSZip(fileList) {
  const zip = new JSZip();
  Array.from(fileList).forEach(archivo => {
    const ruta = archivo.webkitRelativePath || archivo.name;
    zip.file(ruta, archivo);
  });
  return Promise.resolve(zip);
}

/**
 * Reempaqueta un JSZip normalizado como un único archivo .zip real,
 * listo para subir a GitHub — así los 3 caminos de carga (.zip, .rar,
 * carpeta) terminan siempre en el mismo artefacto almacenado.
 * @param {JSZip} zip
 * @param {string} nombreBase nombre de archivo sin extensión
 */
export async function jszipAArchivoZip(zip, nombreBase) {
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  return new File([blob], `${nombreBase}.zip`, { type: 'application/zip' });
}

// El paquete es contenido de terceros (incluida IA): se valida antes de
// guardarlo. Esto no intenta interpretar el diseño, solo comprueba el
// contrato reproducible y evita formatos/rutas que el LMS nunca ejecutaría.
export async function validarPaqueteModulo(zip) {
  const entradas = Object.entries(zip.files).filter(([, entry]) => !entry.dir);
  if (!entradas.length) throw new Error('El paquete no contiene archivos.');
  if (entradas.length > 300) throw new Error('El paquete supera el límite de 300 archivos.');

  let pesoDescomprimido = 0;
  for (const [ruta, entry] of entradas) {
    if (ruta.startsWith('/') || ruta.split('/').includes('..') || ruta.includes('\\')) {
      throw new Error(`El paquete contiene una ruta no permitida: ${ruta}`);
    }
    if (/\.(exe|dll|bat|cmd|ps1|sh|php|py|jar)$/i.test(ruta)) {
      throw new Error(`El paquete contiene un tipo de archivo no permitido: ${ruta}`);
    }
    pesoDescomprimido += Number(entry._data && entry._data.uncompressedSize) || 0;
  }
  if (pesoDescomprimido > 120 * 1024 * 1024) {
    throw new Error('El contenido descomprimido supera el límite de 120 MB.');
  }

  const manifests = entradas.filter(([ruta]) => /(^|\/)manifest\.json$/i.test(ruta));
  const indices = entradas.filter(([ruta]) => /(^|\/)index\.html?$/i.test(ruta));
  if (!manifests.length && !indices.length) {
    throw new Error('El paquete debe incluir manifest.json (formato recomendado) o index.html (compatibilidad).');
  }
  if (!manifests.length) return { formato: 'legacy', archivos: entradas.length, pesoDescomprimido };

  const [rutaManifest, entradaManifest] = manifests.sort(([a], [b]) => a.split('/').length - b.split('/').length)[0];
  let manifest;
  try { manifest = JSON.parse(await entradaManifest.async('text')); }
  catch (_) { throw new Error('El manifest.json no contiene JSON válido.'); }
  if (manifest.version !== 2 || !Array.isArray(manifest.laminas) || !manifest.laminas.length) {
    throw new Error('El manifest debe declarar version: 2 y al menos una lámina.');
  }
  if (manifest.laminas.length > 80) throw new Error('El paquete supera el límite de 80 láminas.');

  const base = rutaManifest.slice(0, rutaManifest.lastIndexOf('/') + 1);
  const existe = ruta => typeof ruta === 'string' && !!zip.files[base + ruta];
  if (manifest.css && !existe(manifest.css)) throw new Error(`No existe el CSS declarado: ${manifest.css}`);
  if (manifest.contenido && !existe(manifest.contenido)) throw new Error(`No existe el contenido declarado: ${manifest.contenido}`);
  for (const [i, lamina] of manifest.laminas.entries()) {
    if (!lamina || typeof lamina !== 'object') throw new Error(`La lámina ${i + 1} no es válida.`);
    if (!lamina.imagen && !lamina.html && !manifest.contenido) {
      throw new Error(`La lámina ${i + 1} debe declarar imagen, html o usar contenido compartido.`);
    }
    for (const ruta of [lamina.imagen, lamina.html, lamina.audio].filter(Boolean)) {
      if (!existe(ruta)) throw new Error(`No existe "${ruta}" declarado en la lámina ${i + 1}.`);
    }
  }
  return { formato: 'v2', archivos: entradas.length, pesoDescomprimido, laminas: manifest.laminas.length };
}
