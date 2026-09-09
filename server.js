const express = require('express');
const cors = require('cors');
const path = require('path');
const https = require('https');
const http = require('http');
const db = require('./database');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Tabla de configuración operativa de la guardia
db.run(`
  CREATE TABLE IF NOT EXISTS configuracion_guardia (
    clave TEXT PRIMARY KEY,
    valor TEXT
  )
`, () => {
  db.run(`INSERT OR IGNORE INTO configuracion_guardia (clave, valor) VALUES ('limite_franco_cadetes', '')`);
  db.run(`INSERT OR IGNORE INTO configuracion_guardia (clave, valor) VALUES ('oficial_servicio_actual', '')`);
  db.run(`INSERT OR IGNORE INTO configuracion_guardia (clave, valor) VALUES ('consigna_turno_actual', '')`);
});

// Columnas necesarias
db.run(`ALTER TABLE vehiculos ADD COLUMN persona_id INTEGER`, () => {});
db.run(`ALTER TABLE personas ADD COLUMN credencial_token TEXT`, () => {});
db.run(`ALTER TABLE personas ADD COLUMN credencial_url TEXT`, () => {});
db.run(`ALTER TABLE personas ADD COLUMN foto_url TEXT`, () => {});

db.run(`ALTER TABLE accesos ADD COLUMN estado TEXT DEFAULT 'ACTIVO'`, () => {});
db.run(`ALTER TABLE accesos ADD COLUMN motivo_anulacion TEXT`, () => {});
db.run(`ALTER TABLE accesos ADD COLUMN notificado_wa INTEGER DEFAULT 0`, () => {});
db.run(`ALTER TABLE accesos ADD COLUMN con_retardo INTEGER DEFAULT 0`, () => {});

db.run(`ALTER TABLE logistica_visitas ADD COLUMN puesto TEXT DEFAULT 'Puesto 1'`, () => {});
db.run(`ALTER TABLE logistica_visitas ADD COLUMN estado TEXT DEFAULT 'ACTIVO'`, () => {});
db.run(`ALTER TABLE logistica_visitas ADD COLUMN motivo_anulacion TEXT`, () => {});
db.run(`ALTER TABLE logistica_visitas ADD COLUMN notificado_wa INTEGER DEFAULT 0`, () => {});

db.run(`ALTER TABLE comisiones ADD COLUMN motivo_anulacion TEXT`, () => {});
db.run(`ALTER TABLE comisiones ADD COLUMN notificado_wa INTEGER DEFAULT 0`, () => {});

