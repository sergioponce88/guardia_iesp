const fs = require('fs');
const { Pool } = require('pg');
const XLSX = require('xlsx');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function importarDatos() {
  try {
    console.log('Iniciando importación masiva...');

    // 1. Importar Cadetes desde "LISTADO DE COMPAÑIA DE CADETES AÑO 2026 PARA D1.xlsx"
    if (fs.existsSync('LISTADO DE COMPAÑIA DE CADETES AÑO 2026 PARA D1.xlsx')) {
      const workbook = XLSX.readFile('LISTADO DE COMPAÑIA DE CADETES AÑO 2026 PARA D1.xlsx');
      const sheetName = workbook.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

      for (const row of rows) {
        const apellido = String(row['APELLIDO'] || '').trim();
        const nombres = String(row['NOMBRES'] || '').trim();
        const nombreCompleto = `${apellido}, ${nombres}`.toUpperCase();
        const dni = String(row['DNI'] || 'S/D').trim();
        const cargoChapa = String(row['CARGO'] || 'S/D').trim();
        const curso = String(row['CURSO'] || '').trim(); // ej: "1 AÑO", "2 AÑO", "3 AÑO"
        const jerarquiaRol = curso ? `Cadete ${curso}` : 'Cadete';

        if (nombreCompleto !== ',') {
          await pool.query(
            `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa) 
             VALUES ($1, $2, $3, $4)`,
            [dni, nombreCompleto, jerarquiaRol, cargoChapa]
          );
        }
      }
      console.log(`> Cadetes importados con éxito (${rows.length} registros procesados).`);
    }

    // 2. Importar Roll de Combate desde "LEO IESP.xlsx"
    if (fs.existsSync('LEO IESP.xlsx')) {
      const fileBuffer = fs.readFileSync('LEO IESP.xlsx');
      const textContent = fileBuffer.toString('utf8');
      const idx = textContent.indexOf('ROLL DE COMBATE');
      
      if (idx !== -1) {
        const cleanLeo = "".join ? [...textContent.slice(idx)].filter(c => c.charCodeAt(0) >= 32 || c === '\n').join('') : textContent.slice(idx);
        const regex = /"([^"]+)",([^,]+),([^,]+),([^\"]+?)(?="[A-ZÁÉÍÓÚÑa-zñ\s\.,-]+",[A-Z]|$)/g;
        let match;
        let count = 0;

        while ((match = regex.exec(textContent)) !== null) {
          const nombreCompleto = match[1].trim().toUpperCase();
          const grado = match[2].trim();
          const cargoChapa = match[3].trim();

          if (nombreCompleto) {
            await pool.query(
              `INSERT INTO personas (dni, nombre_completo, jerarquia_rol, cargo_chapa) 
               VALUES ($1, $2, $3, $4)`,
              ['S/D', nombreCompleto, grado, cargoChapa]
            );
            count++;
          }
        }
        console.log(`> Personal de LEO IESP importado con éxito (${count} registros procesados).`);
      }
    }

    console.log('¡Importación completa finalizada!');
    process.exit(0);
  } catch (err) {
    console.error('Error durante la importación:', err);
    process.exit(1);
  }
}

importarDatos();
