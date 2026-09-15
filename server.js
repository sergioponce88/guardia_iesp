const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const axios = require('axios');
const fs = require('fs');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Configuración de conexión a PostgreSQL usando la variable de entorno de Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Inicialización de tablas e importación automática de planillas
async function inicializarBaseDatos() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS personas (
        id SERIAL PRIMARY KEY,
        dni TEXT,
        nombre_completo TEXT,
        jerarquia_rol TEXT,
        cargo_chapa TEXT,
        credencial_url TEXT,
        credencial_token TEXT,
        vehiculo_modelo TEXT,
        vehiculo_patente TEXT
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS libro_guardia (
        id SERIAL PRIMARY KEY,
        hora TEXT,
        fecha_completa TEXT,
        puesto TEXT,
        accion TEXT,
        protagonista TEXT,
        detalle TEXT,
        rubro TEXT,
        estado TEXT DEFAULT 'ACTIVO',
        motivo_anulacion TEXT,
        notificado_wa INTEGER DEFAULT 0,
        con_retardo INTEGER DEFAULT 0
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS configuracion_guardia (
        clave TEXT PRIMARY KEY,
        valor TEXT
      )
    `);
    console.log('Tablas verificadas y creadas exitosamente en PostgreSQL.');

    // Verificar si la tabla de personas está vacía para importar automáticamente los Excel
    const resConteo = await pool.query(`SELECT COUNT(*) FROM personas`);
    const totalPersonas = parseInt(resConteo.rows[0].count);

    if (totalPersonas === 0) {
      console.log('Base de datos vacía detectada. Iniciando importación automática de planillas...');

      // 1. Importar Cadetes
      const archivoCadetes = 'LISTADO DE COMPAÑIA DE CADETES AÑO 2026 PARA D1.xlsx';
      if (fs.existsSync(archivoCadetes)) {
        const workbook = XLSX.readFile(archivoCadetes);
        const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]]);

        for (const row of rows) {
          const apellido = String(row['APELLIDO'] || '').trim();
          const nombres = String(row['NOMBRES'] || '').trim();
          const nombreCompleto = `${apellido}, ${nombres}`.toUpperCase();
          const dni = String(row['DNI'] || 'S/D').trim();
          const cargoChapa = String(row['CARGO'] || 'S/D').trim();
          const curso = String(row['CURSO'] || '').trim();
          const jerarquiaRol = curso ? `Cadete ${curso}` : 'Cadete';

          if (nombreCompleto !== ',') {
            await pool.query(
              `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa) VALUES ($1, $2, $3, $4)`,
              [dni, nombreCompleto, jerarquiaRol, cargoChapa]
            );
          }
        }
        console.log(`> Importados ${rows.length} cadetes exitosamente.`);
      }

      // 2. Importar LEO IESP
      const archivoLeo = 'LEO IESP.xlsx';
      if (fs.existsSync(archivoLeo)) {
        const fileBuffer = fs.readFileSync(archivoLeo);
        const textContent = fileBuffer.toString('utf8');
        const idx = textContent.indexOf('ROLL DE COMBATE');
        
        if (idx !== -1) {
          const regex = /"([^"]+)",([^,]+),([^,]+),([^\"]+?)(?="[A-ZÁÉÍÓÚÑa-zñ\s\.,-]+",[A-Z]|$)/g;
          let match;
          let count = 0;

          while ((match = regex.exec(textContent)) !== null) {
            const nombreCompleto = match[1].trim().toUpperCase();
            const grado = match[2].trim();
            const cargoChapa = match[3].trim();

            if (nombreCompleto) {
              await pool.query(
                `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa) VALUES ($1, $2, $3, $4)`,
                ['S/D', nombreCompleto, grado, cargoChapa]
              );
              count++;
            }
          }
          console.log(`> Importados ${count} registros de LEO IESP exitosamente.`);
        }
      }
    }
  } catch (err) {
    console.error('Error al inicializar o importar en la base de datos:', err);
  }
}

inicializarBaseDatos();

app.get('/api/extraer-foto', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL requerida');

  try {
    const hash = url.trim().split('/').pop().replace('#', '');
    const paginaUrl = `https://credenciales.dpd1.ar/publicoQR/${hash}`;

    const respuestaHtml = await axios.get(paginaUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      timeout: 8000
    });

    const match = respuestaHtml.data.match(/\/api\/imagen\/[a-zA-Z0-9_\-\.]+/);
    if (!match) return res.status(404).send('Token no encontrado');

    const imagenUrl = `https://credenciales.dpd1.ar${match[0]}`;
    const imagenRes = await axios.get(imagenUrl, {
      responseType: 'arraybuffer',
      headers: {
        'Referer': paginaUrl,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
      },
      timeout: 8000
    });

    res.set('Content-Type', imagenRes.headers['content-type'] || 'image/webp');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(imagenRes.data);
  } catch (error) {
    res.status(500).send('Error interno foto');
  }
});

