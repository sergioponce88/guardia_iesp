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

// Función centralizada para importar y sincronizar LEO IESP2.xlsx
async function sincronizarLeoIesp2() {
  const posiblesRutas = [
    'LEO IESP2.xlsx', 
    'LEO IESP2', 
    'LEO IESP2.XLSX', 
    path.join(__dirname, 'LEO IESP2.xlsx'),
    path.join(__dirname, 'public', 'LEO IESP2.xlsx'),
    path.join(__dirname, 'public', 'LEO IESP2')
  ];
  
  let archivoEncontrado = null;
  for (const ruta of posiblesRutas) {
    if (fs.existsSync(ruta)) {
      archivoEncontrado = ruta;
      break;
    }
  }

  if (!archivoEncontrado) return;

  try {
    const workbookLeo = XLSX.readFile(archivoEncontrado);
    let hojaRoll = workbookLeo.Sheets['ROLL DE COMBATE'] || workbookLeo.Sheets[workbookLeo.SheetNames[0]];
    if (hojaRoll) {
      const rowsRoll = XLSX.utils.sheet_to_json(hojaRoll);
      for (const row of rowsRoll) {
        const apellido = String(row['APELLIDO'] || row['APELLIDOS'] || '').trim();
        const nombres = String(row['NOMBRES'] || row['NOMBRE'] || '').trim();
        let nombreCompleto = `${apellido}, ${nombres}`.toUpperCase();
        if (nombreCompleto === ',') {
          nombreCompleto = String(row['APELLIDO Y NOMBRE'] || row['PERSONAL'] || '').trim().toUpperCase();
        }
        const grado = String(row['GRADO'] || row['JERARQUIA'] || 'Personal').trim();
        const cargoChapa = String(row['CARGO'] || row['DESTINO'] || 'S/D').trim();

        if (nombreCompleto && nombreCompleto !== ',') {
          const existe = await pool.query(`SELECT id FROM personas WHERE nombre_completo ILIKE $1`, [`%${nombreCompleto}%`]);
          if (existe.rows.length === 0) {
            await pool.query(
              `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa) VALUES ('S/D', $1, $2, $3)`,
              [nombreCompleto, grado, cargoChapa]
            );
          }
        }
      }
    }
  } catch (err) {
    console.error('Error al sincronizar LEO IESP2:', err);
  }
}

// Inicialización de tablas de la Base de Datos
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
        vehiculo_patente TEXT,
        celular TEXT,
        familiar_nombre_1 TEXT,
        familiar_telefono_1 TEXT,
        familiar_nombre_2 TEXT,
        familiar_telefono_2 TEXT
      )
    `);

    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS celular TEXT;`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS familiar_nombre_1 TEXT;`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS familiar_telefono_1 TEXT;`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS familiar_nombre_2 TEXT;`);
    await pool.query(`ALTER TABLE personas ADD COLUMN IF NOT EXISTS familiar_telefono_2 TEXT;`);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS novedades_cadetes (
        id SERIAL PRIMARY KEY,
        persona_id INTEGER,
        fecha TEXT,
        estado TEXT, 
        observacion TEXT,
        registrado_por TEXT
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

    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios_sistema (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE,
        pin TEXT,
        nombre_completo TEXT,
        rol TEXT
      )
    `);

    const checkUser = await pool.query(`SELECT COUNT(*) FROM usuarios_sistema`);
    if (parseInt(checkUser.rows[0].count) === 0) {
      await pool.query(`INSERT INTO usuarios_sistema (usuario, pin, nombre_completo, rol) VALUES ('oficial', '1234', 'Oficial de Servicio', 'OFICIAL')`);
      await pool.query(`INSERT INTO usuarios_sistema (usuario, pin, nombre_completo, rol) VALUES ('suboficial', '5678', 'Suboficial de Turno', 'SUBOFICIAL')`);
      await pool.query(`INSERT INTO usuarios_sistema (usuario, pin, nombre_completo, rol) VALUES ('jefatura', '9999', 'Jefatura / Rectorado', 'DIRECTIVO')`);
    }

    await pool.query(`
      CREATE TABLE IF NOT EXISTS visitas_externas (
        id SERIAL PRIMARY KEY,
        dni TEXT,
        nombre_completo TEXT,
        procedencia TEXT,
        motivo TEXT,
        destino_area TEXT,
        fecha_hora TEXT,
        registrado_por TEXT
      )
    `);

    console.log('Base de datos inicializada correctamente.');

    // Importar Cadetes si la tabla está vacía
    const resConteoCadetes = await pool.query(`SELECT COUNT(*) FROM personas WHERE jerarquia_rol ILIKE '%cadete%'`);
    if (parseInt(resConteoCadetes.rows[0].count) === 0) {
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
          const celular = String(row['CELULAR'] || '').trim();
          const jerarquiaRol = curso ? `Cadete ${curso}` : 'Cadete';

          if (nombreCompleto !== ',') {
            await pool.query(
              `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa, celular) VALUES ($1, $2, $3, $4, $5)`,
              [dni, nombreCompleto, jerarquiaRol, cargoChapa, celular]
            );
          }
        }
      }
    }

    await sincronizarLeoIesp2();
  } catch (err) {
    console.error('Error en inicialización:', err);
  }
}

