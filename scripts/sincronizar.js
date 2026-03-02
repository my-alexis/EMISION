require('dotenv').config();
const express = require('express');
const axios = require('axios');
const neo4j = require('neo4j-driver');
const app = express();

// Configuración de Matrix
const API_KEY = 'c602f00b4dafe00e89fabb34a53862d49d4ae0947fe8323b96c7';
const DOMINIO = 'https://newhorizonsperu.matrixlms.com';

// Configuración de Neo4j
const driver = neo4j.driver(
    'bolt://localhost:7687', 
    neo4j.auth.basic('neo4j', 'admin1234')
);

app.set('view engine', 'ejs');
app.use(express.urlencoded({ extended: true }));

// RUTA INICIAL
app.get('/', (req, res) => {
    res.render('index', { alumnos: [], cursoNombre: null, cursoId: null });
});

// RUTA DE BÚSQUEDA Y SINCRONIZACIÓN AUTOMÁTICA
app.post('/buscar', async (req, res) => {
    const cursoId = req.body.cursoId; // Captura el ID que escribiste en la web
    const session = driver.session();
    
    try {
        console.log(`🚀 Procesando curso ID: ${cursoId}`);

        // 1. Obtener nombre del curso (Validación de existencia)
        const resCurso = await axios.get(`${DOMINIO}/api/v3/courses/${cursoId}?api_key=${API_KEY}`);
        const nombreCurso = resCurso.data.name;

        // 2. Traer alumnos directamente de Matrix (Data fresca)
        const urlAlumnos = `${DOMINIO}/api/v3/courses/${cursoId}/learners?api_key=${API_KEY}&$include=user&$limit=100`;
        const resAlumnos = await axios.get(urlAlumnos);
        const listaAlumnos = resAlumnos.data;

        // 3. Sincronizar con Neo4j en segundo plano
        // Usamos MERGE para que si ya existen, solo se actualicen
        for (const item of listaAlumnos) {
            await session.run(`
                MERGE (c:Curso {id: $cId}) ON CREATE SET c.nombre = $cName
                MERGE (s:Estudiante {id: $sId})
                SET s.nombre = $nom, 
                    s.apellido = $ape, 
                    s.dni = $dni, 
                    s.genero = $gen
                MERGE (s)-[:INSCRITO_EN]->(c)
            `, {
                cId: cursoId.toString(),
                cName: nombreCurso,
                sId: item.user_id.toString(),
                nom: item.user.first_name,
                ape: item.user.last_name,
                dni: (item.user.custom_fields && item.user.custom_fields["Nro. de Documento"]) || "S/D",
                gen: item.user.gender
            });
        }

        // 4. Mapear datos para mostrar en la tabla de la interfaz
        const alumnosParaTabla = listaAlumnos.map(item => ({
            dni: (item.user.custom_fields && item.user.custom_fields["Nro. de Documento"]) || "S/D",
            nombre: item.user.first_name,
            apellido: item.user.last_name,
            genero: item.user.gender
        }));

        // Renderizar la vista con los datos obtenidos
        res.render('index', { 
            alumnos: alumnosParaTabla, 
            cursoNombre: nombreCurso, 
            cursoId: cursoId 
        });

    } catch (error) {
        console.error("❌ Error:", error.message);
        res.send(`<h3>Error: No se pudo obtener la información del curso ${cursoId}. Verifica el ID.</h3>`);
    } finally {
        await session.close();
    }
});

app.listen(3000, () => {
    console.log("🌐 Panel de Certificación listo en http://localhost:3000");
});