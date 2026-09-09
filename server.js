const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Base de datos persistente en la raíz del proyecto
const dbPath = path.join(__dirname, 'guardia_iesp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar con la base de datos:', err.message);
  } else {
    console.log('Conectado exitosamente a guardia_iesp.db');
  }
});

// Estructuras de tablas garantizadas
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

// Obtener todo el personal ordenado por ID descendiente para ver los nuevos arriba
app.get('/api/personal-completo', (req, res) => {
  db.all(`SELECT * FROM personas ORDER BY id DESC`, [], (e, filas) => {
    if (e) return res.json([]);
    res.json(filas || []);
  });
});

// Búsqueda en la tabla personas
app.get('/api/buscar', (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.json([]);

  const sql = `
    SELECT * FROM personas 
    WHERE dni LIKE ? OR nombre_completo LIKE ? OR jerarquia_rol LIKE ? OR cargo_chapa LIKE ? OR credencial_token LIKE ?
    LIMIT 100
  `;
  const param = `%${q}%`;
  db.all(sql, [param, param, param, param, param], (err, filas) => {
    if (err) return res.json([]);
    res.json(filas || []);
  });
});

// Listado de vehículos registrados
app.get('/api/vehiculos', (req, res) => {
  db.all(`SELECT id, nombre_completo AS titular, jerarquia_rol AS jerarquia, vehiculo_modelo AS modelo, vehiculo_patente AS patente FROM personas WHERE vehiculo_patente IS NOT NULL AND vehiculo_patente != ''`, [], (err, filas) => {
    if (err) return res.json([]);
    res.json(filas || []);
  });
});

// Actualizar persona por ID
app.put('/api/personas/:id', (req, res) => {
  const { vehiculo_modelo, vehiculo_patente, credencial_url, credencial_token, dni, cargo_chapa, nombre_completo, jerarquia_rol, limpiar_credencial } = req.body;
  
  if (limpiar_credencial) {
    db.run(`UPDATE personas SET credencial_url = NULL, credencial_token = NULL WHERE id = ?`, [req.params.id], function (e) {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true });
    });
  } else {
    let updates = [];
    let params = [];

    if (vehiculo_modelo !== undefined) { updates.push("vehiculo_modelo = ?"); params.push(vehiculo_modelo); }
    if (vehiculo_patente !== undefined) { updates.push("vehiculo_patente = ?"); params.push(vehiculo_patente); }
    if (credencial_url !== undefined) { updates.push("credencial_url = ?"); params.push(credencial_url); }
    if (credencial_token !== undefined) { updates.push("credencial_token = ?"); params.push(credencial_token); }
    if (dni !== undefined) { updates.push("dni = ?"); params.push(dni); }
    if (cargo_chapa !== undefined) { updates.push("cargo_chapa = ?"); params.push(cargo_chapa); }
    if (nombre_completo !== undefined) { updates.push("nombre_completo = ?"); params.push(nombre_completo); }
    if (jerarquia_rol !== undefined) { updates.push("jerarquia_rol = ?"); params.push(jerarquia_rol); }

    if (updates.length === 0) return res.json({ success: true });

    params.push(req.params.id);
    const sql = `UPDATE personas SET ${updates.join(', ')} WHERE id = ?`;
    
    db.run(sql, params, function (e) {
      if (e) return res.status(500).json({ error: e.message });
      res.json({ success: true });
    });
  }
});

// ALTA DE NUEVO EFECTIVO (Guardado garantizado)
app.post('/api/personas', (req, res) => {
  const { dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token, vehiculo_modelo, vehiculo_patente } = req.body;
  
  if (!nombre_completo) {
    return res.status(400).json({ error: 'El nombre completo es obligatorio' });
  }

  const token = credencial_url ? credencial_url.trim().split('/').pop().replace('#', '') : (credencial_token || null);

  const sql = `
    INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa, credencial_url, credencial_token, vehiculo_modelo, vehiculo_patente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
  db.run(sql, [dni || 'S/D', nombre_completo.toUpperCase(), jerarquia_rol || 'Personal', cargo_chapa || 'S/D', credencial_url || null, token, vehiculo_modelo || null, vehiculo_patente || null], function (e) {
    if (e) {
      console.error("Error al insertar persona:", e.message);
      return res.status(500).json({ error: e.message });
    }
    res.json({ id: this.lastID, success: true });
  });
});

// Eliminar persona por ID
app.delete('/api/personas/:id', (req, res) => {
  db.run(`DELETE FROM personas WHERE id = ?`, [req.params.id], function (e) {
    if (e) return res.status(500).json({ error: e.message });
    res.json({ success: true });
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
  console.log(`Servidor activo en puerto ${PORT}`);
});