// ==========================================================
// FUNCIÓN AUXILIAR: EXTRAER FOTO DE CREDENCIAL WEB OFICIAL
// ==========================================================
function extraerFotoDeCredencial(urlDestino) {
  return new Promise((resolve) => {
    try {
      const cliente = urlDestino.startsWith('https') ? https : http;
      cliente.get(urlDestino, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          // Buscar etiquetas img que contengan fotos de perfil o rutas a imágenes
          const regexFoto = /<img[^>]+src=["']([^"']*(?:foto|perfil|avatar|credencial|upload|storage|images)[^"']*)["']/i;
          const match = body.match(regexFoto);

          if (match && match[1]) {
            let encontrada = match[1];
            if (encontrada.startsWith('//')) encontrada = 'https:' + encontrada;
            else if (encontrada.startsWith('/')) {
              const urlObj = new URL(urlDestino);
              encontrada = `${urlObj.origin}${encontrada}`;
            }
            return resolve(encontrada);
          }

          // Respaldo: primera imagen que termine en jpg/png/jpeg/webp si no tiene palabras clave
          const regexGenerica = /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?)["']/i;
          const matchGen = body.match(regexGenerica);
          if (matchGen && matchGen[1]) {
            let encontrada = matchGen[1];
            if (encontrada.startsWith('//')) encontrada = 'https:' + encontrada;
            else if (encontrada.startsWith('/')) {
              const urlObj = new URL(urlDestino);
              encontrada = `${urlObj.origin}${encontrada}`;
            }
            return resolve(encontrada);
          }

          resolve(null);
        });
      }).on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

// ==========================================================
// 1. GESTIÓN DEL OFICIAL DE SERVICIO Y PARÁMETROS DEL TURNO
// ==========================================================
app.get('/api/config/oficial-servicio', (req, res) => {
  db.all(`SELECT clave, valor FROM configuracion_guardia WHERE clave IN ('oficial_servicio_actual', 'limite_franco_cadetes', 'consigna_turno_actual')`, (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const config = {};
    rows.forEach(r => config[r.clave] = r.valor);
    res.json(config);
  });
});

app.post('/api/config/oficial-servicio', (req, res) => {
  const { oficial, limite_franco, consigna } = req.body;
  db.serialize(() => {
    if (oficial !== undefined) {
      db.run(`INSERT INTO configuracion_guardia (clave, valor) VALUES ('oficial_servicio_actual', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [oficial]);
    }
    if (limite_franco !== undefined) {
      db.run(`INSERT INTO configuracion_guardia (clave, valor) VALUES ('limite_franco_cadetes', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [limite_franco]);
    }
    if (consigna !== undefined) {
      db.run(`INSERT INTO configuracion_guardia (clave, valor) VALUES ('consigna_turno_actual', ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor`, [consigna]);
    }
    res.json({ success: true });
  });
});

app.post('/api/oficial-servicio/asentar-acto', (req, res) => {
  const { titulo, detalle } = req.body;
  db.get(`SELECT valor FROM configuracion_guardia WHERE clave = 'oficial_servicio_actual'`, (err, row) => {
    const oficial = (row && row.valor) ? row.valor : 'Oficial de Servicio';
    db.run(
      `INSERT INTO logistica_visitas (puesto, tipo_evento, nombre_completo, dni, vehiculo_dominio, detalle_motivo, estado, notificado_wa) VALUES ('Despacho Oficial', ?, ?, 'OFICIAL DE GUARDIA', '-', ?, 'ACTIVO', 0)`,
      [`DISPOSICIÓN: ${titulo || 'ACTO DE SERVICIO'}`, oficial, detalle || 'Sin detalles'],
      function(errIns) {
        if (errIns) return res.status(500).json({ error: errIns.message });
        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

// ==========================================================
// 2. RESUMEN DE FUERZA EFECTIVA PRESENTE (TIEMPO REAL)
// ==========================================================
app.get('/api/fuerza-presente', (req, res) => {
  const query = `
    WITH UltimoAcceso AS (
      SELECT 
        persona_id,
        tipo_movimiento,
        ROW_NUMBER() OVER (PARTITION BY persona_id ORDER BY fecha_hora DESC) as rn
      FROM accesos
      WHERE estado = 'ACTIVO'
    ),
    UltimoVehiculo AS (
      SELECT 
        UPPER(vehiculo_dominio) as dominio,
        tipo_evento,
        ROW_NUMBER() OVER (PARTITION BY UPPER(vehiculo_dominio) ORDER BY fecha_hora DESC) as rn
      FROM logistica_visitas
      WHERE vehiculo_dominio IS NOT NULL AND vehiculo_dominio != '' AND estado = 'ACTIVO'
    )
    SELECT 
      COUNT(DISTINCT p.id) as total_padron,
      COALESCE(SUM(CASE WHEN p.tipo_persona = 'PERSONAL' THEN 1 ELSE 0 END), 0) as total_planta,
      COALESCE(SUM(CASE WHEN p.tipo_persona = 'PERSONAL' AND ua.tipo_movimiento = 'INGRESO' THEN 1 ELSE 0 END), 0) as presentes_planta,
      
      COALESCE(SUM(CASE WHEN p.jerarquia_rol LIKE '%1°%' THEN 1 ELSE 0 END), 0) as total_cad1,
      COALESCE(SUM(CASE WHEN p.jerarquia_rol LIKE '%1°%' AND ua.tipo_movimiento = 'INGRESO' THEN 1 ELSE 0 END), 0) as presentes_cad1,

      COALESCE(SUM(CASE WHEN p.jerarquia_rol LIKE '%2°%' THEN 1 ELSE 0 END), 0) as total_cad2,
      COALESCE(SUM(CASE WHEN p.jerarquia_rol LIKE '%2°%' AND ua.tipo_movimiento = 'INGRESO' THEN 1 ELSE 0 END), 0) as presentes_cad2,

      COALESCE(SUM(CASE WHEN p.jerarquia_rol LIKE '%3°%' THEN 1 ELSE 0 END), 0) as total_cad3,
      COALESCE(SUM(CASE WHEN p.jerarquia_rol LIKE '%3°%' AND ua.tipo_movimiento = 'INGRESO' THEN 1 ELSE 0 END), 0) as presentes_cad3,

      (SELECT COUNT(*) FROM UltimoVehiculo uv WHERE uv.rn = 1 AND uv.tipo_evento LIKE '%INGRESO%') as vehiculos_adentro,
      (SELECT COUNT(*) FROM comisiones WHERE estado = 'EN CURSO') as comisiones_activas

    FROM personas p
    LEFT JOIN UltimoAcceso ua ON p.id = ua.persona_id AND ua.rn = 1;
  `;

  db.get(query, [], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row);
  });
});

// ==========================================================
// 3. VALIDACIÓN ANTI-PASSBACK (ESTADO ACTUAL ADENTRO / AFUERA)
// ==========================================================
app.get('/api/personas/:id/estado-actual', (req, res) => {
  const sql = `
    SELECT tipo_movimiento, strftime('%H:%M', fecha_hora) as hora, puesto
    FROM accesos
    WHERE persona_id = ? AND estado = 'ACTIVO'
    ORDER BY fecha_hora DESC LIMIT 1
  `;
  db.get(sql, [req.params.id], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(row || { tipo_movimiento: 'EGRESO', hora: null, puesto: null });
  });
});

app.get('/api/vehiculos/estado/:dominio', (req, res) => {
  const dominio = req.params.dominio.trim().toUpperCase();
  const sql = `
    SELECT tipo_evento, strftime('%H:%M', fecha_hora) as hora, puesto
    FROM logistica_visitas
    WHERE UPPER(vehiculo_dominio) = ? AND estado = 'ACTIVO'
    ORDER BY fecha_hora DESC LIMIT 1
  `;
  db.get(sql, [dominio], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    let estado = 'EGRESO';
    if (row && row.tipo_evento && row.tipo_evento.includes('INGRESO')) {
      estado = 'INGRESO';
    }
    res.json({ estado, hora: row ? row.hora : null, puesto: row ? row.puesto : null });
  });
});

// ==========================================================
// 4. LÍNEA CRONOLÓGICA GENERAL (LIBRO DE GUARDIA)
// ==========================================================
app.get('/api/libro-guardia', (req, res) => {
  const fecha = req.query.fecha || new Date().toISOString().slice(0, 10);

  const query = `
    SELECT 
      a.id,
      strftime('%H:%M', a.fecha_hora) as hora,
      a.fecha_hora as fecha_completa,
      COALESCE(a.puesto, 'Puesto 1') as puesto,
      a.tipo_movimiento as accion,
      (p.jerarquia_rol || ' ' || p.nombre_completo || CASE WHEN p.cargo_chapa IS NOT NULL AND p.cargo_chapa != '' THEN ' (C/' || p.cargo_chapa || ')' ELSE '' END) as protagonista,
      COALESCE(a.observacion, p.area_division, p.tipo_persona) as detalle,
      'PERSONAL' as rubro,
      COALESCE(a.estado, 'ACTIVO') as estado,
      a.motivo_anulacion,
      COALESCE(a.notificado_wa, 0) as notificado_wa,
      COALESCE(a.con_retardo, 0) as con_retardo
    FROM accesos a
    JOIN personas p ON a.persona_id = p.id
    WHERE date(a.fecha_hora) = date(?)

    UNION ALL

    SELECT 
      c.id,
      strftime('%H:%M', c.hora_salida) as hora,
      c.hora_salida as fecha_completa,
      'Guardia' as puesto,
      'SALIDA COMISIÓN' as accion,
      c.cadetes_efectivos as protagonista,
      ('Destino: ' || c.destino || ' | Tipo: ' || c.tipo || ' | Móvil: ' || COALESCE(c.vehiculo, 'S/D')) as detalle,
      'COMISION' as rubro,
      COALESCE(c.estado, 'EN CURSO') as estado,
      c.motivo_anulacion,
      COALESCE(c.notificado_wa, 0) as notificado_wa,
      0 as con_retardo
    FROM comisiones c
    WHERE date(c.hora_salida) = date(?)

    UNION ALL

    SELECT 
      c.id,
      strftime('%H:%M', c.hora_regreso) as hora,
      c.hora_regreso as fecha_completa,
      'Guardia' as puesto,
      'REGRESO COMISIÓN' as accion,
      c.cadetes_efectivos as protagonista,
      ('Regresan de: ' || c.destino || ' | S/Novedad') as detalle,
      'COMISION' as rubro,
      'ACTIVO' as estado,
      NULL as motivo_anulacion,
      COALESCE(c.notificado_wa, 0) as notificado_wa,
      0 as con_retardo
    FROM comisiones c
    WHERE c.hora_regreso IS NOT NULL AND date(c.hora_regreso) = date(?) AND c.estado != 'ANULADO'

    UNION ALL

    SELECT 
      l.id,
      strftime('%H:%M', l.fecha_hora) as hora,
      l.fecha_hora as fecha_completa,
      COALESCE(l.puesto, 'Puesto 1') as puesto,
      l.tipo_evento as accion,
      (l.nombre_completo || CASE WHEN l.dni IS NOT NULL AND l.dni != '' THEN ' (' || l.dni || ')' ELSE '' END) as protagonista,
      (l.detalle_motivo || CASE WHEN l.vehiculo_dominio IS NOT NULL AND l.vehiculo_dominio != '' THEN ' [Patente: ' || l.vehiculo_dominio || ']' ELSE '' END) as detalle,
      'LOGISTICA' as rubro,
      COALESCE(l.estado, 'ACTIVO') as estado,
      l.motivo_anulacion,
      COALESCE(l.notificado_wa, 0) as notificado_wa,
      0 as con_retardo
    FROM logistica_visitas l
    WHERE date(l.fecha_hora) = date(?)

    ORDER BY fecha_completa ASC
  `;

  db.all(query, [fecha, fecha, fecha, fecha], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/libro-guardia/marcar-wa', (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids)) return res.status(400).json({ error: 'Formato inválido' });

  db.serialize(() => {
    ids.forEach(item => {
      let tabla = '';
      if (item.rubro === 'PERSONAL') tabla = 'accesos';
      else if (item.rubro === 'LOGISTICA') tabla = 'logistica_visitas';
      else if (item.rubro === 'COMISION') tabla = 'comisiones';

      if (tabla) {
        db.run(`UPDATE ${tabla} SET notificado_wa = 1 WHERE id = ?`, [item.id]);
      }
    });
    res.json({ success: true });
  });
});

app.post('/api/libro-guardia/anular', (req, res) => {
  const { id, rubro, motivo } = req.body;
  const motivoTexto = (motivo || 'Carga errónea').trim();

  let tabla = '';
  if (rubro === 'PERSONAL') tabla = 'accesos';
  else if (rubro === 'LOGISTICA') tabla = 'logistica_visitas';
  else if (rubro === 'COMISION') tabla = 'comisiones';

  if (!tabla) return res.status(400).json({ error: 'Rubro inválido' });

  db.run(
    `UPDATE ${tabla} SET estado = 'ANULADO', motivo_anulacion = ? WHERE id = ?`,
    [motivoTexto, id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

// ==========================================================
// 5. REGISTRO DE ACCESO CON ANTI-PASSBACK Y RETARDO
// ==========================================================
app.post('/api/accesos/combinado', (req, res) => {
  const { persona_id, tipo_movimiento, puesto, con_vehiculo, dominio, modelo, titular, jerarquia, forzar } = req.body;
  const puestoSeleccionado = puesto || 'Puesto 1';

  const sqlCheck = `
    SELECT tipo_movimiento, strftime('%H:%M', fecha_hora) as hora
    FROM accesos
    WHERE persona_id = ? AND estado = 'ACTIVO'
    ORDER BY fecha_hora DESC LIMIT 1
  `;

  db.get(sqlCheck, [persona_id], (err, ultimo) => {
    if (err) return res.status(500).json({ error: err.message });

    if (!forzar && ultimo && ultimo.tipo_movimiento === tipo_movimiento) {
      return res.status(400).json({
        conflicto: true,
        mensaje: `El efectivo ya registra un ${tipo_movimiento} a las ${ultimo.hora} hs. Debe asentar ${tipo_movimiento === 'INGRESO' ? 'EGRESO' : 'INGRESO'}.`
      });
    }

    db.get(`SELECT tipo_persona FROM personas WHERE id = ?`, [persona_id], (errPer, rowPer) => {
      db.get(`SELECT valor FROM configuracion_guardia WHERE clave = 'limite_franco_cadetes'`, (errCfg, rowCfg) => {
        let conRetardo = 0;
        let obsExtra = '';

        if (tipo_movimiento === 'INGRESO' && rowPer && rowPer.tipo_persona === 'CADETE' && rowCfg && rowCfg.valor) {
          const ahora = new Date();
          const limite = new Date(rowCfg.valor);
          if (!isNaN(limite.getTime()) && ahora > limite) {
            conRetardo = 1;
            obsExtra = ' ⚠️ RETARDO (Franco Vencido)';
          }
        }

        db.serialize(() => {
          let obsPersona = con_vehiculo ? `En rodado ${modelo || ''} (${dominio})` : 'A pie';
          if (obsExtra) obsPersona += obsExtra;

          db.run(
            `INSERT INTO accesos (persona_id, puesto, tipo_movimiento, observacion, estado, notificado_wa, con_retardo) VALUES (?, ?, ?, ?, 'ACTIVO', 0, ?)`,
            [persona_id, puestoSeleccionado, tipo_movimiento, obsPersona, conRetardo]
          );

          if (con_vehiculo && dominio) {
            db.run(
              `INSERT INTO logistica_visitas (puesto, tipo_evento, nombre_completo, dni, vehiculo_dominio, detalle_motivo, estado, notificado_wa) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', 0)`,
              [puestoSeleccionado, `VEHÍCULO (${tipo_movimiento})`, titular, jerarquia || '-', dominio, `${tipo_movimiento} al mando de titular`]
            );
          }

          res.json({ success: true, conRetardo });
        });
      });
    });
  });
});

app.post('/api/accesos', (req, res) => {
  const { persona_id, puesto, tipo_movimiento, observacion } = req.body;
  db.run(
    `INSERT INTO accesos (persona_id, puesto, tipo_movimiento, observacion, estado, notificado_wa) VALUES (?, ?, ?, ?, 'ACTIVO', 0)`,
    [persona_id, puesto || 'Puesto 1', tipo_movimiento, observacion || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

// ==========================================================
// 6. ESCANEO QR, FOTOS Y PADRÓN DE INTEGRANTES
// ==========================================================
app.get('/api/personas/por-token/:token', (req, res) => {
  const token = req.params.token.trim();
  const sql = `
    SELECT 
      p.*,
      v.id as vehiculo_id,
      v.dominio as veh_dominio,
      v.modelo as veh_modelo
    FROM personas p
    LEFT JOIN vehiculos v ON (
      v.persona_id = p.id 
      OR UPPER(p.nombre_completo) LIKE '%' || UPPER(TRIM(v.titular)) || '%'
      OR UPPER(v.titular) LIKE '%' || UPPER(TRIM(SUBSTR(p.nombre_completo, 1, INSTR(p.nombre_completo, ',') - 1))) || '%'
    )
    WHERE p.credencial_token = ?
    GROUP BY p.id
    LIMIT 1
  `;
  db.get(sql, [token], async (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.json(null);

    // Si aún no tiene foto guardada, intentar extraerla de inmediato
    if (!row.foto_url && row.credencial_url) {
      const fotoEncontrada = await extraerFotoDeCredencial(row.credencial_url);
      if (fotoEncontrada) {
        db.run(`UPDATE personas SET foto_url = ? WHERE id = ?`, [fotoEncontrada, row.id]);
        row.foto_url = fotoEncontrada;
      }
    }

    res.json(row);
  });
});

app.post('/api/personas/:id/vincular-qr', async (req, res) => {
  const { token, url } = req.body;
  const tokenLimpio = (token || '').trim();
  const urlCompleta = (url || `https://credenciales.dpd1.ar/publicoQR/${tokenLimpio}`).trim();

  // Intentar obtener la foto desde la URL oficial
  const fotoEncontrada = await extraerFotoDeCredencial(urlCompleta);

  db.run(
    `UPDATE personas SET credencial_token = ?, credencial_url = ?, foto_url = COALESCE(?, foto_url) WHERE id = ?`,
    [tokenLimpio, urlCompleta, fotoEncontrada, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, token: tokenLimpio, url: urlCompleta, foto_url: fotoEncontrada });
    }
  );
});

app.get('/api/personas/buscar', (req, res) => {
  const q = req.query.q || '';
  const sql = `
    SELECT 
      p.*,
      v.id as vehiculo_id,
      v.dominio as veh_dominio,
      v.modelo as veh_modelo
    FROM personas p
    LEFT JOIN vehiculos v ON (
      v.persona_id = p.id 
      OR UPPER(p.nombre_completo) LIKE '%' || UPPER(TRIM(v.titular)) || '%'
      OR UPPER(v.titular) LIKE '%' || UPPER(TRIM(SUBSTR(p.nombre_completo, 1, INSTR(p.nombre_completo, ',') - 1))) || '%'
    )
    WHERE p.nombre_completo LIKE ? 
       OR p.cargo_chapa LIKE ? 
       OR p.jerarquia_rol LIKE ?
       OR (p.dni IS NOT NULL AND p.dni LIKE ?)
    GROUP BY p.id
    LIMIT 15
  `;
  db.all(sql, [`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/personas', (req, res) => {
  db.all(`SELECT * FROM personas ORDER BY jerarquia_rol ASC, nombre_completo ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/personas', (req, res) => {
  const { nombre_completo, jerarquia_rol, cargo_chapa, area_division, tipo_persona, dni } = req.body;
  db.run(
    `INSERT INTO personas (nombre_completo, jerarquia_rol, cargo_chapa, area_division, tipo_persona, dni)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [nombre_completo, jerarquia_rol, cargo_chapa || null, area_division || null, tipo_persona || 'PERSONAL', dni || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.put('/api/personas/:id', (req, res) => {
  const { nombre_completo, jerarquia_rol, cargo_chapa, area_division, tipo_persona, dni } = req.body;
  db.run(
    `UPDATE personas 
     SET nombre_completo = ?, jerarquia_rol = ?, cargo_chapa = ?, area_division = ?, tipo_persona = ?, dni = ?
     WHERE id = ?`,
    [nombre_completo, jerarquia_rol, cargo_chapa || null, area_division || null, tipo_persona || 'PERSONAL', dni || null, req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/personas/:id', (req, res) => {
  db.run(`DELETE FROM personas WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ==========================================================
// 7. PARQUE AUTOMOTOR (VEHÍCULOS)
// ==========================================================
app.get('/api/vehiculos', (req, res) => {
  db.all(`SELECT * FROM vehiculos ORDER BY titular ASC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.get('/api/vehiculos/buscar', (req, res) => {
  const q = req.query.q || '';
  db.all(
    `SELECT * FROM vehiculos WHERE dominio LIKE ? OR titular LIKE ? LIMIT 10`,
    [`%${q}%`, `%${q}%`],
    (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(rows);
    }
  );
});

app.post('/api/vehiculos', (req, res) => {
  const { titular, jerarquia, modelo, dominio, persona_id } = req.body;
  if (!titular || !dominio) {
    return res.status(400).json({ error: 'Titular y Dominio son obligatorios' });
  }

  db.run(
    `INSERT INTO vehiculos (titular, jerarquia, modelo, dominio, persona_id) VALUES (?, ?, ?, ?, ?)`,
    [titular, jerarquia || null, modelo || null, dominio.toUpperCase().trim(), persona_id || null],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID, dominio: dominio.toUpperCase().trim(), modelo });
    }
  );
});

app.put('/api/vehiculos/:id', (req, res) => {
  const { titular, jerarquia, modelo, dominio } = req.body;
  db.run(
    `UPDATE vehiculos 
     SET titular = ?, jerarquia = ?, modelo = ?, dominio = ?
     WHERE id = ?`,
    [titular, jerarquia || null, modelo || null, (dominio || '').toUpperCase().trim(), req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.delete('/api/vehiculos/:id', (req, res) => {
  db.run(`DELETE FROM vehiculos WHERE id = ?`, [req.params.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

// ==========================================================
// 8. COMISIONES Y LOGÍSTICA
// ==========================================================
app.post('/api/comisiones', (req, res) => {
  const { tipo, destino, vehiculo, responsable, cadetes_efectivos } = req.body;
  db.run(
    `INSERT INTO comisiones (tipo, destino, vehiculo, responsable, cadetes_efectivos, estado, notificado_wa) VALUES (?, ?, ?, ?, ?, 'EN CURSO', 0)`,
    [tipo, destino, vehiculo, responsable, cadetes_efectivos],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.post('/api/comisiones/:id/regreso', (req, res) => {
  db.run(
    `UPDATE comisiones SET hora_regreso = datetime('now', 'localtime'), estado = 'CONCLUIDO', notificado_wa = 0 WHERE id = ?`,
    [req.params.id],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true });
    }
  );
});

app.get('/api/comisiones/activas', (req, res) => {
  db.all(`SELECT * FROM comisiones WHERE estado = 'EN CURSO' ORDER BY hora_salida DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

app.post('/api/logistica', (req, res) => {
  const { puesto, tipo_evento, nombre_completo, dni, vehiculo_dominio, detalle_motivo } = req.body;
  const nombreLimpio = (nombre_completo || '').trim().toUpperCase();
  const dniLimpio = (dni || '').trim();
  const dominioLimpio = (vehiculo_dominio || '').trim().toUpperCase();

  db.serialize(() => {
    db.run(
      `INSERT INTO logistica_visitas (puesto, tipo_evento, nombre_completo, dni, vehiculo_dominio, detalle_motivo, estado, notificado_wa) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVO', 0)`,
      [puesto || 'Puesto 1', tipo_evento, nombreLimpio, dniLimpio, dominioLimpio, detalle_motivo],
      function (err) {
        if (err) return res.status(500).json({ error: err.message });

        if (nombreLimpio.length > 2) {
          const sqlExiste = dniLimpio.length > 3 
            ? `SELECT id FROM personas WHERE dni = ? OR nombre_completo = ? LIMIT 1`
            : `SELECT id FROM personas WHERE nombre_completo = ? LIMIT 1`;
          const paramsExiste = dniLimpio.length > 3 ? [dniLimpio, nombreLimpio] : [nombreLimpio];

          db.get(sqlExiste, paramsExiste, (errEx, personaExistente) => {
            if (!personaExistente) {
              db.run(
                `INSERT INTO personas (nombre_completo, jerarquia_rol, cargo_chapa, area_division, tipo_persona, dni)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [nombreLimpio, 'VISITANTE / PROVEEDOR', dniLimpio ? `DNI: ${dniLimpio}` : '-', detalle_motivo, 'VISITANTE', dniLimpio || null],
                function(errPer) {
                  const nuevaId = this ? this.lastID : null;
                  if (nuevaId && dominioLimpio.length >= 5) {
                    db.run(
                      `INSERT INTO vehiculos (titular, jerarquia, modelo, dominio, persona_id) VALUES (?, ?, ?, ?, ?)`,
                      [nombreLimpio, 'VISITANTE', 'Particular / Carga', dominioLimpio, nuevaId]
                    );
                  }
                }
              );
            }
          });
        }

        res.json({ success: true, id: this.lastID });
      }
    );
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`===================================================`);
  console.log(` Guardia IESP Activa en http://localhost:${PORT}`);
  console.log(`===================================================`);
});