
"use strict";

// ==========================================================
// CONFIGURACIÓN
// ==========================================================

const API_BASE_URL =
    "https://agente-investigador-tic-dun.vercel.app";

const STORAGE_KEY = "agente_tic_historial_v1";
const MAX_HISTORIAL = 25;
const MAX_PREGUNTA = 3000;

// ==========================================================
// ELEMENTOS
// ==========================================================

const $ = id => document.getElementById(id);

const btnInvestigar = $("btnInvestigar");
const btnNueva = $("btnNueva");
const btnPDF = $("btnPDF");
const btnCopiar = $("btnCopiar");

const pregunta = $("pregunta");
const contadorCaracteres = $("contadorCaracteres");
const actividad = $("actividad");
const estadoActual = $("estadoActual");
const previewContent = $("previewContent");
const fuentesEnVivo = $("fuentesEnVivo");
const fuentesFinales = $("fuentesFinales");
const contadorFuentes = $("contadorFuentes");
const contadorFuentesFinal = $("contadorFuentesFinal");
const resultado = $("resultado");
const reporte = $("reporte");
const errorPanel = $("error");

const listaHistorial = $("listaHistorial");
const buscarHistorial = $("buscarHistorial");
const sidebar = $("sidebar");
const sidebarOverlay = $("sidebarOverlay");

let fuentesConsultadas = [];
let reporteCompleto = "";
let historial = cargarHistorial();
let investigacionActualId = null;
let investigando = false;
let controlador = null;

// ==========================================================
// EVENTOS
// ==========================================================

btnInvestigar.addEventListener("click", investigar);
btnNueva.addEventListener("click", nuevaInvestigacion);
btnPDF.addEventListener("click", exportarPDF);
btnCopiar.addEventListener("click", copiarReporte);

$("btnBorrarHistorial").addEventListener(
    "click", borrarHistorial
);

$("abrirSidebar").addEventListener(
    "click", () => cambiarSidebar(true)
);

$("cerrarSidebar").addEventListener(
    "click", () => cambiarSidebar(false)
);

sidebarOverlay.addEventListener(
    "click", () => cambiarSidebar(false)
);

buscarHistorial.addEventListener(
    "input", renderizarHistorial
);

pregunta.addEventListener("input", () => {
    contadorCaracteres.textContent =
        `${pregunta.value.length} / ${MAX_PREGUNTA} caracteres`;
});

pregunta.addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        investigar();
    }
});

renderizarHistorial();

// ==========================================================
// INVESTIGACIÓN
// ==========================================================

async function investigar() {
    if (investigando) return;

    const textoPregunta = pregunta.value.trim();

    if (!textoPregunta) {
        mostrarError("Escribe una pregunta de investigación.");
        return;
    }

    if (textoPregunta.length > MAX_PREGUNTA) {
        mostrarError("La pregunta supera el límite permitido.");
        return;
    }

    prepararInterfaz();
    investigando = true;
    controlador = new AbortController();
    btnInvestigar.disabled = true;

    let recibioCompletado = false;

    try {
        const respuesta = await fetch(
            `${API_BASE_URL}/api/investigar`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    pregunta: textoPregunta
                }),
                signal: controlador.signal
            }
        );

        if (!respuesta.body) {
            throw new Error(
                "El servidor no proporcionó un flujo de datos."
            );
        }

        const resultadoStream = await procesarStream(respuesta);

        recibioCompletado = resultadoStream.completado;

        if (!respuesta.ok && !resultadoStream.conError) {
            throw new Error(
                `Error HTTP ${respuesta.status} al investigar.`
            );
        }

        if (!recibioCompletado && !resultadoStream.conError) {
            throw new Error(
                "La investigación terminó sin confirmación del servidor."
            );
        }

        if (recibioCompletado) {
            guardarInvestigacion(textoPregunta);
        }

    } catch (err) {
        if (err.name === "AbortError") {
            mostrarError("Investigación cancelada.");
        } else {
            mostrarError(
                err.message || "No se pudo realizar la investigación."
            );
        }
    } finally {
        investigando = false;
        controlador = null;
        btnInvestigar.disabled = false;
    }
}

