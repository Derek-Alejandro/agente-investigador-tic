
"use strict";

// =====================================================
// CONFIGURACIÓN
// =====================================================

const API_BASE_URL =
    "https://agente-investigador-tic-dun.vercel.app";

const STORAGE_KEY = "agente_tic_historial_v1";
const MAX_HISTORIAL = 25;
const MAX_PREGUNTA = 3000;

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
let generacionActual = 0;

// =====================================================
// INICIALIZACIÓN
// =====================================================

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

pregunta.addEventListener("input", actualizarCaracteres);

pregunta.addEventListener("keydown", evento => {
    if (evento.key === "Enter" &&
        (evento.ctrlKey || evento.metaKey)) {
        evento.preventDefault();
        investigar();
    }
});

actualizarCaracteres();
renderizarHistorial();

function actualizarCaracteres() {
    contadorCaracteres.textContent =
        `${pregunta.value.length} / ${MAX_PREGUNTA} caracteres`;
}

// =====================================================
// INVESTIGACIÓN CON VERCEL
// =====================================================

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
    btnInvestigar.disabled = true;

    const token = ++generacionActual;
    const abort = new AbortController();
    controlador = abort;

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
                signal: abort.signal
            }
        );

        if (!respuesta.body) {
            throw new Error(
                "El servidor no proporcionó un flujo de datos."
            );
        }

        const estado = await procesarStream(
            respuesta,
            token
        );

        if (token !== generacionActual) return;

        if (!respuesta.ok && !estado.error) {
            throw new Error(
                `Error HTTP ${respuesta.status}.`
            );
        }

        if (!estado.completado && !estado.error) {
            throw new Error(
                "La investigación terminó sin confirmación."
            );
        }

        if (estado.completado) {
            guardarInvestigacion(textoPregunta);
        }

    } catch (err) {
        if (token !== generacionActual) return;

        if (err.name === "AbortError") {
            mostrarError("Investigación cancelada.");
        } else {
            mostrarError(
                err.message ||
                "No fue posible realizar la investigación."
            );
        }

    } finally {
        if (token === generacionActual) {
            investigando = false;
            controlador = null;
            btnInvestigar.disabled = false;
        }
    }
}

// =====================================================
// LECTURA DEL STREAM SSE
// =====================================================

async function procesarStream(respuesta, token) {
    const reader = respuesta.body.getReader();
    const decoder = new TextDecoder("utf-8");

    let buffer = "";
    const estado = {
        completado: false,
        error: false
    };

    function procesarBloque(bloque) {
        if (token !== generacionActual) return;

        const tipo = procesarEventoSSE(bloque);

        if (tipo === "completado") {
            estado.completado = true;
        }

        if (tipo === "error") {
            estado.error = true;
        }
    }

    try {
        while (true) {
            const { value, done } = await reader.read();

            if (done || token !== generacionActual) break;

            buffer += decoder.decode(value, {
                stream: true
            });

            buffer = buffer.replace(/\r\n?/g, "\n");

            const bloques = buffer.split("\n\n");
            buffer = bloques.pop() || "";

            for (const bloque of bloques) {
                if (bloque.trim()) {
                    procesarBloque(bloque);
                }
            }
        }

        buffer += decoder.decode();

        if (buffer.trim() && token === generacionActual) {
            procesarBloque(buffer);
        }

    } finally {
        reader.releaseLock();
    }

    return estado;
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
                "El servidor interrumpió la investigación."
            );

            return "error";
    }

    return null;
}

// =====================================================
// INTERFAZ DE INVESTIGACIÓN
// =====================================================

function prepararInterfaz() {
    fuentesConsultadas = [];
    reporteCompleto = "";
    investigacionActualId = null;

    errorPanel.classList.add("d-none");
    resultado.classList.add("d-none");
    actividad.classList.remove("d-none");

    reporte.replaceChildren();
    fuentesFinales.replaceChildren();
    fuentesEnVivo.replaceChildren();

    actualizarContadores();

    previewContent.textContent =
        "El agente está preparando la investigación...";

    actualizarEstado(
        "analizando",
        "Verificando la temática de la consulta..."
    );

    renderizarHistorial();
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

    document.querySelectorAll(".process-step")
        .forEach(paso => {
            const indice = orden.indexOf(
                paso.dataset.etapa
            );

            paso.classList.remove(
                "active",
                "complete"
            );

            if (indiceActual < 0) return;

            if (indice < indiceActual) {
                paso.classList.add("complete");
            } else if (indice === indiceActual) {
                paso.classList.add("active");
            }
        });
}

