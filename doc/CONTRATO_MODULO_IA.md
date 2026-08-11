# Contrato de módulo v2 para IA

La IA puede crear el contenido visual, pero no controla el aprendizaje. El LMS
mantiene el audio, el avance, la evaluación y el certificado.

Un paquete v2 contiene `manifest.json`, `contenido.html`, una carpeta `audio/`
con MP3, `Preguntas.txt` y, si corresponde, un PDF de certificado. El manifiesto
declara una lámina por cada audio:

```json
{
  "version": 2,
  "contenido": "contenido.html",
  "lienzo": { "ancho": 1920, "alto": 1080 },
  "laminas": [
    { "audio": "audio/01-introduccion.mp3" },
    { "audio": "audio/02-concepto.mp3" }
  ]
}
```

`contenido.html` debe tener exactamente una sección `<section class="slide">`
por lámina, en el mismo orden que `laminas`. Puede usar HTML, CSS y JavaScript
decorativo propio para gráficos, contadores, animaciones y estados visuales.
No debe crear botones de siguiente/anterior, reproducir audio, enviar datos,
acceder a red, crear formularios ni decidir que el módulo terminó. El iframe
visual no tiene acceso al LMS y aplica una CSP que bloquea recursos de red.

La IA debe entregar también preguntas en formato `Preguntas.txt`. Las respuestas
correctas solo se interpretan cuando el administrador carga el banco de preguntas;
no deben vivir dentro del HTML visual. Antes de la carga, el LMS valida rutas,
referencias, tamaño y estructura del paquete.

La carpeta `plantillas/modulo-v2-html-dinamico` contiene una base visual reutilizable.