// ==========================================================
// LECTOR DE SSE
// ==========================================================

async function procesarStream(respuesta) {
    const reader = respuesta.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    let completado = false;
    let conError = false;

    function manejarBloque(bloque) {
        const resultadoEvento = procesarEventoSSE(bloque);

        if (resultadoEvento === "completado") {
            completado = true;
        }

        if (resultadoEvento === "error") {
            conError = true;
        }
    }

    while (true) {
        const { value, done } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");

        const bloques = buffer.split("\n\n");
        buffer = bloques.pop();

        for (const bloque of bloques) {
            if (bloque.trim()) manejarBloque(bloque);
        }
    }

    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n");

    if (buffer.trim()) {
        manejarBloque(buffer);
    }

    return { completado, conError };
}

function procesarEventoSSE(bloque) {
    const lineas = bloque.split("\n");

    let tipo = "message";
    const datos = [];

    for (const linea of lineas) {
        if (linea.startsWith("event:")) {
            tipo = linea.slice(6).trim();
        }

        if (linea.startsWith("data:")) {
            datos.push(linea.slice(5).trimStart());
        }
    }

    if (!datos.length) return null;

    let contenido;

    try {
        contenido = JSON.parse(datos.join("\n"));
    } catch {
        return null;
    }

    switch (tipo) {
        case "estado":
            actualizarEstado(
                contenido.etapa,
                contenido.mensaje
            );
            break;

        case "fuente":
            agregarFuente(contenido);
            break;

        case "texto":
            reporteCompleto += contenido.delta || "";
            actualizarPreview();
            break;

        case "completado":
            reporteCompleto =
                contenido.reporte || reporteCompleto;

            finalizarInvestigacion();
            return "completado";

        case "error":
            mostrarError(
                contenido.mensaje ||
                "La investigación se interrumpió."
            );
            return "error";
    }

    return null;
}

// ==========================================================
// INTERFAZ DE PROCESAMIENTO
// ==========================================================

function prepararInterfaz() {
    fuentesConsultadas = [];
    reporteCompleto = "";
    investigacionActualId = null;

    errorPanel.classList.add("d-none");
    resultado.classList.add("d-none");
    actividad.classList.remove("d-none");

    reporte.innerHTML = "";
    fuentesFinales.innerHTML = "";
    fuentesEnVivo.innerHTML = "";

    contadorFuentes.textContent = "0";
    contadorFuentesFinal.textContent = "0";

    previewContent.textContent =
        "El agente está preparando la investigación...";

    actualizarEstado(
        "analizando",
        "Analizando y verificando la pregunta..."
    );
}

function actualizarEstado(etapa, mensaje) {
    estadoActual.textContent = mensaje || "";

    const orden = [
        "analizando",
        "busqueda",
        "revision",
        "finalizando"
    ];

    const indiceActual = orden.indexOf(etapa);

    document.querySelectorAll(".process-step").forEach(paso => {
        const indice = orden.indexOf(paso.dataset.etapa);

        paso.classList.remove("active", "complete");

        if (indiceActual < 0) return;

        if (indice < indiceActual) {
            paso.classList.add("complete");
        } else if (indice === indiceActual) {
            paso.classList.add("active");
        }
    });
}

function actualizarPreview() {
    const texto = limpiarMarkdownBasico(reporteCompleto);
    previewContent.textContent = texto.slice(-3500);
    previewContent.scrollTop = previewContent.scrollHeight;
}

