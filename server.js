require('dotenv').config();
const PORT = process.env.PORT || 3000;
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const path = require('path');
const puppeteer = require('puppeteer');
const fs = require('fs').promises;
const fsSync = require('fs');

const app = express();
app.use(express.static('public'));
// Aumentamos el límite para permitir el envío de imágenes en Base64 (firmas)
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- CONFIGURACIÓN ---
const API_KEY = 'c602f00b4dafe00e89fabb34a53862d49d4ae0947fe8323b96c7';
const DOMINIO = 'https://newhorizonsperu.matrixlms.com';
const CARPETA_CERTIFICADOS = path.join(__dirname, 'certificados_generados');

// Crear carpetas necesarias si no existen
if (!fsSync.existsSync(CARPETA_CERTIFICADOS)) {
    fsSync.mkdirSync(CARPETA_CERTIFICADOS, { recursive: true });
}
if (!fsSync.existsSync(path.join(__dirname, 'public/images'))) {
    fsSync.mkdirSync(path.join(__dirname, 'public/images'), { recursive: true });
}

// --- UTILIDADES DE IMÁGENES (CONVERSIÓN A BASE64) ---

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

// --- FORMATEO DE FECHAS ---
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

// --- RENDERIZADO DE CERTIFICADO ---
function renderizarCertificado(app, datos) {
    // Cargamos recursos fijos del servidor
    const logoSrc = getImagenBase64('logoNH.png');
    const firmaFijaSrc = getImagenBase64('firma_juan.png');

    // CORRECCIÓN AQUÍ: Usamos fsSync en lugar de fs
    const fondoPath = path.join(__dirname, 'public', 'images', 'fondo_certificado.png');
    const fondoBase64 = fsSync.readFileSync(fondoPath, { encoding: 'base64' });
    const fondoSrc = `data:image/png;base64,${fondoBase64}`;

    return new Promise((resolve, reject) => {
        app.render('certificado', {
            nombreAlumno: datos.nombre,
            nombreCurso: datos.curso,
            creditos: datos.creditos,
            inicio: datos.inicio,
            fin: datos.fin,
            nombreDocente: datos.docente,
            codigoNH: datos.codigo,
            logoSrc: logoSrc,
            firmaFijaSrc: firmaFijaSrc,
            fondoSrc,
            // La firma manual viene desde el cliente (index.ejs)
            firmaDocenteSrc: datos.firmaManual || ""
        }, (err, html) => {
            if (err) return reject(err);
            resolve(html);
        });
    });
}

// --- GENERACIÓN DE PDF CON PUPPETEER ---
async function generarPDF(html) {
    const browser = await puppeteer.launch({
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle0' });
        const pdf = await page.pdf({
            format: 'A4',
            landscape: true,
            printBackground: true
        });
        return pdf;
    } finally {
        await browser.close();
    }
}

function nombreArchivoSeguro(nombre, codigo) {
    const limpio = nombre.replace(/[^a-zA-Z0-9áéíóúÁÉÍÓÚñÑ\s]/g, '').replace(/\s+/g, '_');
    return `Certificado_${limpio}_${codigo}.pdf`;
}

// --- RUTAS ---

app.get('/', (req, res) => {
    res.render('index', {
        alumnos: [], cursoNombre: null, docenteNombre: null,
        fechaInicio: null, fechaFin: null, creditos: null,
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

        const resAlu = await axios.get(
            `${DOMINIO}/api/v3/courses/${cursoId}/learners?api_key=${API_KEY}&$include=user&$limit=100`
        );
        const alumnos = resAlu.data
            .map((item, i) => ({
                codigo: `NH-${cursoId}-${(i + 1).toString().padStart(2, '0')}`,
                nombre: `${item.user.last_name} ${item.user.first_name}`.toUpperCase()
            }))
            .sort((a, b) => a.nombre.localeCompare(b.nombre));

        res.render('index', {
            alumnos,
            cursoNombre: c.name,
            docenteNombre: nombreDocente,
            fechaInicio: formatearFecha(c.start_at),
            fechaFin: formatearFecha(c.finish_at),
            creditos: c.credits || "0",
            cursoId,
            total: alumnos.length
        });
    } catch (e) {
        console.error(e.message);
        res.status(500).send("Error al buscar el curso. Verifica el ID.");
    }
});

// Ruta para generar PDF Individual
app.post('/api/generar-pdf-individual', async (req, res) => {
    try {
        const datos = req.body; // Aquí ya viene firmaManual si se subió en el index
        const html = await renderizarCertificado(app, datos);
        const pdf = await generarPDF(html);

        const archivo = nombreArchivoSeguro(datos.nombre, datos.codigo);
        await fs.writeFile(path.join(CARPETA_CERTIFICADOS, archivo), pdf);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${archivo}"`);
        res.send(pdf);
    } catch (e) {
        console.error(e);
        res.status(500).json({ error: 'Error al generar: ' + e.message });
    }
});

// Ruta para generar por Lote
app.post('/api/generar-lote', async (req, res) => {
    const { alumnos, cursoNombre, docenteNombre, fechaInicio, fechaFin, creditos, firmaManual } = req.body;
    if (!alumnos || alumnos.length === 0) return res.status(400).json({ error: 'Sin alumnos.' });

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
                firmaManual // Se aplica la misma firma a todo el lote
            };
            const html = await renderizarCertificado(app, datos);
            const pdf = await generarPDF(html);
            const archivo = nombreArchivoSeguro(alumno.nombre, alumno.codigo);
            await fs.writeFile(path.join(CARPETA_CERTIFICADOS, archivo), pdf);
            resultados.push({ nombre: alumno.nombre, estado: 'ok' });
        } catch (e) {
            resultados.push({ nombre: alumno.nombre, estado: 'error' });
        }
    }
    res.json({ mensaje: "Proceso completado", resultados });
});

// --- GESTIÓN DE SUBIDA DE FIRMAS FIJAS (OPCIONAL) ---
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'public/images/'),
    filename: (req, file, cb) => {
        // 1. Limpiamos el nombre del docente
        const nombreDocente = req.body.nombreDocenteFirma.replace(/\s+/g, '_').toUpperCase();

        // 2. Extraemos la extensión original del archivo (.png, .jpg, .jpeg)
        const extension = path.extname(file.originalname).toLowerCase();

        // 3. Concatenamos todo
        cb(null, `firma_${nombreDocente}${extension}`);
    }
});
const upload = multer({ storage: storage });

app.post('/api/subir-firma', upload.single('archivoFirma'), (req, res) => {
    if (!req.file) return res.status(400).send('No se subió archivo.');
    res.send(`<script>alert("Firma guardada en servidor"); window.location.href="/";</script>`);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Servidor Shukita v2 disponible en puerto ${PORT}`);
});