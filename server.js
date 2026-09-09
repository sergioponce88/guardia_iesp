const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Asegurar directorio persistente
const dataDir = path.resolve(__dirname, 'data');
if (!fs.existsSync(dataDir)){
  fs.mkdirSync(dataDir, { recursive: true });
}

// Comprobación de recuperación: Si la DB vieja existe en la raíz, la movemos a data/ para no perder nada
const oldDbPath = path.resolve(__dirname, 'guardia_iesp.db');
const newDbPath = path.join(dataDir, 'guardia_iesp.db');

if (fs.existsSync(oldDbPath) && !fs.existsSync(newDbPath)) {
  try {
    fs.copyFileSync(oldDbPath, newDbPath);
    console.log('Base de datos anterior restaurada y migrada exitosamente a la carpeta persistente.');
  } catch (e) {
    console.error('Error al migrar la base de datos:', e.message);
  }
}

const dbPath = fs.existsSync(newDbPath) ? newDbPath : oldDbPath;
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error DB:', err.message);
  } else {
    console.log('Base de datos activa en:', dbPath);
  }
});

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

app.get('/api/extraer-foto', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL requerida');

  try {
    const hash = url.trim().split('/').pop().replace('#', '');
    const paginaUrl = `https://credenciales.dpd1.ar/publicoQR/${hash}`;

    const respuestaHtml = await axios.get(paginaUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });

    const match = respuestaHtml.data.match(/\/api\/imagen\/[a-zA-Z0-9_\-\.]+/);
    if (!match) return res.status(404).send('Token no encontrado');

    const imagenUrl = `https://credenciales.dpd1.ar${match[0]}`;
    const imagenRes = await axios.get(imagenUrl, {
      responseType: 'arraybuffer',
      headers: { 'Referer': paginaUrl, 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000
    });

    res.set('Content-Type', imagenRes.headers['content-type'] || 'image/webp');
    res.send(imagenRes.data);
  } catch (error) {
    res.status(500).send('Error interno foto');
  }
});

app.get('/api/personal-completo', (req, res) => {
  db.all(`SELECT * FROM personas ORDER BY id DESC`, [], (e, filas) => {
    if (e) return res.status(500).json({ error: e.message });
    res.json(filas || []);
  });
});

app.get('/api/buscar', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const sql = `
    SELECT * FROM personas 
    WHERE id = ? OR dni LIKE ? OR nombre_completo LIKE ? OR jerarquia_rol LIKE ? OR cargo_chapa LIKE ? OR credencial_token LIKE ?
    LIMIT 100
  `;
  const param = `%${q}%`;
  db.all(sql, [q, param, param, param, param, param], (err, filas) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(filas || []);
  });
});

app.get('/api/vehiculos', (req, res) => {
  db.all(`SELECT id, nombre_completo AS titular, jerarquia_rol AS jerarquia, vehiculo_modelo AS modelo, vehiculo_patente AS patente FROM personas WHERE vehiculo_patente IS NOT NULL AND vehiculo_patente != ''`, [], (err, filas) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(filas || []);
  });
});

app.put('/api/personas/:id', (req, res) => {
  const { vehiculo_modelo, vehiculo_patente, credencial_url, credencial_token, dni, cargo_chapa, nombre_completo, jerarquia_rol, limpiar_credencial } = req.body;
  const idPersona = req.params.id;

  if (limpiar_credencial) {
    db.run(`UPDATE personas SET credencial_url = NULL, credencial_token = NULL WHERE id = ?`, [idPersona], function (e) {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true });
    });
  } else {
    db.get(`SELECT * FROM personas WHERE id = ?`, [idPersona], (err, actual) => {
      if (err || !actual) return res.status(404).json({ error: 'Persona no encontrada' });

      let tokenCalculado = credencial_token !== undefined ? credencial_token : actual.credencial_token;
      if (credencial_url) {
        tokenCalculado = credencial_url.trim().split('/').pop().replace('#', '');
      }

      const d = dni !== undefined ? dni : actual.dni;
      const n = nombre_completo !== undefined ? nombre_completo.toUpperCase() : actual.nombre_completo;
      const j = jerarquia_rol !== undefined ? jerarquia_rol : actual.jerarquia_rol;
      const c = cargo_chapa !== undefined ? cargo_chapa : actual.cargo_chapa;
      const u = credencial_url !== undefined ? credencial_url : actual.credencial_url;
      const t = tokenCalculado;
      const m = vehiculo_modelo !== undefined ? vehiculo_modelo : actual.vehiculo_modelo;
      const p = vehiculo_patente !== undefined ? vehiculo_patente : actual.vehiculo_patente;

      const sql = `
        UPDATE personas 
        SET dni = ?, nombre_completo = ?, jerarquia_rol = ?, cargo_chapa = ?, credencial_url = ?, credencial_token = ?, vehiculo_modelo = ?, vehiculo_patente = ?
        WHERE id = ?
      `;

      db.run(sql, [d, n, j, c, u, t, m, p, idPersona], function (e) {
        if (e) {
          console.error("Error al actualizar:", e.message);
          return res.status(500).json({ error: e.message });
        }
        res.json({ success: true });
      });
    });
  }
});

app.post('/api/personas', (req, res) => {
  const { dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token, vehiculo_modelo, vehiculo_patente } = req.body;
  
  if (!nombre_completo) {
    return res.status(400).json({ error: 'El nombre es obligatorio' });
  }

  const token = credencial_url ? credencial_url.trim().split('/').pop().replace('#', '') : (credencial_token || null);

  const sql = `
    INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token, vehiculo_modelo, vehiculo_patente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  db.run(sql, [dni || 'S/D', nombre_completo.toUpperCase(), jerarquia_rol || 'Personal', cargo_chapa || 'S/D', credencial_url || null, token, vehiculo_modelo || null, vehiculo_patente || null], function (e) {
    if (e) {
      return res.status(500).json({ error: e.message });
    }
    res.json({ id: this.lastID, success: true });
  });
});

app.delete('/api/personas/:id', (req, res) => {
  db.run(`DELETE FROM personas WHERE id = ?`, [req.params.id], function (e) {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ success: true });
  });
});

app.get('/api/libro-guardia', (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  db.all(`SELECT * FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id DESC`, [`${fecha}%`], (err, filas) => {
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
  db.run(`UPDATE libro_guardia SET notificado_wa = 1 WHERE id IN (${placeholders})`, ids, function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

app.get('/api/fuerza-presente', (req, res) => {
  const hoy = `${new Date().toISOString().split('T')[0]}%`;
  db.all(`SELECT protagonista, accion, detalle FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id ASC`, [hoy], (err, movimientos) => {
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

app.get('/api/configuracion/:clave', (req, res) => {
  db.get(`SELECT valor FROM configuracion_guardia WHERE clave = ?`, [req.params.clave], (err, fila) => {
    res.json({ valor: fila ? fila.valor : null });
  });
});

app.post('/api/configuracion', (req, res) => {
  const { clave, valor } = req.body;
  db.run(`INSERT INTO configuracion_guardia (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [clave, valor], function (err) {
    res.json({ success: !err });
  });
});

app.listen(PORT, () => {
  console.log(`Servidor activo en puerto ${PORT}`);
});
