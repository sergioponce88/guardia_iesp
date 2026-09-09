const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('./guardia_iesp.db');

module.exports = db;
db.serialize(() => {
  // Padrón de Personal y Cadetes
  db.run(`
    CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dni TEXT UNIQUE,
      nombre_completo TEXT NOT NULL,
      jerarquia_rol TEXT NOT NULL,
      cargo_chapa TEXT,
      area_division TEXT
    )
  `);

  // Registros de Accesos Diarios (Puesto 1 / Puesto 2)
  db.run(`
    CREATE TABLE IF NOT EXISTS accesos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id INTEGER,
      puesto TEXT NOT NULL,
      tipo_movimiento TEXT NOT NULL,
      fecha_hora DATETIME DEFAULT (datetime('now', 'localtime')),
      observacion TEXT,
      FOREIGN KEY (persona_id) REFERENCES personas(id)
    )
  `);

  // Comisiones, Prácticas y Salidas Externas
  db.run(`
    CREATE TABLE IF NOT EXISTS comisiones (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo TEXT NOT NULL,
      destino TEXT NOT NULL,
      vehiculo TEXT,
      responsable TEXT,
      cadetes_efectivos TEXT,
      hora_salida DATETIME DEFAULT (datetime('now', 'localtime')),
      hora_regreso DATETIME,
      estado TEXT DEFAULT 'EN CURSO'
    )
  `);

  // Proveedores, Logística y Visitas Casuales
  db.run(`
    CREATE TABLE IF NOT EXISTS logistica_visitas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_evento TEXT NOT NULL,
      nombre_completo TEXT NOT NULL,
      dni TEXT,
      vehiculo_dominio TEXT,
      detalle_motivo TEXT NOT NULL,
      fecha_hora DATETIME DEFAULT (datetime('now', 'localtime'))
    )
  `);
});

module.exports = db;