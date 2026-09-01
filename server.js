require('dotenv').config();
const PORT = process.env.PORT || 3000;
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');
const { PDFDocument } = require('pdf-lib');

const app = express();
app.use(express.static('public'));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- CONFIGURACIÓN MOODLE ---
// Define MOODLE_URL y MOODLE_TOKEN en tu archivo .env (nunca los dejes escritos en el código).
// MOODLE_URL=https://campus.newhorizons.edu.pe
// MOODLE_TOKEN=2eac31943fb1c4c775c2c0009fbcc3ef
const MOODLE_URL = (process.env.MOODLE_URL || '').replace(/\/+$/, '');
const MOODLE_TOKEN = process.env.MOODLE_TOKEN || '';
const MOODLE_ENDPOINT = `${MOODLE_URL}/webservice/rest/server.php`;

const CARPETA_CERTIFICADOS = path.join(__dirname, 'certificados_generados');
const QR_GLOBAL_PATH = path.join(__dirname, 'public/images/codeqr.png');

if (!fsSync.existsSync(CARPETA_CERTIFICADOS)) {
    fsSync.mkdirSync(CARPETA_CERTIFICADOS, { recursive: true });
}
if (!fsSync.existsSync(path.join(__dirname, 'public/images'))) {
    fsSync.mkdirSync(path.join(__dirname, 'public/images'), { recursive: true });
}

// --- UTILIDADES MOODLE ---

// Convierte objetos anidados/arrays en la notación de corchetes que exige el REST de Moodle.
// Ej: { options: { ids: [123] } } => { "options[ids][0]": 123 }
function aplanarParametrosMoodle(obj, prefijo = '') {
    let params = {};
    for (const key in obj) {
        const valor = obj[key];
        const nuevaClave = prefijo ? `${prefijo}[${key}]` : key;
        if (valor !== null && typeof valor === 'object') {
            Object.assign(params, aplanarParametrosMoodle(valor, nuevaClave));
        } else if (valor !== undefined) {
            params[nuevaClave] = valor;
        }
    }
    return params;
}

// Llama a cualquier función del Web Service de Moodle (moodlewsrestformat=json)
async function moodleCall(wsfunction, params = {}) {
    if (!MOODLE_URL || !MOODLE_TOKEN) {
        throw new Error('MOODLE_URL o MOODLE_TOKEN no están configurados en el .env');
    }
    const parametrosFinales = aplanarParametrosMoodle({
        wstoken: MOODLE_TOKEN,
        wsfunction,
        moodlewsrestformat: 'json',
        ...params
    });
    const { data } = await axios.get(MOODLE_ENDPOINT, { params: parametrosFinales });

    // Moodle responde 200 OK incluso en errores; el error viene dentro del JSON.
    if (data && data.exception) {
        const err = new Error(data.message || data.exception);
        err.moodleError = data;
        throw err;
    }
    return data;
}

// --- UTILIDADES GENERALES ---
const getImagenBase64 = (nombreArchivo) => {
    try {
        const ruta = path.join(process.cwd(), 'public/images', nombreArchivo);
        if (fsSync.existsSync(ruta)) {
            const data = fsSync.readFileSync(ruta, { encoding: 'base64' });
            return `data:image/png;base64,${data}`;
        }
    } catch (e) {
        console.error(`Error cargando ${nombreArchivo}:`, e.message);
    }
    return "";
};

// Formatea una fecha ISO (usada por los formularios/manual)
const formatearFecha = (fechaISO) => {
    if (!fechaISO || fechaISO === "No definida") return "---";
    const fecha = new Date(fechaISO);
    return new Intl.DateTimeFormat('es-PE', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    }).format(fecha);
};

// Formatea un timestamp UNIX (segundos), tal como los devuelve la API de Moodle
// (startdate / enddate de core_course_get_courses)
const formatearFechaUnix = (timestampSegundos) => {
    if (!timestampSegundos) return "---";
    const fecha = new Date(timestampSegundos * 1000);
    return new Intl.DateTimeFormat('es-PE', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC'
    }).format(fecha);
};

// Fecha de hoy en formato largo español
const getFechaHoy = () => {
    return new Intl.DateTimeFormat('es-PE', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }).format(new Date());
};

