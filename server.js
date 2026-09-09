const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Conexión a la base de datos SQLite
const dbPath = path.join(__dirname, 'guardia_iesp.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error al conectar con guardia_iesp.db:', err.message);
  } else {
    console.log('Conectado exitosamente a guardia_iesp.db');
  }
});

// Endpoint proxy para extraer y servir la foto de la credencial oficial
app.get('/api/extraer-foto', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('URL requerida');

  try {
    const respuesta = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      },
      timeout: 7000
    });

    const $ = cheerio.load(respuesta.data);
    
    // Buscar la imagen en selectores comunes o por atributo base64
    let fotoSrc = $('img#foto, img.foto-credencial, img[src*="fotos"], img[src*="credencial"], img[src*="personal"]').attr('src');

    // Si no está en tag <img>, buscar patrón data:image en scripts o HTML crudo
    if (!fotoSrc) {
      const match = respuesta.data.match(/data:image\/[a-zA-Z]+;base64,[^"'\s]+/);
      if (match) {
        fotoSrc = match[0];
      }
    }

    if (!fotoSrc) {
      return res.status(404).send('Foto no localizada en la credencial');
    }

    // Caso 1: Imagen codificada en Base64
    if (fotoSrc.startsWith('data:image')) {
      const partes = fotoSrc.split(',');
      const mime = partes[0].match(/:(.*?);/)[1];
      const imgBuffer = Buffer.from(partes[1], 'base64');
      res.set('Content-Type', mime);
      return res.send(imgBuffer);
    }

    // Caso 2: URL relativa
    if (fotoSrc.startsWith('/')) {
      fotoSrc = 'https://credenciales.dpdt.ar' + fotoSrc;
    }

    // Caso 3: URL externa completa
    const stream = await axios.get(fotoSrc, { responseType: 'arraybuffer' });
    res.set('Content-Type', stream.headers['content-type'] || 'image/jpeg');
    res.send(stream.data);

  } catch (error) {
    console.error('Error al extraer foto:', error.message);
    res.status(500).send('Error interno al obtener imagen');
  }
});

// Endpoint de búsqueda de personas
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

// Endpoint de Libro de Guardia
app.get('/api/libro-guardia', (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().split('T')[0];
  const sql = `SELECT * FROM libro_guardia WHERE fecha_completa LIKE ? ORDER BY id DESC`;
  db.all(sql, [`${fecha}%`], (err, filas) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(filas);
  });
});

// Endpoint de Fuerza Activa
app.get('/api/fuerza-presente', (req, res) => {
  const sql = `SELECT * FROM fuerza_activa`;
  db.all(sql, [], (err, filas) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(filas);
  });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(` Guardia IESP Activa en http://localhost:${PORT}`);
  console.log(`========================================`);
});
