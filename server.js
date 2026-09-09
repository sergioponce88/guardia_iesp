const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Base de datos SQLite local
const dbPath = path.join(__dirname, 'guardia_iesp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar con guardia_iesp.db:', err.message);
  } else {
    console.log('Conectado exitosamente a guardia_iesp.db');
  }
});

// Endpoint proxy para extraer la foto oficial desde credenciales.dpd1.ar
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

    // Localizar el token JWT de la imagen dentro del HTML o scripts
    const match = respuestaHtml.data.match(/\/api\/imagen\/[a-zA-Z0-9_\-\.]+/);
    if (!match) {
      return res.status(404).send('Token de imagen no encontrado');
    }

    const imagenUrl = `https://credenciales.dpd1.ar${match[0]}`;

    // Descarga de la imagen enviando el Referer obligatorio para evitar el error de lectura
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
    console.error('Error al obtener foto oficial:', error.message);
    res.status(500).send('Error interno al procesar la foto');
  }
});

// Búsqueda de personas
app.get('/api/buscar', (req, res) => {
  const query = req.query.q || '';
  const sql = `
    SELECT * FROM personas 
    WHERE nombre LIKE ? OR dni LIKE ? OR credencial LIKE ? OR jerarquia LIKE ?
    LIMIT 10
  `;
  const parametro = `%${query}%`;

  db.all(sql, [parametro, parametro, parametro, parametro], (err, filas) => {
    if (err) {
      console.error('Error en /api/buscar:', err.message);
      return res.status(500).json({ error: 'Error en la base de datos' });
    }
    res.json(filas);
  });
});

// Libro de Guardia
app.get('/api/libro-guardia', (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const sql = `SELECT * FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id DESC`;
  db.all(sql, [`${fecha}%`], (err, filas) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(filas);
  });
});

app.post('/api/libro-guardia', (req, res) => {
  const { puesto, accion, protagonista, detalle, rubro } = req.body;
  const now = new Date();
  const hora = now.toTimeString().split(' ')[0].substring(0, 5);
  const fechaCompleta = now.toISOString().replace('T', ' ').substring(0, 19);

  const sql = `
    INSERT INTO libro_guardia (hora, fecha_completa, puesto, accion, protagonista, detalle, rubro, estado, notificado_wa, con_retardo)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVO', 0, 0)
  `;

  db.run(sql, [hora, fechaCompleta, puesto, accion, protagonista, detalle, rubro || 'PERSONAL'], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ id: this.lastID, success: true });
  });
});

// Estado de Fuerza Presente (seguro frente a ausencia de tabla dedicada)
app.get('/api/fuerza-presente', (req, res) => {
  const sql = `
    SELECT accion, COUNT(*) as total 
    FROM libro_guardia 
    WHERE fecha_completa LIKE ? 
    GROUP BY accion
  `;
  const hoy = `${new Date().toISOString().split('T')[0]}%`;

  db.all(sql, [hoy], (err, filas) => {
    if (err) return res.json([]);
    res.json(filas);
  });
});

app.listen(PORT, () => {
  console.log(`Guardia IESP en puerto ${PORT}`);
});