inicializarBaseDatos();

// --- ENDPOINTS DE LA API ---

app.post('/api/login', async (req, res) => {
  const { usuario, pin } = req.body;
  try {
    const resultado = await pool.query(`SELECT * FROM usuarios_sistema WHERE usuario = $1 AND pin = $2`, [usuario, pin]);
    if (resultado.rows.length > 0) {
      res.json({ success: true, usuario: resultado.rows[0] });
    } else {
      res.status(401).json({ success: false, error: 'Usuario o PIN incorrectos' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
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
  try {
    const resultado = await pool.query(sql, [q, `%${q}%`]);
    res.json(resultado.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/personas/:id', async (req, res) => {
  const idPersona = req.params.id;
  try {
    await pool.query(`DELETE FROM personas WHERE id = $1`, [idPersona]);
    res.json({ success: true });
  } catch (e) {
    console.error("Error al eliminar efectivo:", e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.put('/api/personas/:id', async (req, res) => {
  const { 
    vehiculo_modelo, vehiculo_patente, credencial_url, credencial_token, 
    dni, cargo_chapa, nombre_completo, jerarquia_rol, limpiar_credencial,
    celular, familiar_nombre_1, familiar_telefono_1, familiar_nombre_2, familiar_telefono_2 
  } = req.body;
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
    const nuevoCelular = celular !== undefined ? celular : actual.celular;
    const famNom1 = familiar_nombre_1 !== undefined ? familiar_nombre_1 : actual.familiar_nombre_1;
    const famTel1 = familiar_telefono_1 !== undefined ? familiar_telefono_1 : actual.familiar_telefono_1;
    const famNom2 = familiar_nombre_2 !== undefined ? familiar_nombre_2 : actual.familiar_nombre_2;
    const famTel2 = familiar_telefono_2 !== undefined ? familiar_telefono_2 : actual.familiar_telefono_2;
    
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
      SET dni = $1, nombre_completo = $2, jerarquia_rol = $3, cargo_chapa = $4, credencial_url = $5, credencial_token = $6, vehiculo_modelo = $7, vehiculo_patente = $8, celular = $9, familiar_nombre_1 = $10, familiar_telefono_1 = $11, familiar_nombre_2 = $12, familiar_telefono_2 = $13
      WHERE id = $14
    `;

    await pool.query(sql, [nuevoDni, nuevoNombre, nuevaJerarquia, nuevoChapa, nuevaCredUrl, nuevoToken, nuevoModelo, nuevaPatente, nuevoCelular, famNom1, famTel1, famNom2, famTel2, idPersona]);
    res.json({ success: true });
  } catch (e) {
    console.error("Error al actualizar persona:", e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/personas', async (req, res) => {
  const { dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token } = req.body;
  if (!nombre_completo) return res.status(400).json({ error: 'Nombre obligatorio' });

  const token = credencial_url ? credencial_url.trim().split('/').pop().replace('#', '') : (credencial_token || null);
  try {
    const resultado = await pool.query(
      `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [dni || 'S/D', nombre_completo.toUpperCase(), jerarquia_rol || 'Personal', cargo_chapa || 'S/D', credencial_url || null, token]
    );
    res.json({ id: resultado.rows[0].id, success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/libro-guardia', async (req, res) => {
  const { puesto, accion, protagonista, detalle, rubro } = req.body;
  
  const now = new Date();
  const hora = now.toLocaleTimeString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false });
  const fechaLocal = now.toLocaleDateString('es-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  const fechaCompleta = `${fechaLocal} ${hora}:${String(now.getSeconds()).padStart(2, '0')}`;

  const sql = `
    INSERT INTO libro_guardia (hora, fecha_completa, puesto, accion, protagonista, detalle, rubro, estado, notificado_wa, con_retardo)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVO', 0, 0)
    RETURNING id
  `;

  try {
    const resultado = await pool.query(sql, [
      hora, 
      fechaCompleta, 
      puesto || 'Puesto 1 (Principal)', 
      accion || 'INGRESO', 
      protagonista || 'PERSONAL', 
      detalle || 'A pie', 
      rubro || 'PERSONAL'
    ]);
    res.json({ id: resultado.rows[0].id, success: true, hora });
  } catch (err) {
    console.error("Error al guardar en libro_guardia:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/libro-guardia', async (req, res) => {
  const sql = `SELECT * FROM libro_guardia ORDER BY id DESC LIMIT 50`;
  try {
    const resultado = await pool.query(sql);
    res.json(resultado.rows || []);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/libro-guardia/marcar-enviados', async (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.json({ success: true });
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  try {
    await pool.query(`UPDATE libro_guardia SET notificado_wa = 1 WHERE id IN (${placeholders})`, ids);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/fuerza-presente', async (req, res) => {
  try {
    const resultado = await pool.query(`SELECT protagonista, accion, detalle FROM libro_guardia ORDER BY id ASC`);
    const movimientos = resultado.rows;

    let vehiculosAdentro = 4;
    let plantaAdentro = 8;
    let cad1Adentro = 0;
    let cad2Adentro = 0;
    let cad3Adentro = 0;

    let totalC1 = 61;
    let totalC2 = 48;
    let totalC3 = 75;

    const estados = {};
    (movimientos || []).forEach(m => {
      estados[m.protagonista] = { accion: m.accion, detalle: m.detalle };
    });

    Object.entries(estados).forEach(([persona, data]) => {
      if (data.accion && data.accion.includes('INGRESO')) {
        if (data.detalle && (data.detalle.includes('Patente') || data.detalle.includes('Móvil') || data.detalle.includes('rodado'))) {
          vehiculosAdentro++;
        } else if (persona.includes('1° AÑO') || persona.includes('Cadete 1°')) {
          cad1Adentro++;
        } else if (persona.includes('2° AÑO') || persona.includes('Cadete 2°')) {
          cad2Adentro++;
        } else if (persona.includes('3° AÑO') || persona.includes('Cadete 3°')) {
          cad3Adentro++;
        } else {
          plantaAdentro++;
        }
      }
    });

    res.json({
      plantaPresente: plantaAdentro,
      cad1Presente: cad1Adentro,
      cad1Total: totalC1,
      cad2Presente: cad2Adentro,
      cad2Total: totalC2,
      cad3Presente: cad3Adentro,
      cad3Total: totalC3,
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
  try {
    await pool.query(
      `INSERT INTO configuracion_guardia (clave, valor) VALUES ($1, $2) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor`,
      [clave, valor]
    );
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

app.get('/api/novedades-cadetes', async (req, res) => {
  const fecha = req.query.fecha || new Date().toLocaleDateString('es-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  try {
    const resultado = await pool.query(`SELECT * FROM novedades_cadetes WHERE fecha = $1`, [fecha]);
    res.json(resultado.rows || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/novedades-cadetes', async (req, res) => {
  const { persona_id, fecha, estado, observacion, registrado_por } = req.body;
  const fechaHoy = fecha || new Date().toLocaleDateString('es-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
  try {
    await pool.query(`DELETE FROM novedades_cadetes WHERE persona_id = $1 AND fecha = $2`, [persona_id, fechaHoy]);
    await pool.query(
      `INSERT INTO novedades_cadetes (persona_id, fecha, estado, observacion, registrado_por) VALUES ($1, $2, $3, $4, $5)`,
      [persona_id, fechaHoy, estado, observacion || '', registrado_por || 'Oficial de Guardia']
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