function renderizarCertificado(app, datos) {
    const logoSrc = getImagenBase64('logoNH.png');
    const firmaFijaSrc = getImagenBase64('firma_juan.png');
    const fondoPath = path.join(__dirname, 'public', 'images', 'fondo_certificado.png');
    const fondoBase64 = fsSync.readFileSync(fondoPath, { encoding: 'base64' });
    const fondoSrc = `data:image/png;base64,${fondoBase64}`;

    // --- LÓGICA PARA EL QR GLOBAL ---
    let qrSrc = "";
    if (datos.incluirQR === 'on' || datos.incluirQR === 'true' || datos.incluirQR === true) {
        try {
            const qrPath = path.join(__dirname, 'public', 'images', 'codeqr.png');
            const qrBase64 = fsSync.readFileSync(qrPath, { encoding: 'base64' });
            qrSrc = `data:image/png;base64,${qrBase64}`;
        } catch (err) {
            console.error("Error al cargar el archivo QR PNG:", err);
        }
    }

    return new Promise((resolve, reject) => {
        app.render('certificado', {
            nombreAlumno: datos.nombre,
            nombreCurso: datos.curso,
            creditos: datos.creditos,
            tipoHoras: datos.tipoHoras || 'académicas',
            inicio: datos.inicio,
            fin: datos.fin,
            nombreDocente: datos.docente,
            codigoNH: datos.codigo,
            logoSrc,
            firmaFijaSrc,
            fondoSrc,
            qrSrc: qrSrc,
            firmaDocenteSrc: datos.firmaManual || "",
            fechaEmision: datos.fechaEmision || getFechaHoy(),
            nota: datos.nota || ""
        }, (err, html) => {
            if (err) return reject(err);
            resolve(html);
        });
    });
}

// --- RENDERIZADO DE CONSTANCIA ---
function renderizarConstancia(app, datos) {

    function toTitleCase(str) {
        if (!str) return '';
        return str.toLowerCase().replace(/(?:^|\s)\S/g, (letra) => letra.toUpperCase());
    }

    const firmaFijaSrc = getImagenBase64('firma_juan.png');
    const fondoPath = path.join(__dirname, 'public', 'images', 'fondo_constancia.png');
    const fondoBase64 = fsSync.readFileSync(fondoPath, { encoding: 'base64' });
    const fondoSrc = `data:image/png;base64,${fondoBase64}`;

    const fontPath = path.join(__dirname, 'public', 'fonts', 'DancingScript[wght].ttf');
    const fontBase64 = fsSync.readFileSync(fontPath, { encoding: 'base64' });
    const fontSrc = `data:font/truetype;base64,${fontBase64}`;

    return new Promise((resolve, reject) => {
        app.render('constancia', {
            nombreAlumno: datos.nombre,
            nombreCurso: datos.curso,
            creditos: datos.creditos,
            tipoHoras: datos.tipoHoras || 'académicas',
            inicio: datos.inicio,
            fin: datos.fin,
            nombreDocente: toTitleCase(datos.docente),
            codigoNH: datos.codigo,
            firmaFijaSrc,
            fondoSrc,
            fontSrc,
            firmaDocenteSrc: datos.firmaManual || "",
            fechaEmision: datos.fechaEmision || getFechaHoy()
        }, (err, html) => {
            if (err) return reject(err);
            resolve(html);
        });
    });
}

function renderizarCartaITIL(app, datos) {
    const fondoPath = path.join(__dirname, 'public', 'images', 'fondo_carta itil.png');
    const fondoBase64 = fsSync.readFileSync(fondoPath, { encoding: 'base64' });
    const fondoSrc = `data:image/png;base64,${fondoBase64}`;

    const fontPath = path.join(__dirname, 'public', 'fonts', 'DancingScript[wght].ttf');
    const fontBase64 = fsSync.readFileSync(fontPath, { encoding: 'base64' });
    const fontSrc = `data:font/truetype;base64,${fontBase64}`;

    return new Promise((resolve, reject) => {
        app.render('cartaitil', {
            nombreAlumno: datos.nombre,
            nombreCurso: datos.curso,
            creditos: datos.creditos,
            tipoHoras: datos.tipoHoras || 'académicas',
            inicio: datos.inicio,
            fin: datos.fin,
            nombreDocente: datos.docente,
            codigoNH: datos.codigo,
            fondoSrc,
            fontSrc,
            firmaDocenteSrc: datos.firmaManual || "",
            fechaEmision: datos.fechaEmision || getFechaHoy()
        }, (err, html) => {
            if (err) return reject(err);
            resolve(html);
        });
    });
}

