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