app.get('/api/personal-completo', async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT * FROM personas ORDER BY id DESC`);
    res.json(resultado.rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/buscar', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const sql = `
    SELECT * FROM personas 
    WHERE id::text = $1 OR dni ILIKE $2 OR nombre_completo ILIKE $2 OR jerarquia_rol ILIKE $2 OR cargo_chapa ILIKE $2 OR credencial_token ILIKE $2
    LIMIT 100
  `;
  const param = `%${q}%`;
  try {
    const resultado = await pool.query(sql, [q, param]);
    res.json(resultado.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/vehiculos', async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT id, nombre_completo AS titular, jerarquia_rol AS jerarquia, vehiculo_modelo AS modelo, vehiculo_patente AS patente FROM personas WHERE vehiculo_patente IS NOT NULL AND vehiculo_patente != ''`);
    res.json(resultado.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/personas/:id', async (req, res) => {
  const { vehiculo_modelo, vehiculo_patente, credencial_url, credencial_token, dni, cargo_chapa, nombre_completo, jerarquia_rol, limpiar_credencial } = req.body;
  const idPersona = req.params.id;

  try {
    if (limpiar_credencial) {
      await pool.query(`UPDATE personas SET credencial_url = NULL, credencial_token = NULL WHERE id = $1`, [idPersona]);
      return res.json({ success: true });
    }

    const actualQuery = await pool.query(`SELECT * FROM personas WHERE id = $1`, [idPersona]);
    if (actualQuery.rows.length === 0) return res.status(404).json({ error: 'Persona no encontrada' });
    const actual = actualQuery.rows[0];

    const nuevoDni = (dni !== undefined && dni !== '') ? dni : actual.dni;
    const nuevoNombre = (nombre_completo !== undefined && nombre_completo !== '') ? nombre_completo.toUpperCase() : actual.nombre_completo;
    const nuevaJerarquia = (jerarquia_rol !== undefined && jerarquia_rol !== '') ? jerarquia_rol : actual.jerarquia_rol;
    const nuevoChapa = (cargo_chapa !== undefined && cargo_chapa !== '') ? cargo_chapa : actual.cargo_chapa;
    
    let nuevaCredUrl = actual.credencial_url;
    let nuevoToken = actual.credencial_token;
    
    if (credencial_url !== undefined && credencial_url !== '') {
      nuevaCredUrl = credencial_url;
      nuevoToken = credencial_url.trim().split('/').pop().replace('#', '');
    } else if (credencial_token !== undefined && credencial_token !== '') {
      nuevoToken = credencial_token;
    }

    const nuevoModelo = vehiculo_modelo !== undefined ? vehiculo_modelo : actual.vehiculo_modelo;
    const nuevaPatente = vehiculo_patente !== undefined ? vehiculo_patente : actual.vehiculo_patente;

    const sql = `
      UPDATE personas 
      SET dni = $1, nombre_completo = $2, jerarquia_rol = $3, cargo_chapa = $4, credencial_url = $5, credencial_token = $6, vehiculo_modelo = $7, vehiculo_patente = $8
      WHERE id = $9
    `;

    await pool.query(sql, [nuevoDni, nuevoNombre, nuevaJerarquia, nuevoChapa, nuevaCredUrl, nuevoToken, nuevoModelo, nuevaPatente, idPersona]);
    res.json({ success: true });
  } catch (e) {
    console.error("Error al actualizar:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/personas', async (req, res) => {
  const { dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token, vehiculo_modelo, vehiculo_patente } = req.body;
  
  if (!nombre_completo) {
    return res.status(400).json({ error: 'El nombre completo es obligatorio' });
  }

  const token = credencial_url ? credencial_url.trim().split('/').pop().replace('#', '') : (credencial_token || null);

  const sql = `
    INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token, vehiculo_modelo, vehiculo_patente)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
    RETURNING id
  `;
  try {
    const resultado = await pool.query(sql, [dni || 'S/D', nombre_completo.toUpperCase(), jerarquia_rol || 'Personal', cargo_chapa || 'S/D', credencial_url || null, token, vehiculo_modelo || null, vehiculo_patente || null]);
    res.json({ id: resultado.rows[0].id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/personas/:id', async (req, res) => {
  const idPersona = req.params.id;
  try {
    await pool.query(`DELETE FROM personas WHERE id = $1`, [idPersona]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/api/libro-guardia', async (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const sql = `SELECT * FROM libro_guardia WHERE fecha_completa LIKE $1 ORDER BY id DESC`;
  try {
    const resultado = await pool.query(sql, [`${fecha}%`]);
    res.json(resultado.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/libro-guardia', async (req, res) => {
  const { puesto, accion, protagonista, detalle, rubro } = req.body;
  const now = new Date();
  const hora = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fechaCompleta = `${now.toISOString().split('T')[0]} ${hora}:${String(now.getSeconds()).padStart(2, '0')}`;

  const sql = `
    INSERT INTO libro_guardia (hora, fecha_completa, puesto, accion, protagonista, detalle, rubro, estado, notificado_wa, con_retardo)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVO', 0, 0)
    RETURNING id
  `;

  try {
    const resultado = await pool.query(sql, [hora, fechaCompleta, puesto, accion, protagonista, detalle, rubro || 'PERSONAL']);
    res.json({ id: resultado.rows[0].id, success: true, hora });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/libro-guardia/marcar-enviados', async (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.json({ success: true });
  
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const sql = `UPDATE libro_guardia SET notificado_wa = 1 WHERE id IN (${placeholders})`;
  try {
    await pool.query(sql, ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fuerza-presente', async (req, res) => {
  const hoy = `${new Date().toISOString().split('T')[0]}%`;
  const sql = `SELECT protagonista, accion, detalle FROM libro_guardia WHERE fecha_completa LIKE $1 ORDER BY id ASC`;

  try {
    const resultado = await pool.query(sql, [hoy]);
    const movimientos = resultado.rows;

    let vehiculosAdentro = 4;
    let plantaAdentro = 8;
    let cad1Adentro = 1;
    let cad2Adentro = 1;
    let cad3Adentro = 1;

    const estados = {};
    (movimientos || []).forEach(m => {
      estados[m.protagonista] = { accion: m.accion, detalle: m.detalle };
    });

    Object.entries(estados).forEach(([persona, data]) => {
      if (data.accion && data.accion.includes('INGRESO')) {
        if (data.detalle && (data.detalle.includes('Patente') || data.detalle.includes('Móvil') || data.detalle.includes('rodado'))) {
          vehiculosAdentro++;
        }
        if (persona.includes('Cadete 1°') || persona.includes('1° Año')) cad1Adentro++;
        else if (persona.includes('Cadete 2°') || persona.includes('2° Año')) cad2Adentro++;
        else if (persona.includes('Cadete 3°') || persona.includes('3° Año')) cad3Adentro++;
        else plantaAdentro++;
      }
    });

    res.json({
      plantaPresente: plantaAdentro,
      cad1Presente: cad1Adentro,
      cad2Presente: cad2Adentro,
      cad3Presente: cad3Adentro,
      vehiculosPredio: vehiculosAdentro
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/configuracion/:clave', async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT valor FROM configuracion_guardia WHERE clave = $1`, [req.params.clave]);
    res.json({ valor: resultado.rows.length > 0 ? resultado.rows[0].valor : null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/configuracion', async (req, res) => {
  const { clave, valor } = req.body;
  const sql = `
    INSERT INTO configuracion_guardia (clave, valor) VALUES ($1, $2)
    ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor
  `;
  try {
    await pool.query(sql, [clave, valor]);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