// --- GENERACIÓN DE PDF CON PUPPETEER ---
async function generarPDF(html, orientacion = 'landscape') {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
            format: 'A4',
            landscape: orientacion === 'landscape',
            printBackground: true
        });
        return pdf;
    } finally {
        await browser.close();
    }
}

// --- MERGE CERTIFICADO + TEMARIO ---
async function mergeConTemario(certificadoPdfBytes, temarioBase64) {
    if (!temarioBase64) return certificadoPdfBytes;
    try {
        const base64Data = temarioBase64.includes(',') ? temarioBase64.split(',')[1] : temarioBase64;
        const temarioBytes = Buffer.from(base64Data, 'base64');

        const docFinal = await PDFDocument.create();

        const docCert = await PDFDocument.load(certificadoPdfBytes);
        const pagsCert = await docFinal.copyPages(docCert, docCert.getPageIndices());
        pagsCert.forEach(p => docFinal.addPage(p));

        const docTemario = await PDFDocument.load(temarioBytes);
        const pagsTemario = await docFinal.copyPages(docTemario, docTemario.getPageIndices());
        pagsTemario.forEach(p => docFinal.addPage(p));

        return Buffer.from(await docFinal.save());
    } catch (e) {
        console.error('Error al mergear temario:', e.message);
        return certificadoPdfBytes;
    }
}

function nombreArchivoSeguro(nombre, codigo, prefijo = 'Certificado') {
    const limpio = nombre.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, '').replace(/\s+/g, '_');
    return `${prefijo}_${limpio}_${codigo}.pdf`;
}

// --- RUTAS ---

app.get('/', (req, res) => {
    res.render('index', {
        alumnos: [], cursoNombre: null, docenteNombre: null,
        fechaInicio: null, fechaFin: null,
        horasAcademicas: null, horasCronologicas: null,
        cursoId: '', total: 0
    });
});


app.post('/buscar', async (req, res) => {
    const { cursoId } = req.body;
    try {
        // 1) Obtener datos del curso
        const cursos = await moodleCall('core_course_get_courses', {
            options: { ids: [cursoId] }
        });
        if (!cursos || cursos.length === 0) {
            throw new Error('No se encontró ningún curso con ese ID en Moodle');
        }
        const curso = cursos[0];

        // 2) Extraer Horas Cronológicas desde customfields (shortname: "hours")
        let hCronologicas = 0;
        if (Array.isArray(curso.customfields)) {
            const fieldHours = curso.customfields.find(f => f.shortname === 'hours');
            if (fieldHours && fieldHours.value) {
                hCronologicas = parseFloat(fieldHours.value) || 0;
            }
        }

        // 3) Calcular Horas Académicas: (Horas Cronológicas * 16) / 12
        const hAcademicas = Math.round((hCronologicas * 16) / 12);

        // 4) Usuarios matriculados (docentes + alumnos)
        const usuarios = await moodleCall('core_enrol_get_enrolled_users', {
            courseid: cursoId
        });

        const tieneRol = (usuario, shortnames) =>
            Array.isArray(usuario.roles) && usuario.roles.some(r => shortnames.includes(r.shortname));

        const docente = (usuarios || []).find(u => tieneRol(u, ['editingteacher', 'teacher']));
        const nombreDocente = docente
            ? `${docente.lastname} ${docente.firstname}`.toUpperCase()
            : "POR ASIGNAR";

        let todosLosAlumnos = (usuarios || [])
            .filter(u => tieneRol(u, ['student']))
            .map(u => ({ nombre: `${u.lastname} ${u.firstname}`.toUpperCase() }));

        todosLosAlumnos.sort((a, b) => a.nombre.localeCompare(b.nombre));
        const alumnosFinal = todosLosAlumnos.map((alu, i) => ({
            ...alu,
            codigo: `NH-${cursoId}-${(i + 1).toString().padStart(3, '0')}`
        }));

        res.render('index', {
            alumnos: alumnosFinal,
            cursoNombre: curso.fullname,
            docenteNombre: nombreDocente,
            fechaInicio: formatearFechaUnix(curso.startdate),
            fechaFin: formatearFechaUnix(curso.enddate),
            horasAcademicas: hAcademicas.toString(),
            horasCronologicas: hCronologicas.toString(),
            cursoId,
            total: alumnosFinal.length
        });
    } catch (e) {
        console.error("Error al buscar el curso en Moodle:", e.moodleError || e.message);
        res.status(500).send("Error al buscar el curso. Verifica el ID y la conexión con Moodle.");
    }
});


