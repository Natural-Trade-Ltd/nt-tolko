#!/usr/bin/env node
/* Ingesta local de listas Tolko → tolko-api (Supabase, proyecto Matriz de Ofertas)
   Uso:
     node ingest/ingest-local.mjs excel <ruta.xlsx> [--fecha YYYY-MM-DD] [--dry]
     node ingest/ingest-local.mjs lowgrade <ruta.json> [--fecha YYYY-MM-DD] [--dry]
   El JSON de lowgrade: { fecha, titulo, archivo, rows: [{mill,size,grade,species,pcs,volume,tally,status,chi,usmill,cdnmill,seccion}] } */
import fs from 'node:fs'
import path from 'node:path'
import XLSX from 'xlsx'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const TolkoParser = require('../parser.js')

const API = 'https://borouviqngtdzfvlmlur.supabase.co/functions/v1/tolko-api'
const CLAVE = 'NT-Tolko-2026'

const [, , modo, ruta, ...flags] = process.argv
const getFlag = (n) => { const i = flags.indexOf(n); return i >= 0 ? flags[i + 1] : null }
const dry = flags.includes('--dry')

function fechaDeNombre(nombre) {
  const meses = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 }
  const m = nombre.match(/([A-Za-z]+)_(\d{1,2})(?:st|nd|rd|th)?_(\d{4})/)
  if (m && meses[m[1].toLowerCase()]) return `${m[3]}-${String(meses[m[1].toLowerCase()]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
  return null
}

function resumen(items, warnings) {
  const porPestana = {}
  for (const it of items) {
    const k = it.pestana
    porPestana[k] = porPestana[k] || { n: 0, prompt: 0, carros: 0, conUsmill: 0 }
    porPestana[k].n++
    if (it.es_prompt) porPestana[k].prompt++
    if (it.es_carro) porPestana[k].carros++
    if (it.precio_usmill != null) porPestana[k].conUsmill++
  }
  console.log('--- Resumen de parseo ---')
  for (const [k, v] of Object.entries(porPestana))
    console.log(`  ${k}: ${v.n} items · ${v.prompt} prompt · ${v.carros} carros · ${v.conUsmill} con US MILL`)
  console.log(`  TOTAL: ${items.length} items`)
  if (warnings.length) { console.log('--- Avisos ---'); warnings.forEach(w => console.log('  ⚠ ' + w)) }
}

async function publicar(payload) {
  if (dry) { console.log('[dry-run] no se publica a la API'); return }
  const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ clave: CLAVE, ...payload }) })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || j.error) throw new Error('API respondió: ' + res.status + ' ' + JSON.stringify(j))
  console.log('✔ Publicado:', JSON.stringify(j))
}

if (modo === 'excel') {
  const wb = XLSX.readFile(ruta, { cellDates: true })
  const sheets = {}
  for (const name of wb.SheetNames) sheets[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null })
  const fecha = getFlag('--fecha') || fechaDeNombre(path.basename(ruta)) || new Date().toISOString().slice(0, 10)
  console.log('Fecha de lista:', fecha)
  const { items, warnings } = TolkoParser.parseWorkbook(sheets, { fecha })
  resumen(items, warnings)
  if (flags.includes('--json')) fs.writeFileSync('parse-out.json', JSON.stringify(items, null, 1))
  await publicar({ action: 'ingest', fecha, fuente: 'xlsx_semanal', titulo: `Tolko U.S. Sales List — ${fecha}`, archivo: path.basename(ruta), items })
} else if (modo === 'lowgrade') {
  const data = JSON.parse(fs.readFileSync(ruta, 'utf8'))
  const fecha = getFlag('--fecha') || data.fecha
  const year = parseInt(fecha.slice(0, 4))
  const items = data.rows.map(r => TolkoParser.buildLowGradeItem({ ...r, year }, 'LOW GRADE (correo)'))
  resumen(items, [])
  await publicar({ action: 'ingest', fecha, fuente: 'email_lowgrade', titulo: data.titulo || `Tolko Low Grade — ${fecha}`, archivo: data.archivo || null, items })
} else {
  console.log('Uso: node ingest/ingest-local.mjs excel|lowgrade <ruta> [--fecha YYYY-MM-DD] [--dry]')
}
