/* ============================================================================
   TolkoParser — parser compartido de las listas de venta de Tolko
   Se usa en 3 lados con el MISMO código:
     1. Portal web (GitHub Pages)  → <script src="parser.js">  → window.TolkoParser
     2. Node (ingesta local/CLI)   → require()/import          → module.exports
     3. Referencia para futura ingesta automática (edge function)

   Entrada principal: sheets = { nombreHoja: filas[][] }
     (filas crudas tal como las da SheetJS con {header:1, raw:true, defval:null}
      o openpyxl; fechas como Date u string ISO)

   Salida: { items: [...], warnings: [...] }
     items con el esquema EXACTO de la tabla tolko_items (sin lista_id).
   ========================================================================== */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory()
  else root.TolkoParser = factory()
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict'

  // Mill → grupo de flete (FRT Group del glosario de Tolko, hoja IN_OUT Schedule)
  const GRUPOS = {
    HVT: 'High Level',
    AL: 'Armstrong/Lavington', LVT: 'Armstrong/Lavington', ARL: 'Armstrong/Lavington',
    KLT: 'Kelowna',
    LD: 'Lakeview/Quesnel', SC: 'Lakeview/Quesnel', QUT: 'Lakeview/Quesnel',
  }
  const MILL_NOMBRES = {
    HVT: 'High Level AB', AL: 'Armstrong BC', LVT: 'Lavington BC', ARL: 'Armstrong BC',
    KLT: 'Kelowna BC', LD: 'Williams Lake BC', SC: 'Soda Creek BC', QUT: 'Quesnel BC',
  }
  // Piezas por paquete estándar por medida (confirmado en pestaña #3 & ECON y A&J)
  const STD_PCS = { '1x4': 640, '2x3': 532, '2x4': 294, '2x6': 189, '2x8': 147, '2x10': 105, '2x12': 84 }
  const LENS = [8, 10, 12, 14, 16, 18, 20]
  const CAR_MBF_MIN = 80 // umbral heurístico: ≥80 MBF ≈ carro completo

  const s = v => (v == null ? '' : String(v)).trim()
  const up = v => s(v).toUpperCase()
  const num = v => {
    if (typeof v === 'number') return isFinite(v) ? v : null
    const n = parseFloat(s(v).replace(/[^\d.\-]/g, ''))
    return isFinite(n) ? n : null
  }

  function iso(v, year) {
    if (v instanceof Date && !isNaN(v)) {
      // openpyxl/SheetJS dan fechas locales; usar componentes locales
      const y = v.getFullYear(), mo = v.getMonth() + 1, d = v.getDate()
      return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    }
    const t = s(v)
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
    let m = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/) // '8/24' o '8/24/26'
    if (m) {
      const y = m[3] ? (m[3].length === 2 ? '20' + m[3] : m[3]) : String(year || new Date().getFullYear())
      return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`
    }
    m = t.match(/^(\d{1,2})-([A-Za-z]{3})/) // '10-Aug'
    if (m) {
      const meses = { jan: 1, ene: 1, feb: 2, mar: 3, apr: 4, abr: 4, may: 5, jun: 6, jul: 7, aug: 8, ago: 8, sep: 9, oct: 10, nov: 11, dec: 12, dic: 12 }
      const mo = meses[m[2].toLowerCase()]
      if (mo) return `${year || new Date().getFullYear()}-${String(mo).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`
    }
    return null
  }

  function normStatus(v, year) {
    const t = up(v)
    if (!t) return null
    if (t.startsWith('PMT') || t.startsWith('PROMPT')) return 'PMT'
    if (t.startsWith('SOLD')) return 'SOLD'
    return iso(v, year) || s(v)
  }

  function bfPc(size, lenFt) {
    const m = s(size).match(/^(\d+)\s*x\s*(\d+)$/i)
    if (!m || !lenFt) return null
    return (parseInt(m[1]) * parseInt(m[2]) / 12) * lenFt
  }
  // '92-5/8"' → 7.719 ft · '96"' → 8 ft · '104-5/8 (FL)' → 8.719 ft
  function trimFt(txt) {
    const m = s(txt).match(/(\d{2,3})\s*(?:-\s*(\d+)\/(\d+))?/)
    if (!m) return null
    let inches = parseInt(m[1])
    if (m[2]) inches += parseInt(m[2]) / parseInt(m[3])
    return inches / 12
  }

  function cleanGrade(t) {
    let g = up(t)
      .replace(/\(.*$/g, ' ')
      .replace(/\b\d+\s*X\s*\d+\b/g, ' ')
      .replace(/\b(SPF|DF\/FL|FL\/DF|DFIR|HEM\s*FIR|FIR|HF|FL|DF|STUDS|SHORTS?|NEP|NGS|NPW|TOLPW)\b/g, ' ')
      .replace(/[^\w#&/\s-]/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/^[-&\s]+|[-&\s]+$/g, '').trim()
    if (/#\s*2\s*&?\s*BTR|#2BTR/.test(g)) return '#2Btr'
    if (/^A[\s-]*GRADE|^A$/.test(g)) return 'A-GRADE'
    if (/^J[\s-]*GRADE|^J$/.test(g)) return 'J-GRADE'
    if (/^STUD/.test(g)) return 'STUD'
    if (/^PREM|^PRE$/.test(g)) return 'PREM'
    if (/^SS$/.test(g)) return 'SS'
    if (/^#\s*(\d)/.test(g)) return '#' + g.match(/^#\s*(\d)/)[1]
    if (/^ECON/.test(g)) return 'ECON'
    if (/^KILN/.test(g)) return 'KW'
    if (!g || g.length > 14) return null
    return g
  }

  function speciesFrom(txt, fallback) {
    const t = up(txt)
    if (/\bDF\/FL\b|\bFL\/DF\b/.test(t)) return 'DF/FL'
    if (/\(DF\)|\bDFIR\b/.test(t)) return 'DF'
    if (/\(FL\)/.test(t)) return 'FL'
    if (/\bSPF\b/.test(t)) return 'SPF'
    if (/\bHF\b|\bHEM\b/.test(t)) return 'HF'
    if (/\bDF\b/.test(t)) return 'DF'
    if (/\bFL\b/.test(t)) return 'FL'
    if (/\bFIR\b/.test(t)) return 'DF/FL'
    return fallback || null
  }

  function esMill(txt) {
    const t = up(txt)
    return t in GRUPOS || /^[A-Z]{2,4}$/.test(t) && !['PMT', 'SOLD', 'CHI', 'AG', 'JG', 'ECON', 'PREM', 'PRE', 'SS', 'KW', 'NEP', 'NGS', 'NPW'].includes(t)
  }

  function item(o) {
    const mill = o.mill ? up(o.mill) : null
    const tally = o.tally && Object.keys(o.tally).length ? o.tally : null
    return {
      pestana: o.pestana,
      seccion: o.seccion || null,
      mill,
      grupo_flete: mill && GRUPOS[mill] !== undefined ? GRUPOS[mill] : null,
      producto: o.producto || [o.size, o.grade, o.species].filter(Boolean).join(' '),
      size: o.size || null,
      grade: o.grade || null,
      species: o.species || null,
      pcs_pkg: o.pcs_pkg != null ? Math.round(o.pcs_pkg) : null,
      volumen_raw: o.volumen_raw || null,
      es_carro: o.es_carro != null ? o.es_carro : null,
      es_prompt: o.status === 'PMT',
      tally,
      status: o.status || null,
      precio_chi: o.precio_chi != null ? o.precio_chi : null,
      precio_usmill: o.precio_usmill != null ? o.precio_usmill : null,
      precio_cdnmill: o.precio_cdnmill != null ? o.precio_cdnmill : null,
      usmill_estimado: false,
      mbf_est: o.mbf_est != null ? Math.round(o.mbf_est * 10) / 10 : null,
      raw: o.raw || null,
    }
  }

  function mbfDeTally(size, tally, pcs) {
    if (!tally || !pcs) return null
    let mbf = 0
    for (const [len, q] of Object.entries(tally)) {
      const bf = bfPc(size, parseFloat(len))
      if (bf && q) mbf += q * pcs * bf / 1000
    }
    return mbf || null
  }

  // Localiza columnas por encabezado en una fila
  function findCols(row) {
    const c = { lens: {} }
    row.forEach((v, i) => {
      const t = up(v)
      if (!t) return
      if (t === 'STATUS') c.status = i
      else if (t.includes('US MILL') || t.includes('USMILL')) c.usmill = i
      else if (t.includes('CDN')) c.cdnmill = i
      else if (t.includes('CHI')) c.chi = i
      else if (t.startsWith('SPECIES')) c.species = i
      else if (t === 'SIZE') c.size = i
      else if (t.startsWith('PCS')) c.pcs = i
      else if (t === 'VOLUME') c.volume = i
      else if (t === 'GRADE') c.grade = i
      else {
        const n = num(v)
        if (n != null && LENS.includes(n)) c.lens[n] = i
      }
    })
    return c
  }

  /* ---------- Pestañas tipo TALLY: SPF DIMENSION, FIR, MSR, KW ------------ */
  function parseTallySheet(pestana, rows, opts) {
    const items = [], warnings = []
    let size = null, grade = null, cols = null
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || []
      const a = s(row[0])
      const isHeader = row.some(v => up(v) === 'STATUS')
      if (isHeader) {
        cols = findCols(row)
        const msz = a.match(/^(\d+)\s*x\s*(\d+)/i)
        if (msz) size = `${parseInt(msz[1])}x${parseInt(msz[2])}`
        else if (a && !esMill(a)) grade = cleanGrade(a)
        continue
      }
      const msz = a.match(/^(\d+)\s*x\s*(\d+)/i)
      if (msz && !esMill(a)) { size = `${parseInt(msz[1])}x${parseInt(msz[2])}`; continue }
      if (!cols || !a || !esMill(a)) continue
      const tally = {}
      let pkgs = 0
      for (const [len, ci] of Object.entries(cols.lens)) {
        const q = num(row[ci])
        if (q) { tally[len] = q; pkgs += q }
      }
      if (!pkgs) continue
      let species = opts.species || 'SPF'
      if (cols.species != null && s(row[cols.species])) species = speciesFrom(row[cols.species], species)
      let g = grade
      if (cols.grade != null && s(row[cols.grade])) {
        const gt = s(row[cols.grade])
        const gm = gt.match(/^(\d{4})\s*(.*)$/) // MSR: '1650', '1800 DFIR', '2700 FL'
        if (gm) { g = 'MSR ' + gm[1]; if (gm[2]) species = speciesFrom(gm[2], species) }
        else g = cleanGrade(gt)
      }
      if (!size) { warnings.push(`${pestana} fila ${r + 1}: sin medida, se omite`); continue }
      const pcs = STD_PCS[size] || null
      const mbf = mbfDeTally(size, tally, pcs)
      items.push(item({
        pestana, seccion: grade, mill: a, size, grade: g, species, pcs_pkg: pcs,
        tally, status: normStatus(row[cols.status], opts.year),
        precio_chi: cols.chi != null ? num(row[cols.chi]) : null,
        precio_usmill: cols.usmill != null ? num(row[cols.usmill]) : null,
        precio_cdnmill: cols.cdnmill != null ? num(row[cols.cdnmill]) : null,
        mbf_est: mbf, es_carro: mbf != null ? mbf >= CAR_MBF_MIN : null,
        volumen_raw: `${pkgs} pqt`, raw: row,
      }))
    }
    return { items, warnings }
  }

  /* ---------- Pestaña #3 & ECON (y correo Low Grade) ---------------------- */
  function parseLowGradeSheet(pestana, rows, opts) {
    const items = [], warnings = []
    let seccion = null, cols = null
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || []
      const a = s(row[0])
      if (row.some(v => up(v) === 'STATUS') && row.some(v => up(v) === 'VOLUME')) {
        cols = findCols(row)
        if (cols.size === 0) {
          // encabezado copiado sin la celda vacía inicial (columna del mill): recorrer todo 1
          const c2 = { lens: {} }
          for (const k of ['status', 'chi', 'usmill', 'cdnmill', 'species', 'size', 'pcs', 'volume', 'grade'])
            if (cols[k] != null) c2[k] = cols[k] + 1
          for (const [len, i] of Object.entries(cols.lens)) c2.lens[len] = i + 1
          cols = c2
        }
        continue
      }
      if (a && !esMill(a) && row.filter(v => s(v)).length <= 1) {
        const t = up(a)
        if (t.startsWith('#') || t.startsWith('ECON')) seccion = t.replace(/\s.*$/, '')
        continue
      }
      if (!cols || !a || !esMill(a)) continue
      const sizeGrade = s(row[1] != null && cols.size != null ? row[cols.size] : row[1])
      const msz = sizeGrade.match(/^(\d+\s*x\s*\d+)\s*(.*)$/i)
      if (!msz) continue
      const size = msz[1].replace(/\s/g, '').toLowerCase()
      const grade = cleanGrade(msz[2]) || seccion
      const species = speciesFrom(cols.species != null ? row[cols.species] : row[2], 'SPF')
      const pcs = cols.pcs != null ? num(row[cols.pcs]) : null
      const volRaw = s(cols.volume != null ? row[cols.volume] : row[4])
      const tally = {}
      let pkgs = 0
      for (const [len, ci] of Object.entries(cols.lens)) {
        const q = num(row[ci])
        if (q) { tally[len] = q; pkgs += q }
      }
      // Volume: '1' = 1 carro completo · '41M' / '1 M' = MBF sueltos (armar carro)
      let esCarro = null, mbf = null
      const mM = volRaw.match(/^(\d+(?:\.\d+)?)\s*M$/i)
      const mCar = volRaw.match(/^(\d+)$/)
      if (mM) { esCarro = false; mbf = parseFloat(mM[1]) }
      else if (mCar) { esCarro = parseInt(mCar[1]) >= 1; mbf = mbfDeTally(size, tally, pcs || STD_PCS[size]) }
      else mbf = mbfDeTally(size, tally, pcs || STD_PCS[size])
      items.push(item({
        pestana, seccion, mill: a, size, grade, species,
        pcs_pkg: pcs || STD_PCS[size] || null,
        tally, status: normStatus(row[cols.status], opts.year),
        precio_chi: cols.chi != null ? num(row[cols.chi]) : null,
        precio_usmill: cols.usmill != null ? num(row[cols.usmill]) : null,
        precio_cdnmill: cols.cdnmill != null ? num(row[cols.cdnmill]) : null,
        mbf_est: mbf, es_carro: esCarro,
        volumen_raw: volRaw || `${pkgs} pqt`, raw: row,
      }))
    }
    return { items, warnings }
  }

  /* ---------- Pestañas de STUDS: 4" STUD, 6" STUD, 2x3 STUDS & SHORTS ----- */
  function parseStudSheet(pestana, rows, opts) {
    const items = [], warnings = []
    let seccion = null, grade = null, species = null, size = null
    let statusCols = null, pcsCol = 6, cbCol = 7, chiCol = 8
    if (/4"/.test(pestana)) size = '2x4'
    if (/6"/.test(pestana)) size = '2x6'
    const defaultSize = size
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || []
      const a = s(row[0]), b = s(row[1])
      // encabezado: B='Location'
      if (up(b) === 'LOCATION') {
        statusCols = [{ key: 'PMT', ci: 2 }]
        for (let ci = 3; ci <= 5; ci++) {
          const d = iso(row[ci], opts.year)
          if (d) statusCols.push({ key: d, ci })
        }
        row.forEach((v, i) => {
          const t = up(v)
          if (t.startsWith('PCS')) pcsCol = i
          else if (t.includes('PKG/CB')) cbCol = i
          else if (t.includes('CHI')) chiCol = i
        })
        continue
      }
      // fila de sección/grado (sin mill en B)
      if (a && !esMill(b) && !num(row[chiCol])) {
        const t = up(a)
        const msz = t.match(/(\d+)\s*X\s*(\d+)/)
        if (msz) size = `${parseInt(msz[1])}x${parseInt(msz[2])}`
        else if (defaultSize) size = defaultSize
        const sp = speciesFrom(t, null)
        if (sp) species = sp
        const g = cleanGrade(t)
        if (g) grade = g
        seccion = s(a)
        continue
      }
      if (!statusCols || !esMill(b)) continue
      // fila de datos: A = largo/trim, B = mill
      const trim = a
      const lenFt = trimFt(trim)
      const pcs = num(row[pcsCol])
      const cb = num(row[cbCol])
      const chi = num(row[chiCol])
      const sp = speciesFrom(trim, species)
      const partes = [], tally = {}
      let unidades = 0, carrosAF = 0, statusFinal = null
      for (const sc of statusCols) {
        const t = s(row[sc.ci])
        if (!t) continue
        partes.push(`${sc.key === 'PMT' ? 'Prompt' : sc.key}: ${t}`)
        if (!statusFinal) statusFinal = sc.key
        let m
        const reU = /(\d+)\s*(AF|UNIT|U\b)/gi
        let found = false
        while ((m = reU.exec(t))) {
          found = true
          if (up(m[2]) === 'AF') carrosAF += parseInt(m[1])
          else unidades += parseInt(m[1])
        }
        if (!found) { const n0 = num(t); if (n0) unidades += n0 }
      }
      if (!statusFinal) continue
      const trimKeyM = trim.match(/(\d{2,3}(?:-\d+\/\d+)?)/)
      const trimKey = trimKeyM ? trimKeyM[1] + '"' : trim
      tally[trimKey] = unidades + (carrosAF && cb ? carrosAF * cb : 0)
      const totalPkgs = tally[trimKey]
      const bf = size && lenFt ? bfPc(size, lenFt) : null
      const mbf = bf && pcs && totalPkgs ? totalPkgs * pcs * bf / 1000 : null
      items.push(item({
        pestana, seccion, mill: b, size, grade, species: sp,
        producto: [size, grade, sp, trim].filter(Boolean).join(' '),
        pcs_pkg: pcs, tally, status: statusFinal,
        precio_chi: chi,
        mbf_est: mbf,
        es_carro: cb && totalPkgs ? totalPkgs >= cb : (mbf != null ? mbf >= CAR_MBF_MIN : null),
        volumen_raw: partes.join(' · ') + (cb ? ` (carro=${cb} pqt)` : ''),
        raw: row,
      }))
    }
    return { items, warnings }
  }

  /* ---------- Pestaña A & J GRADE ----------------------------------------- */
  function parseAJSheet(pestana, rows, opts) {
    const items = [], warnings = []
    let grade = null, size = null, species = 'SPF', statusCols = null, chiCol = 6, pcs = null
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r] || []
      const a = s(row[0]), b = s(row[1])
      if (/^A[\s-]?Grade$/i.test(a)) { grade = 'A-GRADE'; continue }
      if (/^J[\s-]?Grade$/i.test(a)) { grade = 'J-GRADE'; continue }
      // sub-encabezado: '2x4 SPF | AG | PMT... | fechas | CHI'
      const msz = a.match(/^(\d+)\s*x\s*(\d+)\s*(.*)$/i)
      if (msz && (up(b) === 'AG' || up(b) === 'JG')) {
        size = `${parseInt(msz[1])}x${parseInt(msz[2])}`
        species = speciesFrom(msz[3], 'SPF')
        grade = up(b) === 'AG' ? 'A-GRADE' : 'J-GRADE'
        statusCols = []
        for (let ci = 2; ci <= 5; ci++) {
          const v = row[ci]
          const t = up(v)
          if (t.startsWith('PMT')) {
            statusCols.push({ key: 'PMT', ci })
            const mp = t.match(/(\d+)\s*PCS/)
            if (mp) pcs = parseInt(mp[1])
          } else {
            const d = iso(v, opts.year)
            if (d) statusCols.push({ key: d, ci })
          }
        }
        row.forEach((v, i) => { if (up(v).includes('CHI')) chiCol = i })
        continue
      }
      if (!statusCols || !a || !esMill(a)) continue
      const lenFt = num(b)
      if (!lenFt || !size) continue
      const chi = num(row[chiCol])
      const pcsEf = pcs || STD_PCS[size] || null
      for (const sc of statusCols) {
        const q = num(row[sc.ci])
        if (!q) continue
        const bf = bfPc(size, lenFt)
        const mbf = bf && pcsEf ? q * pcsEf * bf / 1000 : null
        items.push(item({
          pestana, seccion: grade, mill: a, size, grade, species,
          producto: `${size} ${grade} ${lenFt}' ${species}`,
          pcs_pkg: pcsEf, tally: { [lenFt]: q }, status: sc.key,
          precio_chi: chi, mbf_est: mbf,
          es_carro: mbf != null ? mbf >= CAR_MBF_MIN : null,
          volumen_raw: `${q} pqt de ${lenFt}'`, raw: row,
        }))
      }
      pcs = /J-GRADE/.test(grade || '') ? pcs : pcs // pcs por sección se mantiene
    }
    return { items, warnings }
  }

  /* ---------- Texto pegado del correo Low Grade (tab-separado) ------------ */
  function parseLowGradeText(text, opts) {
    opts = opts || {}
    const lines = String(text || '').split(/\r?\n/)
    const rows = []
    for (const ln of lines) {
      if (ln.includes('\t')) rows.push(ln.split('\t'))
      else if (s(ln)) rows.push([ln])
    }
    return parseLowGradeSheet('LOW GRADE (correo)', rows, opts)
  }

  /* ---------- Router principal -------------------------------------------- */
  function parseWorkbook(sheets, opts) {
    opts = opts || {}
    if (!opts.year && opts.fecha) opts.year = parseInt(String(opts.fecha).slice(0, 4))
    const items = [], warnings = []
    for (const [name, rows] of Object.entries(sheets)) {
      const N = up(name)
      let res = null
      if (N.includes('IN_OUT')) continue
      else if (N.includes('#3') || N.includes('ECON')) res = parseLowGradeSheet(name, rows, opts)
      else if (N.includes('STUD')) res = parseStudSheet(name, rows, opts)
      else if (N.includes('FIR')) res = parseTallySheet(name, rows, { ...opts, species: null })
      else if (N.includes('MSR')) res = parseTallySheet(name, rows, { ...opts, species: 'SPF' })
      else if (N.includes('A & J') || N.includes('A&J')) res = parseAJSheet(name, rows, opts)
      else if (N.includes('KW') || N.includes('KILN')) res = parseTallySheet(name, rows, { ...opts, species: 'SPF' })
      else res = parseTallySheet(name, rows, { ...opts, species: 'SPF' }) // SPF DIMENSION y desconocidas
      items.push(...res.items)
      warnings.push(...res.warnings)
      if (!res.items.length && !N.includes('KW')) warnings.push(`Pestaña "${name}": 0 items (¿formato nuevo?)`)
    }
    return { items, warnings }
  }

  /* ---------- Item low-grade construido a mano (ingesta puntual) ---------- */
  function buildLowGradeItem(o, pestana) {
    const size = o.size.toLowerCase()
    let esCarro = null, mbf = null
    const volRaw = s(o.volume)
    const mM = volRaw.match(/^(\d+(?:\.\d+)?)\s*M$/i)
    if (mM) { esCarro = false; mbf = parseFloat(mM[1]) }
    else if (/^\d+$/.test(volRaw)) { esCarro = parseInt(volRaw) >= 1; mbf = mbfDeTally(size, o.tally, o.pcs || STD_PCS[size]) }
    return item({
      pestana: pestana || 'LOW GRADE (correo)', seccion: o.seccion, mill: o.mill, size,
      grade: o.grade, species: o.species, pcs_pkg: o.pcs || STD_PCS[size] || null,
      tally: o.tally, status: normStatus(o.status, o.year),
      precio_chi: o.chi, precio_usmill: o.usmill, precio_cdnmill: o.cdnmill,
      mbf_est: mbf, es_carro: esCarro, volumen_raw: volRaw, raw: o.raw || null,
    })
  }

  return {
    parseWorkbook, parseLowGradeText, buildLowGradeItem,
    GRUPOS, MILL_NOMBRES, STD_PCS, LENS, CAR_MBF_MIN,
    util: { iso, normStatus, bfPc, trimFt, cleanGrade, speciesFrom, mbfDeTally },
  }
})