app.post('/api/generar-pdf-individual', async (req, res) => {
    try {
        const datos = req.body;
        const html = await renderizarCertificado(app, datos);
        let pdf = await generarPDF(html, 'landscape');
        pdf = await mergeConTemario(pdf, datos.temarioPDF || null);
        const archivo = nombreArchivoSeguro(datos.nombre, datos.codigo, 'Certificado');
        await fs.writeFile(path.join(CARPETA_CERTIFICADOS, archivo), pdf);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
        res.send(pdf);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al generar: ' + e.message });
    }
});

app.post('/api/generar-pdf-individual-constancia', async (req, res) => {
    try {
        const datos = req.body;
        const html = await renderizarConstancia(app, datos);
        let pdf = await generarPDF(html, 'portrait');
        pdf = await mergeConTemario(pdf, datos.temarioPDF || null);
        const archivo = nombreArchivoSeguro(datos.nombre, datos.codigo, 'Constancia');
        await fs.writeFile(path.join(CARPETA_CERTIFICADOS, archivo), pdf);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
        res.send(pdf);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al generar constancia: ' + e.message });
    }
});

app.post('/api/generar-pdf-individual-cartaitil', async (req, res) => {
    try {
        const datos = req.body;
        const html = await renderizarCartaITIL(app, datos);
        let pdf = await generarPDF(html, 'portrait');
        pdf = await mergeConTemario(pdf, datos.temarioPDF || null);
        const archivo = nombreArchivoSeguro(datos.nombre, datos.codigo, 'CartaITIL');
        await fs.writeFile(path.join(CARPETA_CERTIFICADOS, archivo), pdf);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
        res.send(pdf);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al generar carta ITIL: ' + e.message });
    }
});

// --- GENERAR LOTE (certificados o constancias) ---
app.post('/api/generar-lote', async (req, res) => {
    const { alumnos, cursoNombre, docenteNombre, fechaInicio, fechaFin, creditos, firmaManual, tipo, incluirQR, temarioPDF } = req.body;
    if (!alumnos || alumnos.length === 0) return res.status(400).json({ error: 'Sin alumnos.' });

    const esConstancia = tipo === 'constancia';
    const esCartaITIL = tipo === 'cartaitil';
    const resultados = [];

    for (const alumno of alumnos) {
        try {
            const datos = {
                nombre: alumno.nombre,
                codigo: alumno.codigo,
                curso: cursoNombre,
                docente: docenteNombre,
                inicio: fechaInicio,
                fin: fechaFin,
                creditos,
                firmaManual: esConstancia ? "" : firmaManual,
                incluirQR: incluirQR,
                nota: alumno.nota || ""
            };
            const html = esCartaITIL
                ? await renderizarCartaITIL(app, datos)
                : esConstancia
                    ? await renderizarConstancia(app, datos)
                    : await renderizarCertificado(app, datos);
            let pdf = await generarPDF(html, (esConstancia || esCartaITIL) ? 'portrait' : 'landscape');
            pdf = await mergeConTemario(pdf, temarioPDF || null);
            const prefijo = esCartaITIL ? 'CartaITIL' : (esConstancia ? 'Constancia' : 'Certificado');
            const archivo = nombreArchivoSeguro(alumno.nombre, alumno.codigo, prefijo);
            await fs.writeFile(path.join(CARPETA_CERTIFICADOS, archivo), pdf);
            resultados.push({ nombre: alumno.nombre, estado: 'ok' });
        } catch (e) {
            resultados.push({ nombre: alumno.nombre, estado: 'error' });
        }
    }
    res.json({ mensaje: "Proceso completado", resultados });
});

// --- SUBIR FIRMA ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/images/'),
    filename: (req, file, cb) => {
        const nombreDocente = req.body.nombreDocenteFirma.replace(/\s+/g, '_').toUpperCase();
        const extension = path.extname(file.originalname).toLowerCase();
        cb(null, `firma_${nombreDocente}${extension}`);
    }
});
const upload = multer({ storage });

app.post('/api/subir-firma', upload.single('archivoFirma'), (req, res) => {
    if (!req.file) return res.status(400).send('No se subió archivo.');
    res.send(`<script>alert("Firma guardada en servidor"); window.location.href="/";</script>`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Shukita v3 (Moodle) disponible en puerto ${PORT}`);
});