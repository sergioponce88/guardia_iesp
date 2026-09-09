const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Conexión SQLite
const dbPath = path.join(__dirname, 'guardia_iesp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar con guardia_iesp.db:', err.message);
  } else {
    console.log('Conectado exitosamente a guardia_iesp.db');
  }
});

// Tablas auxiliares
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
});

// Proxy de extracción de foto oficial
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

// Búsqueda inteligente universal
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

// Detector profundo de vehículos existentes en cualquier tabla o columna
app.get('/api/vehiculos', (req, res) => {
  db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, [], async (err, tablas) => {
    if (err || !tablas || tablas.length === 0) return res.json([]);

    let resultados = [];

    for (const t of tablas) {
      if (['libro_guardia', 'configuracion_guardia'].includes(t.name)) continue;

      const filas = await new Promise((resolve) => {
        db.all(`SELECT * FROM ${t.name} LIMIT 200`, [], (e, rows) => resolve(rows || []));
      });

      filas.forEach(f => {
        // Barrer todos los campos del registro buscando indicios de patente o vehículo
        let patenteEncontrada = null;
        let modeloEncontrado = null;
        let titular = f.nombre_completo || f.nombre || f.titular || f.apellido || 'Personal Policial';
        let jerarquia = f.jerarquia_rol || f.jerarquia || f.cargo || '';

        for (const [clave, valor] of Object.entries(f)) {
          if (!valor || typeof valor !== 'string') continue;
          const k = clave.toLowerCase();
          const v = valor.trim();

          if ((k.includes('patente') || k.includes('dominio')) && v !== '' && v !== 'null') {
            patenteEncontrada = v;
          }
          if ((k.includes('modelo') || k.includes('marca') || k.includes('rodado') || k.includes('vehiculo')) && v !== '' && v !== 'null') {
            modeloEncontrado = v;
          }
        }

        if (patenteEncontrada) {
          resultados.push({
            id: f.id,
            titular: titular,
            jerarquia: jerarquia,
            modelo: modeloEncontrado || 'Vehículo Registrado',
            patente: patenteEncontrada.toUpperCase()
          });
        }
      });
    }

    res.json(resultados);
  });
});

// Guardar/Actualizar vehículo
app.put('/api/personas/:id', (req, res) => {
  const { vehiculo_modelo, vehiculo_patente } = req.body;
  
  // Detecta en qué tabla está el ID y actualiza
  db.all(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`, [], (err, tablas) => {
    const tabla = tablas.find(t => ['personas', 'personal', 'cadetes'].includes(t.name.toLowerCase()))?.name || 'personas';
    
    // Asegurar columnas
    db.run(`ALTER TABLE ${tabla} ADD COLUMN vehiculo_patente TEXT`, () => {});
    db.run(`ALTER TABLE ${tabla} ADD COLUMN vehiculo_modelo TEXT`, () => {
      const sql = `UPDATE ${tabla} SET vehiculo_modelo = ?, vehiculo_patente = ? WHERE id = ?`;
      db.run(sql, [vehiculo_modelo, vehiculo_patente, req.params.id], function (e) {
        if (e) return res.status(500).json({ error: e.message });
        res.json({ success: true });
      });
    });
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

app.post('/api/libro-guardia/marcar-enviados', (req, res) => {
  const { ids } = req.body;
  if (!ids || ids.length === 0) return res.json({ success: true });
  const placeholders = ids.map(() => '?').join(',');
  const sql = `UPDATE libro_guardia SET notificado_wa = 1 WHERE id IN (${placeholders})`;
  db.run(sql, ids, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// Totales de Fuerza
app.get('/api/fuerza-presente', (req, res) => {
  const hoy = `${new Date().toISOString().split('T')[0]}%`;
  const sql = `SELECT protagonista, accion, detalle FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id ASC`;

  db.all(sql, [hoy], (err, movimientos) => {
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
  });
});

// Oficial de Servicio
app.get('/api/configuracion/:clave', (req, res) => {
  db.get(`SELECT valor FROM configuracion_guardia WHERE clave = ?`, [req.params.clave], (err, fila) => {
    res.json({ valor: fila ? fila.valor : null });
  });
});

app.post('/api/configuracion', (req, res) => {
  const { clave, valor } = req.body;
  const sql = `INSERT INTO configuracion_guardia (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`;
  db.run(sql, [clave, valor], function (err) {
    res.json({ success: !err });
  });
});

app.listen(PORT, () => {
  console.log(`Guardia IESP activa en puerto ${PORT}`);
});