function actualizarPreview() {
    previewContent.textContent =
        limpiarMarkdownBasico(reporteCompleto)
            .slice(-3500);

    previewContent.scrollTop =
        previewContent.scrollHeight;
}

function finalizarInvestigacion() {
    document.querySelectorAll(".process-step")
        .forEach(paso => {
            paso.classList.remove("active");
            paso.classList.add("complete");
        });

    estadoActual.textContent =
        "Investigación completada.";

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
    errorPanel.textContent =
        mensaje || "Ocurrió un error.";

    errorPanel.classList.remove("d-none");

    if (!actividad.classList.contains("d-none")) {
        estadoActual.textContent =
            "La investigación se interrumpió.";
    }
}

// =====================================================
// FUENTES CONSULTADAS
// =====================================================

function agregarFuente(fuente) {
    const url = normalizarUrl(fuente?.url);

    if (!url) return;

    if (fuentesConsultadas.some(
        item => item.url === url
    )) {
        return;
    }

    fuentesConsultadas.push({
        url,
        titulo: String(
            fuente.titulo || obtenerDominio(url)
        ),
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
    fuentesEnVivo.replaceChildren();

    if (!fuentesConsultadas.length) {
        fuentesEnVivo.textContent =
            "Esperando fuentes consultadas...";
        return;
    }

    for (const fuente of fuentesConsultadas) {
        const tarjeta = document.createElement("div");
        tarjeta.className = "live-source-card";

        const enlace = document.createElement("a");
        enlace.href = fuente.url;
        enlace.target = "_blank";
        enlace.rel = "noopener noreferrer";
        enlace.textContent = fuente.titulo;

        const dominio = document.createElement("div");
        dominio.className = "source-domain";
        dominio.textContent =
            obtenerDominio(fuente.url);

        tarjeta.append(enlace, dominio);
        fuentesEnVivo.appendChild(tarjeta);
    }

    fuentesEnVivo.scrollTop =
        fuentesEnVivo.scrollHeight;
}

function renderizarFuentesFinales() {
    fuentesFinales.replaceChildren();

    actualizarContadores();

    if (!fuentesConsultadas.length) {
        const aviso = document.createElement("p");
        aviso.className = "text-muted";
        aviso.textContent =
            "No se recibieron referencias web.";

        fuentesFinales.appendChild(aviso);
        return;
    }

    fuentesConsultadas.forEach((fuente, indice) => {
        const tarjeta = document.createElement("article");
        tarjeta.className = "source-ref-card";

        const numero = document.createElement("small");
        numero.textContent =
            `REFERENCIA ${indice + 1}`;

        const enlace = document.createElement("a");
        enlace.href = fuente.url;
        enlace.target = "_blank";
        enlace.rel = "noopener noreferrer";
        enlace.textContent = fuente.titulo;

        const url = document.createElement("small");
        url.textContent = fuente.url;

        tarjeta.append(numero, enlace, url);
        fuentesFinales.appendChild(tarjeta);
    });
}

// =====================================================
// RENDERIZADO DEL REPORTE
// =====================================================

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
            <span class="eyebrow">
                REPORTE ACADÉMICO · ITIC
            </span>
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
    const lineas = String(markdown || "")
        .replace(/\r/g, "")
        .split("\n");

    let title = "Reporte de investigación";
    let actual = null;

    const sections = {};

    for (const linea of lineas) {
        const titulo = linea.match(/^#\s+(.+)$/);
        const seccion = linea.match(/^##\s+(.+)$/);

        if (titulo) {
            title = titulo[1].trim();
        } else if (seccion) {
            actual = seccion[1].trim();
            sections[actual] = "";
        } else if (actual) {
            sections[actual] += linea + "\n";
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
            ${items.map((item, indice) => `
                <div class="plan-step">
                    <div class="plan-number">
                        ${indice + 1}
                    </div>
                    <p>${escaparHTML(item)}</p>
                </div>
            `).join("")}
        </div>
    `;
}

function renderHallazgos(texto) {
    const bloques = String(texto || "")
        .split(/(?=^###\s+Hallazgo\s+\d+)/gmi)
        .map(b => b.trim())
        .filter(Boolean);

    const hallazgos = [];

    for (const bloque of bloques) {
        if (!/^###\s+Hallazgo\s+\d+/im.test(bloque)) {
            continue;
        }

        const encabezado = bloque.match(
            /^###\s+Hallazgo\s+\d+(?:\s*:\s*(.+))?/im
        );

        const nombre = extraerCampo(
            bloque,
            "Nombre",
            ["Descripción", "Fuente", "URL"]
        ) || encabezado?.[1] || "Hallazgo";

        const descripcion = extraerCampo(
            bloque,
            "Descripción",
            ["Fuente", "URL"]
        );

        const fuente = extraerCampo(
            bloque,
            "Fuente",
            ["URL"]
        );

        const url = normalizarUrl(
            extraerCampo(bloque, "URL")
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
                            limpiarMarkdownBasico(h.nombre)
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
    const inicioRegex = new RegExp(
        `\\*\\*${campo}:\\*\\*\\s*`,
        "i"
    );

    const inicio = inicioRegex.exec(bloque);

    if (!inicio) return "";

    const start = inicio.index + inicio[0].length;
    let end = bloque.length;

    for (const siguiente of siguientes) {
        const regex = new RegExp(
            `\\n\\s*\\*\\*${siguiente}:\\*\\*`,
            "i"
        );

        const match = regex.exec(bloque.slice(start));

        if (match) {
            end = Math.min(
                end,
                start + match.index
            );
        }
    }

    return bloque.slice(start, end).trim();
}

function renderComparacion(texto) {
    const filas = String(texto || "")
        .split("\n")
        .map(linea => linea.trim())
        .filter(linea => linea.startsWith("|"));

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
                        ${encabezados.map(col =>
                            `<th>${escaparHTML(col)}</th>`
                        ).join("")}
                    </tr>
                </thead>

                <tbody>
                    ${cuerpo.map(fila => `
                        <tr>
                            ${encabezados.map((_, i) => `
                                <td>
                                    ${escaparHTML(fila[i] || "")}
                                </td>
                            `).join("")}
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
        .map(x => x.trim())
        .filter(x => /^[-*•]\s+/.test(x))
        .map(x => x.replace(/^[-*•]\s+/, ""));
}

// =====================================================
// HISTORIAL LOCAL
// =====================================================

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
    } catch {
        mostrarError(
            "No se pudo guardar el historial en este navegador."
        );
        return false;
    }
}

function guardarInvestigacion(textoPregunta) {
    const id = (
        crypto.randomUUID?.() ||
        `${Date.now()}-${Math.random()}`
    );

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
    const filtro = buscarHistorial.value
        .trim()
        .toLowerCase();

    listaHistorial.replaceChildren();

    const elementos = historial.filter(item =>
        String(item.titulo || "")
            .toLowerCase()
            .includes(filtro) ||
        String(item.pregunta || "")
            .toLowerCase()
            .includes(filtro)
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

        fecha.textContent =
            Number.isNaN(fechaValida.getTime())
                ? "Sin fecha"
                : fechaValida.toLocaleString("es-MX");

        abrir.append(titulo, fecha);
        abrir.addEventListener(
            "click",
            () => abrirInvestigacion(item.id)
        );

        const acciones = document.createElement("div");
        acciones.className = "history-actions";

        const renombrar = document.createElement("button");
        renombrar.title = "Renombrar";
        renombrar.setAttribute(
            "aria-label",
            "Renombrar investigación"
        );
        renombrar.innerHTML =
            '<i class="bi bi-pencil"></i>';

        renombrar.addEventListener(
            "click",
            () => renombrarInvestigacion(item.id)
        );

        const eliminar = document.createElement("button");
        eliminar.title = "Eliminar";
        eliminar.setAttribute(
            "aria-label",
            "Eliminar investigación"
        );
        eliminar.innerHTML =
            '<i class="bi bi-trash"></i>';

        eliminar.addEventListener(
            "click",
            () => eliminarInvestigacion(item.id)
        );

        acciones.append(renombrar, eliminar);
        tarjeta.append(abrir, acciones);
        listaHistorial.appendChild(tarjeta);
    }
}

function abrirInvestigacion(id) {
    if (investigando) {
        alert(
            "Espera a que termine la investigación actual."
        );
        return;
    }

    const item = historial.find(x => x.id === id);

    if (!item) return;

    investigacionActualId = item.id;

    pregunta.value = item.pregunta;
    reporteCompleto = item.reporte;
    fuentesConsultadas = [...(item.fuentes || [])];

    actualizarCaracteres();

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
    if (!confirm(
        "¿Eliminar esta investigación del historial?"
    )) {
        return;
    }

    historial = historial.filter(
        item => item.id !== id
    );

    if (investigacionActualId === id) {
        investigacionActualId = null;
    }

    persistirHistorial();
    renderizarHistorial();
}

function borrarHistorial() {
    if (!historial.length) return;

    if (!confirm(
        "¿Eliminar todo el historial guardado?"
    )) {
        return;
    }

    historial = [];
    investigacionActualId = null;

    persistirHistorial();
    renderizarHistorial();
}

function nuevaInvestigacion() {
    if (investigando) {
        if (!confirm(
            "¿Cancelar la investigación en curso?"
        )) {
            return;
        }

        generacionActual++;
        controlador?.abort();

        investigando = false;
        controlador = null;
        btnInvestigar.disabled = false;
    }

    investigacionActualId = null;
    reporteCompleto = "";
    fuentesConsultadas = [];

    pregunta.value = "";
    actualizarCaracteres();

    resultado.classList.add("d-none");
    actividad.classList.add("d-none");
    errorPanel.classList.add("d-none");

    reporte.replaceChildren();
    fuentesFinales.replaceChildren();

    renderizarHistorial();
    cambiarSidebar(false);

    window.scrollTo({
        top: 0,
        behavior: "smooth"
    });

    pregunta.focus();
}

function cambiarSidebar(abierto) {
    sidebar.classList.toggle("open", abierto);
    sidebarOverlay.classList.toggle("show", abierto);
}

// =====================================================
// EXPORTACIÓN PDF CORREGIDA
// =====================================================

async function exportarPDF() {
    if (!reporteCompleto.trim()) {
        mostrarError(
            "No existe un reporte para exportar."
        );
        return;
    }

    if (typeof html2pdf === "undefined") {
        mostrarError(
            "No se pudo cargar la biblioteca PDF."
        );
        return;
    }

    const contenidoOriginal =
        $("documentoExportar");

    if (!contenidoOriginal) {
        mostrarError(
            "No se encontró el documento para exportar."
        );
        return;
    }

    const botonOriginal = btnPDF.innerHTML;
    let capaPDF = null;

    btnPDF.disabled = true;

    btnPDF.innerHTML = `
        <span class="spinner-border spinner-border-sm me-2"></span>
        Generando PDF...
    `;

    errorPanel.classList.add("d-none");

    try {
        // Capa temporal situada dentro del área capturable.
        // No usamos display:none ni coordenadas negativas.

        capaPDF = document.createElement("div");
        capaPDF.className = "pdf-capture-layer";

        const documento = document.createElement("div");
        documento.className = "pdf-export";

        // Encabezado institucional.

        const encabezado = document.createElement("header");
        encabezado.className = "pdf-institution-header";

        const instituto = document.createElement("h2");
        instituto.textContent =
            "Instituto Tecnológico de Pachuca";

        const carrera = document.createElement("p");
        carrera.textContent =
            "Ingeniería en Tecnologías de la Información y Comunicaciones";

        const actividadPDF = document.createElement("p");
        actividadPDF.textContent =
            "Inteligencia Artificial Aplicada a las TIC · Práctica 2.2";

        const autor = document.createElement("p");
        autor.textContent =
            "Derek Alejandro Vargas Meneses · 22200792";

        encabezado.append(
            instituto,
            carrera,
            actividadPDF,
            autor
        );

        documento.appendChild(encabezado);

        // Clonar los resultados y fuentes.

        const contenido =
            contenidoOriginal.cloneNode(true);

        contenido.removeAttribute("id");

        documento.appendChild(contenido);
        capaPDF.appendChild(documento);

        document.body.appendChild(capaPDF);

        // Esperar al cálculo de fuentes y estilos.

        await document.fonts.ready;

        await new Promise(resolve => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });

        // Validación: no generar PDF vacío.

        const textoDocumento =
            documento.textContent.trim();

        if (
            !textoDocumento.includes(
                "Hallazgos principales"
            ) ||
            !textoDocumento.includes(
                "Conclusiones"
            )
        ) {
            throw new Error(
                "El reporte no tiene todas sus secciones."
            );
        }

        const opciones = {
            margin: [10, 10, 10, 10],

            filename:
                `Reporte_Investigacion_TIC_${Date.now()}.pdf`,

            image: {
                type: "jpeg",
                quality: 0.98
            },

            html2canvas: {
                scale: 1.5,
                useCORS: true,
                backgroundColor: "#ffffff",
                scrollX: 0,
                scrollY: 0,
                logging: false
            },

            jsPDF: {
                unit: "mm",
                format: "a4",
                orientation: "portrait"
            },

            pagebreak: {
                mode: ["css", "legacy"],
                avoid: [
                    ".finding-item",
                    ".plan-step",
                    ".source-ref-card"
                ]
            }
        };

        await html2pdf()
            .set(opciones)
            .from(documento)
            .save();

    } catch (err) {
        console.error(
            "Error de exportación PDF:",
            err
        );

        mostrarError(
            "No se pudo exportar el reporte: " +
            (err.message || "Error desconocido.")
        );

    } finally {
        capaPDF?.remove();

        btnPDF.innerHTML = botonOriginal;
        btnPDF.disabled = false;
    }
}

// =====================================================
// COPIAR REPORTE
// =====================================================

async function copiarReporte() {
    if (!reporteCompleto.trim()) {
        mostrarError("No hay un reporte para copiar.");
        return;
    }

    const fuentes = fuentesConsultadas
        .map((item, indice) =>
            `${indice + 1}. ${item.url}`
        )
        .join("\n");

    const texto = [
        reporteCompleto,
        "",
        "FUENTES CONSULTADAS",
        fuentes
    ].join("\n");

    const original = btnCopiar.innerHTML;

    try {
        await navigator.clipboard.writeText(texto);

        btnCopiar.innerHTML = `
            <i class="bi bi-check2 me-2"></i>
            ¡Copiado!
        `;

        setTimeout(() => {
            btnCopiar.innerHTML = original;
        }, 1800);

    } catch {
        mostrarError(
            "No fue posible copiar el reporte."
        );
    }
}

// =====================================================
// UTILIDADES Y SEGURIDAD
// =====================================================

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
        : (
            texto.match(
                /https?:\/\/[^\s)\]]+/i
            ) || []
        )[0];

    if (!candidata) return "";

    try {
        const url = new URL(
            candidata.replace(/[.,;]+$/, "")
        );

        if (!["https:", "http:"].includes(
            url.protocol
        )) {
            return "";
        }

        return url.href;
    } catch {
        return "";
    }
}

function obtenerDominio(url) {
    try {
        return new URL(url)
            .hostname
            .replace(/^www\./, "");
    } catch {
        return "Fuente web";
    }
}

function limpiarMarkdownBasico(texto) {
    return String(texto || "")
        .replace(/^#{1,6}\s+/gm, "")
        .replace(/\*\*/g, "")
        .replace(
            /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
            "$1"
        )
        .trim();
}
