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

// --- CONFIGURACIÓN ---
const API_KEY = 'c602f00b4dafe00e89fabb34a53862d49d4ae0947fe8323b96c7';
const DOMINIO = 'https://newhorizonsperu.matrixlms.com';
const CARPETA_CERTIFICADOS = path.join(__dirname, 'certificados_generados');

if (!fsSync.existsSync(CARPETA_CERTIFICADOS)) {
    fsSync.mkdirSync(CARPETA_CERTIFICADOS, { recursive: true });
}
if (!fsSync.existsSync(path.join(__dirname, 'public/images'))) {
    fsSync.mkdirSync(path.join(__dirname, 'public/images'), { recursive: true });
}

// --- UTILIDADES ---
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

// Fecha de hoy en formato largo español
const getFechaHoy = () => {
    return new Intl.DateTimeFormat('es-PE', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }).format(new Date());
};

function renderizarCertificado(app, datos) {   // ← quita el parámetro req
    const logoSrc = getImagenBase64('logoNH.png');
    const firmaFijaSrc = getImagenBase64('firma_juan.png');
    const fondoPath = path.join(__dirname, 'public', 'images', 'fondo_certificado.png');
    const fondoBase64 = fsSync.readFileSync(fondoPath, { encoding: 'base64' });
    const fondoSrc = `data:image/png;base64,${fondoBase64}`;

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
            firmaDocenteSrc: datos.firmaManual || "",
            fechaEmision: datos.fechaEmision || getFechaHoy()  // ← lee de datos, no de req
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

    // ← Fuente embebida en base64 para Puppeteer
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
            fontSrc, // ← agrega esto
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
        const resCurso = await axios.get(`${DOMINIO}/api/v3/courses/${cursoId}?api_key=${API_KEY}`);
        const c = resCurso.data;

        let nombreDocente = "POR ASIGNAR";
        try {
            const resIns = await axios.get(`${DOMINIO}/api/v3/courses/${cursoId}/instructors?api_key=${API_KEY}`);
            if (resIns.data && resIns.data.length > 0) {
                const teacher = resIns.data.find(i => i.coinstructor === false) || resIns.data[0];
                const resUser = await axios.get(`${DOMINIO}/api/v3/users/${teacher.user_id}?api_key=${API_KEY}`);
                nombreDocente = `${resUser.data.first_name} ${resUser.data.last_name}`.toUpperCase();
            }
        } catch (_) { }

        let todosLosAlumnos = [];
        let offset = 0;
        const limit = 100;
        let hayMasPags = true;

        while (hayMasPags) {
            const resAlu = await axios.get(
                `${DOMINIO}/api/v3/courses/${cursoId}/learners?api_key=${API_KEY}&$include=user&$limit=${limit}&$offset=${offset}`
            );
            if (resAlu.data && resAlu.data.length > 0) {
                const listaMapeada = resAlu.data.map(item => ({
                    nombre: `${item.user.last_name} ${item.user.first_name}`.toUpperCase()
                }));
                todosLosAlumnos = todosLosAlumnos.concat(listaMapeada);
                if (resAlu.data.length < limit) {
                    hayMasPags = false;
                } else {
                    offset += limit;
                }
            } else {
                hayMasPags = false;
            }
        }

        todosLosAlumnos.sort((a, b) => a.nombre.localeCompare(b.nombre));
        const alumnosFinal = todosLosAlumnos.map((alu, i) => ({
            ...alu,
            codigo: `NH-${cursoId}-${(i + 1).toString().padStart(3, '0')}`
        }));

        res.render('index', {
            alumnos: alumnosFinal,
            cursoNombre: c.name,
            docenteNombre: nombreDocente,
            fechaInicio: formatearFecha(c.start_at),
            fechaFin: formatearFecha(c.finish_at),
            horasAcademicas: c.section_code || "0",
            horasCronologicas: c.credits  || "0",
            cursoId,
            total: alumnosFinal.length
        });
    } catch (e) {
        console.error(e.message);
        res.status(500).send("Error al buscar el curso. Verifica el ID.");
    }
});

app.post('/api/generar-pdf-individual', async (req, res) => {
    try {
        const datos = req.body;  // fechaEmision ya viene aquí desde el frontend
        const html = await renderizarCertificado(app, datos);  // sin req
        const pdf = await generarPDF(html, 'landscape');
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

// --- GENERAR CONSTANCIA INDIVIDUAL ---
app.post('/api/generar-pdf-individual-constancia', async (req, res) => {
    try {
        const datos = req.body;
        const html = await renderizarConstancia(app, datos);
        const pdf = await generarPDF(html, 'portrait');
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

// --- GENERAR LOTE (certificados o constancias) ---
app.post('/api/generar-lote', async (req, res) => {
    const { alumnos, cursoNombre, docenteNombre, fechaInicio, fechaFin, creditos, firmaManual, tipo } = req.body;
    if (!alumnos || alumnos.length === 0) return res.status(400).json({ error: 'Sin alumnos.' });

    const esConstancia = tipo === 'constancia';
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
                firmaManual: esConstancia ? "" : firmaManual
            };
            const html = esConstancia
                ? await renderizarConstancia(app, datos)
                : await renderizarCertificado(app, datos);
            const pdf = await generarPDF(html, esConstancia ? 'portrait' : 'landscape');
            const prefijo = esConstancia ? 'Constancia' : 'Certificado';
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
    console.log(`🚀 Servidor Shukita v2 disponible en puerto ${PORT}`);
});