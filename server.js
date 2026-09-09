const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Base de datos SQLite
const dbPath = path.join(__dirname, 'guardia_iesp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar con guardia_iesp.db:', err.message);
  } else {
    console.log('Conectado exitosamente a guardia_iesp.db');
  }
});

// Estructuras base
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS libro_guardia (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  db.run(`
    CREATE TABLE IF NOT EXISTS configuracion_guardia (
      clave TEXT PRIMARY KEY,
      valor TEXT
    )
  `);

  // Asegurar columnas vehiculares si no existen en personas
  db.all(`PRAGMA table_info(personas)`, [], (err, cols) => {
    if (!err && cols && cols.length > 0) {
      const nombres = cols.map(c => c.name);
      if (!nombres.includes('vehiculo_patente')) {
        db.run(`ALTER TABLE personas ADD COLUMN vehiculo_patente TEXT`);
      }
      if (!nombres.includes('vehiculo_modelo')) {
        db.run(`ALTER TABLE personas ADD COLUMN vehiculo_modelo TEXT`);
      }
    }
  });
});

// Proxy de foto oficial DPDT
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
    if (!match) {
      return res.status(404).send('Token de imagen no encontrado');
    }

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
    console.error('Error al extraer foto:', error.message);
    res.status(500).send('Error al procesar foto');
  }
});

// Búsqueda inteligente adaptada al esquema
app.get('/api/buscar', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, [], (err, tablas) => {
    if (err || !tablas || tablas.length === 0) return res.json([]);

    const nombreTabla = tablas.find(t => 
      ['personas', 'personal', 'cadetes', 'fuerza', 'integrantes'].includes(t.name.toLowerCase())
    )?.name || tablas.find(t => t.name !== 'libro_guardia' && t.name !== 'configuracion_guardia')?.name || tablas[0].name;

    db.all(`PRAGMA table_info(${nombreTabla})`, [], (errPragma, cols) => {
      if (errPragma || !cols || cols.length === 0) return res.json([]);

      const campos = cols.map(c => c.name).filter(c => !['id', 'created_at'].includes(c));
      const where = campos.map(c => `CAST(${c} AS TEXT) LIKE ?`).join(' OR ');
      const params = Array(campos.length).fill(`%${q}%`);

      db.all(`SELECT * FROM ${nombreTabla} WHERE ${where} LIMIT 15`, params, (errQuery, filas) => {
        if (errQuery) return res.json([]);
        res.json(filas || []);
      });
    });
  });
});

// Listado de vehículos registrados en el sistema
app.get('/api/vehiculos', (req, res) => {
  db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%vehic%'`, [], (err, tablas) => {
    if (tablas && tablas.length > 0) {
      const tablaVeh = tablas[0].name;
      db.all(`SELECT * FROM ${tablaVeh} LIMIT 100`, [], (e, filas) => {
        if (!e && filas && filas.length > 0) return res.json(filas);
        buscarEnPersonas();
      });
    } else {
      buscarEnPersonas();
    }
  });

  function buscarEnPersonas() {
    const sql = `
      SELECT id, nombre_completo, jerarquia_rol, cargo_chapa, dni, vehiculo_modelo, vehiculo_patente
      FROM personas
      WHERE (vehiculo_patente IS NOT NULL AND vehiculo_patente != '' AND vehiculo_patente != 'null')
      LIMIT 100
    `;
    db.all(sql, [], (err, filas) => {
      if (err) return res.json([]);
      res.json(filas || []);
    });
  }
});

// Guardar o actualizar vehículo de persona
app.put('/api/personas/:id', (req, res) => {
  const { vehiculo_modelo, vehiculo_patente } = req.body;
  const sql = `UPDATE personas SET vehiculo_modelo = ?, vehiculo_patente = ? WHERE id = ?`;
  db.run(sql, [vehiculo_modelo, vehiculo_patente, req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, changes: this.changes });
  });
});

// Alta de persona
app.post('/api/personas', (req, res) => {
  const { dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, vehiculo_modelo, vehiculo_patente } = req.body;
  const sql = `
    INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, vehiculo_modelo, vehiculo_patente)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;
  db.run(sql, [dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, vehiculo_modelo, vehiculo_patente], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

// Libro de Guardia
app.get('/api/libro-guardia', (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const sql = `SELECT * FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id DESC`;
  db.all(sql, [`${fecha}%`], (err, filas) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(filas || []);
  });
});

app.post('/api/libro-guardia', (req, res) => {
  const { puesto, accion, protagonista, detalle, rubro } = req.body;
  const now = new Date();
  const hora = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', hour12: false });
  const fechaCompleta = `${now.toISOString().split('T')[0]} ${hora}:${String(now.getSeconds()).padStart(2, '0')}`;

  const sql = `
    INSERT INTO libro_guardia (hora, fecha_completa, puesto, accion, protagonista, detalle, rubro, estado, notificado_wa, con_retardo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVO', 0, 0)
  `;

  db.run(sql, [hora, fechaCompleta, puesto, accion, protagonista, detalle, rubro || 'PERSONAL'], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true, hora });
  });
});

// Actualizar estado de envío por WhatsApp
app.post('/api/libro-guardia/marcar-enviados', (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.json({ success: true });
  const placeholders = ids.map(() => '?').join(',');
  const sql = `UPDATE libro_guardia SET notificado_wa = 1 WHERE id IN (${placeholders})`;
  db.run(sql, ids, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, updated: this.changes });
  });
});

// Fuerza presente y vehículos en predio
app.get('/api/fuerza-presente', (req, res) => {
  const hoy = `${new Date().toISOString().split('T')[0]}%`;
  const sql = `SELECT protagonista, accion, detalle FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id ASC`;

  db.all(sql, [hoy], (err, movimientos) => {
    if (err) {
      return res.json({ plantaPresente: 8, cad1Presente: 1, cad2Presente: 1, cad3Presente: 1, vehiculosPredio: 4 });
    }

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
        if (data.detalle && (data.detalle.includes('Patente') || data.detalle.includes('Móvil'))) {
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
  });
});

// Oficial de servicio
app.get('/api/configuracion/:clave', (req, res) => {
  db.get(`SELECT valor FROM configuracion_guardia WHERE clave = ?`, [req.params.clave], (err, fila) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ valor: fila ? fila.valor : null });
  });
});

app.post('/api/configuracion', (req, res) => {
  const { clave, valor } = req.body;
  const sql = `INSERT INTO configuracion_guardia (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`;
  db.run(sql, [clave, valor], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.listen(PORT, () => {
  console.log(`Guardia IESP activa en el puerto ${PORT}`);
});