function finalizarInvestigacion() {
    document.querySelectorAll(".process-step").forEach(paso => {
        paso.classList.remove("active");
        paso.classList.add("complete");
    });

    estadoActual.textContent = "Investigación completada.";

    mostrarReporte();

    resultado.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

function mostrarReporte() {
    renderizarReporteFinal(reporteCompleto);
    renderizarFuentesFinales();
    renderizarFuentesEnVivo();

    resultado.classList.remove("d-none");
}

function mostrarError(mensaje) {
    errorPanel.textContent = mensaje || "Ocurrió un error.";
    errorPanel.classList.remove("d-none");

    if (!actividad.classList.contains("d-none")) {
        estadoActual.textContent =
            "La investigación se interrumpió.";
    }
}

// ==========================================================
// FUENTES
// ==========================================================

function agregarFuente(fuente) {
    const url = normalizarUrl(fuente?.url);

    if (!url) return;

    if (fuentesConsultadas.some(f => f.url === url)) {
        return;
    }

    fuentesConsultadas.push({
        url,
        titulo: String(fuente.titulo || obtenerDominio(url)),
        origen: String(fuente.origen || "web")
    });

    actualizarContadores();
    renderizarFuentesEnVivo();
}

function actualizarContadores() {
    const total = String(fuentesConsultadas.length);
    contadorFuentes.textContent = total;
    contadorFuentesFinal.textContent = total;
}

function renderizarFuentesEnVivo() {
    fuentesEnVivo.innerHTML = "";

    if (!fuentesConsultadas.length) {
        fuentesEnVivo.textContent =
            "Esperando las fuentes del agente...";
        return;
    }

    fuentesConsultadas.forEach(fuente => {
        const tarjeta = document.createElement("div");
        tarjeta.className = "live-source-card";

        const enlace = document.createElement("a");
        enlace.href = fuente.url;
        enlace.target = "_blank";
        enlace.rel = "noopener noreferrer";
        enlace.textContent =
            fuente.titulo || obtenerDominio(fuente.url);

        const dominio = document.createElement("div");
        dominio.className = "source-domain";
        dominio.textContent = obtenerDominio(fuente.url);

        tarjeta.append(enlace, dominio);
        fuentesEnVivo.appendChild(tarjeta);
    });

    fuentesEnVivo.scrollTop = fuentesEnVivo.scrollHeight;
}

function renderizarFuentesFinales() {
    fuentesFinales.innerHTML = "";

    actualizarContadores();

    if (!fuentesConsultadas.length) {
        fuentesFinales.innerHTML =
            "<p class='text-muted'>Sin fuentes disponibles.</p>";
        return;
    }

    fuentesConsultadas.forEach((fuente, indice) => {
        const tarjeta = document.createElement("article");
        tarjeta.className = "source-ref-card";

        const numero = document.createElement("small");
        numero.textContent = `REFERENCIA ${indice + 1}`;

        const enlace = document.createElement("a");
        enlace.href = fuente.url;
        enlace.target = "_blank";
        enlace.rel = "noopener noreferrer";
        enlace.textContent =
            fuente.titulo || obtenerDominio(fuente.url);

        const url = document.createElement("small");
        url.textContent = fuente.url;

        tarjeta.append(numero, enlace, url);
        fuentesFinales.appendChild(tarjeta);
    });
}

// ==========================================================
// REPORTE ACADÉMICO
// ==========================================================

function renderizarReporteFinal(markdown) {
    const parsed = parseStructuredMarkdown(markdown);

    const secciones = [
        ["1. Pregunta de investigación", "bi-question-circle"],
        ["2. Plan de investigación", "bi-diagram-3"],
        ["3. Hallazgos principales", "bi-journal-check"],
        ["4. Comparación de información", "bi-table"],
        ["5. Coincidencias y diferencias entre fuentes", "bi-shuffle"],
        ["6. Tendencias identificadas", "bi-graph-up-arrow"],
        ["7. Conclusiones", "bi-patch-check"]
    ];

    const resumen =
        parsed.sections["1. Pregunta de investigación"] || "";

    let html = `
        <header class="report-hero">
            <span class="eyebrow">REPORTE ACADÉMICO · ITIC</span>
            <h2>${escaparHTML(parsed.title)}</h2>
            <p>${escaparHTML(
                limpiarMarkdownBasico(resumen).slice(0, 350)
            )}</p>
        </header>
    `;

    for (const [nombre, icono] of secciones) {
        const contenido = parsed.sections[nombre] || "";

        let cuerpo;

        if (nombre.startsWith("2.")) {
            cuerpo = renderPlan(contenido);
        } else if (nombre.startsWith("3.")) {
            cuerpo = renderHallazgos(contenido);
        } else if (nombre.startsWith("4.")) {
            cuerpo = renderComparacion(contenido);
        } else {
            cuerpo = markdownToHtml(contenido);
        }

        html += `
            <article class="report-card">
                <div class="report-card-header">
                    <div class="report-card-icon">
                        <i class="bi ${icono}"></i>
                    </div>
                    <h3>${escaparHTML(nombre)}</h3>
                </div>
                <div class="report-card-body">
                    ${cuerpo}
                </div>
            </article>
        `;
    }

    reporte.innerHTML = html;
}

function parseStructuredMarkdown(markdown) {
    const lines = String(markdown || "")
        .replace(/\r/g, "")
        .split("\n");

    let title = "Reporte de investigación";
    let current = null;

    const sections = {};

    for (const line of lines) {
        const titulo = line.match(/^#\s+(.+)$/);
        const seccion = line.match(/^##\s+(.+)$/);

        if (titulo) {
            title = titulo[1].trim();
        } else if (seccion) {
            current = seccion[1].trim();
            sections[current] = "";
        } else if (current) {
            sections[current] += line + "\n";
        }
    }

    return { title, sections };
}

function renderPlan(texto) {
    const items = extraerBullets(texto);

    if (!items.length) {
        return markdownToHtml(texto);
    }

    return `
        <div class="plan-grid">
            ${items.map((item, index) => `
                <div class="plan-step">
                    <div class="plan-number">${index + 1}</div>
                    <p>${escaparHTML(item)}</p>
                </div>
            `).join("")}
        </div>
    `;
}

function renderHallazgos(texto) {
    const bloques = String(texto || "")
        .split(/(?=^###\s+Hallazgo\s+\d+)/gmi)
        .map(item => item.trim())
        .filter(Boolean);

    const hallazgos = [];

    for (const bloque of bloques) {
        if (!/^###\s+Hallazgo\s+\d+/im.test(bloque)) {
            continue;
        }

        const nombre = extraerCampo(
            bloque, "Nombre", ["Descripción", "Fuente", "URL"]
        );

        const descripcion = extraerCampo(
            bloque, "Descripción", ["Fuente", "URL"]
        );

        const fuente = extraerCampo(
            bloque, "Fuente", ["URL"]
        );

        const url = normalizarUrl(
            extraerCampo(bloque, "URL", [])
        );

        hallazgos.push({
            nombre,
            descripcion,
            fuente,
            url
        });
    }

    if (!hallazgos.length) {
        return markdownToHtml(texto);
    }

    return `
        <div class="findings-showcase">
            ${hallazgos.map((h, i) => `
                <article class="finding-item">
                    <span class="finding-index">
                        HALLAZGO ${String(i + 1).padStart(2, "0")}
                    </span>

                    <h4 class="finding-name">
                        ${escaparHTML(
                            limpiarMarkdownBasico(h.nombre) ||
                            `Hallazgo ${i + 1}`
                        )}
                    </h4>

                    <span class="finding-section-label">
                        Descripción
                    </span>

                    <p class="finding-description-text">
                        ${escaparHTML(
                            limpiarMarkdownBasico(h.descripcion)
                        )}
                    </p>

                    <div class="finding-source-panel">
                        <span class="finding-section-label">
                            Fuente consultada
                        </span>

                        <strong>
                            ${escaparHTML(
                                limpiarMarkdownBasico(h.fuente) ||
                                "No especificada"
                            )}
                        </strong>

                        ${h.url ? `
                            <div>
                                <a href="${escaparHTML(h.url)}"
                                   target="_blank"
                                   rel="noopener noreferrer">
                                    Abrir fuente
                                    <i class="bi bi-box-arrow-up-right"></i>
                                </a>
                            </div>
                        ` : ""}
                    </div>
                </article>
            `).join("")}
        </div>
    `;
}

function extraerCampo(bloque, campo, siguientes = []) {
    const etiqueta = new RegExp(
        `\\*\\*${campo}:\\*\\*\\s*`, "i"
    );

    const inicio = etiqueta.exec(bloque);

    if (!inicio) return "";

    const start = inicio.index + inicio[0].length;
    let end = bloque.length;

    for (const siguiente of siguientes) {
        const regex = new RegExp(
            `\\n\\s*\\*\\*${siguiente}:\\*\\*`, "i"
        );

        const resultado = regex.exec(bloque.slice(start));

        if (resultado) {
            end = Math.min(end, start + resultado.index);
        }
    }

    return bloque.slice(start, end).trim();
}

function renderComparacion(texto) {
    const filas = String(texto || "")
        .split("\n")
        .map(linea => linea.trim())
        .filter(linea => /^\|/.test(linea));

    if (filas.length < 3) {
        return markdownToHtml(texto);
    }

    const separar = fila => fila
        .replace(/^\||\|$/g, "")
        .split("|")
        .map(celda => celda.trim());

    const encabezados = separar(filas[0]);
    const cuerpo = filas.slice(2).map(separar);

    return `
        <div class="compare-table-wrap">
            <table class="compare-table">
                <thead>
                    <tr>
                        ${encabezados.map(columna =>
                            `<th>${escaparHTML(columna)}</th>`
                        ).join("")}
                    </tr>
                </thead>
                <tbody>
                    ${cuerpo.map(fila => `
                        <tr>
                            ${encabezados.map((_, i) =>
                                `<td>${escaparHTML(fila[i] || "")}</td>`
                            ).join("")}
                        </tr>
                    `).join("")}
                </tbody>
            </table>
        </div>
    `;
}

function markdownToHtml(texto) {
    const lineas = String(texto || "").split("\n");

    let html = "";
    let listaAbierta = false;

    function cerrarLista() {
        if (listaAbierta) {
            html += "</ul>";
            listaAbierta = false;
        }
    }

    for (const raw of lineas) {
        const linea = raw.trim();

        if (!linea) {
            cerrarLista();
            continue;
        }

        if (/^###\s+/.test(linea)) {
            cerrarLista();
            html += `<h4>${formatearInline(
                linea.replace(/^###\s+/, "")
            )}</h4>`;
            continue;
        }

        if (/^[-*•]\s+/.test(linea)) {
            if (!listaAbierta) {
                html += "<ul>";
                listaAbierta = true;
            }

            html += `<li>${formatearInline(
                linea.replace(/^[-*•]\s+/, "")
            )}</li>`;

            continue;
        }

        cerrarLista();

        html += `<p>${formatearInline(linea)}</p>`;
    }

    cerrarLista();

    return html || "<p>Sin contenido disponible.</p>";
}

function formatearInline(texto) {
    return escaparHTML(texto)
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
}

function extraerBullets(texto) {
    return String(texto || "")
        .split("\n")
        .map(linea => linea.trim())
        .filter(linea => /^[-*•]\s+/.test(linea))
        .map(linea => linea.replace(/^[-*•]\s+/, ""));
}

// ==========================================================
// HISTORIAL LOCAL
// ==========================================================

function cargarHistorial() {
    try {
        const datos = JSON.parse(
            localStorage.getItem(STORAGE_KEY) || "[]"
        );

        return Array.isArray(datos) ? datos : [];
    } catch {
        return [];
    }
}

function persistirHistorial() {
    try {
        localStorage.setItem(
            STORAGE_KEY,
            JSON.stringify(historial)
        );
        return true;
    } catch (err) {
        console.error("Error guardando historial:", err);
        mostrarError(
            "La investigación terminó, pero no pudo guardarse " +
            "en el historial de este navegador."
        );
        return false;
    }
}

function guardarInvestigacion(textoPregunta) {
    const id = crypto.randomUUID();

    const titulo = textoPregunta.length > 70
        ? textoPregunta.slice(0, 70) + "..."
        : textoPregunta;

    const registro = {
        id,
        titulo,
        pregunta: textoPregunta,
        reporte: reporteCompleto,
        fuentes: [...fuentesConsultadas],
        fecha: new Date().toISOString()
    };

    historial.unshift(registro);
    historial = historial.slice(0, MAX_HISTORIAL);

    investigacionActualId = id;

    persistirHistorial();
    renderizarHistorial();
}

function renderizarHistorial() {
    const filtro = buscarHistorial.value.trim().toLowerCase();

    listaHistorial.innerHTML = "";

    const elementos = historial.filter(item =>
        item.titulo.toLowerCase().includes(filtro) ||
        item.pregunta.toLowerCase().includes(filtro)
    );

    if (!elementos.length) {
        listaHistorial.innerHTML = `
            <div class="history-empty">
                No hay investigaciones para mostrar.
            </div>
        `;
        return;
    }

    for (const item of elementos) {
        const tarjeta = document.createElement("div");
        tarjeta.className = "history-item";

        if (item.id === investigacionActualId) {
            tarjeta.classList.add("active");
        }

        const abrir = document.createElement("button");
        abrir.className = "history-open";

        const titulo = document.createElement("strong");
        titulo.textContent = item.titulo;

        const fecha = document.createElement("small");

        const fechaValida = new Date(item.fecha);

        fecha.textContent = Number.isNaN(fechaValida.getTime())
            ? "Sin fecha"
            : fechaValida.toLocaleString("es-MX");

        abrir.append(titulo, fecha);
        abrir.addEventListener("click", () =>
            abrirInvestigacion(item.id)
        );

        const acciones = document.createElement("div");
        acciones.className = "history-actions";

        const renombrar = document.createElement("button");
        renombrar.title = "Renombrar";
        renombrar.setAttribute("aria-label", "Renombrar investigación");
        renombrar.innerHTML = '<i class="bi bi-pencil"></i>';

        renombrar.addEventListener("click", () =>
            renombrarInvestigacion(item.id)
        );

        const eliminar = document.createElement("button");
        eliminar.title = "Eliminar";
        eliminar.setAttribute("aria-label", "Eliminar investigación");
        eliminar.innerHTML = '<i class="bi bi-trash"></i>';

        eliminar.addEventListener("click", () =>
            eliminarInvestigacion(item.id)
        );

        acciones.append(renombrar, eliminar);
        tarjeta.append(abrir, acciones);
        listaHistorial.appendChild(tarjeta);
    }
}

function abrirInvestigacion(id) {
    if (investigando) {
        alert("Espera a que termine la investigación actual.");
        return;
    }

    const item = historial.find(x => x.id === id);

    if (!item) return;

    investigacionActualId = item.id;

    pregunta.value = item.pregunta;
    reporteCompleto = item.reporte;
    fuentesConsultadas = [...item.fuentes];

    contadorCaracteres.textContent =
        `${pregunta.value.length} / ${MAX_PREGUNTA} caracteres`;

    errorPanel.classList.add("d-none");
    actividad.classList.add("d-none");

    mostrarReporte();
    renderizarHistorial();
    cambiarSidebar(false);

    resultado.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

function renombrarInvestigacion(id) {
    const item = historial.find(x => x.id === id);

    if (!item) return;

    const nuevo = prompt(
        "Nuevo nombre de la investigación:",
        item.titulo
    );

    if (nuevo === null || !nuevo.trim()) return;

    item.titulo = nuevo.trim().slice(0, 100);

    persistirHistorial();
    renderizarHistorial();
}

function eliminarInvestigacion(id) {
    if (!confirm("¿Eliminar esta investigación del historial?")) {
        return;
    }

    historial = historial.filter(item => item.id !== id);

    if (investigacionActualId === id) {
        investigacionActualId = null;
    }

    persistirHistorial();
    renderizarHistorial();
}

function borrarHistorial() {
    if (!historial.length) return;

    if (!confirm("¿Eliminar todo el historial guardado?")) {
        return;
    }

    historial = [];
    investigacionActualId = null;

    persistirHistorial();
    renderizarHistorial();
}

function nuevaInvestigacion() {
    if (investigando) {
        if (!confirm("¿Cancelar la investigación en curso?")) {
            return;
        }

        controlador?.abort();
    }

    investigacionActualId = null;
    reporteCompleto = "";
    fuentesConsultadas = [];

    pregunta.value = "";
    contadorCaracteres.textContent = "0 / 3000 caracteres";

    resultado.classList.add("d-none");
    actividad.classList.add("d-none");
    errorPanel.classList.add("d-none");

    reporte.innerHTML = "";
    fuentesFinales.innerHTML = "";

    renderizarHistorial();
    cambiarSidebar(false);

    window.scrollTo({ top: 0, behavior: "smooth" });
    pregunta.focus();
}

function cambiarSidebar(abierto) {
    sidebar.classList.toggle("open", abierto);
    sidebarOverlay.classList.toggle("show", abierto);
}

// ==========================================================
// EXPORTACIÓN PDF
// ==========================================================

async function exportarPDF() {
    if (!reporteCompleto.trim()) {
        mostrarError("No existe un reporte para exportar.");
        return;
    }

    if (typeof html2pdf === "undefined") {
        mostrarError("No se pudo cargar el generador PDF.");
        return;
    }

    const original = btnPDF.innerHTML;
    btnPDF.disabled = true;
    btnPDF.textContent = "Generando PDF...";

    const contenedor = document.createElement("div");
    contenedor.className = "pdf-export";

    const encabezado = document.createElement("div");
    encabezado.style.padding = "10px 12px 22px";
    encabezado.innerHTML = `
        <h2 style="margin:0;font-size:22px;color:#18243a">
            Instituto Tecnológico de Pachuca
        </h2>
        <p style="margin:8px 0;font-size:13px">
            Ingeniería en Tecnologías de la Información
            y Comunicaciones
        </p>
        <p style="font-size:12px">
            Agente Investigador TIC · Práctica 2.2
        </p>
    `;

    contenedor.appendChild(encabezado);

    const contenido = $("documentoExportar").cloneNode(true);
    contenido.removeAttribute("id");

    contenedor.appendChild(contenido);

    contenedor.style.position = "fixed";
    contenedor.style.left = "-12000px";
    contenedor.style.top = "0";
    document.body.appendChild(contenedor);

    const opciones = {
        margin: 8,
        filename: `investigacion-tic-${Date.now()}.pdf`,
        image: {
            type: "jpeg",
            quality: 0.98
        },
        html2canvas: {
            scale: 1.5,
            useCORS: true,
            windowWidth: 1000,
            scrollX: 0,
            scrollY: 0
        },
        jsPDF: {
            unit: "mm",
            format: "a4",
            orientation: "portrait"
        },
        pagebreak: {
            mode: ["css", "legacy"]
        }
    };

    try {
        await html2pdf()
            .set(opciones)
            .from(contenedor)
            .save();
    } catch (err) {
        console.error(err);
        mostrarError("No se pudo generar el archivo PDF.");
    } finally {
        contenedor.remove();
        btnPDF.disabled = false;
        btnPDF.innerHTML = original;
    }
}

// ==========================================================
// COPIAR REPORTE
// ==========================================================

async function copiarReporte() {
    if (!reporteCompleto.trim()) {
        mostrarError("No hay un reporte para copiar.");
        return;
    }

    const fuentes = fuentesConsultadas
        .map((item, i) => `${i + 1}. ${item.url}`)
        .join("\n");

    const texto = [
        reporteCompleto,
        "",
        "FUENTES CONSULTADAS",
        fuentes
    ].join("\n");

    try {
        await navigator.clipboard.writeText(texto);

        const original = btnCopiar.innerHTML;

        btnCopiar.textContent = "¡Copiado!";

        setTimeout(() => {
            btnCopiar.innerHTML = original;
        }, 1800);

    } catch {
        mostrarError("No se pudo copiar el reporte.");
    }
}

// ==========================================================
// UTILIDADES
// ==========================================================

function escaparHTML(texto) {
    const div = document.createElement("div");
    div.textContent = String(texto ?? "");
    return div.innerHTML;
}

function normalizarUrl(valor) {
    if (!valor) return "";

    const texto = String(valor).trim();
    const markdown = texto.match(
        /\[[^\]]*\]\((https?:\/\/[^)]+)\)/
    );

    const candidata = markdown
        ? markdown[1]
        : (texto.match(/https?:\/\/[^\s)\]]+/i) || [])[0];

    if (!candidata) return "";

    try {
        const url = new URL(
            candidata.replace(/[.,;]+$/, "")
        );

        return ["https:", "http:"].includes(url.protocol)
            ? url.href
            : "";
    } catch {
        return "";
    }
}

function obtenerDominio(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, "");
    } catch {
        return "Fuente web";
    }
}

function limpiarMarkdownBasico(texto) {
    return String(texto || "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*/g, "")
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1")
        .trim();
}
